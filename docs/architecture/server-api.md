# Server API

The FastAPI app exposes three REST families and one WebSocket. All routes
live under `src/server/routes/` and share the application state attached
to `request.app.state`:

| Attribute | Type | Lifecycle |
|---|---|---|
| `app.state.sim_state` | `SimState` | One per process, created in `create_app()` |
| `app.state.event_bus` | `EventBus` | One per process; loop attached in `lifespan` |

`SimState` owns the live `AS`, the session file path, and the
state-machine lock. `EventBus` fans worker-thread events out to all
connected WebSockets.

The default bind is `127.0.0.1:8000` (override with `LOOM_PORT`). The
SPA is served from `/` via `StaticFiles(directory="web", html=True)`.

---

## `GET /topology`

Read the current session YAML.

**Response**

```json
{ "yaml": "as:\n  name: ...\n..." }
```

Reads `<source>.session.yaml` directly from disk; no parse, no
validation. Use this for round-tripping the canvas through the server.

---

## `POST /topology`

Load a new topology, replacing the current one.

**Request**

```json
{ "yaml": "<full YAML text>" }
```

**Behavior**

1. Write the body to `session_path` atomically (temp file + rename).
2. `SimState.load_from_session()` parses it and replaces the AS.
3. Routers are parsed-started by `Parser`, then stopped to enforce
   `idle` semantics.

**Responses**

- `200`:
  ```json
  {
    "ok": true,
    "as_name": "test_as",
    "devices": ["h1", "h2", "h3", "r1", "r2", "r3"],
    "networks": ["lan1", "lan2", "lan3"]
  }
  ```
- `400` `{"detail": "..."}` — invalid YAML or parse/validation failure.

---

## `POST /topology/reset`

Drop the session file and re-clone from the source.

**Behavior**

- Returns `409` if the sim is not `idle` (`"stop the simulation before reset"`).
- Deletes `<source>.session.yaml` and calls `prepare_session(source)` to
  re-clone.
- Reloads the AS from the fresh session.

**Response**

```json
{ "ok": true, "as_name": "..." }
```

The SPA wires this to the toolbar's **Reset** button.

---

## Sim lifecycle: `POST /sim/{start,pause,resume,stop}`

The state machine lives in `SimState`:

```
idle ──/sim/start──► running ──/sim/pause──► paused
                       ▲                       │
                       │                       │
                       └────/sim/resume◄───────┘
running, paused ─────/sim/stop─────► idle
```

All four endpoints return `{"state": <new>}` and emit a
`{"kind": "sim_state", "state": <new>}` event on the WebSocket.

On a state-machine violation (e.g. pause from `idle`), they return
`409 Conflict` with the underlying `InvalidStateTransition` message.

### `POST /sim/start`

`idle → running`. Resumes the `PauseGate`, starts every router's
keepalive. Errors `409` if not idle, or if no topology is loaded.

### `POST /sim/pause`

`running → paused`. Calls `PauseGate.pause()`. Workers block at their
next `wait_or_stop`; in-flight frames stay queued.

### `POST /sim/resume`

`paused → running`. Accepts an optional **patch** in the body:

```json
{ "patch": [
    {"op": "add_network", "name": "lan4", "address": "10.0.0.0/24"},
    {"op": "add_host",    "name": "h4",   "network": "lan4", "address": "10.0.0.10", "gateway": "10.0.0.1"},
    {"op": "add_router",  "name": "r4",   "interfaces": [
        {"name": "eth0", "network": "lan4", "address": "10.0.0.1", "cost": 5}
    ]},
    {"op": "update_cost", "router": "r1", "iface": "eth0", "cost": 25},
    {"op": "remove_host",   "name": "hX"},
    {"op": "remove_router", "name": "rX"},
    {"op": "remove_network","name": "lanX"}
] }
```

Patches are applied in **two phases**:

1. `_validate_op` is called for every op. Any failure raises `400
   Bad Request` with the underlying reason — and **no op is applied**.
2. `_apply_op` is called for every op. If a phase-2 failure occurs
   (rare, since phase 1 validated everything), the patch is partially
   applied — that's a bug class the validator is meant to prevent.

Status code rules (see `routes/sim.py`):

- `409` if the sim is not in `paused` state (true state-machine violation).
- `400` for patch validation errors — these use pseudo-state names
  (`"network_in_use"`, `"duplicate_name"`, etc.) which the dispatcher
  maps to `400`.

### `POST /sim/stop`

Any state → `idle`. Drops the AS entirely. The next `/sim/start` requires
a fresh `/topology` load (or the existing session if you haven't
reloaded).

### `GET /sim/state`

```json
{ "state": "running", "as_name": "test_as" }
```

`as_name` is `null` when no topology is loaded.

### `POST /sim/refresh_interval`

Change the routing-protocol keepalive interval **live**.

**Request**

```json
{ "seconds": 30 }
```

- Must be a number (int or float, not bool).
- Range `[1, 300]` — enforced server-side as `REFRESH_MIN=1`,
  `REFRESH_MAX=300`. Errors `400` outside range.
- Requires `as_obj is not None` (sim must be loaded), else `409`.

Applied via `proto.set_timers(hello_interval=..., lsa_refresh_interval=seconds)` on every
router. The change takes effect at the next sleep boundary of each
router's protocol thread — at most one current-interval's delay.

---

## Device routes: `/devices/{name}/...`

Three endpoints, all device-scoped. Each begins with the standard "look
up the device or 404" guard:

```python
s = request.app.state.sim_state
if s.as_obj is None:
    raise HTTPException(409, "no topology loaded")
try:
    return s.as_obj.device(name)
except Exception:
    raise HTTPException(404, f"unknown device: {name}")
```

`AS.device(name)` tries host then router; either match works.

### `POST /devices/{name}/command`

The terminal endpoint. The SPA's terminal popups POST shell-like commands
here.

**Request**

```json
{ "cmd": "ping h2 -W 2" }
```

**Response**

```json
{ "ok": true,  "output": "ping h2 (100.200.0.20): time=2.34 ms" }
```

or

```json
{ "ok": false, "output": "unknown command: foo" }
```

Dispatch lives in `server/command/dispatch.py`. The `cmd` field is
split with `shlex.split`, the first token is the command name, the rest
are arguments. The handler resolves to `server.command.host` (for hosts)
or `server.command.router` (for routers) and calls
`cmd_<name>(device, args, as_obj)`.

Supported commands per device kind:

| Device | Commands |
|---|---|
| Host | `ifconfig`, `send <dst> <msg>`, `ping <dst> [-W <seconds>] [-c <n>]`, `route`, `set_gateway <ip>`, `help` |
| Router | `ifconfig [<iface> up\|down]`, `route`, `update_cost <iface> <cost>`, `neighbors`, `halt`, `resume`, `help` |

**`ifconfig [<iface> up|down]` (router)**

With no arguments, shows all interfaces. With `<iface> up` or `<iface> down`, changes that interface's admin state: bringing it down stops traffic in both directions and triggers a graceful LSA re-flood omitting the link; bringing it back up re-announces the link immediately.

**`halt` (router)**

Gracefully disables all interfaces — floods a withdrawal LSA so peers purge the router immediately — and marks the router as halted. No traffic is forwarded.

**`resume` (router)**

Re-enables all previously halted interfaces and re-announces the router's links via a fresh LSA flood. Symmetrical to `halt`.

**`ping <dst> [-W <seconds>] [-c <n>]` (host)**

Sends one `PingRequest` per probe. `-W` sets the per-probe timeout (default 3 s); `-c` sets the probe count (default 1, max 100). Output includes one line per probe followed by a summary:

```
h2 (100.200.0.20): time=2.34 ms
h2 (100.200.0.20): time=1.87 ms
--- h2 ping statistics ---
2 sent, 2 received, 0% loss
```

`<dst>` in host commands accepts either a hostname (resolved via
`as_obj.host(dst).address()`) or a literal IP. Falling back to a literal
IP is what makes `ping 10.0.0.1` work even if no host has that name.

Unknown commands return `{"ok": false, "output": "unknown command: ..."}`
with HTTP 200 — failure is in the payload, not the status code, so the
SPA terminal can render an error line uniformly with successful output.

### `GET /devices/{name}/interfaces`

```json
{
  "halted": false,
  "interfaces": [
    { "name": "eth0", "address": "200.100.0.1", "network": "lan1", "cost": 10, "up": true },
    { "name": "eth1", "address": "100.200.0.1", "network": "lan2", "cost": 15, "up": false },
    ...
  ]
}
```

`halted` is `true` when a router has been halted (all interfaces forcibly
down via the `halt` command or a graceful stop). `up` reflects the
per-interface admin state: `false` means the interface has been brought
down (either individually or as part of a halt). For hosts, `halted` is
always `false` and `up` is always `true`.

### `POST /devices/{name}/fail`

Simulate a crash — silently kills the device without a graceful LSA
withdrawal. Peers learn the router is gone only via the Hello dead
interval or LSA max-age expiry.

**Request** (optional body)

```json
{ "interface": "eth0" }
```

With no body (or `null` interface), the entire router is failed (all
interfaces taken down). With an `interface` name, only that interface
is failed.

**Error codes**

- `400` — device is a host (hosts cannot be failed).
- `404` — unknown device name, or unknown interface name on the router.

**Response**

```json
{ "ok": true }
```

This endpoint is not exposed as a terminal command and is not available
in the shell. It is intended for fault-injection scenarios — test
scripts and future automation.

### `GET /devices/{name}/routes`

```json
{ "rules": [
    { "prefix": "200.100.0.0/24", "next_hop": "0.0.0.0", "iface": "eth0" },
    ...
] }
```

For hosts, `routing_table` is absent, so this returns `{"rules": []}`.
For routers, the rules are dumped as currently held by
`router.routing_table()`. `next_hop` is `"0.0.0.0"` for directly-
connected prefixes (`NullAddress` stringifies to that).

---

## `WS /ws/events`

The event stream. The SPA connects on page load and reconnects with
exponential backoff (initial 500 ms, max 8 s).

**Connection lifecycle**

1. Client connects, server `accept()`s.
2. Server subscribes a fresh `asyncio.Queue` to the `EventBus`.
3. Server loops: `event = await queue.get(); ws.send_json(event)`.
4. Client disconnects → `WebSocketDisconnect` → server unsubscribes the
   queue and closes.

**Event shapes**

```json
{ "kind": "sim_state", "state": "running" }
```

```json
{
  "kind": "packet",
  "type": "user_datagram" | "routing_flood" | "ping_request" | "ping_reply" | "unknown",
  "payload_id": "0d7c...e9",
  "payload_src": "200.100.0.10",
  "payload_dst": "100.200.0.20",
  "flow": "100.200.0.20<->200.100.0.10",
  "src":  { "device": "h1", "iface": "iface_h1", "address": "200.100.0.10" },
  "dst":  { "address": "200.100.0.1" },
  "network": "lan1"
}
```

```json
{
  "kind": "routing_table_changed",
  "device": "r1",
  "rules": [
    { "prefix": "200.100.0.0/24", "next_hop": "0.0.0.0", "iface": "eth0" },
    ...
  ]
}
```

```json
{ "kind": "interface_state_changed", "device": "r1", "interface": "eth0", "up": false }
```

Emitted whenever a single interface's admin state changes (up or down),
whether triggered by `ifconfig <iface> down/up`, `halt`, `resume`, or
`POST /devices/{name}/fail`.

```json
{ "kind": "device_state_changed", "device": "r1", "up": false }
```

Emitted when the router-level state flips (halt sets `up: false`;
resume sets `up: true`). A single `halt` emits one `device_state_changed`
plus one `interface_state_changed` per interface.

```json
{ "kind": "ping_result", "device": "h1", "dst": "100.200.0.20", "seq": 1, "rtt_ms": 2.34 }
```

Emitted once per probe from `Host.ping`, regardless of whether the ping
was issued from the terminal or the shell. `rtt_ms` is `null` on timeout.
`seq` is a 1-based counter that resets on each `ping` call.

Notes:

- `payload_id` identifies a **single direction** of a flow (a single
  `Message` instance); a `PingRequest` and its `PingReply` carry
  different `payload_id`s.
- `flow` is the sorted endpoint pair `"min<->max"`; both directions of
  a ping share the same `flow`. The SPA's `packets.js` uses this to
  sequence the request animation before the reply.
- `src.device` may be `null` if the interface has not yet been attached
  to a device (a brief window during topology load — rare in normal
  usage).

**Overflow behavior**

Each subscribed queue is capped at 1000 events. On overflow the **oldest
event is dropped** and `EventBus.overflow_count` is incremented. There
is no overflow signal on the wire — a slow client just loses old packet
animations. The routing-table-changed and sim-state events are emitted
much less frequently and rarely overflow.

---

## End-to-end usage example

```bash
# Load a topology
curl -X POST http://127.0.0.1:8000/topology \
     -H 'Content-Type: application/json' \
     -d '{"yaml": "as:\n  name: tiny\n  networks:\n    lan1: \"10.0.0.0/24\"\n  hosts:\n    h1: { network: lan1, address: \"10.0.0.10\" }\n"}'

# Start the sim
curl -X POST http://127.0.0.1:8000/sim/start

# Inspect routing
curl http://127.0.0.1:8000/devices/h1/interfaces
curl http://127.0.0.1:8000/devices/h1/routes

# Run a command on the device
curl -X POST http://127.0.0.1:8000/devices/h1/command \
     -H 'Content-Type: application/json' \
     -d '{"cmd": "ping 10.0.0.10"}'

# Stop
curl -X POST http://127.0.0.1:8000/sim/stop
```

For the patch-while-paused flow:

```bash
curl -X POST http://127.0.0.1:8000/sim/pause
curl -X POST http://127.0.0.1:8000/sim/resume \
     -H 'Content-Type: application/json' \
     -d '{"patch": [{"op": "update_cost", "router": "r1", "iface": "eth0", "cost": 99}]}'
```
