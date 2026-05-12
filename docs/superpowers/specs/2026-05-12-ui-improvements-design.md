# UI improvements — interactive simulator in the SPA

**Status:** design accepted, pending implementation plan
**Branch:** `feature/ui-improvements` (rebased onto `fix/assorted-bugs`)
**Date:** 2026-05-12

## 1. Goal

Turn the existing `web/index.html` topology *designer* into a live simulator UI by running the Python simulator engine inside a FastAPI server, exposing its primitives over REST + WebSocket, and adding three new SPA surfaces:

- packets animated on the canvas as they traverse links
- per-node terminal popups (geek aesthetic) that run the existing Shell commands plus new inspection commands
- Start/Stop and Pause/Resume controls, with editing allowed only while idle or paused

## 2. Non-goals

- Multi-user / multi-session backend (one AS per server process).
- Replacing the cmd-line shell (kept as a manual alternative; demoted from the default entry).
- Rewriting the simulator's threading model into an event loop.
- Visual differentiation of link cost via animation speed.
- ICMP, TCP, NAT, or any networking concept the current entity layer doesn't already model — `ping` is the only protocol addition.
- A JS test framework for the SPA (manual smoke-tests for now; Playwright is future work).

## 3. Glossary

- **AS** — the live `entities.AS` instance held by the server (singleton).
- **Source YAML** — the file path passed via `--topology`. **Read-only** at runtime.
- **Session YAML** — `<source>.session.yaml`, the writable working copy; all mutations land here.
- **Patch** — a list of structural mutations `[{op: "add_host", ...}, ...]` accumulated by the SPA during `paused` state and submitted on Resume.
- **PauseGate** — a `threading.Event`-backed primitive that worker loops block on each iteration when paused.

## 4. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (SPA, web/index.html)                                  │
│  ┌─ Designer ────────────┐  ┌─ Runtime overlay ───────────────┐ │
│  │ existing canvas/edit  │  │ packet anim · per-node terminal │ │
│  └───────────────────────┘  └─────────────────────────────────┘ │
└─────────────┬──────────────────────────┬────────────────────────┘
         REST │ commands                 │ WebSocket events
              ▼                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  FastAPI server (src/server/)                                   │
│   /sim/start /sim/pause /sim/resume /sim/stop  /topology /reset │
│   /devices/{name}/command  /routes  /interfaces                 │
│   /ws/events  ←  EventBus  ←  EventTracer subscribers           │
└─────────────────────────────────────────────────────────────────┘
              │ holds & mutates
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Simulator (src/entities, src/routing, src/parser)              │
│  Gains: PauseGate, ping support, class-level event broadcast    │
└─────────────────────────────────────────────────────────────────┘
```

## 5. Simulator changes (`src/entities`, `src/routing`, `src/parser`)

### 5.1 PauseGate

New module `src/entities/clock.py`:

```python
class PauseGate:
    """Worker threads block on wait() each loop iteration.
       set()=running, clear()=paused. Holds a separate stop flag so
       paused-and-stopping doesn't wedge."""
```

Backed by `threading.Event` for the run-state, plus a second `threading.Event` for stop. `wait_or_stop(timeout=None)` returns `(running: bool, stopped: bool)` so workers can branch.

`AS` constructs and holds one `PauseGate` instance; exposes it via `AS.gate()`. `AS.stop()` sets the stop flag *and* releases the gate so workers don't wait forever.

**Wiring points:**

| File | Loop | Insertion |
|------|------|-----------|
| `entities/interface.py` | `_pkt_loop` | `gate.wait_or_stop()` after dequeue, before `_device.handle_packet` |
| `entities/network.py`   | `_pkt_loop` | `gate.wait_or_stop()` after dequeue, before `_dispatch_packet` |
| `routing/protocol.py`   | `_keepalive_loop` | replace `time.sleep(KEEPALIVE_INTERVAL)` with `gate.wait_or_stop(timeout=KEEPALIVE_INTERVAL)`; gate check at top of loop before `_handle_update` |

Plumbing: `Interface.__init__` and `Network.__init__` take a `gate` parameter; the parser passes the AS gate when building both. `RoutingProtocol` reaches the gate via `router._as_gate` (set by `AS.add_router`).

**Stop responsiveness:** today `RoutingProtocol.stop()` only sets `_stopped`; the keepalive thread may sleep up to 10s. After the gate change, `wait_or_stop` returns immediately when stop is signalled. Test: stop a paused keepalive, assert it returns in < 100ms.

### 5.2 EventTracer broadcast

Add class-level subscribers to `entities/event.py`:

```python
class EventTracer:
    _subscribers: list[Callable[[dict], None]] = []
    _sub_lock = Lock()

    @classmethod
    def subscribe(cls, fn) -> Callable[[], None]:  # returns unsubscribe()
    @classmethod
    def _broadcast(cls, event: dict) -> None:      # never raises
```

**Broadcast hook points** — `_broadcast` is invoked from two boundaries that together cover every packet hop:

1. **Per-hop egress** — `Interface.send_to` (after enqueuing to the network's in-queue): `EventTracer._broadcast({"kind": "packet", "src": iface.address(), "dst": dst_addr, "type": classify(datagram.payload()), "payload": short_repr(datagram.payload())})`. Fires once per outbound hop, including routing floods (which never went through the existing `message_sent` callback). Single hook is enough — each hop's egress is the next hop's arrival, so no separate ingress event is needed for animation.
2. **Routing table updates** — `RoutingProtocol._recompute_if_dirty` after the table mutations land: `EventTracer._broadcast({"kind": "routing_table_changed", "device": self._router.name(), "rules": [...]})`.

The existing per-message callbacks (`message_sent`/`_received`/`_forwarded`) keep firing — they coexist with the new broadcast. The classifier `classify(payload)` maps `RoutingMessage → "routing_flood"`, `UserMessage → "user_datagram"`, `PingRequest → "ping_request"`, `PingReply → "ping_reply"`.

Exceptions in subscribers are caught and logged, never propagated to the producer thread (test enforces this).

**Contract:** subscribers are called synchronously on the worker thread that produced the event. Slow subscribers stall packet dispatch. The server's `EventBus` MUST be a non-blocking enqueue.

### 5.3 Ping (new packet types + Host method)

`entities/packet.py`:

```python
class PingRequest(Message):
    def __init__(self, seq: int): ...
class PingReply(Message):
    def __init__(self, seq: int, request_ts: float): ...
```

`entities/host.py` additions:

```python
PING_TIMEOUT_S = 3.0

class Host(NetworkDevice):
    def __init__(self, ...):
        ...
        self._ping_seq = itertools.count()
        self._pending_pings: dict[tuple[Address, int], threading.Event] = {}
        self._ping_lock = threading.Lock()
        self._ping_results: dict[tuple[Address, int], float] = {}

    def ping(self, dst_addr: Address, timeout: float = PING_TIMEOUT_S) -> float | None:
        seq = next(self._ping_seq)
        evt = threading.Event()
        key = (dst_addr, seq)
        with self._ping_lock:
            self._pending_pings[key] = evt

        request = PingRequest(seq)
        sent_at = time.monotonic()
        datagram = Datagram(self.address(), dst_addr, payload=request)
        self._interface.send_to(datagram, dst_addr=self._gw_address)

        arrived = evt.wait(timeout=timeout)
        with self._ping_lock:
            self._pending_pings.pop(key, None)
            rtt = self._ping_results.pop(key, None)

        return rtt if arrived else None

    def _handle_message(self, msg, interface, packet):
        if isinstance(msg, PingRequest):
            originator = packet.source()
            reply = PingReply(seq=msg.seq, request_ts=msg.sent_at)
            datagram = Datagram(self.address(), originator, payload=reply)
            self._interface.send_to(datagram, dst_addr=self._gw_address)
            return
        if isinstance(msg, PingReply):
            originator = packet.source()
            key = (originator, msg.seq)
            with self._ping_lock:
                evt = self._pending_pings.get(key)
                if evt is None:
                    return  # late reply, silently drop
                self._ping_results[key] = time.monotonic() - msg.request_ts
                evt.set()
            return
        # existing UserMessage branch unchanged
```

`Router._handle_message` ignores `PingRequest` and `PingReply` (no echo at the router level).

**Signature change:** `_handle_message` today takes `(msg, interface)`. The ping reply path needs the originator's address, which lives on the `Datagram` not on `msg`. So this spec widens the signature to `(msg, interface, packet)`. `NetworkDevice.handle_packet` already has `packet` and passes it through. `Router._handle_message`, `Host._handle_message`, and the routing-message return path all update to the new arity.

**`PingRequest.sent_at`:** the request carries its own monotonic timestamp so the reply can echo it back for RTT calculation, instead of the receiver assigning its own. This avoids cross-thread clock skew on RTT and is symmetric to how real ICMP echo carries the originating timestamp.

### 5.4 New shell commands

`src/shell/shell.py`:

```python
@requires_system
def do_ifconfig(self, arg):
    """Show interfaces for a device. Syntax: ifconfig <device>"""

@requires_system
def do_neighbors(self, arg):
    """Show known routing neighbors. Syntax: neighbors <router>"""

@requires_system
def do_ping(self, arg):
    """Ping one host from another. Syntax: ping <src_host> <dst_host> [-W <seconds>]"""
```

Output format (Spanish-free for these; shell help strings stay in Spanish per CLAUDE.md):

```
ifconfig h1
  iface_h1: addr=200.100.0.10 net=lan1 (200.100.0.0/24) cost=0
  gateway: 200.100.0.1

neighbors r1
  r2  via lan1 (200.100.0.254) cost=5
  r2  via lan2 (100.200.0.2)   cost=8

ping h1 h2
  ping h1 → h2 (100.200.0.20): seq=0 time=2.41 ms
  ping h1 → h2 (100.200.0.20): timeout after 3.00 s
```

### 5.5 Tests

See §8 — every change has TDD coverage with edge cases.

## 6. Backend (`src/server/`)

### 6.1 Layout

```
src/server/
├── __init__.py        # `run()` entry — uvicorn(server.app:create_app, host=0.0.0.0, port=8000)
├── __main__.py        # `python -m server` → run()
├── app.py             # FastAPI app factory; mounts web/ at /; CORS for localhost dev
├── state.py           # SimState — singleton wrapper around AS; thread-safe state machine
├── events.py          # EventBus — non-blocking enqueue, fan-out to WS subscribers
├── persistence.py     # session-file clone, atomic write, reset
├── routes/
│   ├── sim.py         # /sim/start /sim/pause /sim/resume /sim/stop /sim/state
│   ├── topology.py    # POST/GET /topology, POST /topology/reset
│   ├── devices.py     # /devices/{name}/command /routes /interfaces
│   └── ws.py          # /ws/events
└── command/
    ├── dispatch.py    # tokenize command line, dispatch to handler
    ├── host.py        # send, ping, ifconfig, route, help, clear (clear is client-side)
    └── router.py      # route, update_cost, ifconfig, neighbors, help
```

### 6.2 SimState (state machine)

States: `idle`, `running`, `paused`. Transitions:

```
idle    --start--> running
running --pause--> paused
paused  --resume--> running
running --stop--> idle
paused  --stop--> idle
```

All other transitions return HTTP 409 with `{ok: false, error: {code: "invalid_state", ...}}`.

`SimState` holds:
- `_as: AS | None`
- `_state: str`
- `_source_path: Path` (read-only)
- `_session_path: Path` (writable)
- `_lock: threading.RLock` (serializes transitions)

Idempotent operations: `stop` when already `idle` returns 200 + current state (no error). `start` when already `running` returns 200 + current state.

### 6.3 EventBus

```python
class EventBus:
    def __init__(self, max_queue=1000):
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue: ...
    def unsubscribe(self, q): ...
    def emit(self, event: dict) -> None:
        """Called from worker threads. Non-blocking. Drops oldest on overflow."""
```

On simulator startup, `EventTracer.subscribe(bus.emit)` wires producer → bus. The bus uses `asyncio.run_coroutine_threadsafe(queue.put(event), loop)`; on overflow, the WS handler drops the oldest event and logs a counter.

### 6.4 REST surface

| Verb | Path | Request | Response (success) | Errors |
|------|------|---------|--------------------|--------|
| POST | `/topology` | `{yaml: str}` | `{ok, as_name, devices, networks}` | 400 parse error; auto-stops if running |
| GET  | `/topology` | — | `{yaml: str}` (session content) | — |
| POST | `/topology/reset` | `{}` | `{ok, as_name}` (rebuilt from source) | 409 if running |
| POST | `/sim/start` | `{}` | `{state: "running"}` | 400 no topology loaded |
| POST | `/sim/pause` | `{}` | `{state: "paused"}` | 409 if not running |
| POST | `/sim/resume` | `{patch?: [...]}` | `{state: "running", reconverge_eta_s: <float>}` | 409 if not paused; 400 invalid patch |
| POST | `/sim/stop` | `{}` | `{state: "idle"}` | — (idempotent) |
| GET  | `/sim/state` | — | `{state, as_name?, uptime_s?}` | — |
| POST | `/devices/{name}/command` | `{cmd: str}` | `{ok, output: str}` | 404 device; 400 syntax |
| GET  | `/devices/{name}/routes` | — | `{rules: [{prefix, next_hop, iface}, ...]}` | 404 device |
| GET  | `/devices/{name}/interfaces` | — | `{interfaces: [{name, address, network, cost, gateway?}, ...]}` | 404 device |

### 6.5 WebSocket frames (`/ws/events`)

Server pushes JSON; client never sends payloads (only the WS protocol itself).

```json
{ "kind": "packet",
  "id": "evt-12345",
  "ts": 1715000000.123,
  "type": "user_datagram" | "routing_flood" | "ping_request" | "ping_reply",
  "src": { "device": "r1", "iface": "eth0", "address": "200.100.0.1" },
  "dst": { "device": "r2", "address": "200.100.0.254" },
  "network": "lan1",
  "payload": "hello" | null }

{ "kind": "routing_table_changed", "device": "r1", "rules": [...] }

{ "kind": "sim_state", "state": "running" | "paused" | "idle", "ts": ... }

{ "kind": "queue_overflow", "dropped": <int> }
```

### 6.6 Session file persistence

`persistence.py`:

- `prepare_session(source: Path) -> Path` — if `<source>.session.yaml` exists, return it; else clone and return.
- `save_session(path: Path, as_dict: dict) -> None` — serialize via PyYAML, write to `<path>.tmp`, `os.replace`.
- `reset_session(source: Path) -> Path` — delete session, re-clone.

PyYAML round-trip loses formatting and comments — accepted trade-off (sources are read-only; session files are mechanical).

Mutation hooks:
- `POST /topology` → write full new YAML to session file.
- `POST /sim/resume` with patch → apply patch to live AS, then serialize AS back to YAML and write.
- `POST /topology/reset` → delete session, re-clone source, reload AS.

### 6.7 Topology patch format

```json
{ "patch": [
  { "op": "add_network",   "name": "lan4", "address": "10.0.0.0/24" },
  { "op": "remove_network", "name": "lan3" },
  { "op": "add_host",       "name": "h4", "network": "lan4",
                            "address": "10.0.0.10", "gateway": "10.0.0.1" },
  { "op": "remove_host",    "name": "h3" },
  { "op": "add_router",     "name": "r4",
                            "interfaces": [{"name": "eth0", "network": "lan4", "address": "10.0.0.1", "cost": 5}] },
  { "op": "remove_router",  "name": "r3" },
  { "op": "update_cost",    "router": "r1", "iface": "eth0", "cost": 25 }
] }
```

**Validation:** patches are validated against the full live AS *before any mutation*. If any op fails validation, the whole patch is rejected with 400 — no partial application. After validation, ops apply in order.

**Newly-added routers** call `router.start()` as part of `add_router`. The keepalive immediately picks up the gate (still paused at this point), so no spurious sends. On `resume`, the gate opens and the new router floods on its next tick.

### 6.8 Entry point

`src/netrouting.py`:

```python
import sys
if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'shell':
        from shell import Shell
        Shell().cmdloop()
    else:
        from server import run
        run()  # uvicorn :8000, opens browser
```

Web is the default. `python netrouting.py shell` retains the cmd.Cmd REPL for scripting/manual use. README and CLAUDE.md updated accordingly.

### 6.9 Dependencies

Add to `requirements.txt`:
```
fastapi>=0.111
uvicorn[standard]>=0.30
```
(`websockets` is pulled in via `uvicorn[standard]`.)

Add to `.gitignore`:
```
*.session.yaml
```

## 7. Frontend (`web/index.html`)

### 7.1 RuntimeClient module

```js
const RuntimeClient = {
  baseURL: window.location.origin,
  state: 'idle', asName: null,
  ws: null, wsReconnectMs: 500,

  async getTopology(),                          // GET /topology
  async loadTopology(yaml),                     // POST /topology
  async resetTopology(),                        // POST /topology/reset
  async start(), async pause(),
  async resume(patch),                          // POST /sim/resume
  async stop(),
  async getState(),                             // GET /sim/state — used after WS reconnect

  async deviceCommand(name, cmd),               // POST /devices/{name}/command
  async deviceRoutes(name),                     // GET /devices/{name}/routes
  async deviceInterfaces(name),                 // GET /devices/{name}/interfaces

  connectEvents(onEvent),                       // open WS, auto-reconnect
  disconnectEvents(),
};
```

Reconnect: exponential backoff 0.5s → 8s cap. While disconnected, banner: "connection lost — retrying". On reconnect, call `getState()` and resync the UI.

### 7.2 YAML emitter alignment

`exportYaml()` currently wraps under `state.asName`. Change to:

```yaml
as:
  name: <state.asName>
  networks: ...
  hosts: ...
  routers: ...
```

`importYaml()` tightened: expect literal `as:` at top level; read `name:` inside; reject anything else with a clear toast.

### 7.3 Toolbar

```
state=idle    → [ ▶ Start  ]
state=running → [ ■ Stop   ] [ ⏸ Pause  ] [ Chatter ▣ ] [ ↺ Reset ]
state=paused  → [ ■ Stop   ] [ ▶ Resume ] [ Chatter ▣ ] [ ↺ Reset ]
```

- **Primary** (Start/Stop): one DOM element, label/icon swap. State color halo: grey idle → pulsing green running → solid amber paused.
- **Secondary** (Pause/Resume): hidden when idle.
- **Chatter toggle**: hide routing-flood animations (events still received; just not rendered).
- **Reset**: only enabled when idle.

Keyboard: Space = Primary, P = Secondary. Suppressed when focus is inside terminal `<input>`.

### 7.4 Topology lock + patch accumulator

When `state === 'running'`:
- Node drag is no-op (early-return in pointer handlers).
- Add-node toolbar buttons disabled.
- Context menus omit Edit/Delete.

When `state === 'paused'`:
- Editing allowed; each mutation also pushes a patch op to `state.patch`.
- A "(N edits pending)" indicator appears beside Resume.

Resume → `RuntimeClient.resume(state.patch)` → on success, `state.patch = []`.

### 7.5 Packet animation overlay

New SVG group `<g id="packet-layer">` between `edges-layer` and `nodes-layer`.

On WS `packet` event:
1. Look up the src device's node and the network node — these are always adjacent in the rendered graph (device-to-LAN edges).
2. If `evt.dst.device` is on the same network (broadcast or unicast within LAN), animate `src.node → network.node → dst.node` as two sequential CSS `offset-path` transitions.
3. Color the dot by `evt.type`:
   - `routing_flood` → `#94a3b8` 50% opacity
   - `user_datagram` → `#22c55e`
   - `ping_request` → `#f59e0b`
   - `ping_reply` → `#fbbf24`
4. On hover: tooltip with src/dst/payload/timestamp.
5. Auto-remove on animation end.

**Chatter throttle:** track `lastChatterRender[src.iface]`; skip if < 200ms since last. Configurable via toolbar toggle.

**Animation duration:** constant `ANIMATION_DURATION_MS = 600` per hop, decoupled from sim time.

### 7.6 Per-node terminal popup

Double-click on a host or router → open a draggable, resizable floating window pinned near the node.

- Pure DOM: `<div class="term"><pre class="term-out"></pre><span class="term-line"><span class="term-prompt">…</span><input class="term-in"></span></div>`.
- Theme: phosphor green (`#33ff66` on `#0a0a0a`), font stack `"JetBrains Mono", "Geist Mono", ui-monospace, monospace` (JetBrains Mono loaded from the existing Google Fonts CDN block; Geist Mono is already linked as a fallback), block cursor with `@keyframes blink 1s steps(2,start) infinite`.
- Optional subtle CRT scanline overlay (toggleable, default off): `repeating-linear-gradient(rgba(0,0,0,0.04) 0 2px, transparent 2px 4px)`.
- Window controls: drag header, resize SE corner, minimize, close. Position persisted in `localStorage` keyed by device name.
- Multiple terminals open concurrently; independent state.
- Up/Down history per terminal, persisted in `sessionStorage`.
- Client-side commands: `clear` (wipe output), `help` (static text fetched once).
- Server commands: tokenize → `POST /devices/{name}/command {cmd}` → append `{output}` to `term-out`.

Prompt format: `<device>@netrouting:~$ ` in dim green; current input in bright green; output in default green; errors in red.

### 7.7 Inspector "Routing table" section

When sim is running/paused and a device is selected, the right inspector pane gains a "Routing table" section showing `[{prefix, next_hop, iface}, ...]`. Re-fetches on `routing_table_changed` events for the selected device. Hidden when idle or when nothing is selected.

## 8. Test plan (TDD: red → green → refactor)

Every change starts with a failing test. Run `pytest` after every change per CLAUDE.md. New test files complement existing ones (`test_thread_resilience.py` etc.) — no existing test changes.

### 8.1 `test/test_pause_gate.py`

- gate starts in running state
- `pause()` → `Interface._pkt_loop` doesn't dispatch new packets (put 3 frames, assert receiver got 0 after 100ms)
- `pause()` → `Network._pkt_loop` doesn't dispatch (same shape)
- `pause()` → keepalive loop doesn't tick (subscribe to events, assert no `routing_flood` for 2× KEEPALIVE_INTERVAL while paused)
- `resume()` → all pending work drains in expected order
- multiple pause/resume cycles (4×) — no leaks, no double-dispatch
- pause while a packet is mid-dispatch (already past the gate): packet completes; next blocks
- threads blocked on the gate all unblock on resume (use 10 interfaces, assert all dispatch within 50ms of resume)
- `pause()` is idempotent (calling twice in a row is a no-op)
- `resume()` is idempotent
- `stop` while paused wakes blocked threads within 100ms (uses the second `stopped` event)
- `gate.wait_or_stop(timeout=0.05)` returns `(False, False)` when paused and timeout expires (so callers can poll)
- after `AS.stop()`, all worker threads exit within 2s (`threading.enumerate()` before/after)

### 8.2 `test/test_event_subscribers.py`

- `EventTracer.subscribe(fn)` returns an unsubscribe callable
- broadcast fires `fn` once per simulator event
- two subscribers both receive every event in registration order
- exception in subscriber A doesn't suppress subscriber B
- exception in subscriber A is logged but doesn't propagate to producer (test by triggering a real packet send and asserting it completes)
- unsubscribing during a broadcast doesn't cause `RuntimeError` (snapshot iteration)
- subscribing during a broadcast: new subscriber misses the current event but gets the next one (documented behavior)
- subscriber that takes 500ms to return: producer thread stalls — assert this is the case so future code doesn't rely on async (contract test)

### 8.3 `test/test_ping.py`

- happy path: `h1.ping(h2.address())` returns RTT > 0 within `PING_TIMEOUT_S`
- ping to self: `h1.ping(h1.address())` succeeds with very small RTT
- unreachable destination: ping to an address in a network with no route returns `None` within `PING_TIMEOUT_S + 200ms`
- after a `Router.stop()` in between: routes vanish, ping returns `None`
- custom timeout: `h1.ping(addr, timeout=0.5)` returns `None` within `0.5 + 100ms`
- concurrent pings from same host (10 parallel, different destinations): all return correct RTTs, no cross-talk
- two pings to the same destination concurrently: distinct seqs, both return RTTs
- late reply after timeout: explicitly inject a `PingReply` to a popped entry — silently dropped, no crash, no state change
- routers drop `PingRequest` and `PingReply`: send one to a router's address, assert no `_handle_message` panic and no reply
- no thread leaks: `threading.enumerate()` before/after a batch of 50 pings has the same set
- ping after pause→resume completes correctly
- ping after `update_cost` reconvergence still routes correctly

### 8.4 `test/test_shell_commands.py`

- `ifconfig <host>` lists the interface + gateway when present
- `ifconfig <host>` omits gateway line when host has none
- `ifconfig <router>` lists all interfaces, sorted by name
- `ifconfig <unknown>` returns the existing "not found" error from `device()`
- `neighbors <router>` lists adjacent routers from the live graph
- `neighbors <router>` returns "no neighbors yet" before first keepalive
- `neighbors <isolated_router>` returns empty list
- `ping <src> <dst>` returns RTT line
- `ping <src> <dst> -W 0.5` respects the timeout flag
- `ping <src> <unreachable>` returns timeout line within bound
- `ping` syntax errors print usage
- all three commands fail with "system not initialized" before `read`

### 8.5 `test/test_server_lifecycle.py`

Uses `fastapi.testclient.TestClient`.

- `POST /topology {yaml: valid}` returns 200, `state=idle` post-load
- `POST /topology {yaml: malformed}` returns 400 with `ParsingException` message
- `POST /topology` while running stops the previous AS first (assert prior threads gone)
- `POST /sim/start` from idle → 200, state=running
- `POST /sim/start` from running → 200 (idempotent), state=running
- `POST /sim/pause` from idle → 409
- `POST /sim/pause` from running → 200, state=paused
- `POST /sim/resume` from running → 409
- `POST /sim/resume` from paused (no patch) → 200, state=running
- `POST /sim/stop` from idle → 200 (idempotent)
- `POST /sim/stop` from running → 200, threads joined within 2s
- `POST /sim/stop` from paused → 200, threads joined within 2s
- `GET /sim/state` reflects each transition correctly
- session file exists after first `POST /topology` (clone happened)
- session file content matches in-memory state after a patched resume
- `POST /topology/reset` from idle → re-clones from source, replaces session file
- `POST /topology/reset` from running → 409
- two concurrent `POST /sim/start` requests: only one succeeds, no double-start (state lock)
- session file path is `<source>.session.yaml` not the source itself (source mtime unchanged after mutations)

### 8.6 `test/test_server_commands.py`

For each command (`route`, `send`, `update_cost`, `ifconfig`, `neighbors`, `ping`):

- happy path returns `{ok: true, output: <str>}`
- output matches the shell command's output byte-for-byte (regression guard against drift)

Plus:
- unknown device → 404
- empty command string → 400
- unknown command → 200 with `{ok: false, output: "unknown command: ..."}`
- `send h1 h2 hello with spaces` (multi-token payload) — payload normalized per existing shell semantics
- `update_cost r1 eth0 -1` → 400 (existing validation)
- `ping h1 h2 -W abc` → 400 (timeout flag parse)
- `route` with a device that has no rules yet → 200 with empty table
- commands when sim is idle: read-only commands work, mutations return 409

### 8.7 `test/test_server_events.py`

Uses `TestClient.websocket_connect("/ws/events")`.

- `POST /sim/start` → receive `sim_state {state: "running"}`
- send a user datagram → receive at least one `packet {type: "user_datagram", src..., dst...}` frame
- ping → receive `ping_request` and `ping_reply` frames
- routing keepalive → within KEEPALIVE_INTERVAL, receive `routing_flood` frames
- `update_cost` triggers a `routing_table_changed` event after reconvergence
- two concurrent WS clients both receive the same events
- pause → no further `packet` frames; only `sim_state {paused}`
- resume → `sim_state {running}` then packet frames resume
- event payload schema: every frame has `kind`, `ts`; `packet` frames have `id`, `type`, `src`, `dst`
- queue overflow: slow consumer drops oldest events; `queue_overflow` frame reports count
- WS disconnect mid-stream: server cleans up subscriber set (no leak; create+close 100 connections, assert subscriber count = 0)

### 8.8 `test/test_topology_patch.py`

- empty patch → resume succeeds, no mutation
- `add_network` → AS contains the new network after resume; routers' graphs converge to include it
- `remove_network` with active hosts → 400 (or cascading remove, decided in §10)
- `add_host` to existing network → reachable via ping from other hosts after reconvergence
- `add_host` to unknown network → 400, sim still paused, no partial mutation
- `add_router` with valid interfaces → joins routing, floods on resume
- `add_router` with conflicting address → 400
- `remove_host` for host with no in-flight packets → AS no longer contains it
- `remove_router` → other routers' routes drop within 2× keepalive
- `update_cost` for unknown iface → 400
- mixed patch (add_network + add_host on that network): both applied atomically
- patch validation runs *before* any mutation: a 5-op patch with op[3] invalid leaves AS unchanged
- session file reflects post-patch state byte-for-byte equal to a fresh `exportYaml` of the AS
- reconvergence: after a patch that changes link costs, routing tables converge within `2 × KEEPALIVE_INTERVAL` (assertion polls with timeout)

### 8.9 Frontend manual smoke test (documented; not automated)

A checklist committed alongside `web/index.html` (or in the design doc) listing the golden path:
1. Load sample topology, click Start
2. See routing-flood dots animate within 10s
3. Open terminal on h1, run `ifconfig`, `ping h2`
4. See ping_request/ping_reply dots animate
5. Click Pause; add a new router via canvas; click Resume
6. See `routing_table_changed` updates and new routing table in inspector
7. Click Stop; reload page; topology still loads from session file
8. Click Reset; topology reverts to sample

## 9. Phasing (commit boundaries)

Each phase lands as a working set of commits with green tests and lint. The user can pause after any phase and have a useful artifact.

| Phase | Scope | Lands |
|-------|-------|-------|
| 1 | Simulator additions: `PauseGate`, event broadcast, ping, new shell commands | 6–8 commits, all on simulator side |
| 2 | FastAPI backend, session-file model, new entry point, deps | 5–7 commits, backend runnable end-to-end |
| 3 | SPA runtime core: RuntimeClient, toolbar, lock, WS, YAML alignment | 1–2 commits |
| 4 | Packet animation overlay + chatter throttle | 1 commit |
| 5 | Per-node terminals + phosphor theme | 1 commit |
| 6 | Inspector live updates + polish + reset | 1 commit |

## 10. Open questions / decided-later

- **`remove_network` with active devices**: cascading remove vs. 400. Defer to Phase 2 — pick when implementing patch validation.
- **Playwright SPA tests**: future work after the surface stabilizes.
- **TLS / auth**: out of scope (local dev tool).
- **Multi-AS topologies**: out of scope.

## 11. Risks

- **PyYAML round-trip loses formatting/comments** — accepted; sources are read-only.
- **`EventTracer` broadcast on producer thread** — slow subscribers stall packet dispatch. The server's `EventBus.emit` is the only subscriber and is non-blocking. Documented in test_event_subscribers.py contract test.
- **Routing-flood UI clutter** — mitigated by chatter throttle (visual only; WS still receives every event for correctness).
- **WS overflow under burst** — server drops oldest with a `queue_overflow` frame so the client can warn.
- **CLAUDE.md drift after big refactor** — every phase's last commit includes doc updates per CLAUDE.md's "After touching code" rule.
