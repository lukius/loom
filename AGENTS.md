# loom

A Python simulator for an IPv4 autonomous system: hosts, routers, networks, and a link-state routing protocol over a YAML-described topology, driven by an interactive web UI.

## Project Structure

```
loom/
├── src/
│   ├── loom.py            # Entry point — starts the FastAPI server
│   ├── entities/          # AS, Router, Host, Network, Interface, Address, Packet, Event, nat.py
│   ├── routing/           # RoutingProtocol (loom-OSPF link-state), Scheduler, LSDB → NetworkGraph (Dijkstra), policy.py
│   ├── parser/            # YAML topology loader + SystemValidator
│   └── server/            # FastAPI app, SimState lifecycle/edit controller, EventTracer bridge, routes/, command/
├── test/
│   ├── test_*.py          # Suites: address, admin_down, entities, event_subscribers, forwarding, graph, hello, link, lock_safety, lsa, lsdb, nat, neighbor, packet_handling, parser, pause_gate, ping, policy, protocol, routing_table, scheduler, server_{commands,events,files,lifecycle,lock_discipline}, thread_resilience, topology_patch
│   └── resources/         # YAML fixtures — most are intentionally invalid (parser/validator negative tests)
├── samples/sample.yaml    # Example topology
├── web/
│   ├── index.html         # SPA shell (~355 lines: HTML + <script type="module" src="app.js">)
│   ├── styles.css         # Extracted CSS
│   ├── app.js             # Entrypoint: imports, wire(), init(), DOMContentLoaded
│   ├── state.js           # State object, persist/restore, sample, bus (EventTarget)
│   ├── utils.js           # DOM/string helpers (el, escapeHtml, toast, …)
│   ├── sim.js             # Sim state machine + RuntimeClient + WS event router
│   ├── canvas.js          # SVG rendering, drag/pan, theme, layout
│   ├── inspector.js       # Nav, right-pane panels, rename/duplicate/delete ops, context menu
│   ├── terminals.js       # Per-node terminal popups
│   ├── packets.js         # PacketAnim + tooltips
│   ├── packetstore.js     # PacketStore: in-flight registry, NAT cache, #N counters
│   ├── packetspanel.js    # Slide-out Packets panel
│   ├── file-picker.js     # Import file picker
│   ├── modal.js           # Modal dialog helper
│   ├── packettypes.js     # Packet type constants
│   ├── preflight.js       # Pre-start environment checks
│   ├── protocolpopover.js # Protocol timer config popover
│   ├── yaml-io.js         # YAML import/export helpers
│   └── *.test.js          # vitest tests co-located (utils, state, sim, …)
├── e2e/                   # Playwright smoke suite (real Chromium + spawned FastAPI)
├── docs/
│   ├── architecture/      # Technical reference (overview, entities, packets, routing-protocol, concurrency, parser, server-api, nat, policy)
│   ├── user-guide/        # User manual (getting-started, web-ui, building-topologies, running-simulations, routing-tables, terminals, yaml-format, nat-and-private-lans)
│   ├── development/       # Dev process docs (subagent-driven-execution)
│   └── images/            # Screenshots used by user-guide
├── .github/workflows/     # CI (PRs + main) and Release (v* tags) pipelines
├── Dockerfile             # Container image; tools/package-release.sh builds the release zip
├── docker-compose.yml     # One-service compose file for ghcr.io/lukius/loom
├── playwright.config.js   # E2E config: chromium-only, webServer on LOOM_PORT=8766
├── pyproject.toml         # ruff + pytest config (sets pythonpath = ["src"], testpaths = ["test"])
├── requirements.txt       # Runtime deps (PyYAML, FastAPI, uvicorn)
├── requirements-dev.txt   # Dev deps: + pytest, pytest-asyncio, ruff, httpx
├── CONTRIBUTING.md        # Canonical dev guide (full TDD workflow, PR process, conventions)
├── CHANGELOG.md           # Keep-a-Changelog format
├── LICENSE                # MIT
├── AGENTS.md              # This file — non-obvious context for coding agents
├── CLAUDE.md              # Compatibility shim: imports AGENTS.md for Claude Code
└── README.md              # Quick start and project overview
```

## Build & Run

- Requires Python 3.11+. Install runtime deps: `pip install -r requirements.txt`. For dev (tests + lint): `pip install -r requirements-dev.txt`.
- **Web UI:** `cd src && python loom.py` — launches FastAPI on http://127.0.0.1:8000 and serves the SPA from `web/`.
- **Container:** `docker run --rm -p 8000:8000 ghcr.io/lukius/loom:latest`. The image sets `LOOM_HOST=0.0.0.0` (a container binding loopback publishes nothing) and copies `src/`, `web/`, `samples/` into `/app` so the `_repo_root` resolution in `server/app.py` still works. The final image has no pip: the Dockerfile installs through the OS CA store (`--cert`; pip 24.0 keeps honouring its vendored bundle under `--use-feature=truststore`), then uninstalls pip, because the base image's pip vendors a stale CA bundle. `tools/check-image.sh <image>` asserts this and that the server boots.
- Topology source path: env var `LOOM_TOPOLOGY` (default `samples/sample.yaml`). The server never writes the source; it clones to a session file under a temp dir (`<system-tmp>/loom/<stem>.<hash>.session.yaml`, overridable via `LOOM_SESSION_DIR`) and writes only there.
- HTTP bind: env vars `LOOM_HOST` (default `127.0.0.1`) and `LOOM_PORT` (default `8000`), both read by `src/loom.py`. The Playwright suite uses `8766` to avoid colliding with a dev server.
- Run tests: `pytest` from the repo root. Single suite: `pytest test/test_address.py`.
- JS tests: `npm install` (first time only), then `npm test` from the repo root. Uses vitest + happy-dom.
- E2E tests: `npm run test:e2e` runs Playwright against a real Chromium and a spawned FastAPI server. Requires a system Chromium browser (the suite does not download one).
- Lint: `ruff check src/ test/`. Format: `ruff format src/ test/`.

## Git & Remote

- Hosted on **GitHub**: `github.com/lukius/loom` (remote `origin`). Use `gh` or the web UI for PRs/issues. `gitlab.com:lukius/netrouting` remains as a push mirror on remote `gitlab`; it takes no PRs.
- **CI gates `ruff format --check`, not just `ruff check`.** Run `ruff format src/ test/` before pushing or the Python job fails. Releases are tag-driven: pushing `vX.Y.Z` publishes the GHCR image and the GitHub Release. See `CONTRIBUTING.md#releasing`.
- **`main` is protected and expects PRs**, gated on the four CI jobs with linear history (squash/rebase, no merge commits). Repo admins can still push straight to `main`; that is a deliberate hotfix escape hatch, not the normal path, so branch and open a PR by default.

## Development Rules

### Testing — TDD (red / green / refactor)
- Write a failing test first (**red**). Run it and confirm it fails for the expected reason.
- Write the smallest change that makes it pass (**green**). Run the full suite.
- Clean up names, duplication, and structure (**refactor**) with the suite green; re-run after each refactor step.
- Do not commit code without a covering test, and do not commit a red suite. New parser/validator failure modes belong as YAML fixtures under `test/resources/` referenced from `test_parser.py`.
- Run `pytest` after every change.
- **Never dismiss a flake — fix it, whether or not you caused it.** A test that fails intermittently is a defect in its own right: it may be masking a real bug, and it teaches everyone to ignore red. Reproduce it under load (see below), find the actual race, and fix it in the same pass — "it passed on re-run" and "that one was already flaky" are not resolutions.
- **Poll for asynchronous effects; never sleep-then-assert.** Packets and events come from worker threads, so `time.sleep(0.2); assert event_arrived` is a race that passes on an idle machine and fails under load. Use the module-local `_wait(condition, timeout)` helper (`test_ping.py`, `test_protocol.py`, `test_admin_down.py`, `test_link.py`, `test_thread_resilience.py`; `_wait_for` in `test_event_subscribers.py`). A fixed sleep is only legitimate when the wait *is* the subject — measuring a tick rate, or stepping past a dead interval — or before a *negative* assertion ("nothing happened in this window"), where extra delay can only strengthen the check.
- **A ping across a router must wait for that router's routing table first** (`_wait(lambda: _table_has_prefix(r, prefix))`). The table is written on the first protocol tick after `start()`; `Host.ping` sends a single request with no retransmit, so a ping issued before that tick is dropped for want of a route and the test flakes only when the machine is busy.
- **Reproduce flakes under load, not on an isolated run.** A single test rerun almost always passes. Run the whole suite (hundreds of lingering worker threads change the timing), or run a second suite alongside it — `pytest` next to `npm run test:e2e`, or e2e next to repeated `npm test`. Timing assertions are the usual suspects: check the *margin*, not just the pass, since a bound the machine clears by 5% is already broken.

### Documentation — keep in sync with code
- After a code change, check whether `README.md`, this `AGENTS.md`, the relevant page under `docs/architecture/` or `docs/user-guide/`, or any docstrings on the changed surface are now stale. If so, update them in the same commit — do not leave docs for "later".
- Update **only when needed**: a small internal refactor with no observable behavior change typically requires no doc edits. Behavioral, interface, layout, or workflow changes usually do.
- Surfaces that must stay accurate when touched: entry points and how to run them, per-device terminal command set + syntax, YAML schema, routing protocol wire format, project layout, dependencies, HTTP/WS API.
- When touching `docs/user-guide/` for a user-visible change, follow `.claude/skills/user-guide-update/SKILL.md` — it covers page selection, action-level wording, and capturing the screenshot via `npm run screenshot` (tool at `tools/screenshot.mjs`). It is packaged as a Claude Code skill, but the body is plain markdown: if your harness has no skill mechanism, read the file directly.
- `CONTRIBUTING.md` is the canonical dev guide; this file (`AGENTS.md`) is the cheat sheet of non-obvious traps. Don't duplicate content — link from one to the other.
- If a behavior is intentionally undocumented (e.g. an internal helper), say nothing — do not write speculative docs.
- **`docs/es/user-guide/` (and `README.es.md`) is a Spanish translation of `docs/user-guide/` (and `README.md`); English is canonical.** There is no Spanish translation of `docs/architecture/` — it changes too often to keep a second-language copy honest, so `README.es.md`'s architecture table links straight to the English pages. During normal development, IGNORE `docs/es/`: don't read it for context and don't update it alongside English doc edits — it is a periodically-refreshed translation, not a source of truth, and English is the single authority. Only touch it when explicitly doing translation work (then re-translate the changed English user-guide pages). This keeps the English docs authoritative and keeps agent context lean.

### Linting & style
- Run `ruff check src/ test/` before every commit; fix or `# noqa` (with reason) any reported issues. Do not commit a dirty lint.
- Follow standard PEP practices: **PEP 8** (style), **PEP 257** (docstring conventions), **PEP 20** (Zen of Python — favor explicit, simple, readable code). Ruff enforces the mechanical PEP 8 rules by default; the rest is on the author.
- **Imports at the top of the file** (PEP 8). Function-level imports are a code smell — only acceptable to break a circular import or to defer an expensive optional dep, and must carry `# noqa: PLC0415` with the reason. This applies to test files too: ruff's default `E402` only catches module-level placement, not in-function imports, so the discipline is on the author.
- `ruff format src/ test/` is fine to run, but format-only churn should land in its own commit (`style:` or `chore:`), not mixed with behavioral changes.

### Backend ↔ frontend decoupling
- The Python backend (`src/`) MUST NOT mention the SPA, the web UI, animations, the canvas, tooltips, or any frontend rendering concern in code, comments, docstrings, or test docstrings. The HTTP/WS API and the EventTracer event shape are the public contract; describe events as broadcast facts (e.g. "emits a `packet` event"), not in terms of what the UI does with them. The SPA is one subscriber among many possible — tests, future TUIs — and the backend must look the same to all of them.
- The reverse direction (SPA referring to backend wire shapes by name) is fine and expected — the SPA is the consumer.

### Commits
- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `style:`, etc.
- One-liner messages, imperative mood, no co-author trailers.

### After touching code
- Run tests (red → green → refactor cycle complete, full suite green).
- Run `ruff check src/ test/` and resolve any new findings.
- If the change affects behavior, interfaces, layout, build/run, or workflows, update `README.md`, this `AGENTS.md`, the affected pages under `docs/`, and any affected docstrings in the same commit. Pure-internal refactors with no observable change usually need no doc edits.

### Subagent-driven execution for multi-task work
- When implementing a feature planned as multiple tasks/commits (typically from a written plan), follow the per-task dev → reviewer cycle in `docs/development/subagent-driven-execution.md` instead of executing inline. Use it for any multi-commit feature; skip it for single-commit fixes, small refactors, or one-off doc edits.
- The doc covers role profiles (Python / JS / OO for dev; network-engineering for reviewer), briefing templates, the per-task loop, and the final-review + QA passes.

### About this file
- **Keep it under 200 lines.** If it grows past that, prune.
- **Only non-obvious context.** If it can be derived by reading the source, tests, or `git log`, it does not belong here. This file captures the *why*, the implicit conventions, and the traps.
- **`AGENTS.md` is the single source of instructions.** `CLAUDE.md` is a compatibility shim that imports this file, since Claude Code does not read `AGENTS.md` natively. Never add content to the shim, and don't add per-tool variants (`GEMINI.md`, `.cursorrules`, …): every other agent reads `AGENTS.md` directly.

## Key Design Decisions & Traps

- **Server entry point uses bare-package imports; run from `src/`.** `src/loom.py` imports `from server import run` at call time — the bare-package import style requires `cd src && python loom.py`. Pytest and ruff are configured to run from the repo root (`pyproject.toml`). Do not refactor imports to fix the cwd quirk without first updating both the entry point and `pyproject.toml`'s `pythonpath`.

- **YAML shape: `internet:` → `autonomous_systems:` → `<short_name>:`.** The parser requires a top-level `internet:` key (with optional `name:`, default `loom`) containing a mandatory `autonomous_systems:` mapping. Each AS is keyed by its short name (the dict key *is* the name — there is no nested `name:`), and carries `asn:`, `networks:`, optional `links:`, `routers:`, `hosts:`. `samples/sample.yaml` follows this shape and loads cleanly. Anything that emits topology YAML (the SPA, future tools) must produce the same shape, and `SimState._dump_yaml` (`src/server/state.py`) must stay symmetric with the parser.

- **loom-OSPF: one daemon thread per router drives three independent jittered timers via a `Scheduler` (`src/routing/scheduler.py`).** `_protocol_loop` honours `hello` (default 10s), `lsa_refresh` (30s), and `maxage_check` (same cadence as refresh). Each timer reschedules after firing with per-tick jitter `[0.75·T, 1.25·T]`; the initial Hello + LSA fire at t≈0 (unjittered). `set_timers(hello_interval=, lsa_refresh_interval=)` derives `dead = 3 × hello` and `max_age = 2 × refresh`. On origination the router installs a **permit-all** LSA locally (so private prefixes appear in the local graph) but floods a **policy-filtered** LSA to peers (RFC 1918 dropped by `RFC1918_OUTBOUND`). Receivers re-flood every accepted LSA out every interface *except* the inbound, deduplicated per-origin in the `LSDB`. SPF recomputes only when an LSA's links actually change (`InstallResult.changed_graph()`).

- **NAT: routers keep a per-flow `NATTable` (`entities/nat.py`).** Source-NAT rewrites the source address on egress to public networks and reverses on inbound return, keyed by `(rewritten_src, original_dst, flow_id)`. Each rewrite emits a `nat` event; `nat_table_changed` events carry a snapshot for subscribers. The flow discriminator comes from `payload.flow_key()` so two private hosts behind one NAT router can reach the same public destination concurrently.

- **Routing policy: `routing/policy.py` exposes `PERMIT_ALL` and `RFC1918_OUTBOUND`.** The local LSA uses `PERMIT_ALL` so all directly-connected prefixes (including RFC 1918) appear in the local graph. The outbound (flooded) LSA uses `RFC1918_OUTBOUND`, which denies the three private ranges and permits everything else. Private prefixes therefore route locally but never enter peers' graphs.

- **An LSA advertises *attachments*: `{fabric: Attachment(cost, prefix|None)}`. The fabric is always advertised; the prefix only when policy permits.** Topology and reachability are separate: a private LAN or `/30` carries transit traffic while nobody outside installs a route to it (`prefix is None`). `LSDB.build_graph` keys transit nodes on the **fabric object**, not the prefix — duplicate private CIDRs are legal within an AS, so prefix-keyed nodes would fuse unrelated LANs; announced prefixes hang off their fabric as 0-cost leaves with no edge back out. Consequences: `has_same_links_as` compares attachments (or SPF misses fabric-only changes); `_iface_on`/`_next_hop_address` match interfaces by `is` on the fabric, never by prefix equality; a fabric is traversable only while both ends advertise it, which is what stops a half-open link black-holing (no explicit reverse-link check needed). `LSA.add_link(prefix, cost)` stays as a convenience — it resolves the origin's fabric for that prefix so hand-built LSAs key the same node as policy-built ones.

- **`Network._interfaces` is keyed by interface IP address, not by `iface.name()`.** Interface names are only unique within a single device (every router happens to call its first interface `eth0`), so keying by name would clobber siblings on the same LAN. The parser/validator enforces IP-address uniqueness within each network, which is what makes the address a safe key. Anything new that joins interfaces to networks must follow this rule.

- **`Link` is a sibling of `Network`, both subclassing `_FabricBase` (`entities/_fabric.py`).** `Link._dispatch_packet` delivers to the endpoint whose IP is not `frame.source()`; drops silently if only one endpoint is attached (construction race guard). No broadcast/unicast split — there is no broadcast domain. `/30` or `/31` only, enforced in both `Link.__init__` and `LinkValidator`. A host's gateway on a link is auto-filled by the parser post-pass from the peer's IP; an explicit `gateway:` must match the peer exactly.

- **`NullAddress` next-hop = directly connected.** In `RoutingTable`, a rule whose `next_hop` is `NullAddress` means "destination network is on this interface; deliver to the packet's final destination directly." `Router._handle_forwarding` substitutes `packet.destination()` when it sees `NullAddress`. New code that builds rules must follow the same convention.

- **Hosts cannot forward.** `Host._handle_forwarding` raises. Multi-homed hosts are not modeled; a host has exactly one interface and (optionally) one gateway.

- **Longest-prefix match is linear.** `RoutingTable.match` scans all rules and tracks the largest mask. Fine for the simulator's scale; do not introduce a trie unless profiling says so.

- **Dijkstra uses lazy deletion, not decrease-key.** `NetworkGraph._shortest_paths` pushes a fresh heap entry on every relaxation and skips stale pops via a `visited` set — O((V+E) log V). Don't reintroduce an in-place decrease-key scan.

- **All user-facing strings and docstrings are in English.** This includes terminal command output and exception messages. The codebase used to mix Spanish with English; that's been normalized.

- **`PauseGate` gates packet propagation and the protocol loop.** `AS` owns one `PauseGate` (`src/entities/clock.py`). `Interface._pkt_loop` and `Network._pkt_loop` call `gate.wait_or_stop()` after each dequeue; `LinkStateProtocol._protocol_loop` polls the gate instead of sleeping. `AS.stop()` triggers the stop event, which wakes any blocked workers. New worker threads must follow the same pattern or they won't pause cleanly.

- **Admin-down is a per-interface `is_up()` flag; the protocol thread never stops.** `Interface.is_up()` governs whether traffic is forwarded and whether the link appears in the router's LSA. Router halt = disable all interfaces + flood a withdrawal LSA (graceful) or just disable interfaces (crash). Resume = re-enable interfaces + re-announce via a fresh LSA. Crash (`POST /devices/{name}/fail`) is identical at rest — it sets `is_up()` to `False` silently; peers detect it only via dead-interval or max-age. Crash vs graceful is a **transition-time fork**, not stored state; down-state is runtime-only and is not serialized to the session YAML.

- **Web SPA uses native ES modules + an EventTarget bus.** `web/state.js` exports a singleton `bus = new EventTarget()`. Cross-component coordination flows through bus events (representative: `state:topology-changed`, `state:topology-loaded`, `state:selection-changed`, `sim:status-changed`, `sim:packet`, `sim:routing-table-changed`, `sim:packet-arrived`, `sim:nat-table-changed`, `packets:list-changed`, `view:changed`). Synchronous queries and DOM helpers (`canvas.lookupDeviceNode`, `utils.el`, etc.) are direct imports. The rule: state mutations + cross-component re-renders → bus; sync queries + DOM helpers → direct import. Don't reintroduce module-to-module direct render calls.

- **Most fixtures under `test/resources/` are deliberately invalid** (e.g. `invalid_netmask.yaml`, `missing_as.yaml`). Don't "fix" them — they exist to assert the parser rejects them with the right error.

- **Live edits go through `SimState.edit()` under `_edit_lock`.** Validate-all-then-apply-all atomicity against other editors. `start`, `resume`, and `stop` also take `_edit_lock`; lock ordering is always `_edit_lock` → `_lock` (never reversed). Fabric dispatch reads `list(self._interfaces.values())` snapshots so concurrent edits can't raise "dict changed size". Removals must call `fabric.remove_interface(addr)` **before** stopping the iface thread (detach-before-stop). The SPA defers incomplete live-adds until the address/CIDR is valid — same validators as the inspector (`validateAddressOnFabric`, `isValidNetworkCidr`, `isValidLinkCidr` in `utils.js`). Interface re-addressing and host/network reassignment ("C") are **not** supported; those require Stop → edit → Start.
