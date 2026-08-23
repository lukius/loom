# Server API

The app is assembled by `create_app()` in
[`src/server/app.py`](../../src/server/app.py). It exposes four REST
families (`/topology*`, `/samples*`, `/sim/*`, `/devices/*`) and one
WebSocket (`/ws/events`), all defined under
[`src/server/routes/`](../../src/server/routes). The default bind is
`127.0.0.1:8000`, overridable with `LOOM_PORT`.

## Application state

Route handlers need to reach objects that live for the whole process:
the running simulation, the event fan-out, the samples directory.
FastAPI provides `app.state` for this. It is a plain namespace object
hanging off the application instance, and anything `create_app()` assigns
to it is reachable from any handler through the request, as
`request.app.state.<name>`. It is the framework's answer to module-level
globals, and it is what keeps the routes testable: a test builds its own
app with its own state rather than reaching into a shared module.

Three attributes are assigned:

| Attribute | Type | Lifecycle |
|---|---|---|
| `app.state.sim_state` | `SimState` | One per app. Owns the live `AS`, the session file path, and the state-machine lock |
| `app.state.event_bus` | `EventBus` | One per app. Fans worker-thread events out to every connected WebSocket; its asyncio loop is attached in `lifespan` |
| `app.state.samples_dir` | `Path` | Resolved from `LOOM_SAMPLES`, defaulting to `<repo>/samples`. Read only by the `/samples` routes |

The `lifespan` context manager joins the threaded and async halves at
startup: it hands the running asyncio loop to the `EventBus`, then
subscribes `EventBus.emit` to the `EventTracer` so simulator events reach
connected clients. Shutdown unsubscribes and detaches the loop, which
turns any late emit into a safe no-op.

## Serving the SPA

After every API router is registered, `create_app()` mounts the SPA at
the root:

```python
app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
```

`StaticFiles` is Starlette's static-file application: it maps a URL path
onto files under `directory` and serves them directly, with no route
handler of its own. `html=True` puts it in single-page-app mode, so a
request for a directory, `/` included, returns that directory's
`index.html` instead of a listing or a 404. That is what makes
`http://127.0.0.1:8000/` load the SPA.

Two details of that line are important. It is mounted last, because
routes match in registration order and a mount at `/` would otherwise
shadow every API route above it. And it is guarded by
`web_dir.exists()`, so a checkout with no `web/` directory still starts
and still serves the API.

---

## Topology routes

### `GET /topology`

Read the current topology as YAML.

**Response**

```json
{ "yaml": "internet:\n  name: ...\n..." }
```

When a topology is loaded (`as_obj is not None`), returns the
re-serialized live state via `SimState._dump_yaml()`, not the
session file read verbatim. When no topology is loaded, the
raw session-file text is returned instead.

---

### `POST /topology`

Load a new topology, replacing the current one.

**Request**

```json
{ "yaml": "<full YAML text>" }
```

**Behavior**

Parse-then-commit via `SimState.load_from_text()`:

1. Write the YAML to a temporary file in the same directory as the
   session file.
2. `Parser(tmp_path).parse(start_routing=False)` validates and builds the
   AS. On any parse/validation failure the exception propagates, the
   temporary file is deleted, and the session file is left untouched.
3. On success, the temporary file is atomically moved to `session_path`
   (replacing any prior content), and the live AS is swapped in.

Routers are built but not started, so no routing events fire until
`/sim/start` is called.

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
- `400` `{"detail": "..."}`, invalid YAML or parse/validation failure.
- `409` `{"detail": "stop the simulation before importing a topology"}`,
  sim is not `idle`.

---

### `GET /topology/source`

Return the basename of the topology source file (`LOOM_TOPOLOGY` env var).

**Response**

```json
{ "name": "sample.yaml" }
```

Consumers may use this as a default filename stem (e.g. for export
dialogs). The value is the `Path.name` of the source, not a full path.

---

### `POST /topology/reset`

Drop the session file and re-clone from the source.

**Behavior**

- Returns `409` if the sim is not `idle` (`"stop the simulation before reset"`).
- Re-clones the source onto the session path and reloads the AS
  (`start_routing=False`).

**Response**

```json
{ "ok": true, "as_name": "..." }
```

---

## Sample-file routes

Read-only endpoints that enumerate and serve `*.yaml` files from the
configured samples directory (default `<repo>/samples`, overridable via
`LOOM_SAMPLES` env var). Session clones (`*.session.yaml`) are filtered out.

### `GET /samples`

```json
{ "files": ["sample.yaml", "small.yaml"] }
```

Returns an alphabetically-sorted list of bare filenames. Returns
`{"files": []}` when the samples directory does not exist or is empty.

### `GET /samples/{filename}`

```json
{ "yaml": "<full YAML text>" }
```

Names containing `/` or `\`, or equal to `""`, `"."`, or `".."` return
`400`; a `.` inside a name is allowed (so
[`sample.yaml`](../../samples/sample.yaml) loads normally). A well-formed
name that does not exist in the samples directory returns `404`. Note that
`GET /samples` lists files with both `.yaml` and `.yml` extensions.

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

`/sim/start`, `/sim/pause`, `/sim/resume`, and `/sim/stop` each return
`{"state": <new>}` and emit a `{"kind": "sim_state", "state": <new>}`
event on the WebSocket. `/sim/edit` (below) does not change state and
does not emit `sim_state`. `/sim/stop` from `idle` is a no-op that
returns `200 {"state": "idle"}` and emits `sim_state` for consistency.

On a state-machine violation (e.g. pause from `idle`), the lifecycle
endpoints return `409 Conflict` with the underlying
`InvalidStateTransition` message.

### `POST /sim/start`

`idle → running`. Resumes the `PauseGate` and starts every router's
protocol thread. Errors `409` if not idle or if no topology is loaded.

### `POST /sim/pause`

`running → paused`. Calls `PauseGate.pause()`. Workers block at their
next gate wait; in-flight frames stay queued.

### `POST /sim/resume`

`paused → running`. Accepts an optional patch in the body:

```json
{ "patch": [
    {"op": "add_network", "name": "lan4", "address": "10.0.0.0/24"},
    {"op": "add_link",    "name": "lnk1", "address": "10.0.0.0/30"},
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

Patches are applied in two phases:

1. `_validate_op` is called for every op. Any failure raises `400
   Bad Request` with the underlying reason; no op is applied.
2. `_apply_op` is called for every op. If a phase-2 failure occurs
   (rare, since phase 1 validated everything), the patch is partially
   applied: that's a bug class the validator is meant to prevent.

Status code rules (see [`routes/sim.py`](../../src/server/routes/sim.py)):

- `409` if the sim is not in `paused` state (true state-machine violation).
- `400` for patch validation errors: these use pseudo-state names
  (`"network_in_use"`, `"duplicate_name"`, etc.) which the dispatcher
  maps to `400`.

### `POST /sim/edit`

Apply a topology patch to a running simulation without pausing.

**Request**

```json
{ "patch": [
    {"op": "add_network", "name": "lan4", "address": "10.0.0.0/24"},
    {"op": "add_link",    "name": "lnk1", "address": "10.0.0.0/30"},
    {"op": "add_host",    "name": "h4",   "network": "lan4", "address": "10.0.0.10", "gateway": "10.0.0.1"},
    {"op": "add_router",  "name": "r4",   "interfaces": [
        {"name": "eth0", "network": "lan4", "address": "10.0.0.1", "cost": 5}
    ]},
    {"op": "update_cost", "router": "r1", "iface": "eth0", "cost": 25},
    {"op": "remove_host",    "name": "hX"},
    {"op": "remove_router",  "name": "rX"},
    {"op": "remove_network", "name": "lanX"}
] }
```

The same op set as `/sim/resume`'s patch parameter. All ops are
validated before any is applied (validate-all-then-apply-all).

**Behavior**

`SimState.edit(patch)` acquires `_edit_lock`, validates every op
with `_validate_op`, then applies every op with `_apply_op`. The
lock is released on success or on any failure. The fabric dispatch hot
paths read interface snapshots (`list(self._interfaces.values())`) so a
concurrent edit can never trigger a "dict changed size" error.

On success, a `topology_changed` event is broadcast on the WebSocket (see
[`WS /ws/events`](#ws-wsevents)).

**Status codes**

- `200 {"state": "running"}`, patch applied.
- `400 {"detail": "..."}`, one or more ops failed validation; no op
  was applied.
- `409 {"detail": "invalid transition: <state> -> edit"}`, sim is not
  in the `running` state (the message follows the standard
  `InvalidStateTransition` format).

---

### `POST /sim/stop`

Any state → `idle`. Drops the AS entirely. The next `/sim/start` requires
a fresh `/topology` load (or the existing session if you haven't
reloaded). If already `idle`, returns `200` without error.

### `GET /sim/state`

```json
{ "state": "running", "as_name": "test_as" }
```

`as_name` is `null` when no topology is loaded.

### `POST /sim/protocol_config`

Change the routing-protocol timers live: no restart required.

**Request**

```json
{ "hello_interval": 5, "lsa_refresh_interval": 15 }
```

- Both `hello_interval` and `lsa_refresh_interval` are required.
- Both must be positive numbers (int or float, not bool). `400` on
  invalid or non-positive values.
- Requires `as_obj is not None` (sim must be loaded), else `409
  {"detail": "no system loaded"}`.

Applied via `proto.set_timers(hello_interval=..., lsa_refresh_interval=...)`
on every router's `LinkStateProtocol` instance. The change takes effect
at the next sleep boundary of each router's protocol thread.

**Response**

```json
{ "ok": true, "hello_interval": 5.0, "lsa_refresh_interval": 15.0 }
```

The updated values are reflected in the next `GET /topology` response.

---

## Device routes: `/devices/{name}/...`

Five endpoints, all device-scoped. Each begins with a device lookup
under `_lock` via `SimState.device_under_lock()`, the `None`-check
and the `device()` call are atomic, so a concurrent `stop()` cannot
null `_as` between them:

- `409 {"detail": "no topology loaded"}`, `_as is None`.
- `404 {"detail": "unknown device: <name>"}`, `device(name)` raised
  `EntityException` (covers both `HostNotFoundException` and
  `RouterNotFoundException`).

`AS.device(name)` tries hosts then routers; either match works.

### `POST /devices/{name}/command`

The terminal endpoint. Dispatches shell-like commands to a device.

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

Dispatch lives in
[`server/command/dispatch.py`](../../src/server/command/dispatch.py). The
`cmd` field is split with `shlex.split`, the first token is the command
name, the rest are arguments. The handler resolves to `server.command.host`
(for hosts) or `server.command.router` (for routers) and calls
`cmd_<name>(device, args, as_obj)`.

Supported commands per device kind:

| Device | Commands |
|---|---|
| Host | `ifconfig`, `send <dst> <msg>`, `ping <dst> [-W <seconds>] [-c <n>] [-i <seconds>]`, `route`, `set_gateway <ip>`, `help` |
| Router | `ifconfig [<iface> up\|down]`, `route`, `update_cost <iface> <cost>`, `neighbors`, `halt`, `resume`, `help` |

The four commands with behaviour worth spelling out:

#### `ifconfig [<iface> up|down]` (router)

With no arguments, shows all interfaces. With `<iface> up` or `<iface>
down`, changes that interface's admin state. Bringing it down stops
traffic in both directions and triggers a graceful LSA re-flood that
omits the link; bringing it back up re-announces the link immediately.

#### `halt` (router)

Gracefully disables all interfaces, floods a withdrawal LSA so peers
purge the router immediately, and marks the router as halted. No traffic
is forwarded afterwards.

#### `resume` (router)

Re-enables all previously halted interfaces and re-announces the router's
links via a fresh LSA flood. Symmetrical to `halt`.

#### `ping <dst> [-W <seconds>] [-c <n>] [-i <seconds>]` (host)

Sends one `PingRequest` per probe. `-W` sets the per-probe timeout
(default 3 s); `-c` sets the probe count (default 1, max 100); `-i` sets
the inter-probe interval in seconds (default 1, like real ping; max 60;
use `-i 0` for a back-to-back burst). The interval wait goes through the
AS `PauseGate`, so it pauses with the simulation and aborts on stop. The
endpoint returns only the summary; per-probe lines are broadcast as
`ping_result` events. Output summary:

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
with HTTP 200, failure is in the payload, not the status code.

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

Simulate a crash: silently kills the device without a graceful LSA
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

- `400`: device is a host (hosts cannot be failed).
- `404`: unknown device name, or unknown interface name on the router.

**Response**

```json
{ "ok": true }
```

This endpoint is not exposed as a terminal command. It is intended for
fault-injection scenarios: test scripts and future automation.

### `GET /devices/{name}/routes`

```json
{ "rules": [
    { "prefix": "200.100.0.0/24", "next_hop": "0.0.0.0", "iface": "eth0" },
    ...
] }
```

For hosts, returns `{"rules": []}`.
For routers, the rules are dumped as currently held by
`router.routing_table()`. `next_hop` is `"0.0.0.0"` for directly-
connected prefixes (`NullAddress` stringifies to that).

### `GET /devices/{name}/nat-table`

```json
{
  "entries": [
    {
      "rewritten_src": "203.0.113.1",
      "dst": "100.200.0.20",
      "flow_id": "3f7e...",
      "original_src": "10.0.0.10"
    },
    ...
  ]
}
```

Returns the current NAT-table snapshot for a router. Entries are ordered
oldest-first (LRU). For hosts, returns `{"entries": []}`.

Because events on the bus carry only incremental changes, a subscriber
with no prior event history needs this endpoint to recover the current
table state.

---

## `WS /ws/events`

The event stream.

Connection lifecycle

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
  "type": "user_datagram" | "routing_flood" | "ping_request" | "ping_reply" | "hello" | "unknown",
  "payload_id": "0d7c...e9",
  "payload_src": "200.100.0.10",
  "payload_dst": "100.200.0.20",
  "flow": "<conversation-uuid>",
  "src":  { "device": "h1", "iface": "iface_h1", "address": "200.100.0.10" },
  "dst":  { "address": "200.100.0.1" },
  "network": "lan1",
  "payload": { ... }
}
```

`flow` is a UUID string: the conversation key reported by
`payload.flow_key()`. It is stable across NAT address rewrites and is
shared between a `PingRequest` and its corresponding `PingReply` (the
reply echoes the request's id). `payload` is a per-type summary dict:

| `type` | `payload` fields |
|---|---|
| `user_datagram` | `{"bytes": <n>, "text": "<body>"}` (text only when payload is a str) |
| `ping_request` | `{"seq": <n>}` |
| `ping_reply` | `{"seq": <n>, "request_ts": <float>}` |
| `hello` | `{"originator": "<router>", "neighbors_heard": ["<r1>", ...]}` |
| `routing_flood` | `{"seq": <n>, "originator": "<router>", "destinations": [{"prefix": "<cidr>", "cost": <n>}, ...], "attachments": [{"fabric": "<name>", "cost": <n>}, ...]}` |
| `unknown` | `{}` |

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

Emitted once per probe from `Host.ping`. `rtt_ms` is `null` on timeout.
`seq` is a 1-based counter that resets on each `ping` call.

```json
{
  "kind": "topology_changed",
  "ops": [
    {"op": "add_network", "name": "lan4", "address": "10.0.0.0/24"},
    ...
  ]
}
```

Emitted by `SimState.edit()` after a successful live-edit patch. `ops`
is the exact list of ops that was applied.

```json
{
  "kind": "neighbor_state_changed",
  "device": "r1",
  "interface": "eth0",
  "peer": "r2",
  "state": "two_way",
  "last_hello_at": 1234567890.123,
  "peer_acked_at": 1234567890.456
}
```

Emitted by `LinkStateProtocol` whenever a neighbor transitions between
adjacency states (emitted values are lowercase: `"down"`, `"init"`,
`"two_way"`; the enum names in `NeighborState` are uppercase).
`last_hello_at` is the monotonic timestamp of the last Hello heard from
this peer (or `null` before the first Hello); `peer_acked_at` is when the
peer last listed this router in its own `neighbors_heard` list (or `null`
if not yet acknowledged).

```json
{
  "kind": "lsdb_changed",
  "device": "r1",
  "rules": [
    { "prefix": "200.100.0.0/24", "next_hop": "0.0.0.0", "iface": "eth0" },
    ...
  ]
}
```

Emitted by `LinkStateProtocol._emit_rule_change_events` whenever the
link-state graph recomputation produces a new routing table. `rules`
carries the same shape as `routing_table_changed`. `lsdb_changed` fires
at the protocol level (one per `LinkStateProtocol`); `routing_table_changed`
fires immediately after from the same method, at the RIB level.

```json
{
  "kind": "nat",
  "router": "r1",
  "direction": "outbound",
  "original_src": "10.0.0.10",
  "rewritten_src": "203.0.113.1",
  "dst": "100.200.0.20",
  "flow_id": "3f7e...",
  "payload_id": "a1b2..."
}
```

```json
{
  "kind": "nat",
  "router": "r1",
  "direction": "inbound",
  "rewritten_dst": "203.0.113.1",
  "original_dst": "10.0.0.10",
  "src": "100.200.0.20",
  "flow_id": "3f7e...",
  "payload_id": "a1b2..."
}
```

Emitted once per packet at each NAT rewrite. `direction: "outbound"`
fires from `Router._apply_source_nat` when a private-source packet
crosses to a public egress. `direction: "inbound"` fires from
`Router._reverse_inbound_nat` when a return packet's destination is
rewritten back to the original private address. `flow_id` is
`payload.flow_key()`: the conversation UUID shared between request and
reply. `payload_id` identifies this specific `Message` instance.

```json
{
  "kind": "nat_table_changed",
  "device": "r1",
  "entries": [
    {
      "rewritten_src": "203.0.113.1",
      "dst": "100.200.0.20",
      "flow_id": "3f7e...",
      "original_src": "10.0.0.10"
    },
    ...
  ]
}
```

Emitted immediately after every outbound NAT rewrite (from
`Router._apply_source_nat`). `entries` is the full table snapshot in
LRU order (oldest first). Subscribers that need the current NAT state
without polling `GET /devices/{name}/nat-table` can maintain a local
copy by applying each `nat_table_changed` event.

```json
{
  "kind": "router_intercept",
  "router": "r1",
  "originator": "10.0.0.10",
  "pinged_address": "200.100.0.1",
  "received_on": "eth0",
  "owning_iface": "eth1",
  "payload_id": "a1b2..."
}
```

Emitted by a router when it answers an ICMP echo (`PingRequest`)
addressed to one of its own interface IPs. `router` is the router
name. `originator` is the sender's IP address. `pinged_address` is
the destination IP from the incoming request (the router's own
address that was targeted). `received_on` is the name of the
interface the request arrived on. `owning_iface` is the name of the
interface that owns `pinged_address` (may differ from `received_on`
when the request arrived on a different interface than the one holding
the pinged address), or `null` if not found. `payload_id` is the UUID
of the reply `Message` instance.

Notes:

- `payload_id` identifies a single direction of a flow (a single
  `Message` instance); a `PingRequest` and its `PingReply` carry
  different `payload_id`s.
- `flow` in `packet` events is a UUID (the payload's own `flow_key()`).
  Request and reply share the same `flow` value.
- `src.device` may be `null` if the interface has not yet been attached
  to a device (a brief window during topology load: rare in normal
  usage).

Overflow behavior

Each subscribed queue is capped at 1000 events. On overflow the **oldest
event is dropped** and `EventBus.overflow_count` is incremented. There
is no overflow signal on the wire: a slow subscriber simply loses old
events. Routing-table and sim-state events are emitted much less
frequently and rarely overflow.

---

## Patch ops reference

The same op set is accepted by `/sim/resume` (body `patch:`) and
`/sim/edit` (body `patch:`). All ops are validated before any is applied.

| Op | Required fields | Notes |
|---|---|---|
| `add_network` | `name`, `address` | `address` is a CIDR (e.g. `"10.0.0.0/24"`) |
| `add_link` | `name`, `address` | `address` must be `/30` or `/31` |
| `remove_network` | `name` | Fails with `network_in_use` if any host/router interface is on it |
| `add_host` | `name`, `address`, exactly one of `network:` or `link:` | Optional `gateway` |
| `remove_host` | `name` | |
| `add_router` | `name`, `interfaces` | Each interface entry must carry exactly one of `network:` or `link:` |
| `remove_router` | `name` | Stops the protocol thread and detaches all interfaces |
| `update_cost` | `router`, `iface`, `cost` | `cost` must be a positive integer |

`add_host` and `add_router` interface entries each require exactly one of
`network:` or `link:`, providing both or neither raises `invalid_patch`.

---

## End-to-end usage example

```bash
# Load a topology
curl -X POST http://127.0.0.1:8000/topology \
     -H 'Content-Type: application/json' \
     -d '{"yaml": "internet:\n  autonomous_systems:\n    tiny:\n      networks:\n        lan1: \"10.0.0.0/24\"\n      hosts:\n        h1: { network: lan1, address: \"10.0.0.10\" }\n"}'

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

For a live edit while running:

```bash
curl -X POST http://127.0.0.1:8000/sim/edit \
     -H 'Content-Type: application/json' \
     -d '{"patch": [{"op": "update_cost", "router": "r1", "iface": "eth0", "cost": 99}]}'
```

---

## Code references

| Concern | File | Symbol |
|---|---|---|
| App + lifespan wiring | [`src/server/app.py`](../../src/server/app.py) | `create_app` |
| Lifecycle controller | [`src/server/state.py`](../../src/server/state.py) | `SimState` |
| Start / pause / resume / stop | [`src/server/state.py`](../../src/server/state.py) | `SimState.start`, `pause`, `resume`, `stop` |
| Live topology patching | [`src/server/state.py`](../../src/server/state.py) | `SimState.edit` |
| Session file handling | [`src/server/persistence.py`](../../src/server/persistence.py) | none |
| `/sim/*` routes | [`src/server/routes/sim.py`](../../src/server/routes/sim.py) | none |
| `/topology*` routes | [`src/server/routes/topology.py`](../../src/server/routes/topology.py) | none |
| `/devices/*` routes | [`src/server/routes/devices.py`](../../src/server/routes/devices.py) | none |
| `/samples*` routes | [`src/server/routes/files.py`](../../src/server/routes/files.py) | none |
| `/ws/events` | [`src/server/routes/ws.py`](../../src/server/routes/ws.py) | `events` |
| Thread → asyncio bridge | [`src/server/events.py`](../../src/server/events.py) | `EventBus.emit` |
| Terminal command dispatch | [`src/server/command/dispatch.py`](../../src/server/command/dispatch.py) | none |
| Tests | [`test/test_server_commands.py`](../../test/test_server_commands.py), [`test/test_server_lifecycle.py`](../../test/test_server_lifecycle.py) | none |
