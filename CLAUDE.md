# loom

A Python simulator for an IPv4 autonomous system: hosts, routers, networks, and a link-state routing protocol over a YAML-described topology, driven by an interactive web UI (with a legacy `cmd.Cmd` shell still available).

## Project Structure

```
loom/
├── src/
│   ├── loom.py            # Entry point — web UI (default) or 'shell' subcommand
│   ├── entities/          # AS, Router, Host, Network, Interface, Address, Packet, Event
│   ├── routing/           # RoutingProtocol (link-state) + NetworkGraph (Dijkstra)
│   ├── parser/            # YAML topology loader + SystemValidator
│   └── shell/             # `cmd.Cmd`-based REPL (read/route/send/update_cost/exit)
├── test/
│   ├── test_*.py          # Suites: address, entities, event_subscribers, forwarding, graph, packet_handling, parser, pause_gate, ping, protocol, routing_table, shell_commands, thread_resilience
│   └── resources/         # YAML fixtures — most are intentionally invalid (parser/validator negative tests)
├── samples/sample.yaml    # Example topology
├── web/
│   ├── index.html         # SPA shell (~280 lines: HTML + <script type="module" src="app.js">)
│   ├── styles.css         # Extracted CSS
│   ├── app.js             # Entrypoint: imports, wire(), init(), DOMContentLoaded
│   ├── state.js           # State object, persist/restore, sample, bus (EventTarget)
│   ├── utils.js           # DOM/string helpers (el, escapeHtml, toast, …)
│   ├── sim.js             # Sim state machine + RuntimeClient + WS event router
│   ├── canvas.js          # SVG rendering, drag/pan, theme, layout
│   ├── inspector.js       # Nav, right-pane panels, rename/duplicate/delete ops, context menu
│   ├── terminals.js       # Per-node terminal popups
│   ├── packets.js         # PacketAnim + tooltips
│   └── *.test.js          # vitest tests co-located (utils, state, sim)
├── e2e/                   # Playwright smoke suite (real Chromium + spawned FastAPI)
├── docs/
│   ├── architecture/      # Technical reference (overview, entities, packets, routing-protocol, concurrency, parser, server-api, web-spa)
│   ├── user-guide/        # User manual (getting-started, web-ui, building-topologies, running-simulations, routing-tables, terminals, yaml-format, shell-cli)
│   └── images/            # Screenshots used by user-guide
├── playwright.config.js   # E2E config: chromium-only, webServer on LOOM_PORT=8766
├── pyproject.toml         # ruff + pytest config (sets pythonpath = ["src"], testpaths = ["test"])
├── requirements.txt       # Runtime deps (PyYAML, FastAPI, uvicorn)
├── requirements-dev.txt   # Dev deps: + pytest, pytest-asyncio, ruff, httpx
├── CONTRIBUTING.md        # Canonical dev guide (full TDD workflow, MR process, conventions)
├── CHANGELOG.md           # Keep-a-Changelog format
├── LICENSE                # MIT
└── README.md              # Quick start and project overview
```

## Build & Run

- Requires Python 3.11+. Install runtime deps: `pip install -r requirements.txt`. For dev (tests + lint): `pip install -r requirements-dev.txt`.
- **Web UI (default):** `cd src && python loom.py` — launches FastAPI on http://127.0.0.1:8000 and serves the SPA from `web/`.
- **Legacy shell:** `cd src && python loom.py shell` — original cmd.Cmd REPL. Same simulator under the hood.
- Topology source path: env var `LOOM_TOPOLOGY` (default `samples/sample.yaml`). The server clones to `<source>.session.yaml` and writes only there.
- HTTP port: env var `LOOM_PORT` (default `8000`). The Playwright suite uses `8766` to avoid colliding with a dev server.
- Run tests: `pytest` from the repo root. Single suite: `pytest test/test_address.py`.
- JS tests: `npm install` (first time only), then `npm test` from the repo root. Uses vitest + happy-dom.
- E2E tests: `npm run test:e2e` runs Playwright against a real Chromium and a spawned FastAPI server. Requires a system Chromium browser (the suite does not download one).
- Lint: `ruff check src/ test/`. Format: `ruff format src/ test/`.

## Git & Remote

- Hosted on **GitLab**, not GitHub: `gitlab.com:lukius/netrouting`. `gh` will not work; use `glab` or the web UI for MRs/issues.

## Shell usage

Inside the REPL, load a topology before any other command:

```
# read samples/sample.yaml
# route r1
# send h1 h2 hello
# update_cost r1 eth0 25
# set_gateway h1 200.100.0.1
# ifconfig h1
# neighbors r1
# ping h1 h2 -W 1.5
```

Commands run from `src/`, so paths like `samples/...` are relative to the repo root and need `../samples/...`. The `send` payload is a **single whitespace-delimited token** — no quoting, no spaces.

## Development Rules

### Testing — TDD (red / green / refactor)
- Write a failing test first (**red**). Run it and confirm it fails for the expected reason.
- Write the smallest change that makes it pass (**green**). Run the full suite.
- Clean up names, duplication, and structure (**refactor**) with the suite green; re-run after each refactor step.
- Do not commit code without a covering test, and do not commit a red suite. New parser/validator failure modes belong as YAML fixtures under `test/resources/` referenced from `test_parser.py`.
- Run `pytest` after every change.

### Documentation — keep in sync with code
- After a code change, check whether `README.md`, this `CLAUDE.md`, the relevant page under `docs/architecture/` or `docs/user-guide/`, or any docstrings on the changed surface are now stale. If so, update them in the same commit — do not leave docs for "later".
- Update **only when needed**: a small internal refactor with no observable behavior change typically requires no doc edits. Behavioral, interface, layout, or workflow changes usually do.
- Surfaces that must stay accurate when touched: entry points and how to run them, shell + per-device command set + syntax, YAML schema, routing protocol wire format, project layout, dependencies, HTTP/WS API.
- When touching `docs/user-guide/` for a user-visible change, follow the project-local **`user-guide-update`** skill (`.claude/skills/user-guide-update/SKILL.md`) — it covers page selection, action-level wording, and capturing the screenshot via `npm run screenshot` (tool at `tools/screenshot.mjs`).
- `CONTRIBUTING.md` is the canonical dev guide; this file (`CLAUDE.md`) is the cheat sheet of non-obvious traps. Don't duplicate content — link from one to the other.
- If a behavior is intentionally undocumented (e.g. an internal helper), say nothing — do not write speculative docs.

### Linting & style
- Run `ruff check src/ test/` before every commit; fix or `# noqa` (with reason) any reported issues. Do not commit a dirty lint.
- Follow standard PEP practices: **PEP 8** (style), **PEP 257** (docstring conventions), **PEP 20** (Zen of Python — favor explicit, simple, readable code). Ruff enforces the mechanical PEP 8 rules by default; the rest is on the author.
- **Imports at the top of the file** (PEP 8). Function-level imports are a code smell — only acceptable to break a circular import or to defer an expensive optional dep, and must carry `# noqa: PLC0415` with the reason. This applies to test files too: ruff's default `E402` only catches module-level placement, not in-function imports, so the discipline is on the author.
- `ruff format src/ test/` is fine to run, but format-only churn should land in its own commit (`style:` or `chore:`), not mixed with behavioral changes.

### Backend ↔ frontend decoupling
- The Python backend (`src/`) MUST NOT mention the SPA, the web UI, animations, the canvas, tooltips, or any frontend rendering concern in code, comments, docstrings, or test docstrings. The HTTP/WS API and the EventTracer event shape are the public contract; describe events as broadcast facts (e.g. "emits a `packet` event"), not in terms of what the UI does with them. The SPA is one subscriber among many possible — shell tools, tests, future TUIs — and the backend must look the same to all of them.
- The reverse direction (SPA referring to backend wire shapes by name) is fine and expected — the SPA is the consumer.

### Commits
- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `style:`, etc.
- One-liner messages, imperative mood, no co-author trailers.

### After touching code
- Run tests (red → green → refactor cycle complete, full suite green).
- Run `ruff check src/ test/` and resolve any new findings.
- If the change affects behavior, interfaces, layout, build/run, or workflows, update `README.md`, this `CLAUDE.md`, the affected pages under `docs/`, and any affected docstrings in the same commit. Pure-internal refactors with no observable change usually need no doc edits.

### About this file
- **Keep it under 200 lines.** If it grows past that, prune.
- **Only non-obvious context.** If it can be derived by reading the source, tests, or `git log`, it does not belong here. This file captures the *why*, the implicit conventions, and the traps.

## Key Design Decisions & Traps

- **Shell runs from `src/`, everything else from repo root.** The shell entry point uses bare-package imports (`from entities import ...`), so `cd src && python loom.py` is required. Pytest and ruff are configured to run from the repo root (`pyproject.toml`). Do not refactor imports to fix the cwd quirk without first updating both the shell entry and `pyproject.toml`'s `pythonpath`.

- **AS YAML shape: `as:` at the top, `name:` inside.** The parser requires the literal top-level key `as:` and reads the AS name from a nested `name:` field (falling back to `unnamed_entity_N`). `samples/sample.yaml` follows this convention and loads cleanly. Anything that emits topology YAML (the SPA, future tools) must produce the same shape.

- **Link-state with sequence-numbered flooding.** `RoutingProtocol` (`src/routing/protocol.py`) broadcasts a `RoutingMessage` from every interface every `_keepalive_interval` (defaults to `KEEPALIVE_INTERVAL = 10s`, editable per-instance via `set_keepalive_interval`) on a daemon thread per router. The loop ticks **once at start** before the first sleep, so neighbors converge at t~0 instead of after one full interval. Receivers re-flood out of every interface *except* the one the message arrived on, deduplicated by `(src_address, seq)`. Recompute paths only when the local `NetworkGraph` actually changes — preserve that guard when editing, otherwise routing tables churn on every keepalive.

- **`Network._interfaces` is keyed by interface IP address, not by `iface.name()`.** Interface names are only unique within a single device (every router happens to call its first interface `eth0`), so keying by name would clobber siblings on the same LAN. The parser/validator enforces IP-address uniqueness within each network, which is what makes the address a safe key. Anything new that joins interfaces to networks must follow this rule.

- **`Link` is a sibling of `Network`, both subclassing `_FabricBase` (`entities/_fabric.py`).** `Link._dispatch_packet` delivers to the endpoint whose IP is not `frame.source()`; drops silently if only one endpoint is attached (construction race guard). No broadcast/unicast split — there is no broadcast domain. `/30` or `/31` only, enforced in both `Link.__init__` and `LinkValidator`. A host's gateway on a link is auto-filled by the parser post-pass from the peer's IP; an explicit `gateway:` must match the peer exactly.

- **`NullAddress` next-hop = directly connected.** In `RoutingTable`, a rule whose `next_hop` is `NullAddress` means "destination network is on this interface; deliver to the packet's final destination directly." `Router._handle_forwarding` substitutes `packet.destination()` when it sees `NullAddress`. New code that builds rules must follow the same convention.

- **Hosts cannot forward.** `Host._handle_forwarding` raises. Multi-homed hosts are not modeled; a host has exactly one interface and (optionally) one gateway.

- **Longest-prefix match is linear.** `RoutingTable.match` scans all rules and tracks the largest mask. Fine for the simulator's scale; do not introduce a trie unless profiling says so.

- **`@requires_system` decorator on shell commands.** In `src/shell/shell.py`, the module-level `requires_system` decorator wraps any `do_*` that needs a loaded topology — it short-circuits with `'system not initialized!'` when `self._system is None`. `functools.wraps` preserves docstrings so `cmd.Cmd` still surfaces them in help listings. Add new commands with `@requires_system`; leave bootstrapping commands like `do_read` undecorated.

- **Dijkstra uses lazy deletion, not decrease-key.** `NetworkGraph._shortest_paths` pushes a fresh heap entry on every relaxation and skips stale pops via a `visited` set — O((V+E) log V). Don't reintroduce an in-place decrease-key scan.

- **All user-facing strings and docstrings are in English.** This includes shell `do_*` help strings, terminal command output, and exception messages. The codebase used to mix Spanish (shell help) with English (everything else); that's been normalized.

- **`PauseGate` gates packet propagation and keepalive.** `AS` owns one `PauseGate` (`src/entities/clock.py`). `Interface._pkt_loop` and `Network._pkt_loop` call `gate.wait_or_stop()` after each dequeue; `RoutingProtocol._keepalive_loop` waits on it instead of `time.sleep`. `AS.stop()` triggers the stop event, which wakes any blocked workers. New worker threads must follow the same pattern or they won't pause cleanly.

- **Web SPA uses native ES modules + an EventTarget bus.** `web/state.js` exports a singleton `bus = new EventTarget()`. Cross-component coordination (re-render after mutation, react to sim status changes) flows through bus events: `state:topology-changed`, `state:topology-loaded`, `state:selection-changed`, `sim:status-changed`, `sim:packet`, `sim:routing-table-changed`, `view:changed`. Synchronous queries and DOM helpers (`canvas.lookupDeviceNode`, `utils.el`, etc.) are direct imports. The rule: state mutations + cross-component re-renders → bus; sync queries + DOM helpers → direct import. Don't reintroduce module-to-module direct render calls.

- **Most fixtures under `test/resources/` are deliberately invalid** (e.g. `invalid_netmask.yaml`, `missing_as.yaml`). Don't "fix" them — they exist to assert the parser rejects them with the right error.
