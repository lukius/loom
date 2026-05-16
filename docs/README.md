# loom — Documentation

This directory is the long-form reference for `loom`. It is split into two
layers; the top-level [`README.md`](../README.md) is the entry point and
links into both.

```
docs/
├── README.md              ← you are here (index)
├── user-guide/            ← How to drive the simulator
│   ├── getting-started.md
│   ├── web-ui.md
│   ├── building-topologies.md
│   ├── running-simulations.md
│   ├── routing-tables.md
│   ├── terminals.md
│   ├── yaml-format.md
│   └── shell-cli.md
├── architecture/          ← How the simulator is built
│   ├── overview.md
│   ├── entities.md
│   ├── packets.md
│   ├── routing-protocol.md
│   ├── concurrency.md
│   ├── parser.md
│   ├── web-spa.md
│   └── server-api.md
├── images/                ← Screenshots and figures referenced by the docs
└── manual-smoke-test.md   ← Pre-existing manual QA checklist
```

## User Guide

Read these to **use** loom. They assume you have Python 3.11+ installed
and the repo cloned; no other prerequisites.

1. [Getting started](user-guide/getting-started.md) — Install, run the UI,
   run the legacy shell, send your first packet.
2. [Web UI](user-guide/web-ui.md) — Toolbar, canvas, inspector, terminals.
3. [Building topologies](user-guide/building-topologies.md) — Add LANs,
   hosts, routers, point-to-point links; address rules.
4. [Running simulations](user-guide/running-simulations.md) — Start, pause,
   resume, reset; edits while paused; keepalive interval.
5. [Routing tables](user-guide/routing-tables.md) — Inspecting routes,
   neighbors, costs; what convergence looks like.
6. [Terminals](user-guide/terminals.md) — Per-device commands: `ping`,
   `send`, `ifconfig`, `route`, `update_cost`, `set_gateway`,
   `neighbors`.
7. [YAML format](user-guide/yaml-format.md) — Topology schema reference,
   save / resume workflow.
8. [Shell CLI](user-guide/shell-cli.md) — The legacy `cmd.Cmd` REPL.

## Architecture / Technical Reference

Read these to **change** loom or understand the trade-offs the design
makes. Reader is assumed to know IPv4 routing fundamentals (subnets, next
hop, longest prefix, link-state vs. distance vector) at the level of an
undergraduate networking course.

1. [Overview](architecture/overview.md) — Layers, processes, threads, data
   flow.
2. [Entities](architecture/entities.md) — `AS`, `Router`, `Host`, `Network`,
   `Link`, `Interface`, `Address`, `NetworkAddress`.
3. [Packets](architecture/packets.md) — `Frame`, `Datagram`, `Message` and
   its subclasses (user, routing, ping).
4. [Routing protocol](architecture/routing-protocol.md) — Link-state
   flooding, Dijkstra, the dirty-graph guard, and sequence diagrams.
5. [Concurrency](architecture/concurrency.md) — Threads, queues,
   `PauseGate`, packet lifecycle from `send_to` to delivery.
6. [Parser & validator](architecture/parser.md) — YAML loading, structural
   validation, link post-pass.
7. [Web SPA](architecture/web-spa.md) — Module map, event-bus contract,
   state shape.
8. [Server API](architecture/server-api.md) — REST and WebSocket endpoints.

---

## Conventions used in this documentation

- **Mermaid** for sequence diagrams and graphs. They render natively on
  GitLab / GitHub.
- **ASCII art** for component / layer diagrams where Mermaid is less
  legible than a hand-drawn box.
- **File paths** are written relative to the repo root.
- **Code references** use the form `src/path/to/file.py:line_number` when
  pointing at a specific definition.
- **Examples** assume the bundled `samples/sample.yaml` topology unless
  otherwise stated.
