# Contributing

Thank you for your interest in contributing to **loom**. This document covers
how to set up a development environment, the project's coding conventions, how
to run the test suites, and the merge-request process.

## Table of Contents

- [Development Setup](#development-setup)
- [Running the App Locally](#running-the-app-locally)
- [Getting to Know the Codebase](#getting-to-know-the-codebase)
- [Architecture Overview](#architecture-overview)
- [Test-Driven Development](#test-driven-development)
- [Running Tests](#running-tests)
- [Code Style](#code-style)
- [Documentation Discipline](#documentation-discipline)
- [Commit Conventions](#commit-conventions)
- [Submitting Changes](#submitting-changes)
- [AI-Assisted Development](#ai-assisted-development)
- [Project Conventions and Traps](#project-conventions-and-traps)

---

## Development Setup

**Prerequisites**

- Python 3.11+
- Node.js 18+ (only required for the JS unit tests and the Playwright
  end-to-end suite)
- A system Chromium browser (only for end-to-end tests)

```bash
git clone git@gitlab.com:lukius/netrouting.git
cd netrouting

# Python — create a virtualenv and install dev deps
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

# JS deps (only needed for vitest + playwright)
npm install
```

`requirements-dev.txt` brings in `pytest`, `pytest-asyncio`, `ruff`, and
`httpx`. The runtime-only set lives in `requirements.txt` (PyYAML, FastAPI,
Uvicorn).

---

## Running the App Locally

### Web UI (default)

```bash
cd src
python loom.py
# open http://127.0.0.1:8000
```

The server binds `127.0.0.1:8000` by default. Override with `LOOM_PORT`:

```bash
LOOM_PORT=8123 python loom.py
```

### Topology source

The server loads its topology from a YAML file. The default is
`samples/sample.yaml`; override with `LOOM_TOPOLOGY`:

```bash
LOOM_TOPOLOGY=/path/to/topology.yaml python loom.py
```

Mutations made during a simulation are persisted to
`<source>.session.yaml` next to the source. **The source file is never
modified.** Reset via the toolbar's **Reset** button (or `POST /topology/reset`).

### Legacy shell

```bash
cd src
python loom.py shell
```

See [`docs/user-guide/shell-cli.md`](docs/user-guide/shell-cli.md) for the
full command set.

---

## Getting to Know the Codebase

Before touching anything non-trivial, read these in order:

| Step | File | Why |
|---|---|---|
| 1 | `README.md` | Quick start, feature overview, project layout |
| 2 | `CLAUDE.md` | Build commands, key design decisions, traps (under 200 lines on purpose) |
| 3 | `docs/architecture/overview.md` | Component map and packet/event flow |
| 4 | `docs/architecture/routing-protocol.md` | The link-state protocol — the heart of the simulator |
| 5 | `samples/sample.yaml` | The shape of a topology file |

The `CLAUDE.md` file is the project's running list of *non-obvious context*.
If you find a footgun while working on the code, that is the right place to
record it.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│                  Web SPA (web/, ES modules)                    │
│  app · state · canvas · inspector · terminals · packets · sim  │
└─────────────────────────────┬──────────────────────────────────┘
                              │ HTTP (REST) + WebSocket (events)
┌─────────────────────────────▼──────────────────────────────────┐
│                FastAPI server (src/server/)                    │
│  routes/  command/  state.py  events.py  persistence.py        │
└─────────────────────────────┬──────────────────────────────────┘
                              │ Python calls
┌─────────────────────────────▼──────────────────────────────────┐
│                 Simulator core (src/entities/, src/routing/)   │
│  AS  Router  Host  Network  Link  Interface  Packet  PauseGate │
│  RoutingProtocol (link-state) + NetworkGraph (Dijkstra)        │
└─────────────────────────────┬──────────────────────────────────┘
                              │ parses
┌─────────────────────────────▼──────────────────────────────────┐
│        Parser + Validator (src/parser/)  ← samples/*.yaml      │
└────────────────────────────────────────────────────────────────┘
```

Rules of thumb:

- **Threads, not async, for the simulator core.** Each `Interface` and each
  `Network`/`Link` owns a daemon thread; `RoutingProtocol` owns one per
  router. All blocking workers gate on `PauseGate.wait_or_stop()` so the
  web UI can pause/resume cleanly.
- **Async only at the HTTP/WS boundary.** `server/events.py` bridges
  worker threads to the asyncio loop via `loop.call_soon_threadsafe`.
- **The SPA is plain ES modules — no framework, no bundler.** State and
  cross-component coordination flow through `bus = new EventTarget()` in
  `web/state.js`. Direct imports are reserved for synchronous queries and
  DOM helpers.

For the full picture see [`docs/architecture/overview.md`](docs/architecture/overview.md).

---

## Test-Driven Development

**TDD is the rule for this project**, not a preference. The cycle is
red → green → refactor:

1. **Red.** Write a failing test first. Run it and confirm it fails for the
   reason you expect.
2. **Green.** Write the smallest change that makes the test pass. Re-run the
   whole suite (not just the new test) — the smallest change in routing
   often breaks something three modules away.
3. **Refactor.** Clean up names, duplication, and structure with the suite
   green. Re-run after each refactor step.

Two hard rules:

- **No code without a covering test.** Including bug fixes — reproduce the
  bug as a failing test first.
- **No commit on a red suite.** If `pytest` fails locally, the commit waits.

New parser/validator failure modes belong as YAML fixtures under
`test/resources/`, referenced from `test/test_parser.py`. Most fixtures in
that directory are **deliberately invalid** — they exist to prove the
parser rejects them. Don't "fix" them.

---

## Running Tests

### Python (simulator + server)

```bash
pytest                      # full suite (190+ tests)
pytest test/test_protocol.py        # one suite
pytest -k routing_table             # one keyword
pytest -x                           # stop on first failure
```

`pyproject.toml` already configures `pythonpath = ["src"]` and
`testpaths = ["test"]`, so plain `pytest` works from the repo root.

### JavaScript (SPA units)

```bash
npm test
```

Uses vitest + happy-dom on the modules under `web/`.

### End-to-end (Playwright + real Chromium)

```bash
npm run test:e2e
```

Playwright boots a real FastAPI server on `LOOM_PORT=8766` (set in
`playwright.config.js` so it never collides with a hand-run `python loom.py`
on 8000). Requires a system Chromium — the suite does not download one.

### Lint

```bash
ruff check src/ test/
ruff format src/ test/      # format-only changes go in a separate commit
```

Linting must be clean before opening a merge request.

---

## Code Style

### Python

- Follow **PEP 8** (mechanically enforced by ruff), **PEP 257** for
  docstring conventions, and the spirit of **PEP 20** (Zen of Python —
  favor explicit, simple, readable code).
- Default line length is whatever ruff defaults to. Wrap aggressively.
- No new runtime dependencies without discussion. The runtime set is
  small on purpose: PyYAML, FastAPI, Uvicorn.
- Identifiers, docstrings, comments, and all user-facing strings in
  English.

### JavaScript

- Plain ES modules — **no framework, no bundler**.
- Cross-component coordination through `bus` (the singleton EventTarget
  exported from `state.js`). Synchronous queries and DOM helpers stay as
  direct imports.
- Each module is single-purpose: `canvas.js` owns the SVG, `inspector.js`
  owns the right pane, etc. Don't introduce module-to-module direct
  render calls.

---

## Documentation Discipline

`loom` has three layers of documentation that travel with the code:

1. **`README.md`** — the entry point. Quick start, feature overview, and
   pointers to the rest of the documentation.
2. **`CLAUDE.md`** — non-obvious project context (under 200 lines, by
   policy). Decisions, traps, and conventions a fresh reader cannot
   recover from the source.
3. **`docs/`** — the comprehensive reference, split into
   `docs/architecture/` (technical, how it's built) and
   `docs/user-guide/` (user-facing, how to drive it).

When you change code:

- **If the change is observable** (behavior, interface, project layout,
  build/run command, YAML schema, wire protocol), update the relevant
  doc surface in the same commit. Don't leave docs for "later" — they
  rot in hours.
- **If the change is a pure internal refactor** with no observable effect,
  documentation usually needs no edits. Don't churn the docs for code
  motion.
- **Update only what's affected.** A change to packet animation does not
  imply a sweep of `docs/architecture/`.

If a behavior is intentionally undocumented (e.g. an internal helper),
say nothing — speculative documentation is worse than none.

---

## Commit Conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>
```

| Type | When |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code change that is neither a fix nor a feature |
| `test` | Adding or updating tests |
| `docs` | Documentation only |
| `chore` | Build, tooling, dependencies |
| `style` | Pure format/whitespace |

Rules:

- One-liner messages only (no multi-paragraph body).
- Imperative mood: "add forwarding test", not "added" or "adds".
- **No co-author lines or AI attribution** in commit messages.
- Mix categories carefully. A typical safe shape is one `feat:` per MR
  with a small `test:` and `docs:` follow-up.

---

## Submitting Changes

The project is hosted on **GitLab** (`gitlab.com:lukius/netrouting`).
The GitHub CLI (`gh`) does not work here — use `glab` or the GitLab web UI
for merge requests and issues.

1. Branch off `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
2. Make your changes following the [Test-Driven Development](#test-driven-development)
   cycle.
3. Ensure `pytest`, `npm test`, and `ruff check src/ test/` are all clean.
4. Push and open an MR:
   ```bash
   git push -u origin feat/my-feature
   glab mr create        # or use the web UI
   ```
5. Describe **what** the MR does and **why** in the description; reference
   related issues. Keep MRs focused — one logical change per MR.

---

## AI-Assisted Development

`loom` is primarily developed with [Claude Code](https://claude.ai/code),
but any AI assistant can use `CLAUDE.md` and the `docs/` tree to get
oriented. Human contributors do not need to use any AI tooling; all
conventions apply equally.

### CLAUDE.md

`CLAUDE.md` is the AI context file for this project. Keep it useful:

- **Under 200 lines.** If it grows past that, something belongs
  elsewhere (probably `docs/architecture/`) or can be cut.
- **Only non-obvious context.** Things a reader cannot derive by
  reading the source, tests, or `git log`: the *why* behind decisions,
  implicit conventions, known traps, the rationale for non-default
  choices. Routine implementation details belong in
  `docs/architecture/` or in the code itself.
- **Update when the trap surface changes.** New gotchas, renamed
  entry points, schema changes, threading-model shifts — those go
  here. Internal refactors that don't change observable behavior
  usually don't need a `CLAUDE.md` update.
- **Don't duplicate this file.** `CONTRIBUTING.md` is the canonical
  dev guide; `CLAUDE.md` is the trap cheat sheet. Link between them,
  don't copy.

### The doc set

`docs/architecture/` and `docs/user-guide/` are the long-form
reference. When you change observable behavior (interfaces, layout,
build/run, YAML schema, HTTP/WS API, packet types, the routing-protocol
wire format), update the affected page in the same commit. See
[Documentation Discipline](#documentation-discipline) above for the
full rule.

The `.claude/` directory holds only local Claude Code settings
(`settings.local.json` is gitignored). `loom` is small enough that an
AI assistant reading `CLAUDE.md` plus the relevant architecture page
can plan and execute most changes directly.

### If you use Claude Code (or a similar agent-style assistant)

A few pointers that save time on this project specifically:

- **Always read `CLAUDE.md` first.** It's the shortest path to "what
  will trip me up."
- **For protocol or packet-level work**, also read
  `docs/architecture/routing-protocol.md` and
  `docs/architecture/packets.md` — they cover the non-obvious
  invariants in detail (sequence-number dedup, `NullAddress` as the
  directly-connected sentinel, structural link-peer resolution).
- **For threading work**, read `docs/architecture/concurrency.md`
  before adding a new worker — every new thread must gate on the
  shared `PauseGate`, or pause/resume will be broken.
- **For UI work**, `docs/architecture/web-spa.md` is the module map
  and event-bus contract.
- **The `docs/superpowers/` directory is gitignored.** It's where the
  `superpowers:writing-plans` and related skills drop their working
  files; plans and specs that live there are local artifacts, not
  project documentation. Lift anything worth keeping into
  `docs/architecture/` before deleting.

### Subagent-driven execution for multi-task features

When a feature is planned as several tasks/commits, `loom` follows a
fixed per-task dev → reviewer cycle, with a final review and QA pass
after every task lands. The process is captured in
[`.claude/process/subagent-driven-execution.md`](.claude/process/subagent-driven-execution.md):
role profiles (Python / JavaScript / OO design for the developer;
hands-on network engineering for the reviewer), briefing templates,
the loop, and decision rules. Reuse the process for any multi-commit
feature; skip it for single-commit fixes, small refactors, or
one-off doc edits.

---

## Project Conventions and Traps

The full list lives in `CLAUDE.md`. The most important ones for newcomers:

- **The shell runs from `src/`, everything else from the repo root.** The
  shell entry point uses bare-package imports (`from entities import ...`).
  `pytest` and `ruff` are configured from the repo root via
  `pyproject.toml`'s `pythonpath = ["src"]`.
- **AS YAML shape: `as:` at the top, `name:` inside.** The parser requires
  the literal top-level key `as:` and reads the AS name from a nested
  `name:` field. Anything that emits topology YAML (the SPA, future
  tools) must produce that shape.
- **`Network._interfaces` is keyed by interface IP, not by `iface.name()`.**
  Interface names are only unique within a single device (`r1.eth0` and
  `r2.eth0` both sit on the same LAN); keying by name would clobber
  siblings.
- **`Link` is a sibling of `Network`** (both subclass `_FabricBase`).
  `/30` or `/31` only, enforced in both `Link.__init__` and
  `LinkValidator`. Capped at exactly two endpoints; a host's gateway on a
  link is auto-filled from the peer's IP by the parser post-pass.
- **`NullAddress` next-hop = directly connected.** In `RoutingTable`, a
  rule whose `next_hop` is `NullAddress` means "destination network is on
  this interface; deliver to the packet's final destination directly."
- **Hosts cannot forward.** A host has exactly one interface and (optionally)
  one gateway.
- **`PauseGate` is the project's pause primitive.** New worker threads
  must call `gate.wait_or_stop()` after each dequeue, or
  `gate.sleep(interval)` if they have a timer, or they will not pause
  cleanly with the rest of the system.
- **Dijkstra uses lazy deletion, not decrease-key.** `NetworkGraph._shortest_paths`
  pushes a fresh heap entry on every relaxation and skips stale pops via a
  `visited` set. O((V+E) log V); fine for the simulator's scale.
- **Most fixtures under `test/resources/` are deliberately invalid.** They
  assert that the parser rejects malformed input. Don't "fix" them.
