> 🌐 **English** · [Español](README.es.md)

<div align="center">
  <img src="web/favicon.svg" width="80" alt="loom">
</div>

# loom

A Python simulator for an IPv4 autonomous system, driven by an interactive
web UI and a YAML topology under the hood: hosts, routers,
networks, and point-to-point links interconnected through a link-state
routing protocol resembling OSPF.

`loom` is mainly built for teaching and exploration. Networks are drawn
on the canvas and, once the simulation starts, the routing protocol
converges live: datagrams hop across routers and routing tables update
in real time.

## Scope

`loom` is deliberately network-layer only. There is no link layer (frames
are abstract envelopes) and no transport layer (no TCP/UDP, no ports, no
transport state). The goal is to make routing convergence and forwarding observable, not to model a
full network stack. For richer-fidelity work,
see [ns-3](https://www.nsnam.org/), [mininet](https://mininet.org/),
[Containerlab](https://containerlab.dev/), or [GNS3](https://www.gns3.com/).

## Features

- **Interactive web UI.** Drag networks, hosts, and routers onto an SVG
  canvas; edit interfaces and costs in the right pane; double-click any
  device to open a terminal with commands such as `ping`, `route`,
  and `ifconfig`.
- **Topology edits without restart.** Add networks, hosts, and routers
  while the simulation runs, or pause, batch a set of changes, and
  resume atomically.
- **Multi-router IPv4 simulation.** Hosts, routers, multi-access LANs,
  and `/30` / `/31` point-to-point links, all wired through
  per-interface and per-fabric Python threads. Forwarding decisions use
  longest-prefix match on a per-router routing table.
- **loom-OSPF link-state protocol.** Sequence-numbered flooding, per-router
  keepalive thread with configurable Hello and LSA-refresh intervals
  (live-tunable) and Dijkstra shortest-path computation that re-runs only
  when the graph actually changes.
- **Live interface disable and router halt/crash.** Bring an individual
  interface up or down, halt a router or inject a silent crash, then watch
  the network routing state change live.
- **Packet animations.** Datagrams, ping and routing-protocol packets
  animate across the canvas as they flow; toolbar toggles control speed
  and routing protocol chatter visibility.
- **NAT and private LANs.** Source-NAT rewrites private addresses
  (RFC 1918) on egress to public networks, with per-flow rewrite tables and
  reverse translation on return traffic. Routing policy keeps private
  prefixes local (they are never advertised to peer routers).
- **YAML import / export.** The topology is the source of truth. Drop a
  YAML file into the import dialog, copy the canvas back out, persist or
  share.
- **No external state.** Everything lives in memory plus a single
  session-YAML clone on disk.

## Tech Stack

| Layer | Technology |
|---|---|
| Simulator core | Python 3.11+, threads + queues, custom `PauseGate` |
| Web server | FastAPI + Uvicorn, static SPA mount, REST + WebSocket |
| Web UI | Plain ES modules + SVG (no framework, no bundler) |
| Topology | YAML (PyYAML), with a structural validator |
| Tests | `pytest` (547), `pytest-asyncio`, `vitest` (824), Playwright |
| Lint / format | `ruff` |

No runtime dependencies beyond PyYAML, FastAPI, and Uvicorn (the rest
of the table is dev tooling).

## Quick Start

**Prerequisites:** Python 3.11+

```bash
git clone git@gitlab.com:lukius/netrouting.git
cd netrouting

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cd src
python loom.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). You'll see the canvas
pre-populated with the bundled sample topology (3 hosts, 3 routers, 3
LANs, 1 point-to-point link). Press **Start** in the toolbar and watch the
routing protocol converge.

### Topology source

By default `loom` reads `samples/sample.yaml`. Override with
`LOOM_TOPOLOGY`:

```bash
LOOM_TOPOLOGY=/path/to/topology.yaml python loom.py
```

Edits made through the UI land in `<source>.session.yaml`; the source file
is never modified. Use the toolbar's **Reset** button (or
`POST /topology/reset`) to wipe the session and re-clone from source.

### Port

The server binds `127.0.0.1:8000` by default. Override:

```bash
LOOM_PORT=8123 python loom.py
```

## Documentation

The full documentation set lives under [`docs/`](docs/).

### User Guide

Start here if you want to **drive** the simulator.

| File | Topic                                                                  |
|---|------------------------------------------------------------------------|
| [`docs/user-guide/getting-started.md`](docs/user-guide/getting-started.md) | Install, run the UI, your first ping                                   |
| [`docs/user-guide/web-ui.md`](docs/user-guide/web-ui.md) | Toolbar, canvas, inspector, terminals: a guided tour                   |
| [`docs/user-guide/building-topologies.md`](docs/user-guide/building-topologies.md) | Add LANs, hosts, routers, point-to-point links                         |
| [`docs/user-guide/running-simulations.md`](docs/user-guide/running-simulations.md) | Start / pause / resume / reset, edits while paused, keepalive interval |
| [`docs/user-guide/routing-tables.md`](docs/user-guide/routing-tables.md) | Inspecting routing tables, neighbors, costs                            |
| [`docs/user-guide/terminals.md`](docs/user-guide/terminals.md) | Per-device terminals: `ping`, `send`, `ifconfig`, ...                  |
| [`docs/user-guide/yaml-format.md`](docs/user-guide/yaml-format.md) | YAML schema reference, save / resume workflow                          |
| [`docs/user-guide/nat-and-private-lans.md`](docs/user-guide/nat-and-private-lans.md) | NAT, private LANs, source address rewriting                            |

### Architecture / Technical Reference

Start here if you want to **change** the simulator or understand how it works.

| File | Topic                                                             |
|---|-------------------------------------------------------------------|
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | The big picture: components, layers, data flow                    |
| [`docs/architecture/entities.md`](docs/architecture/entities.md) | `AS`, `Router`, `Host`, `Network`, `Link`, `Interface`, `Address` |
| [`docs/architecture/packets.md`](docs/architecture/packets.md) | `Frame`, `Datagram`, `Message` (user / routing / ping)            |
| [`docs/architecture/routing-protocol.md`](docs/architecture/routing-protocol.md) | Link-state protocol, flooding, Dijkstra, sequence diagrams        |
| [`docs/architecture/concurrency.md`](docs/architecture/concurrency.md) | Threads, queues, `PauseGate`, lifecycle                           |
| [`docs/architecture/parser.md`](docs/architecture/parser.md) | YAML parser, validators, error paths                              |
| [`docs/architecture/nat.md`](docs/architecture/nat.md) | Source-NAT, per-flow rewrite tables, NAT events                   |
| [`docs/architecture/policy.md`](docs/architecture/policy.md) | Routing policy, RFC 1918 outbound filter                          |
| [`docs/architecture/server-api.md`](docs/architecture/server-api.md) | HTTP + WebSocket reference                                        |

### Other top-level files

- [`CONTRIBUTING.md`](CONTRIBUTING.md): dev setup, TDD workflow, MR process
- [`CHANGELOG.md`](CHANGELOG.md): release history
- [`CLAUDE.md`](CLAUDE.md): non-obvious project context for AI assistants and new contributors
- [`LICENSE`](LICENSE): MIT

## Project Structure

```
loom/
├── src/
│   ├── loom.py            # Entry point — starts the web UI
│   ├── entities/          # AS, Router, Host, Network, Link, Interface, Address, Packet, Event, nat.py, PauseGate
│   ├── routing/           # RoutingProtocol (loom-OSPF link-state) + LSDB → NetworkGraph (Dijkstra)
│   ├── parser/            # YAML topology loader + SystemValidator
│   └── server/            # FastAPI app, routes, sim state machine, persistence, command dispatch
├── test/                  # pytest suite (547 tests) + invalid YAML fixtures under resources/
├── samples/               # sample.yaml — the bundled example topology
├── web/                   # SPA: ES modules, styles, favicon, vitest tests
├── e2e/                   # Playwright/Chromium smoke suite
├── docs/                  # User guide + architecture reference
├── pyproject.toml         # ruff + pytest config (pythonpath = ["src"], testpaths = ["test"])
├── requirements.txt       # Runtime deps (PyYAML, FastAPI, uvicorn)
├── requirements-dev.txt   # Dev deps (pytest, pytest-asyncio, ruff, httpx)
├── playwright.config.js   # E2E config (chromium-only, LOOM_PORT=8766)
├── vitest.config.js       # JS unit tests config
└── package.json           # npm scripts: test (vitest), test:e2e (playwright)
```

## Running Tests

```bash
# Python
pytest                              # full suite
ruff check src/ test/               # lint

# JavaScript
npm test                            # vitest unit suite
npm run test:e2e                    # Playwright + real Chromium (binds LOOM_PORT=8766)
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full TDD workflow.

## AI-Assisted Development

`loom` is approachable by AI assistants out of the box. Two files
carry the load:

- **`CLAUDE.md`**: short cheat sheet of non-obvious project context:
  entry points, key design decisions, traps. Under 200 lines on purpose;
  read this first to avoid common pitfalls.
- **`docs/`**: the deep-dive reference. Architecture pages
  (`docs/architecture/`) cover components, the link-state protocol,
  concurrency, the parser, the HTTP/WS API, and the SPA module map.
  User-guide pages (`docs/user-guide/`) cover the web UI, terminals,
  and YAML format.

An AI assistant pointed at `CLAUDE.md` plus the relevant
`docs/architecture/` page can plan and execute most changes directly.

Human contributors do not need to use any AI tooling. All conventions
apply equally. See [CONTRIBUTING.md](CONTRIBUTING.md#ai-assisted-development)
for guidelines on maintaining `CLAUDE.md` and the doc set as the project
evolves.

## Contributing

This project is developed test-first. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the development setup, the red → green → refactor cycle, the
documentation discipline, commit conventions, and the merge-request
process. The project is hosted on GitLab: use `glab` or the web UI for
MRs.

## License

[MIT](LICENSE)
