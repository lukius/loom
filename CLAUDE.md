# netrouting

A Python simulator for an IPv4 autonomous system: hosts, routers, networks, and a link-state routing protocol over a YAML-described topology, driven from an interactive shell.

## Project Structure

```
netrouting/
├── src/
│   ├── netrouting.py      # Entry point — launches the shell
│   ├── entities/          # AS, Router, Host, Network, Interface, Address, Packet, Event
│   ├── routing/           # RoutingProtocol (link-state) + NetworkGraph (Dijkstra)
│   ├── parser/            # YAML topology loader + SystemValidator
│   └── shell/             # `cmd.Cmd`-based REPL (read/route/send/update_cost/exit)
├── test/
│   ├── base.py            # Custom unittest discovery (see "Tests" below)
│   ├── test_*.py          # Suites: address, entities, forwarding, graph, packet_handling, parser, protocol, routing_table
│   └── resources/         # YAML fixtures — most are intentionally invalid (parser/validator negative tests)
├── samples/sample.yaml    # Example topology
├── web/                   # Empty — placeholder for future UI
├── run_tests.py           # Test driver
└── README.md              # GitLab template boilerplate, ignore
```

## Build & Run

- Requires Python 3 and PyYAML (no `requirements.txt`; install ad-hoc: `pip install pyyaml`).
- Run shell: `cd src && python netrouting.py` — **must run from `src/`** because modules import bare top-level packages (`from entities import ...`, `from routing import ...`).
- Run tests: `python run_tests.py` from the **repo root** — `test/base.py` does `os.listdir('test')`, so cwd matters.
- Run a single suite: `python run_tests.py --address` → `test_address.py`. The `--<name>` flag is rewritten to `test_<name>.py`; the `--test<name>` form skips the `test_` prefix (so `--testbase` would load `base.py`).

## Git & Remote

- Hosted on **GitLab**, not GitHub: `gitlab.com:lukius/netrouting`. `gh` will not work; use `glab` or the web UI for MRs/issues.

## Shell usage

Inside the REPL, load a topology before any other command:

```
# read samples/sample.yaml
# route r1
# send h1 h2 hello
# update_cost r1 eth0 25
```

Commands run from `src/`, so paths like `samples/...` are relative to the repo root and need `../samples/...`. The `send` payload is a **single whitespace-delimited token** — no quoting, no spaces.

## Development Rules

### Testing — TDD (red / green / refactor)
- Write a failing test first (**red**). Run it and confirm it fails for the expected reason.
- Write the smallest change that makes it pass (**green**). Run the full suite.
- Clean up names, duplication, and structure (**refactor**) with the suite green; re-run after each refactor step.
- Do not commit code without a covering test, and do not commit a red suite. New parser/validator failure modes belong as YAML fixtures under `test/resources/` referenced from `test_parser.py`.
- Run `python run_tests.py` after every change.

### Documentation — keep in sync with code
- After a code change, check whether `README.md`, this `CLAUDE.md`, or any docstrings on the changed surface are now stale. If so, update them in the same commit — do not leave docs for "later".
- Update **only when needed**: a small internal refactor with no observable behavior change typically requires no doc edits. Behavioral, interface, layout, or workflow changes usually do.
- Surfaces that must stay accurate when touched: entry points and how to run them, shell command set + syntax, YAML schema, routing protocol wire format, project layout, dependencies.
- If a behavior is intentionally undocumented (e.g. an internal helper), say nothing — do not write speculative docs.

### Commits
- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, etc.
- One-liner messages, imperative mood, no co-author trailers.

### After touching code
- Run tests (red → green → refactor cycle complete, full suite green).
- If the change affects behavior, interfaces, layout, build/run, or workflows, update `README.md`, this `CLAUDE.md`, and any affected docstrings in the same commit. Pure-internal refactors with no observable change usually need no doc edits.

### About this file
- **Keep it under 200 lines.** If it grows past that, prune.
- **Only non-obvious context.** If it can be derived by reading the source, tests, or `git log`, it does not belong here. This file captures the *why*, the implicit conventions, and the traps.

## Key Design Decisions & Traps

- **Two different working directories.** The shell is run from `src/` (bare-package imports); tests are run from the repo root (`os.listdir('test')`). Do not "fix" one by breaking the other — instead preserve both entry-point contracts.

- **`samples/sample.yaml` uses the key `test_as:` while the parser requires `as:`.** Loading it as-is fails with `missing "as" key`. Either rename the top-level key when demoing, or treat the sample as a schema reference rather than a runnable file.

- **Link-state with sequence-numbered flooding.** `RoutingProtocol` (`src/routing/protocol.py`) broadcasts a `RoutingMessage` from every interface every `KEEPALIVE_INTERVAL = 10s` on a daemon thread per router. Receivers re-flood out of every interface *except* the one the message arrived on, deduplicated by `(src_address, seq)`. Recompute paths only when the local `NetworkGraph` actually changes — preserve that guard when editing, otherwise routing tables churn on every keepalive.

- **`NullAddress` next-hop = directly connected.** In `RoutingTable`, a rule whose `next_hop` is `NullAddress` means "destination network is on this interface; deliver to the packet's final destination directly." `Router._handle_forwarding` substitutes `packet.destination()` when it sees `NullAddress`. New code that builds rules must follow the same convention.

- **Hosts cannot forward.** `Host._handle_forwarding` raises. Multi-homed hosts are not modeled; a host has exactly one interface and (optionally) one gateway.

- **Longest-prefix match is linear.** `RoutingTable.match` scans all rules and tracks the largest mask. Fine for the simulator's scale; do not introduce a trie unless profiling says so.

- **`Shell.cmd` decorator trick.** In `src/shell/shell.py`, `cmd` is defined as an instance-method decorator, applied to each `do_*`, and then reassigned to `staticmethod(cmd)` at the end of the class body. This is required because `cmd.Cmd` introspects class attributes; without the staticmethod wrap, Python's descriptor protocol would bind `cmd` itself when the REPL lists commands. Add new commands using the same pattern: decorate with `@cmd` for ones that need a loaded system, leave undecorated (like `do_read`) for bootstrapping commands.

- **Dijkstra heap uses linear scan for decrease-key.** `NetworkGraph._shortest_paths` re-heapifies after locating the entry by `data() == neighbor`. Correct but O(V) per relaxation — acceptable for the toy graphs in scope; flag if topology sizes grow.

- **Mixed-language docstrings.** Shell help strings are in Spanish; code identifiers and most comments are in English. Keep new shell help in Spanish to match the user-facing convention; keep code in English.

- **Most fixtures under `test/resources/` are deliberately invalid** (e.g. `invalid_netmask.yaml`, `missing_as.yaml`). Don't "fix" them — they exist to assert the parser rejects them with the right error.
