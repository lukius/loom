# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed

- LSAs now advertise *attachments* — the fabric a router sits on, its cost,
  and the fabric's prefix only when advertisement policy permits.
  Reachability and topology are no longer the same field, so a private LAN
  or `/30` link carries transit traffic while staying out of peers' routing
  tables as a destination. Shortest-path nodes key on the fabric rather
  than its prefix, which keeps two LANs that share a private CIDR distinct.
  The `routing_flood` event payload gains an `attachments` list.

### Fixed

- A LAN or link added while the simulation ran, but left incomplete, was
  discarded when the simulation paused instead of moving into the pending
  edits. Attaching a host or router to it and resuming then failed with
  `network_not_found`.
- Source-NAT applied to the reply leg of conversations opened from the
  public side, so a ping into a private LAN came back from the router's
  address, was discarded by the sender, and reported a timeout even
  though the round trip completed. Translation is now limited to flows
  the private side starts.
- A router whose neighbor died kept forwarding through it: the
  dead-interval sweep purged the neighbor's LSA without recomputing the
  routing table, and the purge then made the max-age path a no-op.
- The sample topology seeded on a first visit carried no host gateways,
  so the first ping between LANs failed.
- The NAT table's flow-ID column spilled past the inspector's edge.
- Confirmed live edits no longer announce "Topology imported".

---

## [1.0.0] — 2026-07-27

Initial release of **loom** — a Python simulator for an IPv4 autonomous
system driven by a YAML topology and an interactive web UI: multi-router
simulation, a loom-OSPF link-state protocol, NAT and routing policy,
failure injection, per-device terminals, and packet animations on an SVG
canvas. See the [README](README.md) and [`docs/`](docs/) for details.

[1.0.0]: https://gitlab.com/lukius/netrouting/-/tags/v1.0.0
