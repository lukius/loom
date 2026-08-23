import asyncio
import textwrap
import time

import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.events import EventBus
from server.routes.ws import events as ws_handler


@pytest.mark.asyncio
async def test_subscribe_and_emit_delivers_event():
    bus = EventBus(loop=asyncio.get_running_loop())
    q = bus.subscribe()
    bus.emit({"kind": "x"})
    event = await asyncio.wait_for(q.get(), timeout=0.5)
    assert event == {"kind": "x"}


@pytest.mark.asyncio
async def test_two_subscribers_receive_both():
    bus = EventBus(loop=asyncio.get_running_loop())
    q1 = bus.subscribe()
    q2 = bus.subscribe()
    bus.emit({"kind": "e"})
    e1 = await asyncio.wait_for(q1.get(), timeout=0.5)
    e2 = await asyncio.wait_for(q2.get(), timeout=0.5)
    assert e1 == e2 == {"kind": "e"}


@pytest.mark.asyncio
async def test_overflow_drops_oldest():
    bus = EventBus(loop=asyncio.get_running_loop(), max_queue=2)
    q = bus.subscribe()
    bus.emit({"i": 1})
    bus.emit({"i": 2})
    bus.emit({"i": 3})  # should drop {"i":1}
    await asyncio.sleep(0.05)
    items = []
    while not q.empty():
        items.append(q.get_nowait())
    # tolerate ordering: at least the newest must be present, oldest dropped
    assert {"i": 3} in items
    assert {"i": 1} not in items


@pytest.mark.asyncio
async def test_unsubscribe_removes_queue():
    bus = EventBus(loop=asyncio.get_running_loop())
    q = bus.subscribe()
    bus.unsubscribe(q)
    bus.emit({"kind": "y"})
    await asyncio.sleep(0.05)
    assert q.empty()


def test_sim_state_event_emitted_on_transitions(tmp_path, monkeypatch):
    import textwrap

    from fastapi.testclient import TestClient

    from server.app import create_app

    yaml_text = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "10.0.0.0/24"
          hosts:
            h1: {network: lan1, address: "10.0.0.1"}
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml_text)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))

    app = create_app()
    with TestClient(app) as c:
        c.post("/topology", json={"yaml": yaml_text})
        with c.websocket_connect("/ws/events") as ws:
            c.post("/sim/start")
            # collect events until we see sim_state {running}, or timeout
            states_seen = []
            for _ in range(10):
                try:
                    evt = ws.receive_json()
                except Exception:
                    break
                if evt.get("kind") == "sim_state":
                    states_seen.append(evt["state"])
                    if "running" in states_seen:
                        break
            assert "running" in states_seen
            c.post("/sim/pause")
            for _ in range(5):
                try:
                    evt = ws.receive_json()
                except Exception:
                    break
                if evt.get("kind") == "sim_state":
                    states_seen.append(evt["state"])
                    if "paused" in states_seen:
                        break
            assert "paused" in states_seen


def test_packet_event_carries_flow_and_payload_id(tmp_path, monkeypatch):
    """Each `packet` event carries `flow` and `payload_id`.

    `payload_id` uniquely identifies one Message instance (one direction).
    `flow` is the end-to-end conversation key reported by the payload —
    stable across NAT, and shared between a ping request and its reply so
    both directions group as one conversation.
    """
    import textwrap

    from fastapi.testclient import TestClient

    yaml_text = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "10.0.0.0/24"
            lan2: "10.0.1.0/24"
          hosts:
            h1: {network: lan1, address: "10.0.0.1", gateway: "10.0.0.254"}
            h2: {network: lan2, address: "10.0.1.1", gateway: "10.0.1.254"}
          routers:
            r1:
              interfaces:
                eth0: {network: lan1, address: "10.0.0.254", cost: 1}
                eth1: {network: lan2, address: "10.0.1.254", cost: 1}
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml_text)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))

    from server.app import create_app

    app = create_app()
    with TestClient(app) as c:
        c.post("/topology", json={"yaml": yaml_text})
        c.post("/sim/start")
        import time as _t

        _t.sleep(0.4)  # let routing converge
        with c.websocket_connect("/ws/events") as ws:
            c.post("/devices/h1/command", json={"cmd": "ping h2 -W 1.0"})
            packets = []
            for _ in range(80):
                try:
                    evt = ws.receive_json()
                except Exception:
                    break
                if evt.get("kind") == "packet" and evt.get("type") in (
                    "ping_request",
                    "ping_reply",
                ):
                    packets.append(evt)
                if any(p["type"] == "ping_reply" for p in packets):
                    break

    requests = [p for p in packets if p["type"] == "ping_request"]
    replies = [p for p in packets if p["type"] == "ping_reply"]
    assert requests and replies, f"saw types: {[p['type'] for p in packets]}"
    # Every hop must carry flow, payload_id, payload_src/dst.
    for p in packets:
        for f in ("flow", "payload_id", "payload_src", "payload_dst"):
            assert p.get(f), f"missing {f} in {p}"
    # Request and reply share the same flow (one conversation).
    assert requests[0]["flow"] == replies[0]["flow"]
    # But carry different payload_ids (different Message instances).
    assert requests[0]["payload_id"] != replies[0]["payload_id"]
    # The flow equals the request's payload_id; the reply echoes it.
    assert requests[0]["flow"] == requests[0]["payload_id"]
    # Request: src=h1, dst=h2. Reply: src=h2, dst=h1. Endpoints are flipped.
    assert requests[0]["payload_src"] == "10.0.0.1"
    assert requests[0]["payload_dst"] == "10.0.1.1"
    assert replies[0]["payload_src"] == "10.0.1.1"
    assert replies[0]["payload_dst"] == "10.0.0.1"


def test_ws_streams_packet_events(tmp_path, monkeypatch):
    import textwrap

    from fastapi.testclient import TestClient

    from server.app import create_app

    yaml_text = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "10.0.0.0/24"
          hosts:
            h1: {network: lan1, address: "10.0.0.1"}
            h2: {network: lan1, address: "10.0.0.2"}
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml_text)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))

    app = create_app()
    with TestClient(app) as c:
        c.post("/topology", json={"yaml": yaml_text})
        c.post("/sim/start")
        with c.websocket_connect("/ws/events") as ws:
            c.post("/devices/h1/command", json={"cmd": "send h2 hello"})
            kinds = []
            for _ in range(5):
                try:
                    kinds.append(ws.receive_json())
                except Exception:
                    break
            types = [(e.get("kind"), e.get("type")) for e in kinds]
            assert any(t == ("packet", "user_datagram") for t in types)


# ---------------------------------------------------------------------------
# Fix A: WebSocket broadcast loop handles non-WebSocketDisconnect send errors
# ---------------------------------------------------------------------------

_MINIMAL_YAML = textwrap.dedent("""
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan1: "10.0.0.0/24"
      hosts:
        h1: {network: lan1, address: "10.0.0.1"}
""")


def test_ws_broadcast_non_disconnect_error_does_not_leak_and_unsubscribes(
    tmp_path, monkeypatch
):
    """A RuntimeError raised by ws.send_json must end the handler silently.

    The subscriber queue must be removed from the bus (no leak) and the error
    must not propagate as an unhandled exception.
    """
    src = tmp_path / "src.yaml"
    src.write_text(_MINIMAL_YAML)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))

    app = create_app()
    bus = app.state.event_bus

    # Unit-level: create a fake WebSocket whose send_json raises RuntimeError.
    async def _run():
        loop = asyncio.get_running_loop()
        bus.attach_loop(loop)

        sends = []
        errors = []

        class FakeWS:
            async def accept(self):
                pass

            async def send_json(self, data):
                sends.append(data)
                raise RuntimeError("Cannot call send once close message sent")

        fake_ws = FakeWS()
        fake_ws.app = type("App", (), {"state": type("S", (), {"event_bus": bus})()})()

        # Run the handler in background; emit one event to trigger the error path.
        task = loop.create_task(ws_handler(fake_ws))
        await asyncio.sleep(0.01)
        bus.emit({"kind": "probe"})
        await asyncio.sleep(0.05)
        try:
            await asyncio.wait_for(task, timeout=0.5)
        except Exception as exc:
            errors.append(exc)

        return sends, errors, len(bus._queues)

    sends, errors, remaining_queues = asyncio.run(_run())

    # The handler must have attempted one send (and hit the error).
    assert len(sends) >= 1
    # No exception must have escaped the handler task.
    assert errors == [], f"unexpected exception escaped: {errors}"
    # The subscriber queue must have been removed (no leak).
    assert remaining_queues == 0, f"leaked {remaining_queues} subscriber queue(s)"


# ---------------------------------------------------------------------------
# Fix B: EventBus.emit is a safe no-op when loop is None or closed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_emit_is_noop_when_loop_is_none():
    """emit() must not raise when _loop is None."""
    bus = EventBus(loop=None)
    q = bus.subscribe()
    # Must not raise.
    bus.emit({"kind": "x"})
    await asyncio.sleep(0.02)
    assert q.empty()


@pytest.mark.asyncio
async def test_emit_is_noop_when_loop_is_closed():
    """emit() must not raise when the loop is already closed."""
    closed_loop = asyncio.new_event_loop()
    closed_loop.close()
    bus = EventBus(loop=closed_loop)
    q = bus.subscribe()
    # Must not raise even though the loop is closed.
    bus.emit({"kind": "x"})
    await asyncio.sleep(0.02)
    assert q.empty()


def test_lifespan_shutdown_detaches_bridge_and_clears_loop(tmp_path, monkeypatch):
    """After app shutdown the event bridge is detached.

    A post-shutdown emit must not reach any subscriber and must not raise.
    """
    src = tmp_path / "src.yaml"
    src.write_text(_MINIMAL_YAML)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))

    app = create_app()
    bus = app.state.event_bus

    with TestClient(app):
        # The bridge is active during the session; shut it down by exiting.
        pass  # app is now shut down

    # After the context manager exits, lifespan teardown has run.
    # The bus loop should be None (cleared) so emit is a no-op.
    assert bus._loop is None, f"_loop not cleared after shutdown: {bus._loop}"

    # Emitting after shutdown must not raise and must not deliver to any queue.
    sub_q = bus.subscribe()
    bus.emit({"kind": "post-shutdown"})
    time.sleep(0.05)
    assert sub_q.empty(), "post-shutdown emit delivered to subscriber"
