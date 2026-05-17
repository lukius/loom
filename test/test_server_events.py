import asyncio

import pytest

from server.events import EventBus


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

    from entities.event import EventTracer
    from server.app import create_app

    yaml_text = textwrap.dedent("""
    as:
      name: t
      networks:
        lan1: "10.0.0.0/24"
      hosts:
        h1: {network: lan1, address: "10.0.0.1"}
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml_text)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    EventTracer._subscribers.clear()

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
    """The UI uses `flow` (unordered endpoint pair) to queue request + reply
    of a single conversation on the same animation track."""
    import textwrap

    from fastapi.testclient import TestClient

    yaml_text = textwrap.dedent("""
    as:
      name: t
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

    from entities.event import EventTracer
    from server.app import create_app

    EventTracer._subscribers.clear()
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
                    "ping_request", "ping_reply",
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
    # Request and reply share the same flow (unordered endpoint pair).
    assert requests[0]["flow"] == replies[0]["flow"]
    # But carry different payload_ids (different Message instances).
    assert requests[0]["payload_id"] != replies[0]["payload_id"]
    # The flow is the sorted pair "10.0.0.1<->10.0.1.1".
    assert requests[0]["flow"] == "10.0.0.1<->10.0.1.1"
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
    as:
      name: t
      networks:
        lan1: "10.0.0.0/24"
      hosts:
        h1: {network: lan1, address: "10.0.0.1"}
        h2: {network: lan1, address: "10.0.0.2"}
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml_text)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))

    from entities.event import EventTracer

    EventTracer._subscribers.clear()

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
