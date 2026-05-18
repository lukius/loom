import textwrap
import time

import pytest
import yaml as _yaml

from entities.event import EventTracer
from server.state import SimState

SAMPLE = textwrap.dedent("""
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
        assert body["ok"] and body["as_name"] == "main"


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
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
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
    s = None
    unsubscribe = None
    try:
        s = SimState(src)
        s.load_from_session()
        # Subscribe on the Internet's tracer after load; then wait to catch
        # any keepalive thread that snuck through.
        unsubscribe = EventTracer.subscribe(events.append)
        # Give any keepalive thread that snuck through a chance to tick.
        time.sleep(0.2)
        leaked = [
            e for e in events
            if e.get("kind") == "packet" and e.get("network") in own_networks
        ]
        assert leaked == [], f"load_from_session() leaked packet events: {leaked}"
    finally:
        if unsubscribe is not None:
            unsubscribe()
        if s is not None:
            try:
                s.stop()
            except Exception:
                pass


def test_persisted_yaml_preserves_links_for_round_trip(tmp_path):
    """Session persistence must round-trip: a topology with links survives
    a save/reload cycle. Otherwise a sim restart (or SPA refresh that re-reads
    via GET /topology) sees a degenerate view with the wiring deleted.
    """
    yaml_with_link = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "10.0.0.0/24"
          links:
            p2p: "10.1.0.0/30"
          hosts:
            h1: {network: lan1, address: "10.0.0.1"}
          routers:
            r1:
              interfaces:
                eth0: {network: lan1, address: "10.0.0.254", cost: 1}
                eth1: {link: p2p, address: "10.1.0.1", cost: 1}
            r2:
              interfaces:
                eth0: {link: p2p, address: "10.1.0.2", cost: 1}
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml_with_link)
    s = SimState(src)
    try:
        s.load_from_session()
        s.start()
        s.pause()
        s.resume()  # triggers _persist
        persisted = s.session_path.read_text()
    finally:
        s.stop()

    # Structural assertions on the dumped YAML.
    dumped = _yaml.safe_load(persisted)
    as_ = dumped["internet"]["autonomous_systems"]["main"]
    assert as_.get("links") == {"p2p": "10.1.0.0/30"}, (
        f"links section missing or wrong: {as_.get('links')!r}"
    )
    assert as_["routers"]["r1"]["interfaces"]["eth1"] == {
        "link": "p2p", "address": "10.1.0.1", "cost": 1,
    }, "link-attached router interface must use `link:` key, not `network:`"
    assert as_["routers"]["r2"]["interfaces"]["eth0"] == {
        "link": "p2p", "address": "10.1.0.2", "cost": 1,
    }

    # Round-trip parse: feed the persisted YAML into a fresh SimState.
    src2 = tmp_path / "src2.yaml"
    src2.write_text(persisted)
    s2 = SimState(src2)
    try:
        s2.load_from_session()
        assert "p2p" in s2.as_obj.links()
        r1_eth1 = s2.as_obj.routers()["r1"].interface("eth1")
        assert r1_eth1.network() is s2.as_obj.link("p2p")
    finally:
        s2.stop()


def test_invalid_yaml_returns_400(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from server.app import create_app

    src = tmp_path / "src.yaml"
    src.write_text("not yaml :::")
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        r = c.post("/topology", json={"yaml": "as:\n  rubbish"})
        assert r.status_code == 400
