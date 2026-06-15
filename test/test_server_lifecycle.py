import textwrap
import time
from pathlib import Path

import pytest
import yaml as _yaml
from fastapi.testclient import TestClient

from entities.event import EventTracer
from server.app import create_app
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


def test_session_file_created_on_first_use(source_yaml, tmp_path, monkeypatch):
    from server.persistence import prepare_session

    monkeypatch.setenv("LOOM_SESSION_DIR", str(tmp_path / "sessions"))
    session = prepare_session(source_yaml)
    assert session.exists()
    assert session.read_text() == SAMPLE
    assert session.name.endswith(".session.yaml")
    assert source_yaml.read_text() == SAMPLE  # source untouched


def test_session_reset_reclones(source_yaml, tmp_path, monkeypatch):
    from server.persistence import prepare_session, reset_session

    monkeypatch.setenv("LOOM_SESSION_DIR", str(tmp_path / "sessions"))
    session = prepare_session(source_yaml)
    session.write_text("mutated")
    new_session = reset_session(source_yaml)
    assert new_session.read_text() == SAMPLE


def test_session_path_lives_in_LOOM_SESSION_DIR_not_alongside_source(
    source_yaml, tmp_path, monkeypatch,
):
    # Sessions used to land next to the source file; they now live in a
    # dedicated tmp dir so the source tree stays clean and the OS can wipe
    # them at reboot.
    from server.persistence import prepare_session

    session_dir = tmp_path / "sessions"
    monkeypatch.setenv("LOOM_SESSION_DIR", str(session_dir))
    session = prepare_session(source_yaml)
    assert session.parent == session_dir.resolve()
    # Make sure nothing was written next to the source.
    assert not (source_yaml.with_name(source_yaml.stem + ".session.yaml")).exists()


def test_session_default_dir_is_system_tmp(source_yaml, monkeypatch):
    # When LOOM_SESSION_DIR is unset, sessions land in <system-tmp>/loom.
    # Verify default placement, then clean up the file we wrote so /tmp/loom
    # doesn't accumulate cruft from test runs (the directory itself is
    # shared across tests, so we leave it in place).
    import tempfile

    from server.persistence import prepare_session

    monkeypatch.delenv("LOOM_SESSION_DIR", raising=False)
    session = prepare_session(source_yaml)
    try:
        expected = Path(tempfile.gettempdir()).resolve() / "loom"
        assert session.parent == expected
    finally:
        if session.exists():
            session.unlink()


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
    src = tmp_path / "src.yaml"
    src.write_text("not yaml :::")
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        r = c.post("/topology", json={"yaml": "as:\n  rubbish"})
        assert r.status_code == 400


SAMPLE_WITH_ROUTER = textwrap.dedent("""
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan1: "10.0.0.0/24"
      hosts:
        h1: {network: lan1, address: "10.0.0.1"}
      routers:
        r1: {interfaces: {eth0: {network: lan1, address: "10.0.0.254", cost: 1}}}
""")


@pytest.fixture
def running_client(tmp_path, monkeypatch):
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE_WITH_ROUTER)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE_WITH_ROUTER})
        c.post("/sim/start")
        sim = c.app.state.sim_state
        try:
            yield c, sim
        finally:
            c.post("/sim/stop")


def test_fail_router_crashes_silently(running_client):
    client, sim = running_client
    name = next(iter(sim.as_obj.routers()))
    resp = client.post(f"/devices/{name}/fail")
    assert resp.status_code == 200
    assert sim.as_obj.router(name).is_halted() is True


def test_fail_single_interface(running_client):
    client, sim = running_client
    name = next(iter(sim.as_obj.routers()))
    iface_name = next(iter(sim.as_obj.router(name).interfaces()))
    resp = client.post(f"/devices/{name}/fail", json={"interface": iface_name})
    assert resp.status_code == 200
    assert sim.as_obj.router(name).interface(iface_name).is_up() is False
    assert sim.as_obj.router(name).is_halted() is False  # only one iface failed


def test_fail_on_host_is_rejected(running_client):
    client, sim = running_client
    host = next(iter(sim.as_obj.hosts()))
    resp = client.post(f"/devices/{host}/fail")
    assert resp.status_code == 400


def test_interfaces_read_includes_up_and_halted(running_client):
    client, sim = running_client
    name = next(iter(sim.as_obj.routers()))
    iface_name = next(iter(sim.as_obj.router(name).interfaces()))
    sim.as_obj.router(name).disable_interface(iface_name, graceful=False)
    resp = client.get(f"/devices/{name}/interfaces")
    body = resp.json()
    assert body["halted"] is False
    by_name = {i["name"]: i for i in body["interfaces"]}
    assert by_name[iface_name]["up"] is False


@pytest.fixture
def idle_client(tmp_path, monkeypatch):
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE_WITH_ROUTER)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE_WITH_ROUTER})
        sim = c.app.state.sim_state
        yield c, sim


def test_sim_edit_applies_live(running_client):
    client, sim = running_client
    resp = client.post("/sim/edit", json={"patch": [
        {"op": "add_network", "name": "lanE", "address": "172.16.7.0/24"}]})
    assert resp.status_code == 200
    assert resp.json()["state"] == "running"
    assert "lanE" in sim.as_obj.networks()


def test_sim_edit_bad_patch_is_400(running_client):
    client, sim = running_client
    resp = client.post("/sim/edit", json={"patch": [{"op": "nope"}]})
    assert resp.status_code == 400


def test_sim_edit_when_idle_is_409(idle_client):
    client, sim = idle_client
    resp = client.post("/sim/edit", json={"patch": [
        {"op": "add_network", "name": "lanE", "address": "172.16.7.0/24"}]})
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# H3: topology import safety
# ---------------------------------------------------------------------------


def test_invalid_import_leaves_session_file_unchanged(tmp_path, monkeypatch):
    """POST /topology with invalid YAML must return 400 and NOT modify the
    session file — the corrupt text must not be persisted.
    """
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    monkeypatch.setenv("LOOM_SESSION_DIR", str(tmp_path / "sessions"))

    app = create_app()
    with TestClient(app) as c:
        # Load a valid topology first so the session file is known-good.
        ok = c.post("/topology", json={"yaml": SAMPLE})
        assert ok.status_code == 200

        sim = c.app.state.sim_state
        session_before = sim.session_path.read_text()

        # Now POST an invalid topology that will fail the parser.
        bad = c.post("/topology", json={"yaml": "as:\n  rubbish"})
        assert bad.status_code == 400

        # The session file must be byte-for-byte identical to before the bad POST.
        session_after = sim.session_path.read_text()
        assert session_after == session_before, (
            "session file was modified by a rejected topology import"
        )


def test_invalid_import_topology_still_served_after_failure(tmp_path, monkeypatch):
    """After a rejected POST /topology, GET /topology must still return the
    previous valid topology, not the corrupt text.
    """
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    monkeypatch.setenv("LOOM_SESSION_DIR", str(tmp_path / "sessions"))

    app = create_app()
    with TestClient(app) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        good_yaml = c.get("/topology").json()["yaml"]

        c.post("/topology", json={"yaml": "as:\n  rubbish"})

        after_yaml = c.get("/topology").json()["yaml"]
        assert after_yaml == good_yaml, (
            "GET /topology returned changed content after a rejected import"
        )


def test_import_while_running_returns_409(tmp_path, monkeypatch):
    """POST /topology must return 409 when the simulation is running, mirroring
    the guard on POST /topology/reset.
    """
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE_WITH_ROUTER)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    monkeypatch.setenv("LOOM_SESSION_DIR", str(tmp_path / "sessions"))

    app = create_app()
    with TestClient(app) as c:
        c.post("/topology", json={"yaml": SAMPLE_WITH_ROUTER})
        c.post("/sim/start")
        try:
            resp = c.post("/topology", json={"yaml": SAMPLE_WITH_ROUTER})
            assert resp.status_code == 409, (
                f"expected 409 while running, got {resp.status_code}"
            )
        finally:
            c.post("/sim/stop")
