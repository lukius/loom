# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-06-15

Initial tagged release of **loom** — a Python simulator for an IPv4
autonomous system driven by a YAML topology and an interactive web UI.

### Added

**Simulation core**

- `AS` autonomous-system container with hosts, routers, networks, and
  point-to-point links.
- `Router`, `Host`, `Network`, `Link`, `Interface` entities and a
  longest-prefix-match `RoutingTable`.
- Datagram model: `Frame` (link layer), `Datagram` (network layer with
  TTL, decremented per forwarding hop), and `Message` payloads
  (`UserMessage`, `RoutingMessage`, `PingRequest`, `PingReply`).
- `NetworkGraph` undirected weighted graph with Dijkstra
  shortest-path search (lazy-deletion heap, O((V+E) log V)).
- `RoutingProtocol` (abstract) / `LinkStateProtocol` (concrete):
  link-state with sequence-numbered flooding, jittered three-timer
  `Scheduler` (hello / lsa_refresh / maxage_check; default 10 s hello,
  30 s LSA refresh), live-tunable from the toolbar's Protocol popover,
  receiver-side flood deduplication per originator in the LSDB, and
  SPF that re-runs only when the graph actually changes.
- NAT: per-router `NATTable` rewrites private (RFC 1918) source
  addresses on egress to public networks and reverses on inbound return,
  keyed per flow. Emits `nat` and `nat_table_changed` events.
- Routing policy: `PERMIT_ALL` for the local graph (private prefixes
  route locally) and `RFC1918_OUTBOUND` for flooded LSAs (private
  prefixes never advertised to peers).
- Router admin controls: per-interface `ifconfig up|down` (admin-down),
  `halt` (graceful withdrawal LSA + disable), `resume`, and silent crash
  (`POST /devices/{name}/fail`).
- `PauseGate`: a two-state gate (running / paused / stopped) that
  every worker thread blocks on each loop iteration; powers the
  web UI's pause/resume control without losing in-flight packets.
- Point-to-point `Link` fabric (`/30` or `/31` only) with
  exactly-two-endpoint enforcement and structural peer resolution
  (so cross-link IP collisions don't break delivery).
- `EventTracer` pub/sub bus: workers emit `packet`, `routing_table_changed`,
  `sim_state`, `neighbor_state_changed`, `lsdb_changed`, `ping_result`,
  `nat`, `nat_table_changed`, `router_intercept`, and related events that
  subscribers stream over WebSocket.

**Parsers & validators**

- YAML topology parser (`parser/parser.py`) that loads `samples/sample.yaml`
  and rejects malformed input with `ParsingException`.
- Structural validators (`parser/validator.py`): address syntax, network
  uniqueness, link `/30`-or-`/31` CIDRs, per-network IP uniqueness, host
  gateway-in-network, and host-on-link gateway = peer.
- Negative fixtures under `test/resources/` (intentionally invalid YAML)
  exercising each parser/validator failure path.

**Web UI (default: `cd src && python loom.py`)**

- FastAPI server serving the SPA from `web/`, plus REST + WebSocket
  endpoints for sim lifecycle, topology load/edit/reset, per-device
  commands, and a live event stream.
- Single-page application built from native ES modules:
  `app.js`, `state.js`, `canvas.js`, `inspector.js`, `terminals.js`,
  `packets.js`, `packetstore.js`, `packetspanel.js`, `sim.js`,
  `yaml-io.js`, `utils.js`, `modal.js`, `file-picker.js`,
  `packettypes.js`, `protocolpopover.js`, `preflight.js`.
- Toolbar: Start/Pause/Reset, Protocol popover (hello / LSA-refresh
  intervals), packet animation speed, chatter toggle, show-costs and
  show-interfaces toggles, Packets slide-out panel, theme switcher.
- Topology mutation while running: add networks, hosts, and routers
  live; each edit commits as soon as a valid address is entered. Or
  pause, batch a set of changes, and resume atomically.
- Per-device terminals (`Ctrl+L` to clear, `Ctrl+D` to close);
  `ping`, `send`, `ifconfig`, `route`, `neighbors`, `update_cost`,
  `set_gateway`; router additionally supports `halt`, `resume`,
  `ifconfig <iface> up|down`.
- NAT inspector panel and Packets slide-out panel showing in-flight
  and recent packet history.
- Session persistence: SPA state in `localStorage`; backend writes a
  cloned session YAML under a temp directory and never touches the
  source file.

**Testing & tooling**

- `pytest` suite (526+ tests) covering addressing, entities, event
  subscribers, forwarding, graph search, packet handling, parser,
  pause gate, ping, protocol, routing table, server commands/events/
  lifecycle/lock discipline, NAT, policy, and thread resilience.
- Vitest unit suite for `web/utils.js`, `web/state.js`, `web/sim.js`,
  `web/canvas.js`, `web/inspector.js`, `web/packets.js`.
- Playwright/Chromium smoke suite (`e2e/spa.spec.js`) booted by
  `webServer` on `LOOM_PORT=8766` against a real FastAPI process.
- Ruff lint + format (PEP 8 / I rules), configured via `pyproject.toml`.

**Documentation**

- Comprehensive documentation set under `docs/`:
  - `docs/architecture/` — technical reference: backend components, packet
    types, link-state protocol, concurrency model, NAT, routing policy,
    parser/validator, web SPA structure, HTTP/WebSocket API.
  - `docs/user-guide/` — user-facing manual: install/run, web UI tour,
    building topologies, running simulations, routing tables, terminals,
    YAML format, NAT and private LANs.
- Top-level project files: `LICENSE` (MIT), `CONTRIBUTING.md`,
  `CHANGELOG.md`.

[1.0.0]: https://gitlab.com/lukius/netrouting/-/tags/v1.0.0
