# loom: Documentation

This directory is the long-form reference for `loom`. Two layers carry the
bulk of it, user guide and architecture; the top-level
[`README.md`](../README.md) is the entry point and links into both. A third
directory holds development-process notes.

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
│   ├── nat-and-private-lans.md
│   └── yaml-format.md
├── architecture/          ← How the simulator is built
│   ├── overview.md
│   ├── entities.md
│   ├── packets.md
│   ├── routing-protocol.md
│   ├── concurrency.md
│   ├── nat.md
│   ├── policy.md
│   ├── parser.md
│   └── server-api.md
├── development/           ← How contributors and agents drive the work
│   └── subagent-driven-execution.md
└── images/                ← Screenshots and figures referenced by the docs
```

## User Guide

Read these to **use** loom. They assume you have Python 3.11+ installed
and the repo cloned; no other prerequisites.

1. [Getting started](user-guide/getting-started.md): Install, run the UI,
   send your first packet.
2. [Web UI](user-guide/web-ui.md): Toolbar, canvas, inspector, terminals.
3. [Building topologies](user-guide/building-topologies.md): Add LANs,
   hosts, routers, point-to-point links; address rules.
4. [Running simulations](user-guide/running-simulations.md): Start, pause,
   resume, reset; edits while paused; keepalive interval.
5. [Routing tables](user-guide/routing-tables.md): Inspecting routes,
   neighbors, costs; what convergence looks like.
6. [Terminals](user-guide/terminals.md): Per-device commands: `ping`,
   `send`, `ifconfig`, `route`, `update_cost`, `set_gateway`,
   `neighbors`.
7. [NAT and private LANs](user-guide/nat-and-private-lans.md): How
   traffic crosses the private↔public boundary, inspecting the NAT
   table, overlap rules.
8. [YAML format](user-guide/yaml-format.md): Topology schema reference,
   save / resume workflow.

## Architecture / Technical Reference

Read these to **change** loom or understand the trade-offs the design
makes. Reader is assumed to know IPv4 routing fundamentals (subnets, next
hop, longest prefix, link-state vs. distance vector) at the level of an
undergraduate networking course.

1. [Overview](architecture/overview.md): Layers, processes, threads, data
   flow.
2. [Entities](architecture/entities.md): `AS`, `Router`, `Host`, `Network`,
   `Link`, `Interface`, `Address`, `NetworkAddress`.
3. [Packets](architecture/packets.md): `Frame`, `Datagram`, `Message` and
   its subclasses (user, routing, ping).
4. [Routing protocol](architecture/routing-protocol.md): Link-state
   flooding, Dijkstra, the dirty-graph guard, and sequence diagrams.
5. [Concurrency](architecture/concurrency.md): Threads, queues,
   `PauseGate`, packet lifecycle from `send_to` to delivery.
6. [NAT](architecture/nat.md): Source-NAT at the private↔public boundary,
   the per-router NAT table, the conversation-keyed `flow_id`.
7. [Policy framework](architecture/policy.md): route maps, the RFC 1918
   outbound filter, reachability versus topology.
8. [Parser & validator](architecture/parser.md): YAML loading, structural
   validation, link post-pass.
9. [Server API](architecture/server-api.md): REST and WebSocket endpoints.

## Development Process

Read this to **build** loom across several commits. It is process, not
reference; the day-to-day workflow lives in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

1. [Subagent-driven execution](development/subagent-driven-execution.md):
   the per-task developer → reviewer cycle for multi-commit features,
   with role profiles, briefing templates, and decision rules.

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
