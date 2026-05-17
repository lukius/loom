import textwrap
import time

import pytest

from entities.event import EventTracer
from server.state import SimState

SAMPLE = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.0.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.0.1"}
""")


@pytest.fixture
def source_yaml(tmp_path):
    p = tmp_path / "src.yaml"
    p.write_text(SAMPLE)
    return p


def test_session_file_created_on_first_use(source_yaml):
    from server.persistence import prepare_session

    session = prepare_session(source_yaml)
    assert session.exists()
    assert session.read_text() == SAMPLE
    assert session.name.endswith(".session.yaml")
    assert source_yaml.read_text() == SAMPLE  # source untouched


def test_session_reset_reclones(source_yaml):
    from server.persistence import prepare_session, reset_session

    session = prepare_session(source_yaml)
    session.write_text("mutated")
    new_session = reset_session(source_yaml)
    assert new_session.read_text() == SAMPLE


def test_sim_state_transitions(source_yaml):
    from server.state import SimState

    s = SimState(source_yaml)
    assert s.state == "idle"

    s.load_from_session()
    assert s.state == "idle"

    s.start()
    assert s.state == "running"

    s.pause()
    assert s.state == "paused"

    s.resume()
    assert s.state == "running"

    s.stop()
    assert s.state == "idle"


def test_invalid_transitions_raise(source_yaml):
    from server.state import InvalidStateTransition, SimState

    s = SimState(source_yaml)
    with pytest.raises(InvalidStateTransition):
        s.pause()  # from idle
    s.load_from_session()
    s.start()
    with pytest.raises(InvalidStateTransition):
        s.resume()  # from running


def test_start_is_idempotent(source_yaml):
    from server.state import SimState

    s = SimState(source_yaml)
    s.load_from_session()
    s.start()
    s.start()  # no-op
    assert s.state == "running"


def test_stop_then_start_works(source_yaml):
    from server.state import SimState

    s = SimState(source_yaml)
    s.load_from_session()
    s.start()
    s.stop()
    s.load_from_session()
    s.start()  # second cycle
    assert s.state == "running"
    s.stop()


def test_topology_endpoint_loads_yaml(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from server.app import create_app

    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))

    app = create_app()
    with TestClient(app) as c:
        r = c.post("/topology", json={"yaml": SAMPLE})
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] and body["as_name"] == "t"


def test_lifecycle_via_rest(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from server.app import create_app

    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))

    app = create_app()
    with TestClient(app) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        assert c.post("/sim/start").json()["state"] == "running"
        assert c.post("/sim/pause").json()["state"] == "paused"
        assert c.post("/sim/resume").json()["state"] == "running"
        assert c.post("/sim/stop").json()["state"] == "idle"


def test_load_from_session_emits_no_packet_events(tmp_path):
    """Loading a topology must not emit any `packet` events.

    A sim in 'idle' state is silent on the event bus: no protocol traffic,
    no user traffic. Routers exist but their keepalive threads are not
    started until /sim/start.
    """
    # Unique network names so we can filter out leftover events from
    # other tests' router threads that may still be alive when this runs.
    yaml_with_router = textwrap.dedent("""
    as:
      name: load_session_isolation
      networks:
        loadsess_a: "10.99.0.0/24"
        loadsess_b: "10.99.1.0/24"
      routers:
        loadsess_r1:
          interfaces:
            eth0: {network: loadsess_a, address: "10.99.0.1", cost: 1}
            eth1: {network: loadsess_b, address: "10.99.1.1", cost: 1}
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml_with_router)

    own_networks = {"loadsess_a", "loadsess_b"}
    events = []
    unsubscribe = EventTracer.subscribe(events.append)
    s = None
    try:
        s = SimState(src)
        s.load_from_session()
        # Give any keepalive thread that snuck through a chance to tick.
        time.sleep(0.2)
        leaked = [
            e for e in events
            if e.get("kind") == "packet" and e.get("network") in own_networks
        ]
        assert leaked == [], f"load_from_session() leaked packet events: {leaked}"
    finally:
        if s is not None:
            try:
                s.stop()
            except Exception:
                pass
        unsubscribe()


def test_invalid_yaml_returns_400(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from server.app import create_app

    src = tmp_path / "src.yaml"
    src.write_text("not yaml :::")
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        r = c.post("/topology", json={"yaml": "as:\n  rubbish"})
        assert r.status_code == 400
