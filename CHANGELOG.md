# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

The container image no longer ships setuptools or wheel, and picks up current
Debian security fixes from a rebuilt base image.

---

## [1.0.0] - 2026-08-23

Initial release of **loom**: a Python simulator for an IPv4 autonomous
system, driven by a YAML topology and an interactive web UI. It covers
multi-router simulation, a loom-OSPF link-state protocol, NAT and routing
policy, failure injection, per-device terminals, and packet animation on
an SVG canvas. Ships as a source checkout and as a container image
(`ghcr.io/lukius/loom`). See the [README](README.md) and [`docs/`](docs/)
for details.

[Unreleased]: https://github.com/lukius/loom/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/lukius/loom/releases/tag/v1.0.0
