"""Lock-safety tests for route-layer handlers (H10 + related mediums).

Tests verify that device routes, set_protocol_config, and GET /topology do
not race against concurrent stop() calls, yielding clean HTTP responses
(409, clean fallback) instead of 500s/NoneType derefs.

Determinism strategy
--------------------
For the simple "after stop" cases (H10-A): verify the happy-path status codes
(409 when no topology is loaded).

For the TOCTOU barrier cases (H10-B through H10-E): inject a barrier inside
the SimState accessors so the route handler reads the live `_as` BEFORE stop()
nulls it, then stop() nulls it, then the handler tries to use the stale
reference.  Without the fix, handlers dereference the stale (now None)
reference and raise AttributeError → 500.  With the fix (resolve under _lock),
the handler holds a stable snapshot and finishes cleanly.

Barrier injection details
-------------------------
- `as_obj` property is patched to block on `_barrier` after returning a value
  so stop() runs in that window.
- Alternatively, for handler-internal deref, we patch a method on the returned
  AS object to pause so stop() can null _as between the check and the call.
"""

import textwrap
import threading
import unittest.mock

import pytest
from fastapi.testclient import TestClient

from server.app import create_app

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
        h2: {network: lan1, address: "10.0.0.2"}
      routers:
        r1: {interfaces: {eth0: {network: lan1, address: "10.0.0.254", cost: 1}}}
""")


@pytest.fixture
def running_client(tmp_path, monkeypatch):
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        c.post("/sim/start")
        yield c
        try:
            c.post("/sim/stop")
        except Exception:
            pass


@pytest.fixture
def stopped_client(tmp_path, monkeypatch):
    """Client with topology loaded, started, then stopped (no topology active)."""
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        c.post("/sim/start")
        c.post("/sim/stop")
        yield c


# ---------------------------------------------------------------------------
# H10-A: device routes after stop() yield 409, NOT 500
# ---------------------------------------------------------------------------

def test_fail_after_stop_returns_409_not_500(stopped_client):
    """POST /devices/r1/fail with no running topology must return 409, not 500."""
    c = stopped_client
    r = c.post("/devices/r1/fail")
    assert r.status_code == 409, (
        f"expected 409 (no topology), got {r.status_code}: {r.text}"
    )


def test_interfaces_after_stop_returns_409_not_500(stopped_client):
    """GET /devices/r1/interfaces with no running topology must return 409, not 500."""
    c = stopped_client
    r = c.get("/devices/r1/interfaces")
    assert r.status_code == 409, (
        f"expected 409 (no topology), got {r.status_code}: {r.text}"
    )


def test_routes_after_stop_returns_409_not_500(stopped_client):
    """GET /devices/r1/routes with no running topology must return 409, not 500."""
    c = stopped_client
    r = c.get("/devices/r1/routes")
    assert r.status_code == 409, (
        f"expected 409 (no topology), got {r.status_code}: {r.text}"
    )


def test_nat_table_after_stop_returns_409_not_500(stopped_client):
    """GET /devices/r1/nat-table with no running topology must return 409, not 500."""
    c = stopped_client
    r = c.get("/devices/r1/nat-table")
    assert r.status_code == 409, (
        f"expected 409 (no topology), got {r.status_code}: {r.text}"
    )


def test_command_after_stop_returns_409_not_500(stopped_client):
    """POST /devices/r1/command with no running topology must return 409, not 500."""
    c = stopped_client
    r = c.post("/devices/r1/command", json={"cmd": "ifconfig"})
    assert r.status_code == 409, (
        f"expected 409 (no topology), got {r.status_code}: {r.text}"
    )


# ---------------------------------------------------------------------------
# H10-B: TOCTOU deterministic barrier — _as nulled between check and device()
#
# The bug: _device_or_404 reads `s.as_obj` (not None), then stop() nulls _as,
# then it reads `s.as_obj.device(name)` → AttributeError on None → 500.
#
# The fix: resolve device under _lock so that check + dereference are atomic.
#
# Barrier placement: patch the SimState `_as` property at the class level so
# that after the first read (the None-check passes) we block and let stop()
# null _as before the second read.  This deterministically reproduces the race.
# ---------------------------------------------------------------------------

def test_fail_toctou_stop_races_device_resolve(tmp_path, monkeypatch):
    """stop() nulling _as between the None-check and device() must not 500.

    Without the fix, the handler sees _as is not None, stop() nulls it, then
    the handler dereferences _as.device(name) → AttributeError → 500.
    With the fix (resolve under _lock), the handler resolves the device in one
    atomic step under the lock, yielding 200 or 409 — never 500.
    """
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        c.post("/sim/start")
        sim = c.app.state.sim_state

        # Two events implement the barrier: the handler signals it has passed
        # the None-check, and waits for stop() to complete before proceeding.
        handler_past_check = threading.Event()
        stop_done = threading.Event()

        # We patch the SimState `as_obj` property to inject the barrier:
        # the first read (None-check) returns the real AS; the second read
        # (after stop() has run) would return None — exposing the TOCTOU.
        # With the fix, there is only ONE read under _lock, so the patch is
        # only called once (and returns the locked snapshot, not None).
        real_as_obj = type(sim).as_obj  # the original property descriptor

        call_count = [0]

        def patched_as_obj(self):
            val = real_as_obj.fget(self)  # delegate to real property
            call_count[0] += 1
            if call_count[0] == 1 and val is not None:
                # First access by the handler: signal we're past the None-check.
                handler_past_check.set()
                # Wait for stop() to null _as before we allow the second access.
                stop_done.wait(timeout=2.0)
            return val

        with unittest.mock.patch.object(
            type(sim), "as_obj", property(patched_as_obj)
        ):
            response_holder = []

            def call_fail():
                r = c.post("/devices/r1/fail")
                response_holder.append(r.status_code)

            t = threading.Thread(target=call_fail)
            t.start()

            # Wait until handler has passed the None-check, then stop().
            handler_past_check.wait(timeout=2.0)
            c.post("/sim/stop")
            stop_done.set()

            t.join(timeout=5.0)
            assert not t.is_alive(), "request thread hung"

        status = response_holder[0] if response_holder else None
        assert status in (200, 409), (
            f"expected 200 or 409 (not 500/None), got {status}"
        )


# ---------------------------------------------------------------------------
# H10-C: get_state TOCTOU — _as truthiness check then .name() call
#
# Bug: `s.as_obj.name() if s.as_obj else None` reads as_obj twice.
# stop() can null _as between the two reads → AttributeError on None → 500.
# Fix: read as_obj once into a local variable.
# ---------------------------------------------------------------------------

def test_get_state_toctou_stop_races_name_call(tmp_path, monkeypatch):
    """stop() nulling _as between the truthiness check and .name() must not 500.

    Without the fix, `s.as_obj.name() if s.as_obj else None` reads as_obj twice:
    the conditional evaluates to True, stop() nulls _as, then .name() is called
    on None → AttributeError → 500.
    With the fix (single local-variable read), both uses of as_obj see the same
    snapshot and the result is always clean (None → "idle" response, object → name).
    """
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        c.post("/sim/start")
        sim = c.app.state.sim_state

        handler_past_check = threading.Event()
        stop_done = threading.Event()

        real_as_obj = type(sim).as_obj
        call_count = [0]

        def patched_as_obj(self):
            val = real_as_obj.fget(self)
            call_count[0] += 1
            if call_count[0] == 1 and val is not None:
                handler_past_check.set()
                stop_done.wait(timeout=2.0)
            return val

        with unittest.mock.patch.object(
            type(sim), "as_obj", property(patched_as_obj)
        ):
            response_holder = []
            status_holder = []

            def call_get_state():
                r = c.get("/sim/state")
                response_holder.append(r.status_code)
                status_holder.append(r)

            t = threading.Thread(target=call_get_state)
            t.start()

            handler_past_check.wait(timeout=2.0)
            c.post("/sim/stop")
            stop_done.set()

            t.join(timeout=5.0)
            assert not t.is_alive(), "request thread hung"

        status = response_holder[0] if response_holder else None
        assert status == 200, (
            f"expected 200 from GET /sim/state (graceful None), got {status}"
        )
        # The response body must be valid JSON (no 500 error body).
        body = status_holder[0].json() if status_holder else {}
        assert "state" in body, f"response body missing 'state' key: {body}"


# ---------------------------------------------------------------------------
# H10-D: set_protocol_config iterating routers — _as swapped under iteration
#
# Bug: `for r in s.as_obj.routers().values()` reads as_obj, then iterates.
# stop() can null _as and a subsequent load can rebuild the dict mid-iteration
# → RuntimeError: dictionary changed size during iteration → 500.
# Fix: snapshot routers under _lock before iterating.
# ---------------------------------------------------------------------------

def test_set_protocol_config_toctou_stop_races_routers_iter(tmp_path, monkeypatch):
    """stop() nulling _as between the as_obj None-check and routers iteration
    must not produce a 500.

    Without the fix, the handler checks `s.as_obj is None` (passes), stop()
    nulls _as, then `for r in s.as_obj.routers().values()` dereferences None
    → AttributeError → 500.
    With the fix (snapshot routers under _lock), the dereference is atomic.
    """
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        c.post("/sim/start")
        sim = c.app.state.sim_state

        check_passed = threading.Event()
        stop_done = threading.Event()

        real_as_obj = type(sim).as_obj
        call_count = [0]

        def patched_as_obj(self):
            val = real_as_obj.fget(self)
            call_count[0] += 1
            if call_count[0] == 1 and val is not None:
                # Handler has passed the `as_obj is None` guard.
                check_passed.set()
                # stop() nulls _as before the routers() call.
                stop_done.wait(timeout=2.0)
            return val

        with unittest.mock.patch.object(
            type(sim), "as_obj", property(patched_as_obj)
        ):
            response_holder = []

            def call_protocol_config():
                r = c.post(
                    "/sim/protocol_config",
                    json={"hello_interval": 5, "lsa_refresh_interval": 15},
                )
                response_holder.append(r.status_code)

            t = threading.Thread(target=call_protocol_config)
            t.start()

            check_passed.wait(timeout=2.0)
            c.post("/sim/stop")
            stop_done.set()

            t.join(timeout=5.0)
            assert not t.is_alive(), "request thread hung"

        status = response_holder[0] if response_holder else None
        assert status in (200, 409), (
            f"expected 200 or 409 (not 500), got {status}"
        )


# ---------------------------------------------------------------------------
# H10-E: GET /topology — None-check outside _lock; stop() races _dump_yaml
#
# Bug: `if s.as_obj is not None:` is outside `_lock`, so stop() can null
# _as between the check and `with s._lock: _dump_yaml()` → 500 in _dump_yaml.
# Fix: do both the None-check and _dump_yaml inside a single _lock acquisition.
# ---------------------------------------------------------------------------

def test_get_topology_toctou_stop_races_dump(tmp_path, monkeypatch):
    """stop() nulling _as between the None-check and _dump_yaml must not 500.

    Without the fix, `if s.as_obj is not None` passes, stop() nulls _as,
    then `with s._lock: _dump_yaml()` dereferences self._as (None) → 500.
    With the fix (None-check and dump inside one _lock acquisition), stop()
    cannot interleave — the result is always the YAML or the file fallback.
    """
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        c.post("/sim/start")
        sim = c.app.state.sim_state

        check_passed = threading.Event()
        stop_done = threading.Event()

        real_as_obj = type(sim).as_obj
        call_count = [0]

        def patched_as_obj(self):
            val = real_as_obj.fget(self)
            call_count[0] += 1
            if call_count[0] == 1 and val is not None:
                # Handler has evaluated `as_obj is not None` as True.
                check_passed.set()
                # Now stop() runs and nulls _as before we enter _dump_yaml.
                stop_done.wait(timeout=2.0)
            return val

        with unittest.mock.patch.object(
            type(sim), "as_obj", property(patched_as_obj)
        ):
            response_holder = []
            resp_holder = []

            def call_get_topology():
                r = c.get("/topology")
                response_holder.append(r.status_code)
                resp_holder.append(r)

            t = threading.Thread(target=call_get_topology)
            t.start()

            check_passed.wait(timeout=2.0)
            c.post("/sim/stop")
            stop_done.set()

            t.join(timeout=5.0)
            assert not t.is_alive(), "request thread hung"

        status = response_holder[0] if response_holder else None
        assert status == 200, (
            f"expected 200 from GET /topology (yaml or file fallback), got {status}"
        )
        body = resp_holder[0].json() if resp_holder else {}
        assert "yaml" in body, f"response body missing 'yaml' key: {body}"
