# loom

A Python simulator for an IPv4 autonomous system: hosts, routers, networks, and a link-state routing protocol over a YAML-described topology, with an interactive web UI.

## Quick start

```bash
pip install -r requirements.txt
cd src && python loom.py
```

Then open http://127.0.0.1:8000/ in a browser to use the SPA. Drag/drop networks, hosts, and routers onto the canvas, click Start, and watch packets flow.

Toolbar offers Start/Pause, a Refresh field that tunes the routing keepalive (1–300s, applied to every router live), and a Chatter toggle that shows or hides routing-protocol packets. Double-click a host or router to open a terminal — `Ctrl+L` clears, `Ctrl+D` closes when the prompt is empty.

## Topology source

The simulator reads its topology from `samples/sample.yaml` by default. Set `LOOM_TOPOLOGY` to point at a different file. Mutations during simulation land in `<source>.session.yaml`; the source is never modified.

The web server binds `127.0.0.1:8000` by default. Set `LOOM_PORT` to override (e.g. for the e2e suite).

## Point-to-point links

The YAML topology supports `/30` or `/31` point-to-point links between any two endpoints (router–router, router–host, or host–host). Declare them under a top-level `links:` key alongside `networks:`:

```yaml
as:
  name: example
  networks:
    lan1: "10.10.0.0/24"
  links:
    p2p1: "10.0.0.0/30"
  hosts:
    h1: { network: lan1, address: "10.10.0.10", gateway: "10.10.0.1" }
    h2: { link: p2p1, address: "10.0.0.2" }   # gateway auto-filled to peer
  routers:
    r1:
      interfaces:
        eth0: { network: lan1, address: "10.10.0.1", cost: 5 }
        eth1: { link:    p2p1, address: "10.0.0.1",  cost: 5 }
```

Rules: a link must have exactly two endpoints; `network:` and `link:` are mutually exclusive per interface; only `/30` or `/31` CIDRs are accepted; a host on a link has its gateway auto-filled to the peer's IP (an explicit `gateway:` must match).

The SPA renders p2p links as direct edges between devices rather than a LAN-bus visual.

## Legacy CLI shell

`cd src && python loom.py shell` launches the original cmd.Cmd REPL. Commands: `read`, `route`, `send`, `update_cost`, `ifconfig`, `neighbors`, `ping`, `exit`.

## Development

- Requires Python 3.11+.
- Dev deps: `pip install -r requirements-dev.txt`.
- Run tests: `pytest`.
- Lint: `ruff check src/ test/`.

### JS tests

After `pip install`, also install JS dev deps once: `npm install`. Then `npm test` to run the vitest suite for `web/utils.js`, `web/state.js`, and `web/sim.js`.

### End-to-end

`npm run test:e2e` runs a Playwright/Chromium smoke suite from `e2e/` against a real FastAPI server (spawned by Playwright on port 8766 via `LOOM_PORT`). Requires `@playwright/test` (installed via `npm install`) and a system Chromium browser; see `playwright.config.js`.
