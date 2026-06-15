# Architecture Overview

> **Scope:** loom is deliberately L3-only. There is no L2 (MAC/ARP/STP)
> and no L4 (TCP/UDP/ports). The simulator exists to make routing
> convergence and forwarding observable, not to model a full network
> stack.

`loom` is split into four cooperating layers, each with a clear
responsibility and a narrow seam to its neighbors.

```
┌─────────────────────────────────────────────────────────────────┐
│                Web SPA  (web/, native ES modules)               │
│                                                                 │
│  app.js · state.js · canvas.js · inspector.js · terminals.js    │
│  packets.js · packetstore.js · packetspanel.js · sim.js         │
│  yaml-io.js · utils.js · (see web-spa.md for the full map)      │
│                                                                 │
│  State + cross-component events flow through `bus`              │
│  (EventTarget singleton in state.js).                           │
└──────────────────────────────┬──────────────────────────────────┘
                               │   HTTP (REST: /sim, /topology,
                               │             /devices)
                               │   WebSocket (events from server)
┌──────────────────────────────▼──────────────────────────────────┐
│             FastAPI server (src/server/, async)                 │
│                                                                 │
│  routes/    sim.py · topology.py · devices.py · files.py · ws.py │
│  command/   dispatch.py · host.py · router.py                   │
│  state.py   SimState (idle/running/paused) — owns the AS        │
│  events.py  EventBus — bridges worker threads to asyncio        │
│  persistence.py  source.yaml → source.session.yaml clone        │
└──────────────────────────────┬──────────────────────────────────┘
                               │   Python calls (synchronous,
                               │     cross-thread via PauseGate)
┌──────────────────────────────▼──────────────────────────────────┐
│        Simulator core (src/entities/, src/routing/, threaded)   │
│                                                                 │
│  AS  Router  Host  Network  Link  Interface  Address  Packet    │
│  PauseGate   EventTracer                                        │
│  LinkStateProtocol (loom-OSPF; abstract base: RoutingProtocol)  │
│  + LSDB → NetworkGraph (Dijkstra)                               │
│                                                                 │
│  One daemon thread per Interface, one per Network/Link, one     │
│  protocol thread per Router. All gate on PauseGate.             │
└──────────────────────────────┬──────────────────────────────────┘
                               │   parses, validates
┌──────────────────────────────▼──────────────────────────────────┐
│                Parser + Validator (src/parser/)                 │
│                                                                 │
│  Parser.parse()  →  AS  (or raises ParsingException)            │
│  SystemValidator: address, network, link, device, host          │
└─────────────────────────────────────────────────────────────────┘
                               ▲
                               │ reads
                       samples/sample.yaml
                       (or LOOM_TOPOLOGY)
```

## Process / Thread Model

There is one Python process. Inside it:

- One asyncio event loop (Uvicorn + FastAPI). Handles all HTTP and
  WebSocket I/O.
- One **`PauseGate`** owned by the `AS` instance. Every simulator worker
  thread blocks on it once per loop iteration.
- Daemon threads created by the simulator core:

  | Owner | Count | Purpose |
  |---|---|---|
  | `Interface` | 1 per interface | Drain inbound frames, dispatch to its device |
  | `Network` / `Link` (`_FabricBase`) | 1 per fabric | Drain frames sent into the fabric, dispatch to peers |
  | `LinkStateProtocol` | 1 per router | Periodic hello/LSA flood + SPF recompute |

The thread fan-out for a topology with H hosts, R routers, N LANs, L
links, and an average of K interfaces per router is roughly:

```
threads ≈ H                           (one Interface thread per host)
        + R · K                       (Interface threads on routers)
        + N + L                       (one fabric thread per network and link)
        + R                           (one protocol thread per router)
        + 1                           (asyncio loop)
```

For the sample topology (H=3, R=3, K=3, N=3, L=1): about 19 threads plus
the asyncio loop. See [`concurrency.md`](concurrency.md#scaling-characteristics)
for where this curve starts to bite.

## Data Flow: A Host Sends a Message

When `h1` sends a `UserMessage` to `h3` (sample topology), the message
crosses every layer:

```mermaid
sequenceDiagram
  participant U as User (UI terminal)
  participant API as POST /devices/h1/command<br/>(server)
  participant H1 as Host h1
  participant IF1 as h1.interface
  participant LAN1 as Network lan1
  participant R1 as Router r1
  participant LAN2 as Network lan2
  participant H3 as Host h3
  participant WS as WebSocket /ws/events

  U->>API: {"cmd": "send h3 hi"}
  API->>H1: send_message_to(UserMessage("hi"), h3.address)
  H1->>IF1: send_to(Datagram, dst=gateway)
  IF1->>WS: EventTracer emit {"kind":"packet", ...}
  IF1->>LAN1: Frame -> _in_queue
  LAN1->>R1: _dispatch_unicast(Frame) -> r1.eth0.receive(Frame)
  R1->>R1: routing_table.match(h3.address)
  R1->>R1: out_iface = eth1, next_hop = NullAddress -> h3.address
  R1->>WS: EventTracer emit {"kind":"packet", ...}
  R1->>LAN2: Frame -> _in_queue
  LAN2->>H3: _dispatch_unicast(Frame) -> h3.iface.receive(Frame)
  H3->>H3: dst == iface.address -> _handle_message(UserMessage)
  H3->>WS: EventTracer.message_received(...)
```

Two things to notice:

1. **Every packet event hits the WebSocket**, even when the SPA only cares
   about a subset. `EventTracer._broadcast` is non-blocking — subscribers
   exceptions are swallowed and logged so one bad subscriber can't kill
   the rest.
2. **The forwarding decision happens entirely inside `Router`**. The
   fabric (`Network`/`Link`) only knows how to dispatch a frame to its
   peers; it does no routing. `Router._handle_forwarding` runs longest-
   prefix match against its `RoutingTable`, decrements the TTL, and hands
   the next frame to the chosen interface.

See [`packets.md`](packets.md) for the packet types, and
[`routing-protocol.md`](routing-protocol.md) for how the routing table
gets populated in the first place.

## Data Flow: Routing Convergence

When the simulation starts (or any router boots), `LinkStateProtocol._protocol_loop`
ticks once immediately, then on independent hello and refresh cadences
(both live-tunable via the toolbar; see [`routing-protocol.md`](routing-protocol.md)
for details):

```mermaid
sequenceDiagram
  participant R1KA as r1 protocol thread
  participant R1 as Router r1
  participant LAN1 as Network lan1
  participant R2 as Router r2 (LinkStateProtocol)
  participant R2GR as r2's NetworkGraph

  R1KA->>R1: _handle_update()
  R1->>R1: update_state()  (refresh self edges in graph)
  R1->>R1: _rebuild_graph_and_recompute() if graph changed
  R1->>LAN1: For each iface: broadcast RoutingMessage(seq=N)
  LAN1->>R2: deliver frame (broadcast)
  R2->>R2: handle_incoming_message(msg, iface)
  R2->>R2: LSDB.install() -> per-origin dedup by (origin_router, seq)
  R2->>R2GR: rebuild graph from LSDB if InstallResult.changed_graph()
  R2->>R2: changed? -> _recompute_routing_table() via Dijkstra
  R2->>R2KA: emit {"kind":"routing_table_changed", "device":"r2", "rules":[...]}
```

The flood is **receiver-side deduplicated** per origin router: `LSDB.install()`
tracks the last seen sequence number for each origin and drops messages with
`seq <= last_seen_seq`. New messages are re-flooded out of **every interface
except** the one they arrived on.

Routing tables are only recomputed when the graph actually changes —
`_rebuild_graph_and_recompute` calls `_recompute_routing_table` only when
`InstallResult.changed_graph()` is true.
**Preserve that guard** when editing the protocol; without it routing
tables churn on every protocol tick.

## State Machine: SimState

The web layer adds a lifecycle on top of the simulator core. It lives in
`src/server/state.py`:

```mermaid
stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> running: /sim/start
  running --> paused: /sim/pause
  paused --> running: /sim/resume
  running --> idle: /sim/stop
  paused --> idle: /sim/stop
```

(`/topology` and `/topology/reset` are also accepted while idle and
leave the state unchanged — see the rules below.)

Rules enforced by `SimState`:

- **`load_from_session`** stops the previous AS (if any) and parses the
  session file with `start_routing=False`, so routers exist but their
  protocol threads are not started — they wait for `start()`.
- **`start`** resumes the gate and starts every router's protocol thread.
- **`pause`** pauses the gate. In-flight frames remain queued; threads
  block on `wait_or_stop`. No frames are lost.
- **`resume`** applies an optional patch (`add_*` / `remove_*` /
  `update_cost`) atomically — two phases, **validate all → apply all** —
  and re-resumes the gate.
- **`stop`** drops the AS entirely and goes back to `idle`. The next
  `start` requires a topology load.

See [`server-api.md`](server-api.md) for the wire format and
[`concurrency.md`](concurrency.md) for what `PauseGate.pause()` actually
does to the worker threads.

## Event Plumbing

Events flow **out** of the simulator core via the `EventTracer`
class-level pub/sub bus:

```mermaid
sequenceDiagram
  participant WT as Worker thread<br/>(Interface / Protocol)
  participant ET as EventTracer<br/>(class-level)
  participant EB as EventBus
  participant L as asyncio loop
  participant WS as /ws/events handler
  participant SPA as Browser SPA

  Note over WT,ET: thread side (GIL)
  WT->>ET: _broadcast(event)
  ET->>EB: emit(event)
  EB->>L: call_soon_threadsafe(_enqueue, q, event)
  Note over L,SPA: asyncio side (single loop)
  L->>WS: q.put_nowait(event)  per-WS queue
  WS->>SPA: ws.send_json(event)
  SPA->>SPA: bus.dispatchEvent(<br/>'sim:packet' /<br/>'sim:routing-table-changed' /<br/>'sim:status-changed')
```

`EventBus` is a thread-safe fan-out: every WebSocket connection has its
own `asyncio.Queue`, capped at 1000 events. On overflow the **oldest**
event is dropped and `overflow_count` increments. The bus is created at
app startup and shared across the lifespan of the process.

Event kinds currently emitted:

- `packet` — every frame leaving an interface (`Interface.send_to`)
- `routing_table_changed` — every recompute (`LinkStateProtocol._recompute_routing_table`)
- `sim_state` — every state transition (`SimState.start/pause/resume/stop`)
- `device_state_changed` — router halted or resumed (`Router.halt` / `Router.resume`)
- `interface_state_changed` — interface brought up or down (`Interface._emit_state`)
- `lsdb_changed` — LSDB updated with a new LSA (`LinkStateProtocol`); emitted but currently unconsumed by the SPA
- `neighbor_state_changed` — adjacency state changed (`LinkStateProtocol._broadcast_neighbor_state_changed`)
- `ping_result` — one ICMP echo reply or timeout (`Host.ping`)
- `topology_changed` — topology mutated via a live edit (`SimState.edit`)
- `nat` — a router performed source or destination NAT (`Router._apply_source_nat` / `_reverse_inbound_nat`)
- `nat_table_changed` — a router's NAT table was mutated (`Router._apply_source_nat`)
- `router_intercept` — a router answered an ICMP echo addressed to one of its own IPs (`Router._reply_to_ping`)

## What's Not in This Diagram

A few things deliberately don't appear above because they don't fit a
layer cleanly:

- **`EventTracer.register_message_event`** lets a caller observe a single
  message's lifecycle (`on_sent` / `on_received` / `on_forwarded`) by
  registering callbacks keyed by message identity. Consumers that want a
  broadcast stream use the WebSocket event bus instead.
- **`Host.ping`** does its own thread synchronization: a per-flow
  `threading.Event` plus a `_pending_pings` dict, woken by the matching
  `PingReply`. RTT comes back as `time.monotonic() - request_ts`.
- **`Router._handle_forwarding`** does **not** raise on TTL expiry — it
  logs a warning and returns `None`, silently dropping the packet.

For the deep dives, jump to:

- [`entities.md`](entities.md) — every class in `src/entities/`.
- [`routing-protocol.md`](routing-protocol.md) — flooding + Dijkstra.
- [`concurrency.md`](concurrency.md) — threads, gates, queues.
- [`parser.md`](parser.md) — YAML → AS.
- [`server-api.md`](server-api.md) — HTTP / WS reference.
- [`web-spa.md`](web-spa.md) — the SPA module map.
