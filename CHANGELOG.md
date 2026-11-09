# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

Nothing yet.

---

## [1.0.3] - 2026-11-09

Security patch for the container image: it now upgrades its Debian packages
at build time, and release builds skip the layer cache, so a release picks up
OS security fixes before the Python base image does.

---

## [1.0.2] - 2026-11-02

Security patch: the browser now loads js-yaml 4.3.2, which fixes
denial-of-service advisories reachable by importing a crafted YAML file.

---

## [1.0.1] - 2026-11-02

Security patch for the container image: it no longer ships setuptools or wheel,
and picks up current Debian security fixes from a rebuilt base image, which
clears all fixable HIGH and CRITICAL CVEs in a Trivy scan.

---

## [1.0.0] - 2026-08-23

Initial release of **loom**: a Python simulator for an IPv4 autonomous
system, driven by a YAML topology and an interactive web UI. It covers
multi-router simulation, a loom-OSPF link-state protocol, NAT and routing
policy, failure injection, per-device terminals, and packet animation on
an SVG canvas. Ships as a source checkout and as a container image
(`ghcr.io/lukius/loom`). See the [README](README.md) and [`docs/`](docs/)
for details.

[Unreleased]: https://github.com/lukius/loom/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/lukius/loom/releases/tag/v1.0.3
[1.0.2]: https://github.com/lukius/loom/releases/tag/v1.0.2
[1.0.1]: https://github.com/lukius/loom/releases/tag/v1.0.1
[1.0.0]: https://github.com/lukius/loom/releases/tag/v1.0.0
