# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- Comprehensive documentation set under `docs/`:
  - `docs/architecture/` — technical reference: backend components, packet
    types, link-state protocol, concurrency model, parser/validator, web
    SPA structure, HTTP/WebSocket API.
  - `docs/user-guide/` — user-facing manual: install/run, web UI tour,
    building topologies, running simulations, routing tables, terminals,
    YAML format, legacy shell.
- Top-level project files: `LICENSE` (MIT), `CONTRIBUTING.md`,
  `CHANGELOG.md`.

---

## [1.0.0] — 2026-05-16

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
- `RoutingProtocol`: link-state with sequence-numbered flooding,
  per-router keepalive thread (default 10s interval, live-editable
  via the web toolbar), receiver-side flood deduplication keyed by
  `(src_address, seq)`, and idempotent re-recompute guarded by a
  graph-dirty flag.
- `PauseGate`: a two-state gate (running / paused / stopped) that
  every worker thread blocks on each loop iteration; powers the
  web UI's pause/resume control without losing in-flight packets.
- Point-to-point `Link` fabric (`/30` or `/31` only) with
  exactly-two-endpoint enforcement and structural peer resolution
  (so cross-link IP collisions don't break delivery).
- `EventTracer` pub/sub bus: workers emit `packet`, `routing_table_changed`,
  and `sim_state` events that the web layer streams over WebSocket.

**Parsers & validators**

- YAML topology parser (`parser/parser.py`) that loads `samples/sample.yaml`
  and rejects malformed input with `ParsingException`.
- Structural validators (`parser/validator.py`): address syntax, network
  uniqueness, link `/30`-or-`/31` CIDRs, per-network IP uniqueness, host
  gateway-in-network, and host-on-link gateway = peer.
- Negative fixtures under `test/resources/` (intentionally invalid YAML)
  exercising each parser/validator failure path.

**Interactive shell (`cd src && python loom.py shell`)**

- `cmd.Cmd` REPL with: `read`, `route`, `send`, `update_cost`,
  `ifconfig`, `neighbors`, `set_gateway`, `ping`, `exit`.
- `@requires_system` decorator that short-circuits commands when no
  topology is loaded.

**Web UI (default: `cd src && python loom.py`)**

- FastAPI server serving the SPA from `web/`, plus REST + WebSocket
  endpoints for sim lifecycle, topology load/edit/reset, per-device
  commands, and a live event stream.
- Single-file SPA split into native ES modules:
  `app.js` (entrypoint), `state.js` (state + EventTarget bus),
  `canvas.js` (SVG rendering, pan/zoom, drag), `inspector.js`
  (left-nav, right-pane editors, context menu), `terminals.js`
  (per-device terminal popups), `packets.js` (packet animations),
  `sim.js` (state machine + REST/WS client), `yaml-io.js`
  (YAML import/export), `utils.js` (DOM helpers).
- Toolbar: Start/Pause/Reset, refresh interval (1–300 s),
  packet animation speed, chatter toggle (routing-protocol packets),
  show-costs and show-interfaces toggles, theme switcher.
- Topology mutation while running: edits accumulate as a patch list
  while the simulation is paused, then applied atomically on resume
  (`POST /sim/resume`).
- Per-device terminals (`Ctrl+L` to clear, `Ctrl+D` to close);
  `ping`, `send`, `ifconfig`, `route`, `neighbors`, `update_cost`,
  `set_gateway`.
- Session persistence: SPA state in `localStorage`; backend writes a
  cloned `<source>.session.yaml` next to the source file and never
  touches the source.

**Testing & tooling**

- `pytest` suite (190+ tests) covering addressing, entities, event
  subscribers, forwarding, graph search, packet handling, parser,
  pause gate, ping, protocol, routing table, shell commands, and
  thread resilience.
- Vitest unit suite for `web/utils.js`, `web/state.js`, `web/sim.js`,
  `web/canvas.js`, `web/inspector.js`, `web/packets.js`.
- Playwright/Chromium smoke suite (`e2e/spa.spec.js`) booted by
  `webServer` on `LOOM_PORT=8766` against a real FastAPI process.
- Ruff lint + format (PEP 8 / I rules), configured via `pyproject.toml`.

[Unreleased]: https://gitlab.com/lukius/netrouting/-/compare/v1.0.0...main
[1.0.0]: https://gitlab.com/lukius/netrouting/-/tags/v1.0.0
