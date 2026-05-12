# UI Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `web/index.html` from a topology designer into a live simulator UI: a FastAPI server runs the Python simulator engine, the SPA observes live packets and runs per-node terminal commands, and the user can start/pause/resume/stop the simulation, editing topology while paused.

**Architecture:** A singleton `AS` lives inside a FastAPI process. REST endpoints drive the lifecycle and command dispatch; a single WebSocket fans out packet/state events to the SPA. Worker threads in the simulator block on a `PauseGate` for pause/resume. A session-file model keeps the source YAML read-only — all mutations land in `<source>.session.yaml`.

**Tech Stack:** Python 3.11+, FastAPI + uvicorn, WebSockets, PyYAML, pytest. Frontend: vanilla JS/SVG/CSS in a single `web/index.html` (existing). No JS framework.

**Companion spec:** `docs/superpowers/specs/2026-05-12-ui-improvements-design.md` — the design doc this plan implements. Reference it for design rationale.

---

## File Structure

### New files (Phase 1)
- `src/entities/clock.py` — `PauseGate`
- `test/test_pause_gate.py`
- `test/test_event_subscribers.py`
- `test/test_ping.py`
- `test/test_shell_commands.py`

### Modified files (Phase 1)
- `src/entities/__init__.py` — export new types
- `src/entities/packet.py` — add `PingRequest`, `PingReply`
- `src/entities/host.py` — add `ping()`, handle ping messages
- `src/entities/router.py` — accept gate, ignore ping messages
- `src/entities/device.py` — pass `packet` to `_handle_message`
- `src/entities/interface.py` — accept gate, broadcast egress events
- `src/entities/network.py` — accept gate
- `src/entities/system.py` — own `PauseGate`, expose `gate()`
- `src/entities/event.py` — class-level subscribers
- `src/routing/protocol.py` — gate keepalive, broadcast `routing_table_changed`
- `src/parser/parser.py` — pass AS gate when building entities
- `src/shell/shell.py` — `do_ifconfig`, `do_neighbors`, `do_ping`
- `CLAUDE.md` — document new shell commands and PauseGate

### New files (Phase 2)
- `src/server/__init__.py`, `__main__.py`, `app.py`, `state.py`, `events.py`, `persistence.py`
- `src/server/routes/__init__.py`, `sim.py`, `topology.py`, `devices.py`, `ws.py`
- `src/server/command/__init__.py`, `dispatch.py`, `host.py`, `router.py`
- `test/test_server_lifecycle.py`, `test_server_commands.py`, `test_server_events.py`, `test_topology_patch.py`

### Modified files (Phase 2)
- `src/netrouting.py` — web by default, `shell` subcommand for legacy
- `requirements.txt` — `fastapi`, `uvicorn[standard]`
- `.gitignore` — `*.session.yaml`
- `README.md`, `CLAUDE.md` — web-first docs

### Modified files (Phases 3–6)
- `web/index.html` — RuntimeClient, toolbar, lock, WS, YAML alignment (3); packet overlay (4); per-node terminal (5); inspector live + reset (6)

---

# Phase 1 — Simulator additions (PauseGate, event broadcast, ping, new shell commands)

## Task 1: PauseGate primitive

**Files:**
- Create: `src/entities/clock.py`
- Create: `test/test_pause_gate.py`

- [ ] **Step 1: Write failing tests**

```python
# test/test_pause_gate.py
import threading
import time
import pytest
from entities.clock import PauseGate


def test_gate_starts_running():
    gate = PauseGate()
    running, stopped = gate.wait_or_stop(timeout=0.05)
    assert running is True
    assert stopped is False


def test_pause_blocks_until_resume():
    gate = PauseGate()
    gate.pause()

    result = []
    def worker():
        result.append(gate.wait_or_stop(timeout=1.0))
    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.05)
    assert not result          # still blocked
    gate.resume()
    t.join(timeout=0.5)
    assert result == [(True, False)]


def test_stop_wakes_paused_gate():
    gate = PauseGate()
    gate.pause()

    result = []
    def worker():
        result.append(gate.wait_or_stop())
    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.05)
    gate.stop()
    t.join(timeout=0.2)
    assert result == [(False, True)]


def test_pause_resume_idempotent():
    gate = PauseGate()
    gate.pause(); gate.pause()
    gate.resume(); gate.resume()
    running, stopped = gate.wait_or_stop(timeout=0.05)
    assert (running, stopped) == (True, False)


def test_multiple_workers_all_unblock_on_resume():
    gate = PauseGate()
    gate.pause()
    started = threading.Barrier(11)
    results = []
    lock = threading.Lock()

    def worker():
        started.wait()
        r = gate.wait_or_stop(timeout=1.0)
        with lock:
            results.append(r)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(10)]
    for t in threads: t.start()
    started.wait()
    time.sleep(0.05)
    assert results == []
    gate.resume()
    for t in threads: t.join(timeout=0.5)
    assert len(results) == 10
    assert all(r == (True, False) for r in results)


def test_wait_or_stop_timeout_returns_false_when_paused():
    gate = PauseGate()
    gate.pause()
    running, stopped = gate.wait_or_stop(timeout=0.05)
    assert (running, stopped) == (False, False)
```

- [ ] **Step 2: Run test, verify failure**

Run: `pytest test/test_pause_gate.py -v`
Expected: ImportError / ModuleNotFoundError (`entities.clock` missing).

- [ ] **Step 3: Implement PauseGate**

```python
# src/entities/clock.py
import threading


class PauseGate:
    """A two-state gate worker threads block on each loop iteration.

    Carries an internal running-event and stopped-event so callers can
    distinguish "resume" from "stop" without polling separately.
    """

    def __init__(self):
        self._running = threading.Event()
        self._running.set()
        self._stopped = threading.Event()

    def pause(self) -> None:
        self._running.clear()

    def resume(self) -> None:
        self._running.set()

    def stop(self) -> None:
        self._stopped.set()
        self._running.set()  # release any blocked waiters

    def is_running(self) -> bool:
        return self._running.is_set() and not self._stopped.is_set()

    def is_paused(self) -> bool:
        return not self._running.is_set() and not self._stopped.is_set()

    def wait_or_stop(self, timeout: float | None = None) -> tuple[bool, bool]:
        """Block until running, stopped, or timeout. Returns (running, stopped).

        - (True,  False): we are running — proceed.
        - (False, True ): stop was signalled — exit the loop.
        - (False, False): timeout expired while paused — caller may poll.
        """
        woken = self._running.wait(timeout=timeout)
        if self._stopped.is_set():
            return (False, True)
        return (woken, False)
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pytest test/test_pause_gate.py -v`
Expected: all 6 tests pass.

- [ ] **Step 5: Lint and commit**

```bash
ruff check src/entities/clock.py test/test_pause_gate.py
git add src/entities/clock.py test/test_pause_gate.py
git commit -m "feat(entities): add PauseGate primitive for pause/resume/stop"
```

---

## Task 2: Plumb PauseGate into AS

**Files:**
- Modify: `src/entities/system.py`
- Modify: `src/entities/__init__.py`

- [ ] **Step 1: Update tests to construct AS with a gate (sanity test inline)**

Edit `test/test_pause_gate.py`, append:

```python
def test_as_owns_a_gate():
    from entities import AS
    system = AS("demo")
    gate = system.gate()
    assert gate.is_running()

def test_as_stop_releases_workers():
    from entities import AS
    system = AS("demo")
    gate = system.gate()
    gate.pause()
    system.stop()
    # workers waiting on the gate should now wake with stopped=True
    running, stopped = gate.wait_or_stop(timeout=0.1)
    assert (running, stopped) == (False, True)
```

- [ ] **Step 2: Run, verify failure**

Run: `pytest test/test_pause_gate.py -v -k "as_"`
Expected: `AttributeError: 'AS' object has no attribute 'gate'`.

- [ ] **Step 3: Implement**

Edit `src/entities/system.py`:

```python
from .base import Entity
from .clock import PauseGate
from .exception import HostNotFoundException, RouterNotFoundException, NetworkNotFoundException
from .host import Host
from .device import NetworkDevice
from .router import Router


class AS(Entity):

    def __init__(self, name):
        super().__init__(name)
        self._networks = dict()
        self._routers = dict()
        self._hosts = dict()
        self._gate = PauseGate()

    def gate(self) -> PauseGate:
        return self._gate

    # ... (existing methods unchanged) ...

    def stop(self):
        self._gate.stop()
        for network in self._networks.values():
            network.stop()
        for router in self._routers.values():
            router.stop()
```

Add `PauseGate` to `src/entities/__init__.py`:

```python
from .clock import PauseGate  # noqa: F401
```

(Plus existing exports.)

- [ ] **Step 4: Run all tests**

Run: `pytest -v`
Expected: all tests pass (new AS tests included).

- [ ] **Step 5: Commit**

```bash
git add src/entities/system.py src/entities/__init__.py test/test_pause_gate.py
git commit -m "feat(entities): AS owns a PauseGate; stop() releases blocked workers"
```

---

## Task 3: Wire PauseGate into Interface and Network

**Files:**
- Modify: `src/entities/interface.py`
- Modify: `src/entities/network.py`
- Modify: `src/entities/host.py`, `src/entities/router.py` (constructor changes)
- Modify: `src/parser/parser.py` (pass gate)
- Modify: `test/test_pause_gate.py` (integration test)

- [ ] **Step 1: Write integration tests**

Append to `test/test_pause_gate.py`:

```python
def test_paused_interface_does_not_dispatch():
    from entities import AS, Network, Host, NetworkAddress, Address
    from parser import Parser
    import os, tempfile, textwrap

    yaml = textwrap.dedent("""
    as:
      name: t
      networks:
        lan1: "10.0.0.0/24"
      hosts:
        h1: {network: lan1, address: "10.0.0.1"}
        h2: {network: lan1, address: "10.0.0.2"}
    """)
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml); path = f.name
    try:
        system = Parser(path).parse()
        system.gate().pause()

        h1 = system.host("h1"); h2 = system.host("h2")
        from entities import UserMessage
        msg = UserMessage("hi")
        h1.send_message_to(msg, h2.address())

        time.sleep(0.1)
        # The frame is enqueued but the network's _pkt_loop is gated.
        # We expect h2 NOT to have received it yet.
        # Sanity: the network's in_queue should still contain a pending item.
        assert h2.network()._in_queue.qsize() > 0, "expected packet to be queued, not dispatched"
    finally:
        system.stop()
        os.unlink(path)
```

(The exact assertion is implementation-detail-leaky; acceptable for an integration test guarding regression.)

- [ ] **Step 2: Run, verify failure**

Run: `pytest test/test_pause_gate.py::test_paused_interface_does_not_dispatch -v`
Expected: assertion fails because Interface and Network don't yet check the gate.

- [ ] **Step 3: Add gate parameter and check to Interface/Network**

Edit `src/entities/interface.py`:

```python
class Interface(Entity):

    def __init__(self, name, network, address, cost=0, gate=None):
        super().__init__(name)
        self._net = network
        self._address = address
        self._cost = cost
        self._device = None
        self._gate = gate                        # PauseGate or None

        self._in_queue = queue.Queue()
        self._out_queue = None

        self._stopped = False
        self._pkt_thread = threading.Thread(target=self._pkt_loop, daemon=True)
        self._pkt_thread.start()

    # ... existing methods unchanged ...

    def _pkt_loop(self):
        while not self._stopped:
            frame = self._in_queue.get()
            if frame is None:
                self._stopped = True
                continue
            if self._gate is not None:
                running, stopped = self._gate.wait_or_stop()
                if stopped:
                    self._stopped = True
                    continue
            try:
                if self._device is None:
                    raise Exception('interface not ready')
                self._device.handle_packet(frame.payload(), self)
            except Exception:
                traceback.print_exc()
```

Edit `src/entities/network.py`:

```python
class Network(Entity):

    def __init__(self, name, address, gate=None):
        super().__init__(name)
        self._address = address
        self._interfaces = dict()
        self._in_queue = queue.Queue()
        self._gate = gate

        self._stopped = False
        self._pkt_thread = threading.Thread(target=self._pkt_loop, daemon=True)
        self._pkt_thread.start()

    # ... existing methods unchanged ...

    def _pkt_loop(self):
        while not self._stopped:
            packet = self._in_queue.get()
            if packet is None:
                self._stopped = True
                continue
            if self._gate is not None:
                running, stopped = self._gate.wait_or_stop()
                if stopped:
                    self._stopped = True
                    continue
            try:
                self._dispatch_packet(packet)
            except Exception:
                traceback.print_exc()
```

Edit `src/entities/host.py` to forward gate to its Interface:

```python
class Host(NetworkDevice):

    def __init__(self, name, net, address, gw_address=None, gate=None):
        super().__init__(name)

        iface_name = f'iface_{name}'
        self._interface = Interface(iface_name, net, address, gate=gate)
        self.add_interface(self._interface)

        self._gw_address = gw_address
        self._gate = gate
```

Edit `src/parser/parser.py` to pass `system.gate()` everywhere:

```python
# in _parse_networks:
net = Network(name, address, gate=system.gate())

# in _parse_routers, when building Interfaces:
iface = Interface(iface_name, net, address, cost, gate=system.gate())

# in _parse_hosts:
host = Host(name, net, address, gw_address, gate=system.gate())
```

- [ ] **Step 4: Run all tests**

Run: `pytest -v`
Expected: all 67+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/entities/interface.py src/entities/network.py src/entities/host.py src/parser/parser.py test/test_pause_gate.py
git commit -m "feat(entities): gate Interface and Network packet loops on the AS PauseGate"
```

---

## Task 4: Gate the keepalive loop

**Files:**
- Modify: `src/entities/router.py` (receive AS gate via add_router)
- Modify: `src/entities/system.py` (set router gate on add)
- Modify: `src/routing/protocol.py`
- Modify: `test/test_pause_gate.py`

- [ ] **Step 1: Failing test for paused keepalive**

Append to `test/test_pause_gate.py`:

```python
def test_paused_keepalive_does_not_tick():
    from entities import AS, Network, Router, Interface, NetworkAddress, Address
    system = AS("t")
    net = Network("lan1", NetworkAddress("10.0.0.0/24"), gate=system.gate())
    system.add_network(net)
    r1 = Router("r1")
    iface = Interface("eth0", net, Address("10.0.0.1"), cost=1, gate=system.gate())
    net.add_interface(iface)
    r1.add_interface(iface)
    system.add_router(r1)
    r1.start()

    system.gate().pause()
    # Subscribe a counter to EventTracer broadcast (introduced in Task 5).
    # For this test, instead poll: routing flood floods every 10s; we only need
    # to see < 1 second worth of no activity.
    import time
    initial_q = net._in_queue.qsize()
    time.sleep(0.2)
    # No keepalive ticks should occur while paused.
    assert net._in_queue.qsize() == initial_q
    system.stop()
```

- [ ] **Step 2: Run, verify failure**

Run: `pytest test/test_pause_gate.py::test_paused_keepalive_does_not_tick -v`
Expected: fails — keepalive thread still ticks.

- [ ] **Step 3: Implement**

Edit `src/entities/system.py`:

```python
def add_router(self, router):
    router._as_gate = self._gate
    self._routers[router.name()] = router
```

Edit `src/entities/router.py` to expose the gate:

```python
class Router(NetworkDevice):

    def __init__(self, name):
        super().__init__(name)
        self._routing_table = RoutingTable()
        self._protocol = RoutingProtocol(self)
        self._as_gate = None  # set by AS.add_router

    def gate(self):
        return self._as_gate
```

Edit `src/routing/protocol.py`:

```python
def _keepalive_loop(self):
    gate = self._router.gate()
    while not self._stopped:
        if gate is not None:
            running, stopped = gate.wait_or_stop(timeout=self.KEEPALIVE_INTERVAL)
            if stopped:
                break
            if not running:
                continue          # paused; loop again
        else:
            time.sleep(self.KEEPALIVE_INTERVAL)
        try:
            self._handle_update()
        except Exception:
            traceback.print_exc()
```

(Note: the gate-aware path uses `wait_or_stop(timeout=KEEPALIVE_INTERVAL)`. When running, this returns `(True, False)` after the timeout, just like `sleep`. When paused, it blocks until resumed or stopped. When stopped, the loop exits within microseconds.)

- [ ] **Step 4: Run tests**

Run: `pytest -v`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/entities/system.py src/entities/router.py src/routing/protocol.py test/test_pause_gate.py
git commit -m "feat(routing): gate the keepalive loop on the AS PauseGate"
```

---

## Task 5: EventTracer class-level subscribers

**Files:**
- Modify: `src/entities/event.py`
- Create: `test/test_event_subscribers.py`

- [ ] **Step 1: Failing tests**

```python
# test/test_event_subscribers.py
import threading
from entities.event import EventTracer


def setup_function():
    # reset between tests
    EventTracer._subscribers = []


def test_subscribe_returns_unsubscribe():
    events = []
    unsub = EventTracer.subscribe(events.append)
    EventTracer._broadcast({"kind": "x"})
    assert events == [{"kind": "x"}]
    unsub()
    EventTracer._broadcast({"kind": "y"})
    assert events == [{"kind": "x"}]


def test_multiple_subscribers_receive_in_order():
    a, b = [], []
    EventTracer.subscribe(a.append)
    EventTracer.subscribe(b.append)
    EventTracer._broadcast({"kind": "e1"})
    EventTracer._broadcast({"kind": "e2"})
    assert a == b == [{"kind": "e1"}, {"kind": "e2"}]


def test_subscriber_exception_does_not_break_others():
    a, b = [], []
    def boom(_evt): raise RuntimeError("oops")
    EventTracer.subscribe(boom)
    EventTracer.subscribe(a.append)
    EventTracer.subscribe(b.append)
    EventTracer._broadcast({"kind": "e1"})
    assert a == b == [{"kind": "e1"}]


def test_unsubscribe_during_broadcast_is_safe():
    log = []
    handles = []

    def killer(evt):
        log.append("k")
        handles[0]()  # unsubscribe the next subscriber mid-broadcast

    def follower(evt):
        log.append("f")

    EventTracer.subscribe(killer)
    handles.append(EventTracer.subscribe(follower))
    EventTracer._broadcast({"kind": "e1"})
    # snapshot iteration: follower still fires this round
    assert log == ["k", "f"]
    # but is gone next round
    log.clear()
    EventTracer._broadcast({"kind": "e2"})
    assert log == ["k"]
```

- [ ] **Step 2: Run, verify failure**

Run: `pytest test/test_event_subscribers.py -v`
Expected: AttributeError on `_subscribers`, `subscribe`, `_broadcast`.

- [ ] **Step 3: Implement**

Edit `src/entities/event.py`, add to the `EventTracer` class:

```python
import logging
_logger = logging.getLogger(__name__)


class EventTracer:

    _events = dict()
    _lock = Lock()

    _subscribers: list = []        # class-level
    _sub_lock = Lock()

    @classmethod
    def subscribe(cls, fn):
        with cls._sub_lock:
            cls._subscribers.append(fn)
        def unsubscribe():
            with cls._sub_lock:
                try:
                    cls._subscribers.remove(fn)
                except ValueError:
                    pass
        return unsubscribe

    @classmethod
    def _broadcast(cls, event: dict) -> None:
        # Snapshot the list under the lock so unsubscribe during iteration is safe.
        with cls._sub_lock:
            snapshot = list(cls._subscribers)
        for fn in snapshot:
            try:
                fn(event)
            except Exception:
                _logger.exception("subscriber raised in EventTracer._broadcast")

    # ... existing classmethods unchanged ...
```

- [ ] **Step 4: Run, verify pass**

Run: `pytest test/test_event_subscribers.py -v`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/entities/event.py test/test_event_subscribers.py
git commit -m "feat(event): add class-level subscribers to EventTracer"
```

---

## Task 6: Egress hook + routing_table_changed broadcast

**Files:**
- Modify: `src/entities/interface.py` (broadcast on egress)
- Modify: `src/routing/protocol.py` (broadcast on table change)
- Modify: `test/test_event_subscribers.py` (integration test)

- [ ] **Step 1: Failing tests**

Append to `test/test_event_subscribers.py`:

```python
def test_egress_broadcast_fires_for_user_datagram():
    import textwrap, tempfile, os, time
    from entities.event import EventTracer
    from parser import Parser
    from entities import UserMessage

    yaml_text = textwrap.dedent("""
    as:
      name: t
      networks:
        lan1: "10.0.0.0/24"
      hosts:
        h1: {network: lan1, address: "10.0.0.1"}
        h2: {network: lan1, address: "10.0.0.2"}
    """)
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml_text); path = f.name
    try:
        events = []
        EventTracer._subscribers = []
        EventTracer.subscribe(events.append)

        system = Parser(path).parse()
        h1, h2 = system.host("h1"), system.host("h2")
        h1.send_message_to(UserMessage("hi"), h2.address())
        time.sleep(0.2)
        kinds = [(e.get("kind"), e.get("type")) for e in events]
        assert ("packet", "user_datagram") in kinds
        system.stop()
    finally:
        os.unlink(path)


def test_routing_table_changed_event_fires():
    import textwrap, tempfile, os, time
    from entities.event import EventTracer
    from parser import Parser

    yaml_text = textwrap.dedent("""
    as:
      name: t
      networks:
        lan1: "10.0.0.0/24"
        lan2: "10.0.1.0/24"
      routers:
        r1: {interfaces: {eth0: {network: lan1, address: "10.0.0.1", cost: 5},
                          eth1: {network: lan2, address: "10.0.1.1", cost: 5}}}
    """)
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml_text); path = f.name
    try:
        events = []
        EventTracer._subscribers = []
        EventTracer.subscribe(events.append)

        system = Parser(path).parse()
        # First keepalive within ~KEEPALIVE_INTERVAL; for a test, manually update.
        system.router("r1").update_interface("eth0", 99)
        # nudge protocol to recompute by faking a keepalive call:
        system.router("r1")._protocol._handle_update()
        kinds = [e.get("kind") for e in events]
        assert "routing_table_changed" in kinds
        system.stop()
    finally:
        os.unlink(path)
```

- [ ] **Step 2: Run, verify failure**

Run: `pytest test/test_event_subscribers.py -v -k "egress or routing_table"`
Expected: fails — no broadcasts yet.

- [ ] **Step 3: Implement**

Edit `src/entities/interface.py`, after `_out_queue.put(frame)`:

```python
from .packet import RoutingMessage, UserMessage  # add top imports as needed

_PACKET_KIND = {
    'RoutingMessage':  'routing_flood',
    'UserMessage':     'user_datagram',
    'PingRequest':     'ping_request',
    'PingReply':       'ping_reply',
}

def _classify(payload) -> str:
    return _PACKET_KIND.get(type(payload).__name__, 'unknown')


# In send_to:
def send_to(self, datagram: Datagram, dst_addr: Address):
    from .event import EventTracer
    frame = Frame(src_addr=self._address, dst_addr=dst_addr, payload=datagram)
    self._out_queue.put(frame)
    EventTracer._broadcast({
        "kind": "packet",
        "type": _classify(datagram.payload()),
        "src": {"device": self._device.name() if self._device else None,
                "iface": self._name,
                "address": str(self._address)},
        "dst": {"address": str(dst_addr)},
        "network": self._net.name(),
    })
```

Edit `src/routing/protocol.py`, at the end of `_recompute_if_dirty` (after the for-loops build rules):

```python
def _recompute_if_dirty(self, changed: bool):
    from entities.address import NullAddress
    from entities.event import EventTracer

    if not changed:
        return

    routing_table = self._router.routing_table()
    routing_table.clear()
    paths = self._graph.shortest_paths(self._router)
    for prefix in self._graph.networks():
        # ... existing logic ...
        pass

    # Broadcast the table change
    EventTracer._broadcast({
        "kind": "routing_table_changed",
        "device": self._router.name(),
        "rules": [
            {"prefix": str(r.prefix()),
             "next_hop": str(r.next_hop()),
             "iface": r.interface().name()}
            for r in routing_table.rules()
        ],
    })
```

- [ ] **Step 4: Run all tests**

Run: `pytest -v`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/entities/interface.py src/routing/protocol.py test/test_event_subscribers.py
git commit -m "feat(event): broadcast packet egress and routing_table_changed events"
```

---

## Task 7: Add `packet` parameter to `_handle_message`

**Files:**
- Modify: `src/entities/device.py`
- Modify: `src/entities/host.py`
- Modify: `src/entities/router.py`
- (existing tests should still pass)

- [ ] **Step 1: Modify signatures**

Edit `src/entities/device.py`:

```python
def handle_packet(self, packet, interface):
    dst = packet.destination()
    net_broadcast_addr = interface.network().broadcast_address()
    if dst == interface.address() or dst == net_broadcast_addr:
        self._handle_message(packet.payload(), interface, packet)
    else:
        self._handle_forwarding(packet)

def _handle_message(self, msg, interface, packet):
    raise NotImplementedError
```

Edit `src/entities/host.py`:

```python
def _handle_message(self, msg, interface, packet):
    if msg.type() == UserMessage:
        return EventTracer.message_received(src=self.address(), msg=msg)
```

Edit `src/entities/router.py`:

```python
def _handle_message(self, msg, interface, packet):
    if msg.type() == RoutingMessage:
        self._handle_routing_message(msg, interface)
```

- [ ] **Step 2: Run full suite**

Run: `pytest -v`
Expected: all existing tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/entities/device.py src/entities/host.py src/entities/router.py
git commit -m "refactor(entities): pass packet to _handle_message for source lookup"
```

---

## Task 8: PingRequest / PingReply types and Host.ping()

**Files:**
- Modify: `src/entities/packet.py`
- Modify: `src/entities/host.py`
- Modify: `src/entities/router.py`
- Modify: `src/entities/__init__.py`
- Create: `test/test_ping.py`

- [ ] **Step 1: Failing tests**

```python
# test/test_ping.py
import textwrap, tempfile, os, time, threading
import pytest
from parser import Parser


def _make_topology(yaml_text):
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml_text); return f.name


TWO_HOSTS = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.0.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.0.1"}
    h2: {network: lan1, address: "10.0.0.2"}
""")


def test_ping_happy_path():
    path = _make_topology(TWO_HOSTS)
    system = Parser(path).parse()
    try:
        h1, h2 = system.host("h1"), system.host("h2")
        rtt = h1.ping(h2.address(), timeout=1.0)
        assert rtt is not None
        assert rtt < 0.5
    finally:
        system.stop(); os.unlink(path)


def test_ping_unreachable_returns_none():
    path = _make_topology(TWO_HOSTS)
    system = Parser(path).parse()
    try:
        from entities import Address
        h1 = system.host("h1")
        bogus = Address("192.168.99.99")
        t0 = time.monotonic()
        rtt = h1.ping(bogus, timeout=0.3)
        elapsed = time.monotonic() - t0
        assert rtt is None
        assert 0.3 <= elapsed < 0.7
    finally:
        system.stop(); os.unlink(path)


def test_concurrent_pings_independent():
    path = _make_topology(TWO_HOSTS)
    system = Parser(path).parse()
    try:
        h1, h2 = system.host("h1"), system.host("h2")
        results = [None] * 5
        threads = []
        def go(i):
            results[i] = h1.ping(h2.address(), timeout=1.0)
        for i in range(5):
            t = threading.Thread(target=go, args=(i,), daemon=True)
            threads.append(t); t.start()
        for t in threads: t.join(timeout=2.0)
        assert all(r is not None for r in results)
    finally:
        system.stop(); os.unlink(path)


def test_no_thread_leak_after_pings():
    path = _make_topology(TWO_HOSTS)
    before = {t.ident for t in threading.enumerate()}
    system = Parser(path).parse()
    try:
        h1, h2 = system.host("h1"), system.host("h2")
        for _ in range(10):
            h1.ping(h2.address(), timeout=0.5)
    finally:
        system.stop(); os.unlink(path)
    time.sleep(0.2)
    after = {t.ident for t in threading.enumerate()}
    # only daemon threads from parser may remain; ping itself must not leak threads
    assert len(after - before) <= 0, f"thread leak: {after - before}"
```

- [ ] **Step 2: Run, verify failures**

Run: `pytest test/test_ping.py -v`
Expected: `AttributeError: 'Host' object has no attribute 'ping'`.

- [ ] **Step 3: Implement packets**

Edit `src/entities/packet.py`, append:

```python
import time as _time


class PingRequest(Message):
    def __init__(self, seq: int):
        super().__init__()
        self._seq = seq
        self._sent_at = _time.monotonic()

    @property
    def seq(self) -> int: return self._seq

    @property
    def sent_at(self) -> float: return self._sent_at


class PingReply(Message):
    def __init__(self, seq: int, request_ts: float):
        super().__init__()
        self._seq = seq
        self._request_ts = request_ts

    @property
    def seq(self) -> int: return self._seq

    @property
    def request_ts(self) -> float: return self._request_ts
```

- [ ] **Step 4: Implement Host.ping and handler updates**

Edit `src/entities/host.py`:

```python
import itertools
import threading
import time

from .device import NetworkDevice
from .interface import Interface
from .packet import Datagram, PingReply, PingRequest, UserMessage
from .event import EventTracer
from .address import Address


PING_TIMEOUT_S = 3.0


class Host(NetworkDevice):

    def __init__(self, name, net, address, gw_address=None, gate=None):
        super().__init__(name)
        iface_name = f'iface_{name}'
        self._interface = Interface(iface_name, net, address, gate=gate)
        self.add_interface(self._interface)
        self._gw_address = gw_address
        self._gate = gate

        self._ping_seq = itertools.count()
        self._ping_lock = threading.Lock()
        self._pending_pings: dict[tuple, threading.Event] = {}
        self._ping_results: dict[tuple, float] = {}

    # ... existing methods unchanged ...

    def ping(self, dst_addr: Address, timeout: float = PING_TIMEOUT_S):
        seq = next(self._ping_seq)
        key = (str(dst_addr), seq)
        evt = threading.Event()
        with self._ping_lock:
            self._pending_pings[key] = evt

        request = PingRequest(seq)
        datagram = Datagram(src_addr=self.address(), dst_addr=dst_addr, payload=request)
        self._interface.send_to(datagram, dst_addr=self._gw_address or dst_addr)

        arrived = evt.wait(timeout=timeout)
        with self._ping_lock:
            self._pending_pings.pop(key, None)
            rtt = self._ping_results.pop(key, None)

        return rtt if arrived else None

    def _handle_message(self, msg, interface, packet):
        if isinstance(msg, PingRequest):
            originator = packet.source()
            reply = PingReply(seq=msg.seq, request_ts=msg.sent_at)
            datagram = Datagram(src_addr=self.address(), dst_addr=originator, payload=reply)
            self._interface.send_to(datagram, dst_addr=self._gw_address or originator)
            return
        if isinstance(msg, PingReply):
            originator = packet.source()
            key = (str(originator), msg.seq)
            with self._ping_lock:
                evt = self._pending_pings.get(key)
                if evt is None:
                    return
                self._ping_results[key] = time.monotonic() - msg.request_ts
                evt.set()
            return
        if msg.type() == UserMessage:
            return EventTracer.message_received(src=self.address(), msg=msg)
```

Edit `src/entities/router.py`:

```python
def _handle_message(self, msg, interface, packet):
    if msg.type() == RoutingMessage:
        self._handle_routing_message(msg, interface)
    # PingRequest/PingReply silently dropped
```

Export from `src/entities/__init__.py`:

```python
from .packet import PingRequest, PingReply  # noqa: F401
```

- [ ] **Step 5: Run tests**

Run: `pytest test/test_ping.py -v && pytest -v`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/entities/packet.py src/entities/host.py src/entities/router.py src/entities/__init__.py test/test_ping.py
git commit -m "feat(entities): add Host.ping with PingRequest/PingReply round-trip"
```

---

## Task 9: New shell commands (ifconfig, neighbors, ping)

**Files:**
- Modify: `src/shell/shell.py`
- Create: `test/test_shell_commands.py`

- [ ] **Step 1: Failing tests**

```python
# test/test_shell_commands.py
import io, contextlib, textwrap, tempfile, os
import pytest
from shell import Shell


SAMPLE = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.0.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.0.1"}
    h2: {network: lan1, address: "10.0.0.2"}
  routers:
    r1: {interfaces: {eth0: {network: lan1, address: "10.0.0.254", cost: 1}}}
""")


@pytest.fixture
def shell():
    sh = Shell()
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE); path = f.name
    sh.do_read(path)
    yield sh
    sh.do_exit("")  # might call sys.exit; if so, catch via try in tests below


def _capture(shell, method, arg):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        method(arg)
    return buf.getvalue()


def test_ifconfig_host(shell):
    out = _capture(shell, shell.do_ifconfig, "h1")
    assert "iface_h1" in out
    assert "10.0.0.1" in out


def test_ifconfig_router(shell):
    out = _capture(shell, shell.do_ifconfig, "r1")
    assert "eth0" in out
    assert "10.0.0.254" in out
    assert "cost=1" in out


def test_neighbors_router(shell):
    out = _capture(shell, shell.do_neighbors, "r1")
    # before convergence, expect either empty list message or just no rows
    assert "r1" not in out  # self not listed


def test_ping_happy(shell):
    out = _capture(shell, shell.do_ping, "h1 h2 -W 1.0")
    assert "h2" in out
    assert "time=" in out or "timeout" in out


def test_ping_unreachable(shell):
    out = _capture(shell, shell.do_ping, "h1 192.168.99.99 -W 0.3")
    assert "timeout" in out.lower() or "unreachable" in out.lower()
```

(The exit cleanup in the fixture may try to `sys.exit(0)` — catch with `pytest.raises(SystemExit)` in tests that explicitly need it. The simpler path: don't call `do_exit` in the fixture; the system threads are daemon and die with the test process.)

Fix the fixture:

```python
@pytest.fixture
def shell():
    sh = Shell()
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE); path = f.name
    sh.do_read(path)
    yield sh
    if sh._system is not None:
        sh._system.stop()
    os.unlink(path)
```

- [ ] **Step 2: Run, verify failures**

Run: `pytest test/test_shell_commands.py -v`
Expected: `AttributeError: 'Shell' object has no attribute 'do_ifconfig'`.

- [ ] **Step 3: Implement commands**

Edit `src/shell/shell.py`. After the existing `do_update_cost`:

```python
@requires_system
def do_ifconfig(self, arg):
    'Mostrar las interfaces del dispositivo dado. Sintaxis: ifconfig <dispositivo>'
    name = arg.strip()
    if not name:
        print('syntax: ifconfig <device>')
        return
    device = self._system.device(name)
    for iname, iface in device.interfaces().items():
        print(f'{iname}: addr={iface.address()} '
              f'net={iface.network().name()} ({iface.network().address()}) '
              f'cost={iface.cost()}')
    # host gateway
    from entities import Host
    if isinstance(device, Host) and device.gateway() is not None:
        print(f'  gateway: {device.gateway()}')


@requires_system
def do_neighbors(self, arg):
    'Listar los routers vecinos. Sintaxis: neighbors <router>'
    name = arg.strip()
    if not name:
        print('syntax: neighbors <router>')
        return
    router = self._system.router(name)
    graph = router._protocol._graph
    # routers in graph that share at least one network with us
    my_nets = {iface.network().address() for iface in router.interfaces().values()}
    seen = set()
    for node in graph.routers():
        if node == router or node.name() in seen:
            continue
        other_nets = {iface.network().address() for iface in node.interfaces().values()}
        shared = my_nets & other_nets
        if not shared:
            continue
        for net_addr in shared:
            for iface in node.interfaces().values():
                if iface.network().address() == net_addr:
                    print(f'  {node.name():<6} via {iface.network().name():<8} '
                          f'({iface.address()})  cost={iface.cost()}')
        seen.add(node.name())
    if not seen:
        print('  no neighbors yet')


@requires_system
def do_ping(self, arg):
    'Hacer ping entre hosts. Sintaxis: ping <origen> <destino> [-W <segundos>]'
    parts = arg.split()
    timeout = 3.0
    # parse -W flag
    if '-W' in parts:
        i = parts.index('-W')
        try:
            timeout = float(parts[i + 1])
        except (IndexError, ValueError):
            print('syntax: ping <src> <dst> [-W <seconds>]')
            return
        parts = parts[:i] + parts[i + 2:]
    if len(parts) != 2:
        print('syntax: ping <src> <dst> [-W <seconds>]')
        return

    src_name, dst = parts
    from entities import Address
    src = self._system.host(src_name)
    # resolve dst: hostname or literal address
    try:
        dst_host = self._system.host(dst)
        dst_addr = dst_host.address()
    except Exception:
        dst_addr = Address(dst)
    rtt = src.ping(dst_addr, timeout=timeout)
    if rtt is None:
        print(f'ping {src_name} -> {dst}: timeout after {timeout:.2f} s')
    else:
        print(f'ping {src_name} -> {dst} ({dst_addr}): time={rtt*1000:.2f} ms')
```

- [ ] **Step 4: Run tests**

Run: `pytest test/test_shell_commands.py -v && pytest -v`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/shell/shell.py test/test_shell_commands.py
git commit -m "feat(shell): add ifconfig, neighbors, ping commands"
```

---

## Task 10: Documentation update (Phase 1)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Add new shell commands to the Shell usage section; add a new entry to "Key Design Decisions & Traps" for the PauseGate.

Edit the Shell usage block:

```
# read samples/sample.yaml
# route r1
# send h1 h2 hello
# update_cost r1 eth0 25
# ifconfig h1
# neighbors r1
# ping h1 h2 -W 1.5
```

Add a new bullet to Key Design Decisions & Traps:

```
- **`PauseGate` gates packet propagation and keepalive.** `AS` owns one `PauseGate` (`src/entities/clock.py`). `Interface._pkt_loop` and `Network._pkt_loop` call `gate.wait_or_stop()` after each dequeue; `RoutingProtocol._keepalive_loop` waits on it instead of `time.sleep`. `AS.stop()` triggers the stop event, which wakes any blocked workers. New worker threads must follow the same pattern or they won't pause cleanly.
```

- [ ] **Step 2: Run lint + tests one more time**

```bash
ruff check src/ test/
pytest -v
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document new shell commands and PauseGate behavior"
```

---

# Phase 2 — FastAPI backend

## Task 11: Dependencies and skeleton

**Files:**
- Modify: `requirements.txt`
- Modify: `.gitignore`
- Create: `src/server/__init__.py`, `src/server/__main__.py`, `src/server/app.py`

- [ ] **Step 1: Update deps**

Edit `requirements.txt`:

```
PyYAML>=6.0
fastapi>=0.111
uvicorn[standard]>=0.30
```

Edit `.gitignore`:

```
.idea
*.pyc
*.pyo
*.session.yaml
```

Install: `pip install -r requirements.txt`

- [ ] **Step 2: Create empty server skeleton**

```python
# src/server/__init__.py
from .app import create_app  # noqa: F401


def run(host: str = "127.0.0.1", port: int = 8000) -> None:
    import uvicorn
    uvicorn.run(create_app(), host=host, port=port, log_level="info")
```

```python
# src/server/__main__.py
from . import run

if __name__ == "__main__":
    run()
```

```python
# src/server/app.py
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pathlib import Path


def create_app() -> FastAPI:
    app = FastAPI(title="netrouting")
    web_dir = Path(__file__).parent.parent.parent / "web"
    if web_dir.exists():
        app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
    return app
```

- [ ] **Step 3: Smoke test by running**

```bash
cd src && python -m server &
sleep 1
curl -s http://127.0.0.1:8000/ | head -3
kill %1
```

Expected: HTML from `web/index.html`.

- [ ] **Step 4: Commit**

```bash
git add requirements.txt .gitignore src/server/
git commit -m "feat(server): scaffold FastAPI app serving the SPA"
```

---

## Task 12: SimState + persistence (session-file model)

**Files:**
- Create: `src/server/persistence.py`, `src/server/state.py`
- Create: `test/test_server_lifecycle.py`

- [ ] **Step 1: Failing tests for persistence + state machine**

```python
# test/test_server_lifecycle.py
import textwrap, tempfile, os
from pathlib import Path
import pytest

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
    from server.state import SimState, InvalidStateTransition
    s = SimState(source_yaml)
    with pytest.raises(InvalidStateTransition):
        s.pause()   # from idle
    s.load_from_session(); s.start()
    with pytest.raises(InvalidStateTransition):
        s.resume()  # from running


def test_start_is_idempotent(source_yaml):
    from server.state import SimState
    s = SimState(source_yaml)
    s.load_from_session()
    s.start()
    s.start()  # no-op
    assert s.state == "running"
```

- [ ] **Step 2: Run, verify failure**

Run: `pytest test/test_server_lifecycle.py -v`
Expected: ModuleNotFoundError.

- [ ] **Step 3: Implement persistence**

```python
# src/server/persistence.py
from pathlib import Path
import os, shutil, tempfile


def session_path_for(source: Path) -> Path:
    return source.with_suffix(source.suffix + ".session")  # foo.yaml -> foo.yaml.session


def prepare_session(source: Path) -> Path:
    """Ensure a session file exists for `source`. Returns the session path."""
    # Use `<source>.session.yaml` naming: foo.yaml -> foo.session.yaml
    target = source.with_name(source.stem + ".session" + source.suffix)
    if not target.exists():
        shutil.copyfile(source, target)
    return target


def reset_session(source: Path) -> Path:
    target = source.with_name(source.stem + ".session" + source.suffix)
    if target.exists():
        target.unlink()
    return prepare_session(source)


def atomic_write(target: Path, content: str) -> None:
    fd, tmp = tempfile.mkstemp(prefix=target.name + ".", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp, target)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise
```

- [ ] **Step 4: Implement SimState**

```python
# src/server/state.py
from __future__ import annotations
import threading
from pathlib import Path
from typing import Optional

from .persistence import prepare_session


class InvalidStateTransition(Exception):
    def __init__(self, from_state, to_state):
        super().__init__(f"invalid transition: {from_state} -> {to_state}")
        self.from_state = from_state
        self.to_state = to_state


class SimState:
    """Singleton-ish wrapper around an AS. Serializes state transitions."""

    def __init__(self, source: Path):
        self._source = Path(source)
        self._session: Optional[Path] = None
        self._as = None
        self._state = "idle"
        self._lock = threading.RLock()

    # ---- accessors ----
    @property
    def state(self) -> str: return self._state

    @property
    def as_obj(self): return self._as

    @property
    def source(self) -> Path: return self._source

    @property
    def session_path(self) -> Path:
        if self._session is None:
            self._session = prepare_session(self._source)
        return self._session

    # ---- transitions ----
    def load_from_session(self):
        """Parse the session file into an AS. AS is constructed but not started."""
        from parser import Parser
        with self._lock:
            if self._as is not None:
                self._as.stop()
            self._as = Parser(str(self.session_path)).parse()
            # Parser.parse() calls router.start() — undo for "idle" semantics.
            for r in self._as.routers().values():
                r.stop()
            self._state = "idle"

    def start(self):
        with self._lock:
            if self._state == "running":
                return
            if self._state != "idle":
                raise InvalidStateTransition(self._state, "running")
            if self._as is None:
                raise InvalidStateTransition("no_topology", "running")
            self._as.gate().resume()  # ensure gate is set
            for r in self._as.routers().values():
                r.start()
            self._state = "running"

    def pause(self):
        with self._lock:
            if self._state != "running":
                raise InvalidStateTransition(self._state, "paused")
            self._as.gate().pause()
            self._state = "paused"

    def resume(self):
        with self._lock:
            if self._state != "paused":
                raise InvalidStateTransition(self._state, "running")
            self._as.gate().resume()
            self._state = "running"

    def stop(self):
        with self._lock:
            if self._state == "idle":
                return
            if self._as is not None:
                self._as.stop()
                self._as = None
            self._state = "idle"
```

**Why we stop router protocols immediately after `Parser.parse()`:** the parser auto-starts each router's keepalive thread. `SimState` needs an "idle" entry state where threads aren't ticking, so we stop them right after parse and let `start()` re-start them. The contract is enforced by `test_sim_state_transitions` (state is `idle` after load).

- [ ] **Step 5: Run tests**

Run: `pytest test/test_server_lifecycle.py -v`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/server/persistence.py src/server/state.py test/test_server_lifecycle.py
git commit -m "feat(server): SimState lifecycle and session-file persistence"
```

---

## Task 13: EventBus

**Files:**
- Create: `src/server/events.py`
- Create: `test/test_server_events.py`

- [ ] **Step 1: Failing tests**

```python
# test/test_server_events.py
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
    q1 = bus.subscribe(); q2 = bus.subscribe()
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
```

Add `pytest-asyncio` to `requirements-dev.txt`:

```
-r requirements.txt
pytest>=8.0
pytest-asyncio>=0.23
ruff>=0.6
```

And to `pyproject.toml` `[tool.pytest.ini_options]`:

```
asyncio_mode = "auto"
```

- [ ] **Step 2: Install + run, verify failures**

```bash
pip install -r requirements-dev.txt
pytest test/test_server_events.py -v
```

Expected: ModuleNotFoundError.

- [ ] **Step 3: Implement EventBus**

```python
# src/server/events.py
from __future__ import annotations
import asyncio
import threading
from typing import Set


class EventBus:
    """Threadsafe fan-out from worker threads to asyncio WS handlers."""

    def __init__(self, loop: asyncio.AbstractEventLoop | None = None, max_queue: int = 1000):
        self._loop = loop
        self._max_queue = max_queue
        self._queues: Set[asyncio.Queue] = set()
        self._lock = threading.Lock()
        self._overflow_count = 0

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue(maxsize=self._max_queue)
        with self._lock:
            self._queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._queues.discard(q)

    def emit(self, event: dict) -> None:
        """Called from any thread. Non-blocking. Drops oldest on overflow."""
        if self._loop is None:
            return
        with self._lock:
            queues = list(self._queues)
        for q in queues:
            self._loop.call_soon_threadsafe(self._enqueue, q, event)

    def _enqueue(self, q: asyncio.Queue, event: dict) -> None:
        if q.full():
            try:
                q.get_nowait()
                self._overflow_count += 1
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            self._overflow_count += 1

    @property
    def overflow_count(self) -> int:
        return self._overflow_count
```

- [ ] **Step 4: Run, verify pass**

Run: `pytest test/test_server_events.py -v`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/server/events.py test/test_server_events.py requirements-dev.txt pyproject.toml
git commit -m "feat(server): EventBus with non-blocking emit and overflow handling"
```

---

## Task 14: REST routes — sim lifecycle and topology

**Files:**
- Create: `src/server/routes/__init__.py`, `routes/sim.py`, `routes/topology.py`
- Modify: `src/server/app.py` (wire routes)
- Modify: `test/test_server_lifecycle.py`

- [ ] **Step 1: Failing tests**

Append to `test/test_server_lifecycle.py`:

```python
def test_topology_endpoint_loads_yaml(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from server.app import create_app
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))

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
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))

    app = create_app()
    with TestClient(app) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        assert c.post("/sim/start").json()["state"] == "running"
        assert c.post("/sim/pause").json()["state"] == "paused"
        assert c.post("/sim/resume").json()["state"] == "running"
        assert c.post("/sim/stop").json()["state"] == "idle"


def test_invalid_yaml_returns_400(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from server.app import create_app
    src = tmp_path / "src.yaml"; src.write_text("not yaml :::")
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        r = c.post("/topology", json={"yaml": "as:\n  rubbish"})
        assert r.status_code == 400
```

- [ ] **Step 2: Run, verify failure**

Run: `pytest test/test_server_lifecycle.py -v -k "endpoint or rest or 400"`
Expected: 404 on every endpoint.

- [ ] **Step 3: Implement routes/sim.py**

```python
# src/server/routes/sim.py
from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/sim", tags=["sim"])


def _state(request: Request):
    return request.app.state.sim_state


@router.post("/start")
def start(request: Request):
    s = _state(request)
    try:
        s.start()
    except Exception as e:
        raise HTTPException(409, str(e))
    return {"state": s.state}


@router.post("/pause")
def pause(request: Request):
    s = _state(request)
    try:
        s.pause()
    except Exception as e:
        raise HTTPException(409, str(e))
    return {"state": s.state}


@router.post("/resume")
def resume(request: Request, body: dict | None = None):
    s = _state(request)
    try:
        s.resume()
        # patch application is Task 15
    except Exception as e:
        raise HTTPException(409, str(e))
    return {"state": s.state}


@router.post("/stop")
def stop(request: Request):
    s = _state(request)
    s.stop()
    return {"state": s.state}


@router.get("/state")
def get_state(request: Request):
    s = _state(request)
    return {"state": s.state,
            "as_name": s.as_obj.name() if s.as_obj else None}
```

- [ ] **Step 4: Implement routes/topology.py**

```python
# src/server/routes/topology.py
from fastapi import APIRouter, HTTPException, Request

from server.persistence import atomic_write, reset_session

router = APIRouter(tags=["topology"])


def _state(request: Request):
    return request.app.state.sim_state


@router.post("/topology")
def load(body: dict, request: Request):
    yaml_text = body.get("yaml", "")
    if not yaml_text:
        raise HTTPException(400, "missing 'yaml'")
    s = _state(request)
    atomic_write(s.session_path, yaml_text)
    try:
        s.load_from_session()
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"ok": True,
            "as_name": s.as_obj.name(),
            "devices": [d for d in (*s.as_obj.hosts(), *s.as_obj.routers())],
            "networks": list(s.as_obj.networks())}


@router.get("/topology")
def fetch(request: Request):
    s = _state(request)
    return {"yaml": s.session_path.read_text()}


@router.post("/topology/reset")
def reset(request: Request):
    s = _state(request)
    if s.state != "idle":
        raise HTTPException(409, "stop the simulation before reset")
    reset_session(s.source)
    s._session = None
    s.load_from_session()
    return {"ok": True, "as_name": s.as_obj.name()}
```

- [ ] **Step 5: Wire routes in app.py**

```python
# src/server/app.py
import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .state import SimState
from .events import EventBus
from .routes import sim as sim_routes
from .routes import topology as topology_routes


def create_app() -> FastAPI:
    app = FastAPI(title="netrouting")

    source = Path(os.environ.get("NETROUTING_TOPOLOGY", "samples/sample.yaml")).resolve()
    app.state.sim_state = SimState(source)
    app.state.event_bus = EventBus()

    app.include_router(sim_routes.router)
    app.include_router(topology_routes.router)

    web_dir = Path(__file__).parent.parent.parent / "web"
    if web_dir.exists():
        app.mount("/web", StaticFiles(directory=str(web_dir), html=True), name="web")
    # Note: SPA served at /web during dev; final mount-at-root in Task 16.
    return app
```

(We mount under `/web` temporarily so the static route doesn't shadow `/topology`. The final mount in Task 16 uses a smarter approach.)

- [ ] **Step 6: Run tests**

Run: `pytest test/test_server_lifecycle.py -v`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/server/app.py src/server/routes/ test/test_server_lifecycle.py
git commit -m "feat(server): /sim/* and /topology REST endpoints"
```

---

## Task 15: Topology patch on resume

**Files:**
- Modify: `src/server/state.py` (apply_patch)
- Modify: `src/server/routes/sim.py` (forward patch to apply_patch)
- Create: `test/test_topology_patch.py`

- [ ] **Step 1: Failing tests**

```python
# test/test_topology_patch.py
import textwrap, pytest
from pathlib import Path
from fastapi.testclient import TestClient
from server.app import create_app


SAMPLE = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.0.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.0.1"}
""")


@pytest.fixture
def client(tmp_path, monkeypatch):
    src = tmp_path / "src.yaml"; src.write_text(SAMPLE)
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        yield c


def test_add_host_via_patch(client):
    client.post("/sim/start"); client.post("/sim/pause")
    r = client.post("/sim/resume", json={"patch": [
        {"op": "add_host", "name": "h2", "network": "lan1", "address": "10.0.0.2"}
    ]})
    assert r.status_code == 200
    state = client.get("/sim/state").json()
    # smoke check: h2 now exists
    devices = client.get("/devices/h2/interfaces").json()
    assert devices["interfaces"]


def test_invalid_patch_rejected_atomically(client):
    client.post("/sim/start"); client.post("/sim/pause")
    r = client.post("/sim/resume", json={"patch": [
        {"op": "add_host", "name": "h2", "network": "lan1", "address": "10.0.0.2"},
        {"op": "add_host", "name": "h3", "network": "nonexistent", "address": "10.0.0.3"},
    ]})
    assert r.status_code == 400
    # both h2 and h3 should be absent — atomic rejection
    assert client.get("/devices/h2/interfaces").status_code == 404
    assert client.get("/devices/h3/interfaces").status_code == 404
```

(These also depend on /devices/{name}/interfaces from Task 16 — re-order or stub.)

- [ ] **Step 2: Run, verify failures**

Run: `pytest test/test_topology_patch.py -v`
Expected: errors due to missing endpoints.

- [ ] **Step 3: Implement apply_patch**

Edit `src/server/state.py`:

```python
class SimState:
    # ... existing ...

    def resume(self, patch: list[dict] | None = None):
        with self._lock:
            if self._state != "paused":
                raise InvalidStateTransition(self._state, "running")
            if patch:
                self._apply_patch(patch)
            self._as.gate().resume()
            self._state = "running"
            self._persist()

    def _apply_patch(self, patch: list[dict]) -> None:
        # Two-phase: validate then apply. Stash a textual representation we
        # can snapshot for rollback.
        for op in patch:
            self._validate_op(op)
        for op in patch:
            self._apply_op(op)

    def _validate_op(self, op: dict) -> None:
        kind = op.get("op")
        if kind == "add_network":
            if not all(k in op for k in ("name", "address")):
                raise InvalidStateTransition("invalid_patch", kind)
            if op["name"] in self._as.networks():
                raise InvalidStateTransition("duplicate_name", op["name"])
        elif kind == "remove_network":
            if op.get("name") not in self._as.networks():
                raise InvalidStateTransition("network_not_found", op.get("name", ""))
            # disallow removal of a network still referenced by any host/router
            net_name = op["name"]
            users = [h.name() for h in self._as.hosts().values() if h.network().name() == net_name]
            users += [r.name() for r in self._as.routers().values()
                      if any(i.network().name() == net_name for i in r.interfaces().values())]
            if users:
                raise InvalidStateTransition("network_in_use", ",".join(users))
        elif kind == "add_host":
            if not all(k in op for k in ("name", "network", "address")):
                raise InvalidStateTransition("invalid_patch", kind)
            if op["network"] not in self._as.networks():
                raise InvalidStateTransition("network_not_found", op["network"])
            if op["name"] in self._as.hosts() or op["name"] in self._as.routers():
                raise InvalidStateTransition("duplicate_name", op["name"])
        elif kind == "remove_host":
            if op.get("name") not in self._as.hosts():
                raise InvalidStateTransition("host_not_found", op.get("name", ""))
        elif kind == "add_router":
            if not all(k in op for k in ("name", "interfaces")):
                raise InvalidStateTransition("invalid_patch", kind)
            if op["name"] in self._as.hosts() or op["name"] in self._as.routers():
                raise InvalidStateTransition("duplicate_name", op["name"])
            for iface in op["interfaces"]:
                if iface.get("network") not in self._as.networks():
                    raise InvalidStateTransition("network_not_found", iface.get("network", ""))
        elif kind == "remove_router":
            if op.get("name") not in self._as.routers():
                raise InvalidStateTransition("router_not_found", op.get("name", ""))
        elif kind == "update_cost":
            r = self._as.routers().get(op.get("router"))
            if r is None or op.get("iface") not in r.interfaces():
                raise InvalidStateTransition("interface_not_found", op.get("iface", ""))
            if int(op.get("cost", 0)) <= 0:
                raise InvalidStateTransition("invalid_cost", str(op.get("cost", "")))
        else:
            raise InvalidStateTransition("unknown_op", str(kind))

    def _apply_op(self, op: dict) -> None:
        from entities import Host, Router, Network, NetworkAddress, Address, Interface
        kind = op["op"]
        if kind == "add_network":
            net = Network(op["name"], NetworkAddress(op["address"]), gate=self._as.gate())
            self._as.add_network(net)
        elif kind == "remove_network":
            net = self._as.network(op["name"])
            net.stop()
            del self._as.networks()[op["name"]]
        elif kind == "add_host":
            net = self._as.network(op["network"])
            gw = Address(op["gateway"]) if op.get("gateway") else None
            host = Host(op["name"], net, Address(op["address"]),
                        gw_address=gw, gate=self._as.gate())
            net.add_interface(host.interface())
            self._as.add_host(host)
        elif kind == "remove_host":
            host = self._as.host(op["name"])
            host.interface().stop()
            del self._as.hosts()[op["name"]]
        elif kind == "add_router":
            router = Router(op["name"])
            for iface_spec in op["interfaces"]:
                net = self._as.network(iface_spec["network"])
                iface = Interface(iface_spec["name"], net,
                                   Address(iface_spec["address"]),
                                   cost=int(iface_spec.get("cost", 1)),
                                   gate=self._as.gate())
                net.add_interface(iface)
                router.add_interface(iface)
            self._as.add_router(router)
            router.start()                # gate is still paused; will flood on resume
        elif kind == "remove_router":
            router = self._as.router(op["name"])
            router.stop()
            for iface in list(router.interfaces().values()):
                iface.stop()
            del self._as.routers()[op["name"]]
        elif kind == "update_cost":
            self._as.router(op["router"]).update_interface(op["iface"], int(op["cost"]))
        else:
            raise InvalidStateTransition("unknown_op", kind)

    def _persist(self) -> None:
        from .persistence import atomic_write
        # Render current AS to YAML. For now, render only what we can reconstruct.
        # (Full serializer added in Task 18 — for now write a placeholder of the
        # current session content; refinement note tracked in the spec.)
        atomic_write(self.session_path, self._dump_yaml())

    def _dump_yaml(self) -> str:
        import yaml
        out = {self._as.name(): {
            "name": self._as.name(),
            "networks": {n.name(): str(n.address()) for n in self._as.networks().values()},
            "hosts": {h.name(): {"network": h.network().name(),
                                  "address": str(h.address()),
                                  **({"gateway": str(h.gateway())} if h.gateway() else {})}
                       for h in self._as.hosts().values()},
            "routers": {r.name(): {"interfaces": {
                i.name(): {"network": i.network().name(),
                           "address": str(i.address()),
                           "cost": i.cost()}
                for i in r.interfaces().values()}}
                for r in self._as.routers().values()},
        }}
        # Top-level key must be literal "as:"
        return yaml.safe_dump({"as": out[self._as.name()]}, sort_keys=False)
```

Edit `src/server/routes/sim.py`:

```python
@router.post("/resume")
def resume(body: dict | None = None, request: Request = None):
    s = _state(request)
    try:
        s.resume(patch=(body or {}).get("patch"))
    except Exception as e:
        raise HTTPException(409 if "invalid transition" in str(e) else 400, str(e))
    return {"state": s.state}
```

- [ ] **Step 4: Run, verify pass**

Run: `pytest test/test_topology_patch.py -v`
Expected: passes after Task 16 (device routes) — until then, test order matters. Mark these as `@pytest.mark.xfail(strict=True)` and unxfail in Task 16.

- [ ] **Step 5: Commit**

```bash
git add src/server/state.py src/server/routes/sim.py test/test_topology_patch.py
git commit -m "feat(server): topology patches applied atomically on resume"
```

---

## Task 16: Device routes and command dispatch

**Files:**
- Create: `src/server/routes/devices.py`
- Create: `src/server/command/__init__.py`, `dispatch.py`, `host.py`, `router.py`
- Modify: `src/server/app.py`
- Create: `test/test_server_commands.py`

- [ ] **Step 1: Failing tests**

```python
# test/test_server_commands.py
import textwrap, pytest
from fastapi.testclient import TestClient
from server.app import create_app

SAMPLE = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.0.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.0.1"}
    h2: {network: lan1, address: "10.0.0.2"}
  routers:
    r1: {interfaces: {eth0: {network: lan1, address: "10.0.0.254", cost: 1}}}
""")


@pytest.fixture
def client(tmp_path, monkeypatch):
    src = tmp_path / "src.yaml"; src.write_text(SAMPLE)
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        c.post("/sim/start")
        yield c


def test_routes_endpoint(client):
    r = client.get("/devices/r1/routes")
    assert r.status_code == 200
    assert "rules" in r.json()


def test_interfaces_endpoint(client):
    r = client.get("/devices/h1/interfaces")
    assert r.status_code == 200
    ifaces = r.json()["interfaces"]
    assert len(ifaces) == 1
    assert ifaces[0]["address"] == "10.0.0.1"


def test_unknown_device_returns_404(client):
    r = client.get("/devices/ghost/interfaces")
    assert r.status_code == 404


def test_command_ifconfig(client):
    r = client.post("/devices/h1/command", json={"cmd": "ifconfig"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"]
    assert "10.0.0.1" in body["output"]


def test_command_ping(client):
    r = client.post("/devices/h1/command", json={"cmd": "ping h2 -W 1.0"})
    assert r.status_code == 200
    out = r.json()["output"]
    assert "h2" in out


def test_command_send_does_not_block(client):
    r = client.post("/devices/h1/command", json={"cmd": "send h2 hello"})
    assert r.status_code == 200
    assert r.json()["ok"]


def test_command_route(client):
    r = client.post("/devices/r1/command", json={"cmd": "route"})
    assert r.status_code == 200
    assert r.json()["ok"]
```

- [ ] **Step 2: Implement command dispatch**

```python
# src/server/command/dispatch.py
import io, contextlib
import shlex

from entities import Host, Router


def dispatch(device, cmd_line: str) -> dict:
    parts = shlex.split(cmd_line.strip()) if cmd_line.strip() else []
    if not parts:
        return {"ok": False, "output": "empty command"}
    name, args = parts[0], parts[1:]

    if isinstance(device, Host):
        from . import host as handlers
    elif isinstance(device, Router):
        from . import router as handlers
    else:
        return {"ok": False, "output": "unknown device type"}

    fn = getattr(handlers, f"cmd_{name}", None)
    if fn is None:
        return {"ok": False, "output": f"unknown command: {name}"}
    try:
        out = fn(device, args)
        return {"ok": True, "output": out}
    except Exception as e:
        return {"ok": False, "output": str(e)}
```

```python
# src/server/command/host.py
from entities import Address


def cmd_ifconfig(host, args):
    iface = host.interface()
    lines = [f'{iface.name()}: addr={iface.address()} net={iface.network().name()} '
             f'({iface.network().address()}) cost={iface.cost()}']
    if host.gateway():
        lines.append(f'  gateway: {host.gateway()}')
    return '\n'.join(lines)


def cmd_send(host, args):
    if len(args) < 2:
        return 'syntax: send <dst> <message>'
    dst, msg = args[0], ' '.join(args[1:])
    from entities import UserMessage
    # dst can be hostname (look up via AS — not directly accessible here, so use addr)
    dst_addr = Address(dst)
    host.send_message_to(UserMessage(msg), dst_addr)
    return f'sent {len(msg)} bytes to {dst_addr}'


def cmd_ping(host, args):
    timeout = 3.0
    if '-W' in args:
        i = args.index('-W')
        timeout = float(args[i + 1])
        args = args[:i] + args[i + 2:]
    if not args:
        return 'syntax: ping <dst> [-W <seconds>]'
    dst = args[0]
    dst_addr = Address(dst)
    rtt = host.ping(dst_addr, timeout=timeout)
    if rtt is None:
        return f'ping {dst}: timeout after {timeout:.2f} s'
    return f'ping {dst} ({dst_addr}): time={rtt*1000:.2f} ms'


def cmd_route(host, args):
    # hosts have no routing table; show gateway summary
    return f'gateway: {host.gateway() or "(none)"}'


def cmd_help(host, args):
    return 'available: ifconfig, send <dst> <msg>, ping <dst> [-W t], route, help, clear'
```

```python
# src/server/command/router.py
def cmd_ifconfig(router, args):
    return '\n'.join(
        f'{name}: addr={iface.address()} net={iface.network().name()} '
        f'({iface.network().address()}) cost={iface.cost()}'
        for name, iface in router.interfaces().items()
    )


def cmd_route(router, args):
    rows = router.routing_table().rules()
    if not rows:
        return '(empty routing table)'
    lines = [f"{'prefix':<20} {'next_hop':<15} iface"]
    for r in rows:
        lines.append(f"{str(r.prefix()):<20} {str(r.next_hop()):<15} {r.interface().name()}")
    return '\n'.join(lines)


def cmd_update_cost(router, args):
    if len(args) != 2:
        return 'syntax: update_cost <iface> <cost>'
    iface, cost = args[0], int(args[1])
    if cost <= 0:
        return 'cost must be positive'
    router.update_interface(iface, cost)
    return f'cost of {iface} set to {cost}'


def cmd_neighbors(router, args):
    graph = router._protocol._graph
    my_nets = {iface.network().address() for iface in router.interfaces().values()}
    lines = []
    for node in graph.routers():
        if node == router: continue
        other_nets = {iface.network().address() for iface in node.interfaces().values()}
        shared = my_nets & other_nets
        for net_addr in shared:
            for iface in node.interfaces().values():
                if iface.network().address() == net_addr:
                    lines.append(f"  {node.name():<6} via {iface.network().name():<8} "
                                 f"({iface.address()})  cost={iface.cost()}")
    return '\n'.join(lines) if lines else '(no neighbors yet)'


def cmd_help(router, args):
    return 'available: route, update_cost <iface> <cost>, ifconfig, neighbors, help'
```

```python
# src/server/routes/devices.py
from fastapi import APIRouter, HTTPException, Request

from server.command.dispatch import dispatch

router = APIRouter(prefix="/devices", tags=["devices"])


def _device_or_404(request: Request, name: str):
    s = request.app.state.sim_state
    if s.as_obj is None:
        raise HTTPException(409, "no topology loaded")
    try:
        return s.as_obj.device(name)
    except Exception:
        raise HTTPException(404, f"unknown device: {name}")


@router.post("/{name}/command")
def command(name: str, body: dict, request: Request):
    device = _device_or_404(request, name)
    cmd_line = body.get("cmd", "")
    result = dispatch(device, cmd_line)
    return result


@router.get("/{name}/interfaces")
def interfaces(name: str, request: Request):
    device = _device_or_404(request, name)
    out = []
    for iname, iface in device.interfaces().items():
        d = {"name": iname,
             "address": str(iface.address()),
             "network": iface.network().name(),
             "cost": iface.cost()}
        out.append(d)
    return {"interfaces": out}


@router.get("/{name}/routes")
def routes(name: str, request: Request):
    device = _device_or_404(request, name)
    table = getattr(device, "routing_table", None)
    if table is None:
        return {"rules": []}
    rules = []
    for r in table().rules():
        rules.append({"prefix": str(r.prefix()),
                      "next_hop": str(r.next_hop()),
                      "iface": r.interface().name()})
    return {"rules": rules}
```

Wire in `app.py`:

```python
from .routes import devices as device_routes
app.include_router(device_routes.router)
```

- [ ] **Step 3: Run tests**

Run: `pytest test/test_server_commands.py test/test_topology_patch.py -v`
Expected: all green; unxfail any patch tests.

- [ ] **Step 4: Commit**

```bash
git add src/server/command/ src/server/routes/devices.py src/server/app.py test/test_server_commands.py
git commit -m "feat(server): /devices/* endpoints and per-device command dispatch"
```

---

## Task 17: WebSocket events route

**Files:**
- Create: `src/server/routes/ws.py`
- Modify: `src/server/app.py` (bus startup; EventTracer subscribe)
- Append to: `test/test_server_events.py`

- [ ] **Step 1: Failing test**

Append to `test/test_server_events.py`:

```python
def test_ws_streams_packet_events(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from server.app import create_app
    import textwrap, time

    yaml_text = textwrap.dedent("""
    as:
      name: t
      networks:
        lan1: "10.0.0.0/24"
      hosts:
        h1: {network: lan1, address: "10.0.0.1"}
        h2: {network: lan1, address: "10.0.0.2"}
    """)
    src = tmp_path / "src.yaml"; src.write_text(yaml_text)
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))

    app = create_app()
    with TestClient(app) as c:
        c.post("/topology", json={"yaml": yaml_text})
        c.post("/sim/start")
        with c.websocket_connect("/ws/events") as ws:
            c.post("/devices/h1/command", json={"cmd": "send h2 hello"})
            # collect a few frames
            kinds = []
            for _ in range(5):
                try:
                    kinds.append(ws.receive_json())
                except Exception:
                    break
            types = [(e.get("kind"), e.get("type")) for e in kinds]
            assert any(t == ("packet", "user_datagram") for t in types)
```

- [ ] **Step 2: Implement WS route**

```python
# src/server/routes/ws.py
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["ws"])


@router.websocket("/ws/events")
async def events(ws: WebSocket):
    await ws.accept()
    bus = ws.app.state.event_bus
    if bus._loop is None:
        bus.attach_loop(asyncio.get_running_loop())
    q = bus.subscribe()
    try:
        while True:
            event = await q.get()
            await ws.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        bus.unsubscribe(q)
```

- [ ] **Step 3: Wire EventTracer → EventBus**

Edit `src/server/app.py`, at the end of `create_app`:

```python
from entities.event import EventTracer

@app.on_event("startup")
async def _wire_event_bus():
    app.state.event_bus.attach_loop(asyncio.get_running_loop())
    EventTracer.subscribe(app.state.event_bus.emit)

# Add WS router:
from .routes import ws as ws_routes
app.include_router(ws_routes.router)
```

- [ ] **Step 4: Run tests**

Run: `pytest test/test_server_events.py -v`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/ws.py src/server/app.py test/test_server_events.py
git commit -m "feat(server): /ws/events WebSocket fan-out from EventBus"
```

---

## Task 18: Entry point rewire (web by default; shell as subcommand)

**Files:**
- Modify: `src/netrouting.py`
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Rewire entry**

```python
# src/netrouting.py
import sys


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if argv and argv[0] == 'shell':
        from shell import Shell
        Shell().cmdloop()
    else:
        from server import run
        run()


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Manual smoke test**

```bash
cd src && python netrouting.py &
sleep 1
curl -s http://127.0.0.1:8000/sim/state
kill %1
```

Expected: `{"state":"idle","as_name":null}`.

```bash
echo "exit" | (cd src && python netrouting.py shell)
```

Expected: `netrouting shell v1.0` banner.

- [ ] **Step 3: Update docs**

Edit `README.md` (replace the GitLab template with relevant content) and `CLAUDE.md` Build & Run section:

`CLAUDE.md`:

```
## Build & Run

- Requires Python 3.11+. Install runtime deps: `pip install -r requirements.txt`. For dev (tests + lint): `pip install -r requirements-dev.txt`.
- **Web UI (default):** `cd src && python netrouting.py` — launches FastAPI on http://127.0.0.1:8000 and serves the SPA from `web/`.
- **Legacy shell:** `cd src && python netrouting.py shell` — original cmd.Cmd REPL. Same simulator under the hood.
- Topology source path: env var `NETROUTING_TOPOLOGY` (default `samples/sample.yaml`). The server clones to `<source>.session.yaml` and writes only there.
- Run tests: `pytest` from the repo root. Single suite: `pytest test/test_address.py`.
- Lint: `ruff check src/ test/`. Format: `ruff format src/ test/`.
```

- [ ] **Step 4: Commit**

```bash
git add src/netrouting.py CLAUDE.md README.md
git commit -m "feat: web UI is now the default entry; shell available via 'shell' subcommand"
```

---

# Phase 3 — SPA runtime core

## Task 19: RuntimeClient module

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add the module**

Inside the existing `<script>` block in `web/index.html`, add (near other top-level objects like `state`):

```js
const RuntimeClient = {
  baseURL: '',
  state: 'idle',
  asName: null,
  ws: null,
  _wsBackoff: 500,
  _onEvent: null,

  async _json(method, path, body) {
    const r = await fetch(this.baseURL + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || r.statusText);
    return j;
  },

  getTopology()          { return this._json('GET',  '/topology'); },
  loadTopology(yaml)     { return this._json('POST', '/topology', { yaml }); },
  resetTopology()        { return this._json('POST', '/topology/reset', {}); },
  start()                { return this._json('POST', '/sim/start', {}); },
  pause()                { return this._json('POST', '/sim/pause', {}); },
  resume(patch)          { return this._json('POST', '/sim/resume', { patch: patch || [] }); },
  stop()                 { return this._json('POST', '/sim/stop', {}); },
  getState()             { return this._json('GET',  '/sim/state'); },
  deviceCommand(n, cmd)  { return this._json('POST', `/devices/${encodeURIComponent(n)}/command`, { cmd }); },
  deviceRoutes(n)        { return this._json('GET',  `/devices/${encodeURIComponent(n)}/routes`); },
  deviceInterfaces(n)    { return this._json('GET',  `/devices/${encodeURIComponent(n)}/interfaces`); },

  connectEvents(onEvent) {
    this._onEvent = onEvent;
    this._openWs();
  },
  _openWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws/events`);
    this.ws.onmessage = (m) => { try { this._onEvent(JSON.parse(m.data)); } catch (e) {} };
    this.ws.onopen  = () => { this._wsBackoff = 500; setConnectionStatus(true); };
    this.ws.onclose = () => {
      setConnectionStatus(false);
      setTimeout(() => this._openWs(), this._wsBackoff);
      this._wsBackoff = Math.min(this._wsBackoff * 2, 8000);
    };
  },
  disconnectEvents() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
  },
};

function setConnectionStatus(connected) {
  // populated in Task 20 (toolbar)
}
```

- [ ] **Step 2: Manual smoke test in console**

Open the SPA in a browser with the backend running. In devtools console:

```js
await RuntimeClient.getState()
```

Expected: `{state: "idle", as_name: null}`.

- [ ] **Step 3: Commit**

```bash
git add web/index.html
git commit -m "feat(web): RuntimeClient module wraps REST + WS to backend"
```

---

## Task 20: Toolbar — Start/Stop + Pause/Resume

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add toolbar buttons in HTML**

Locate the `<div class="canv-toolbar">` block in `web/index.html`. Add new buttons after the existing topology buttons (LAN/Host/Router):

```html
<span class="div"></span>
<button class="tb-btn primary" id="tb-play"  title="Start simulation (Space)">
  <svg class="ico"><use href="#ui-play"/></svg> <span class="lbl">Start</span>
</button>
<button class="tb-btn" id="tb-pause" title="Pause simulation (P)" hidden>
  <svg class="ico"><use href="#ui-pause"/></svg> <span class="lbl">Pause</span>
</button>
<button class="tb-btn" id="tb-reset" title="Revert topology to source" disabled>
  <svg class="ico"><use href="#ui-reset"/></svg> Reset
</button>
```

(Define `#ui-play`, `#ui-pause`, `#ui-reset` SVG symbols in the existing symbol section.)

- [ ] **Step 2: Wire state machine in JS**

```js
const Sim = {
  state: 'idle',
  patch: [],

  async refreshState() {
    const s = await RuntimeClient.getState();
    this.state = s.state;
    this._renderToolbar();
  },

  _renderToolbar() {
    const play = document.getElementById('tb-play');
    const pause = document.getElementById('tb-pause');
    const reset = document.getElementById('tb-reset');
    const playLbl = play.querySelector('.lbl');

    if (this.state === 'idle') {
      playLbl.textContent = 'Start'; play.classList.remove('running','paused');
      pause.hidden = true;
      reset.disabled = false;
    } else if (this.state === 'running') {
      playLbl.textContent = 'Stop'; play.classList.add('running');
      pause.hidden = false; pause.querySelector('.lbl').textContent = 'Pause';
      reset.disabled = true;
    } else if (this.state === 'paused') {
      playLbl.textContent = 'Stop'; play.classList.add('paused');
      pause.hidden = false; pause.querySelector('.lbl').textContent = 'Resume';
      reset.disabled = true;
    }
  },

  async onPrimary() {
    if (this.state === 'idle') {
      const yaml = exportYaml();
      await RuntimeClient.loadTopology(yaml);
      await RuntimeClient.start();
    } else {
      await RuntimeClient.stop();
      this.patch = [];
    }
    await this.refreshState();
  },

  async onSecondary() {
    if (this.state === 'running') await RuntimeClient.pause();
    else if (this.state === 'paused') {
      await RuntimeClient.resume(this.patch);
      this.patch = [];
    }
    await this.refreshState();
  },

  async onReset() {
    if (this.state !== 'idle') return;
    await RuntimeClient.resetTopology();
    const { yaml } = await RuntimeClient.getTopology();
    importYaml(yaml);
  },
};

document.getElementById('tb-play').addEventListener('click', () => Sim.onPrimary());
document.getElementById('tb-pause').addEventListener('click', () => Sim.onSecondary());
document.getElementById('tb-reset').addEventListener('click', () => Sim.onReset());

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); Sim.onPrimary(); }
  if (e.key === 'p' || e.key === 'P') { e.preventDefault(); Sim.onSecondary(); }
});

// On load
Sim.refreshState().catch(() => setConnectionStatus(false));
RuntimeClient.connectEvents((evt) => {
  if (evt.kind === 'sim_state') {
    Sim.state = evt.state; Sim._renderToolbar();
  }
  // packet handler wired in Phase 4
});
```

- [ ] **Step 3: YAML emitter — align to `as: { name: ... }` shape**

Find `exportYaml()` (around line 2670 in `web/index.html`). Change the wrapping:

```js
function exportYaml() {
  const out = { as: { name: state.asName, networks: {}, hosts: {}, routers: {} } };
  // ... rest unchanged, but populate out.as.networks, out.as.hosts, out.as.routers ...
  return jsyaml.dump(out, { quotingType: '"', forceQuotes: true, lineWidth: -1, indent: 2 });
}
```

And update `importYaml(text)`:

```js
function importYaml(text) {
  let parsed;
  try { parsed = jsyaml.load(text); } catch (e) { ... }
  if (!parsed || !parsed.as) { toast('YAML root must be "as:"', 'error'); return false; }
  const node = parsed.as;
  state.asName = node.name || 'unnamed_as';
  // ... rest reads node.networks/hosts/routers as before
}
```

- [ ] **Step 4: Manual smoke test**

1. Start server. Open SPA. Click `Start` — expect button to flip to `Stop` and pulse green; backend `/sim/state` returns `running`.
2. Click `Pause` — secondary becomes `Resume`, button turns amber.
3. Click `Resume` — back to running.
4. Click `Stop` — back to idle.

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat(web): Start/Stop and Pause/Resume buttons wired to backend"
```

---

## Task 21: Topology lock + patch accumulator

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add lock guards**

Wrap mutation paths with `if (Sim.state === 'running') return;`. The two main entry points are the node drag handlers in `attachNodeEvents` and the toolbar Add-LAN/Host/Router buttons.

For paused-mode edits, append to `Sim.patch` from the same mutation points:

```js
function recordPatchOp(op) {
  if (Sim.state === 'paused') Sim.patch.push(op);
}
```

Wire `recordPatchOp({op: "add_host", name, network, address})` in `addHost`, and similar for router/network add, remove, and `update_cost`.

- [ ] **Step 2: Manual smoke**

Start → drag a node (no movement). Pause → add a host on the canvas → Resume → host appears, animation begins after reconvergence. Backend `/devices/<new>/interfaces` returns 200.

- [ ] **Step 3: Commit**

```bash
git add web/index.html
git commit -m "feat(web): lock topology during run; accumulate patches during pause"
```

---

# Phase 4 — Packet animation

## Task 22: Packet overlay layer + dot animation

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add SVG layer**

In the existing viewport group, insert between `edges-layer` and `nodes-layer`:

```html
<g id="packet-layer"></g>
```

- [ ] **Step 2: Animation utility**

```js
const PacketAnim = {
  DURATION_MS: 600,
  COLORS: {
    routing_flood:  { fill: '#94a3b8', opacity: 0.5 },
    user_datagram:  { fill: '#22c55e', opacity: 1.0 },
    ping_request:   { fill: '#f59e0b', opacity: 1.0 },
    ping_reply:     { fill: '#fbbf24', opacity: 1.0 },
  },
  _lastChatter: new Map(),

  play(evt) {
    if (evt.type === 'routing_flood' && !this._chatterAllowed(evt)) return;
    const a = lookupDeviceNode(evt.src.device);
    const net = lookupNetworkNode(evt.network);
    if (!a || !net) return;
    const dst = lookupAddressNode(evt.dst.address);
    const layer = document.getElementById('packet-layer');
    const dot = el('circle', { r: 5, ...this.COLORS[evt.type] || {} });
    layer.appendChild(dot);

    this._tween(dot, a, net, this.DURATION_MS / 2, () => {
      if (!dst) { layer.removeChild(dot); return; }
      this._tween(dot, net, dst, this.DURATION_MS / 2, () => layer.removeChild(dot));
    });
    dot.addEventListener('mouseenter', () => showPacketTooltip(evt));
  },

  _chatterAllowed(evt) {
    if (state.routingChatterMuted) return false;
    const key = `${evt.src.device}:${evt.network}`;
    const now = performance.now();
    const last = this._lastChatter.get(key) || 0;
    if (now - last < 200) return false;
    this._lastChatter.set(key, now);
    return true;
  },

  _tween(dot, fromNode, toNode, durationMs, done) {
    const fp = getNodeCenter(fromNode), tp = getNodeCenter(toNode);
    const startedAt = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - startedAt) / durationMs);
      dot.setAttribute('cx', fp.x + (tp.x - fp.x) * t);
      dot.setAttribute('cy', fp.y + (tp.y - fp.y) * t);
      if (t < 1) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  },
};

function showPacketTooltip(evt) {
  const tt = document.getElementById('packet-tooltip') || (() => {
    const e = document.createElement('div');
    e.id = 'packet-tooltip';
    e.className = 'packet-tt';
    document.body.appendChild(e); return e;
  })();
  tt.textContent = `${evt.type}: ${evt.src.address} → ${evt.dst.address}` + (evt.payload ? ` "${evt.payload}"` : '');
  tt.style.display = 'block';
  document.addEventListener('mousemove', moveTt);
  setTimeout(() => { tt.style.display = 'none'; document.removeEventListener('mousemove', moveTt); }, 1200);
  function moveTt(e) { tt.style.left = (e.pageX + 12) + 'px'; tt.style.top = (e.pageY + 12) + 'px'; }
}
```

Helpers `lookupDeviceNode(name)`, `lookupNetworkNode(name)`, `lookupAddressNode(address)`, `getNodeCenter(g)` come from the existing canvas code — wire them to your existing node maps.

- [ ] **Step 2: Wire to events stream**

In the WS event handler set up in Task 20:

```js
RuntimeClient.connectEvents((evt) => {
  if (evt.kind === 'sim_state') { Sim.state = evt.state; Sim._renderToolbar(); }
  if (evt.kind === 'packet') PacketAnim.play(evt);
  if (evt.kind === 'routing_table_changed') Inspector.onRouteChange(evt);  // phase 6
});
```

- [ ] **Step 3: Add chatter toggle**

Add a small toggle button next to Reset, default checked. Wire to `state.routingChatterMuted`.

- [ ] **Step 4: Manual smoke**

Start sim → send a packet via terminal stub (or `curl POST /devices/h1/command -d '{"cmd":"send h2 hi"}'`) → see green dot move from h1 → lan1 → h2. Hover on dot → tooltip.

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat(web): packet animation overlay with hover tooltips and chatter throttle"
```

---

# Phase 5 — Per-node terminal

## Task 23: Terminal window component

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: HTML + CSS for terminal**

Add CSS in the `<style>` block:

```css
.term {
  position: fixed; z-index: 9999;
  width: 480px; height: 280px;
  background: #0a0a0a; color: #33ff66;
  font-family: "JetBrains Mono", "Geist Mono", ui-monospace, monospace;
  font-size: 13px; line-height: 1.35;
  border: 1px solid #233; border-radius: 6px;
  box-shadow: 0 14px 40px rgba(0,0,0,0.5);
  display: flex; flex-direction: column;
  resize: both; overflow: hidden;
}
.term-header { padding: 4px 8px; background: #111; cursor: move; user-select: none;
  display: flex; align-items: center; justify-content: space-between; }
.term-header .title { color: #88e; font-size: 12px; }
.term-header .close { color: #f88; cursor: pointer; padding: 0 6px; }
.term-out { flex: 1; padding: 6px 8px; overflow-y: auto; white-space: pre-wrap; margin: 0; }
.term-line { display: flex; padding: 0 8px 6px; }
.term-prompt { color: #4a8; margin-right: 6px; }
.term-in { flex: 1; background: transparent; color: #aaffaa;
  border: none; outline: none; font: inherit; caret-color: #33ff66; }
.term-in::after { content: '█'; animation: blink 1s steps(2, start) infinite; }
@keyframes blink { 50% { opacity: 0; } }
```

- [ ] **Step 2: Terminal JS module**

```js
const Terminals = {
  _active: new Map(),                   // name -> element

  open(deviceName) {
    if (this._active.has(deviceName)) {
      const el = this._active.get(deviceName);
      el.style.display = 'flex'; el.focus(); return;
    }
    const tmpl = `
      <div class="term-header">
        <div class="title">${deviceName}@netrouting</div>
        <div class="close" title="Close">×</div>
      </div>
      <pre class="term-out">netrouting v1.0 — ${deviceName}\\ntype 'help' for commands\\n</pre>
      <div class="term-line">
        <span class="term-prompt">${deviceName}@netrouting:~$</span>
        <input class="term-in" autocomplete="off" spellcheck="false" />
      </div>`;
    const w = document.createElement('div');
    w.className = 'term'; w.innerHTML = tmpl;
    const pos = JSON.parse(localStorage.getItem('term.pos.' + deviceName) || '{"x":120,"y":120}');
    w.style.left = pos.x + 'px'; w.style.top = pos.y + 'px';
    document.body.appendChild(w);
    this._active.set(deviceName, w);
    this._wire(w, deviceName);
    w.querySelector('.term-in').focus();
  },

  _wire(w, name) {
    const out = w.querySelector('.term-out');
    const inp = w.querySelector('.term-in');
    const close = w.querySelector('.close');
    const history = JSON.parse(sessionStorage.getItem('term.hist.' + name) || '[]');
    let histIdx = history.length;

    close.addEventListener('click', () => {
      w.remove(); this._active.delete(name);
    });

    // drag
    const hdr = w.querySelector('.term-header');
    let drag = null;
    hdr.addEventListener('mousedown', (e) => { drag = { x: e.clientX - w.offsetLeft, y: e.clientY - w.offsetTop }; });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      w.style.left = (e.clientX - drag.x) + 'px';
      w.style.top  = (e.clientY - drag.y) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (drag) localStorage.setItem('term.pos.' + name, JSON.stringify({ x: w.offsetLeft, y: w.offsetTop }));
      drag = null;
    });

    inp.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const cmd = inp.value;
        out.textContent += `${name}@netrouting:~$ ${cmd}\n`;
        inp.value = '';
        if (cmd.trim() === 'clear') { out.textContent = ''; return; }
        if (cmd.trim() === 'help') {
          out.textContent += 'available: ifconfig, route, send, ping, neighbors, update_cost, clear, help\n';
        } else {
          try {
            const r = await RuntimeClient.deviceCommand(name, cmd);
            out.textContent += (r.output || '') + '\n';
          } catch (err) {
            out.textContent += `[error] ${err.message}\n`;
          }
        }
        out.scrollTop = out.scrollHeight;
        history.push(cmd); histIdx = history.length;
        sessionStorage.setItem('term.hist.' + name, JSON.stringify(history.slice(-200)));
      } else if (e.key === 'ArrowUp') {
        if (histIdx > 0) inp.value = history[--histIdx]; e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        if (histIdx < history.length - 1) inp.value = history[++histIdx];
        else { inp.value = ''; histIdx = history.length; } e.preventDefault();
      }
    });
  },
};
```

- [ ] **Step 3: Wire double-click on host/router nodes**

In `attachNodeEvents`, add to the dblclick path for host/router kinds:

```js
g.addEventListener('dblclick', () => {
  if (kind === 'host' || kind === 'router') {
    if (Sim.state === 'idle') return;     // can't run commands without backend AS
    Terminals.open(name);
  }
});
```

- [ ] **Step 4: Manual smoke**

Start sim → double-click h1 → terminal opens → type `ifconfig` → see interface output. Type `ping h2 -W 1.0` → see RTT.

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat(web): per-node terminal popup with phosphor theme"
```

---

# Phase 6 — Inspector live + polish

## Task 24: Inspector routing-table section live updates

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add section to inspector**

In the inspector render path (find where node details are rendered in the right pane), append a `<div class="insp-section" id="insp-routes" hidden></div>`.

- [ ] **Step 2: Update on event + on selection**

```js
const Inspector = {
  async refreshRoutes(deviceName) {
    const sec = document.getElementById('insp-routes');
    if (Sim.state === 'idle' || !deviceName) { sec.hidden = true; return; }
    try {
      const r = await RuntimeClient.deviceRoutes(deviceName);
      sec.hidden = false;
      sec.innerHTML = `<h4>Routing table — ${deviceName}</h4>` +
        (r.rules.length === 0
          ? '<div class="hint">(empty)</div>'
          : `<table class="insp-table">
               <thead><tr><th>Prefix</th><th>Next hop</th><th>Iface</th></tr></thead>
               <tbody>${r.rules.map(x => `<tr><td>${x.prefix}</td><td>${x.next_hop}</td><td>${x.iface}</td></tr>`).join('')}</tbody>
             </table>`);
    } catch (e) { sec.hidden = true; }
  },
  onRouteChange(evt) {
    if (state.selection?.name === evt.device) this.refreshRoutes(evt.device);
  },
};
```

Wire `Inspector.refreshRoutes(state.selection?.name)` to selection-change handlers and the sim-state-change handler.

- [ ] **Step 3: Manual smoke**

Start sim with a multi-router topology → select r1 → see its routing table → `update_cost r2 eth0 99` from a terminal → see r1's routing table update without page reload.

- [ ] **Step 4: Commit**

```bash
git add web/index.html
git commit -m "feat(web): live routing-table section in inspector"
```

---

## Task 25: Final polish (connection banner, manual checklist)

**Files:**
- Modify: `web/index.html` — finalize connection banner CSS and copy
- Create: `docs/manual-smoke-test.md`

- [ ] **Step 1: Connection-lost banner**

```js
function setConnectionStatus(connected) {
  const b = document.getElementById('conn-banner') || (() => {
    const e = document.createElement('div');
    e.id = 'conn-banner';
    e.className = 'conn-banner';
    document.body.appendChild(e); return e;
  })();
  b.textContent = connected ? '' : 'connection lost — retrying';
  b.style.display = connected ? 'none' : 'block';
}
```

CSS:

```css
.conn-banner {
  position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
  background: #dc2626; color: white; padding: 6px 14px; border-radius: 4px;
  font: 13px/1 var(--font-mono, ui-monospace, monospace);
  z-index: 10000; display: none;
}
```

- [ ] **Step 2: Manual smoke checklist**

Create `docs/manual-smoke-test.md`:

```markdown
# Manual smoke test — UI improvements

Backend running: `cd src && python netrouting.py`. Open http://127.0.0.1:8000.

1. SPA loads with default topology (sample).
2. Click **Start** → button turns green pulse, label switches to **Stop**. `/sim/state` returns `running`.
3. Within ~10s, routing-flood dots animate on edges (subtle grey).
4. Double-click `h1` → terminal opens with phosphor theme.
5. In terminal: `ifconfig` → interface listed. `route` → gateway shown.
6. In terminal: `ping h2 -W 1.0` → see ping_request and ping_reply dots; RTT printed.
7. Send a user datagram: `send h2 hello world` → green dot animates h1 → lan1 → h2.
8. Click **Pause** → animations stop, button turns amber. Label: **Resume**.
9. Drag a new host onto the canvas in `lan1`. Save (autosave). Indicator "(1 edit pending)" appears.
10. Click **Resume** → server applies patch, new host appears in inspector. Within 2 keepalives, routing tables converge.
11. Click **Stop** → idle. Topology reverts to designer mode (editable).
12. Click **Reset** → topology re-cloned from source; SPA reloads it.
13. Stop the server. Banner "connection lost — retrying" shows. Restart server → banner clears.
```

- [ ] **Step 3: Commit**

```bash
git add web/index.html docs/manual-smoke-test.md
git commit -m "feat(web): connection-lost banner; add manual smoke-test doc"
```

---

## Final lint + doc check

- [ ] **Step 1: Lint everything**

```bash
ruff check src/ test/
```

Expected: clean.

- [ ] **Step 2: Full test suite**

```bash
pytest -v
```

Expected: all tests green (>120 tests after Phase 2).

- [ ] **Step 3: Update CLAUDE.md final entries**

Add to "Key Design Decisions & Traps":

```
- **Session file is the authoritative working copy.** `<source>.session.yaml` is created on first server start and rewritten on every successful pause/resume patch and `/topology` POST. The source file is read-only. `POST /topology/reset` removes the session and re-clones. `*.session.yaml` is in `.gitignore`.
- **EventBus runs `emit` from worker threads.** `Interface.send_to` calls `EventTracer._broadcast` synchronously; the bus must enqueue without blocking. Slow subscribers would stall packet dispatch — `test_event_subscribers.py` pins this contract.
- **Resume applies the patch before opening the gate.** New routers' protocol threads are started during `add_router`, but they block on the still-paused gate; they begin flooding only when `resume()` opens it. This avoids spurious packets during patch application.
```

```bash
git add CLAUDE.md
git commit -m "docs: capture session-file, EventBus, and resume-order invariants"
```
