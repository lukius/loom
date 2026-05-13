# netrouting

A Python simulator for an IPv4 autonomous system: hosts, routers, networks, and a link-state routing protocol over a YAML-described topology, with an interactive web UI.

## Quick start

```bash
pip install -r requirements.txt
cd src && python netrouting.py
```

Then open http://127.0.0.1:8000/ in a browser to use the SPA. Drag/drop networks, hosts, and routers onto the canvas, click Start, and watch packets flow.

Toolbar offers Start/Pause, a Refresh field that tunes the routing keepalive (1–300s, applied to every router live), and a Chatter toggle that shows or hides routing-protocol packets. Double-click a host or router to open a terminal — `Ctrl+L` clears, `Ctrl+D` closes when the prompt is empty.

## Topology source

The simulator reads its topology from `samples/sample.yaml` by default. Set `NETROUTING_TOPOLOGY` to point at a different file. Mutations during simulation land in `<source>.session.yaml`; the source is never modified.

## Legacy CLI shell

`cd src && python netrouting.py shell` launches the original cmd.Cmd REPL. Commands: `read`, `route`, `send`, `update_cost`, `ifconfig`, `neighbors`, `ping`, `exit`.

## Development

- Requires Python 3.11+.
- Dev deps: `pip install -r requirements-dev.txt`.
- Run tests: `pytest`.
- Lint: `ruff check src/ test/`.
