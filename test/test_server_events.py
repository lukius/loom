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
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))
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
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))

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
