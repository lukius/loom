"""Tests for SimState lock discipline (findings H9, H9b, H11).

All assertions use threading.Event barriers — no time.sleep-based races.
"""
import shutil
import textwrap
import threading
from pathlib import Path

import pytest

import entities.event as ev_mod
from server.state import SimState

_SAMPLE_YAML = Path(__file__).parent.parent / "samples" / "sample.yaml"

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


@pytest.fixture
def minimal_src(tmp_path):
    p = tmp_path / "src.yaml"
    p.write_text(_MINIMAL_YAML)
    return p


@pytest.fixture
def minimal_running(minimal_src):
    sim = SimState(minimal_src)
    sim.load_from_session()
    sim.start()
    yield sim
    sim.stop()


@pytest.fixture
def sample_running(tmp_path):
    src = tmp_path / "sample.yaml"
    shutil.copy(_SAMPLE_YAML, src)
    sim = SimState(src)
    sim.load_from_session()
    sim.start()
    yield sim
    sim.stop()


# ---------------------------------------------------------------------------
# H9: edit() must hold _lock across _apply_patch AND _persist
# ---------------------------------------------------------------------------
# Strategy: monkeypatch _apply_patch to block mid-mutation on a threading.Event.
# From a second thread, attempt to acquire _lock (mirroring GET /topology's
# "with s._lock:" critical section).  Assert it CANNOT acquire _lock while
# the first thread is inside _apply_patch (i.e. _lock must be held throughout).
# After unblocking the first thread, assert _lock becomes free again and the
# topology change is visible.
#
# The test is deterministic because:
#  - thread A signals `inside_apply` before it starts blocking, so thread B
#    only tries the lock *after* A is inside the critical section.
#  - thread B checks tryacquire with a very short timeout; any spurious success
#    while A holds the lock would be a real failure (lock released too early).
#  - `lock_acquired_mid_apply` is a positive assertion: the test waits for B to
#    finish so there is no race between the assertion and thread teardown.
# ---------------------------------------------------------------------------


def test_edit_holds_lock_across_apply(minimal_running, monkeypatch):
    """_lock must be held continuously from state-check through apply+persist."""
    sim = minimal_running

    inside_apply = threading.Event()   # signals thread B: A is inside _apply_patch
    unblock_apply = threading.Event()  # lets thread A's _apply_patch finish

    original_apply_patch = sim._apply_patch

    def blocking_apply(patch):
        inside_apply.set()
        unblock_apply.wait()  # block until thread B has made its assertion
        return original_apply_patch(patch)

    monkeypatch.setattr(sim, "_apply_patch", blocking_apply)

    lock_acquired_mid_apply = threading.Event()
    lock_free_mid_apply = threading.Event()

    def reader_thread():
        # Wait until A is inside _apply_patch, then try to grab _lock.
        inside_apply.wait()
        # Non-blocking acquire: if _lock is NOT held by A this would succeed.
        acquired = sim._lock.acquire(blocking=True, timeout=0.1)
        if acquired:
            lock_acquired_mid_apply.set()   # BAD: lock was free during apply
            sim._lock.release()
        else:
            lock_free_mid_apply.set()       # GOOD: _lock is properly held
        unblock_apply.set()                 # let thread A finish

    patch = [{"op": "add_network", "name": "lanH9", "address": "172.16.10.0/24"}]

    t_reader = threading.Thread(target=reader_thread, daemon=True)
    t_reader.start()

    # Run edit() synchronously in the main thread (thread A).
    sim.edit(patch)

    t_reader.join(timeout=5.0)
    assert not t_reader.is_alive(), "reader thread did not finish"

    # The lock must have been held during _apply_patch: reader must have blocked.
    assert lock_free_mid_apply.is_set(), (
        "_lock was NOT held during _apply_patch — edit() released it too early (H9)"
    )
    assert not lock_acquired_mid_apply.is_set(), (
        "_lock was free during _apply_patch — race window exists (H9)"
    )

    # Sanity: the patch was applied.
    assert "lanH9" in sim.as_obj.networks()


def test_edit_holds_lock_across_persist(minimal_running, monkeypatch):
    """_lock must still be held when _persist() runs inside edit()."""
    sim = minimal_running

    inside_persist = threading.Event()
    unblock_persist = threading.Event()

    original_persist = sim._persist

    def blocking_persist():
        inside_persist.set()
        unblock_persist.wait()
        return original_persist()

    monkeypatch.setattr(sim, "_persist", blocking_persist)

    lock_acquired_mid_persist = threading.Event()
    lock_free_mid_persist = threading.Event()

    def reader_thread():
        inside_persist.wait()
        acquired = sim._lock.acquire(blocking=True, timeout=0.1)
        if acquired:
            lock_acquired_mid_persist.set()
            sim._lock.release()
        else:
            lock_free_mid_persist.set()
        unblock_persist.set()

    patch = [{"op": "add_network", "name": "lanH9b", "address": "172.16.11.0/24"}]

    t = threading.Thread(target=reader_thread, daemon=True)
    t.start()
    sim.edit(patch)
    t.join(timeout=5.0)
    assert not t.is_alive()

    assert lock_free_mid_persist.is_set(), (
        "_lock was NOT held during _persist — topology dump is unprotected (H9)"
    )
    assert not lock_acquired_mid_persist.is_set()


def test_edit_broadcasts_outside_lock(minimal_running, monkeypatch):
    """EventTracer._broadcast must be called AFTER _lock is released."""
    sim = minimal_running

    broadcast_saw_lock_free = threading.Event()
    broadcast_saw_lock_held = threading.Event()

    original_bc = ev_mod.EventTracer._broadcast.__func__  # staticmethod

    def checking_broadcast(event):
        # If _lock is reentrant and we are the holder, acquire(False) succeeds.
        # We want to know whether the *outer* call released _lock before calling
        # this.  Since _lock is an RLock, the test checks it from a side thread.
        result_box = []

        def probe():
            # Try to acquire with zero timeout; succeeds only if nobody (or this
            # thread itself via RLock reentry) holds it.  We are a fresh thread,
            # so success means truly free.
            ok = sim._lock.acquire(blocking=True, timeout=0.05)
            result_box.append(ok)
            if ok:
                sim._lock.release()

        t = threading.Thread(target=probe, daemon=True)
        t.start()
        t.join(timeout=2.0)
        if result_box and result_box[0]:
            broadcast_saw_lock_free.set()
        else:
            broadcast_saw_lock_held.set()
        return original_bc(ev_mod.EventTracer, event)  # noqa: SLF001

    monkeypatch.setattr(
        ev_mod.EventTracer, "_broadcast", staticmethod(checking_broadcast)
    )

    patch = [{"op": "add_network", "name": "lanH9c", "address": "172.16.12.0/24"}]
    sim.edit(patch)

    assert broadcast_saw_lock_free.is_set(), (
        "EventTracer._broadcast was called while _lock was still held"
    )
    assert not broadcast_saw_lock_held.is_set()


# ---------------------------------------------------------------------------
# H9b: load_from_session() must take _edit_lock THEN _lock
# ---------------------------------------------------------------------------
# Strategy: hold _edit_lock from a background thread, then attempt
# load_from_session() from the main thread and assert it BLOCKS until the
# background releases the lock.  This is entirely deterministic via Events.
# ---------------------------------------------------------------------------


def test_load_from_session_serializes_under_edit_lock(minimal_src, monkeypatch):
    """load_from_session() must not proceed while _edit_lock is held by an editor."""
    sim = SimState(minimal_src)

    edit_lock_held = threading.Event()   # background: has acquired _edit_lock
    edit_lock_release = threading.Event()  # main: tells background to release
    load_unblocked = threading.Event()   # main: load_from_session returned

    def hold_edit_lock():
        with sim._edit_lock:
            edit_lock_held.set()
            edit_lock_release.wait()   # hold until told to release

    t_holder = threading.Thread(target=hold_edit_lock, daemon=True)
    t_holder.start()

    edit_lock_held.wait()  # background now holds _edit_lock

    load_returned_before_release = threading.Event()

    def do_load():
        sim.load_from_session()
        load_unblocked.set()

    t_load = threading.Thread(target=do_load, daemon=True)
    t_load.start()

    # Give t_load 0.3 s — it should NOT complete because _edit_lock is held.
    t_load.join(timeout=0.3)
    early = not t_load.is_alive()
    if early:
        load_returned_before_release.set()

    # Release the editor lock — load_from_session must now proceed.
    edit_lock_release.set()
    t_holder.join(timeout=2.0)
    t_load.join(timeout=5.0)

    assert not load_returned_before_release.is_set(), (
        "load_from_session() returned while _edit_lock was held by an editor (H9b) "
        "— it does not take _edit_lock"
    )
    assert load_unblocked.is_set(), (
        "load_from_session() never completed after _edit_lock was released"
    )


# ---------------------------------------------------------------------------
# H11: stop() must NOT hold _lock across internet.stop() joins
# ---------------------------------------------------------------------------
# Strategy: monkeypatch the internet's stop() (or a router's stop) so it
# blocks on an Event.  Run SimState.stop() in a background thread.  From
# the main thread, assert _lock is acquirable BEFORE unblocking the join
# (i.e. stop() released _lock before calling internet.stop()).
# Also assert _edit_lock IS held during that window (H3 invariant preserved).
# Then release the Event and assert final state == "idle".
# ---------------------------------------------------------------------------


def test_stop_releases_lock_before_internet_stop(sample_running, monkeypatch):
    """stop() must release _lock before blocking on internet.stop()."""
    sim = sample_running
    internet = sim._internet  # grab before stop() nulls it

    join_started = threading.Event()   # internet.stop() entered
    allow_join = threading.Event()     # let internet.stop() return

    original_internet_stop = internet.stop

    def blocking_internet_stop():
        join_started.set()
        allow_join.wait()
        original_internet_stop()

    monkeypatch.setattr(internet, "stop", blocking_internet_stop)

    stop_done = threading.Event()

    def run_stop():
        sim.stop()
        stop_done.set()

    t_stop = threading.Thread(target=run_stop, daemon=True)
    t_stop.start()

    # Wait until internet.stop() has been called (state is flipped, _lock released)
    joined = join_started.wait(timeout=5.0)
    assert joined, "internet.stop() was never called — stop() may have hung"

    # At this point stop() is INSIDE internet.stop(), holding _edit_lock.
    # _lock must be FREE so GET /topology won't stall.
    lock_acquired = sim._lock.acquire(blocking=True, timeout=0.5)
    try:
        assert lock_acquired, (
            "_lock is still held during internet.stop() — "
            "GET /topology would stall (H11)"
        )
    finally:
        if lock_acquired:
            sim._lock.release()

    # _edit_lock must be HELD (serializes concurrent load/edit — H3 invariant).
    edit_lock_free = sim._edit_lock.acquire(blocking=False)
    try:
        assert not edit_lock_free, (
            "_edit_lock was NOT held during internet.stop() — a concurrent "
            "load could swap the EventTracer while old threads run (H11/H3)"
        )
    finally:
        if edit_lock_free:
            sim._edit_lock.release()

    # Release the blocking join and let stop() finish.
    allow_join.set()
    t_stop.join(timeout=15.0)
    assert not t_stop.is_alive(), "stop() thread did not finish"

    assert sim.state == "idle", f"state should be idle after stop(), got {sim.state!r}"
    assert stop_done.is_set()


def test_stop_state_visible_without_lock(sample_running, monkeypatch):
    """After _lock is released by stop(), state must already be 'idle'.

    This verifies that the state flip happens INSIDE _lock, not after it,
    so readers that poll `sim.state` see a consistent 'idle' even before
    the slow internet.stop() joins finish.
    """
    sim = sample_running
    internet = sim._internet

    join_started = threading.Event()
    allow_join = threading.Event()

    original_stop = internet.stop

    def blocking_stop():
        join_started.set()
        allow_join.wait()
        original_stop()

    monkeypatch.setattr(internet, "stop", blocking_stop)

    t_stop = threading.Thread(target=sim.stop, daemon=True)
    t_stop.start()

    join_started.wait(timeout=5.0)

    # _lock is free; read state without the lock (as a non-critical reader).
    state_during_join = sim.state
    as_during_join = sim._as
    internet_during_join = sim._internet

    allow_join.set()
    t_stop.join(timeout=15.0)

    assert state_during_join == "idle", (
        f"state was {state_during_join!r} during internet.stop() joins — "
        "should be 'idle' already (state flip must happen before join)"
    )
    assert as_during_join is None, "_as should be None before the join completes"
    assert internet_during_join is None, "_internet should be None before the join"
