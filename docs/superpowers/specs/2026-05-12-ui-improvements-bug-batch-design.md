# UI improvements — bug batch design

**Date:** 2026-05-12
**Branch:** `feature/ui-improvements`
**Source:** the `fixes` punch list captured after the first round of manual smoke-testing on this branch.

## Scope

22 items from the `fixes` file, fixed in a single linear pass on this worktree. Items group into ten clusters by area; each cluster lands as one commit with a conventional-commits one-liner. No parallel subagents — most clusters share `web/index.html`.

## Decisions (user-confirmed)

- Hostnames remain valid args for `ping`/`send`; uniqueness already enforced at the AS level.
- Terminal input is **disabled** while the simulation is paused; a `(paused)` chip appears in the term header.
- The chatter button keeps its current behavior but gains a visible `Chatter` label and a clearer tooltip.
- `KEEPALIVE_INTERVAL` becomes editable from the toolbar (1–300s server-side validation).

## Clusters

### A — Command / role correctness (#4, #5, #6)
- Frontend `help` no longer uses the hardcoded list at `web/index.html:1864`. Instead, route `help` through the same backend dispatcher as every other command (`POST /devices/{name}/command`, `cmd=help`).
- Backend `server/command/host.cmd_help` and `server/command/router.cmd_help` already return the right per-role list; no backend change needed.
- Test: extend `test_shell_commands` to assert host/router help differs and that role-only commands (`neighbors`, `update_cost` on a host; `send`, `ping` on a router) return "unknown command".

### B — Ping with no gateway (#14)
- `src/entities/host.py` `ping()` currently does `send_dst = self._gw_address or dst_addr`, silently emitting a packet on the local LAN even when the destination is off-LAN with no gateway.
- Fix: raise `ValueError("no route to host: no gateway configured")` in the same shape as `send_message_to`. Server-side `cmd_ping` already catches exceptions and surfaces the message.
- Test: new `test_host_ping_no_gateway` asserts the exception and that no packet event is emitted.

### C — Default sim doesn't converge (#7)
- Root cause hypothesis: `RoutingProtocol._keepalive_loop` sleeps `KEEPALIVE_INTERVAL` (10s) **before** the first tick; full LSA propagation in the sample topology requires ~30s and the user's first interaction can land in that window with empty neighbor tables.
- Fix: tick once immediately on `start()` (before entering the sleep loop), so every router broadcasts its first LSA at t≈0.
- If after the fix the r1-sees-no-neighbors symptom from the screenshots persists, dig into the `_seqs_by_address` / `_update_graph` paths and the receive side of `handle_incoming_message`.
- Test: new `test_protocol_initial_broadcast` boots the sample topology, waits one keepalive interval, and asserts every router's graph contains every other router and every network prefix.

### D — Pause / edit / context-menu UX (#16, #17, #20, #21)
- **#16 Pause icon:** in `Sim._renderToolbar`, swap the `<use href="#ui-pause"/>` to `#ui-play` when state is `paused`. Label change already exists.
- **#17 Terminal during pause:** disable `.term-in`, show a `(paused)` chip in the term header. Hook into the existing `sim_state` WS event; re-enable on resume.
- **#21 Right-click during sim:** when `Sim.state !== 'idle'`, render destructive context-menu options (`edit`, `delete`, `duplicate`, `detach`, `connect-to-LAN`, `move-host`) as disabled. Keep read-only items (`Fit to view`) live.
- **#20 Resume-after-edit kills clicks:** investigate at implementation. Likely candidates: stale DOM event listeners after `reconcilePatch`, or `renderCanvas` failing to re-wire handlers after the resume round-trip. Fix the actual cause; add a regression test on the patch+resume path.

### E — Terminal UX (#2, #3, #9)
- **#2 Focus recovery:** mousedown on the term window calls `.term-in.focus()`.
- **#3 Shortcuts:** `Ctrl+D` closes the focused terminal (only when input is empty, matching bash); `Ctrl+L` clears the screen.
- **#9 Mac-style frame:** redesign `.term-header`: gray background, traffic-light buttons on the left — red (functional close), yellow + green decorative (no handler, `cursor: default`). Drop the existing `×` button. Title stays centered. CSS-only change.

### F — Inspector polish (#11)
- Wrap each router interface in a `<details>` element collapsed by default, with a one-line summary like `eth0 — lan1 (200.100.0.1) cost=10`. The routing-table section already renders below — collapsing the interfaces makes it visible at first glance.

### G — Toast info visibility (#1)
- The toast CSS currently only styles `.ok` and `.error` (line ~1147). Add an `.info` variant with a blue/cyan border + tinted background that works in both light and dark themes.

### H — Packet animation (#10, #12, #22)
- `PacketAnim.DURATION_MS: 600 → 1800` (per-hop animation 900ms each segment instead of 300ms).
- Packet dot `r: 5 → 8`, plus a subtle outline for contrast against the canvas grid.
- Per-hop path correctness is already correct: each `Interface.send_to` fires one packet event, so the animated dot really does walk hop-by-hop. Slowing it down makes that visible. The "ping fires a packet anyway with no gateway" symptom from #12 is fixed by cluster B.

### I — Chatter button label (#18)
- Add a visible `<span class="lbl">Chatter</span>` next to the icon, mirroring the Pause/Play buttons. Tooltip becomes `"Show/hide routing-protocol packets"`. No behavior change.

### J — Editable refresh interval (#19)
- Promote `KEEPALIVE_INTERVAL` from class constant to instance attribute on `RoutingProtocol`; expose a setter. The keepalive thread reads the instance attribute each loop, so the new value takes effect on the next tick.
- New backend endpoint `POST /sim/refresh_interval {seconds: N}` updates every router's protocol; validates `1 ≤ N ≤ 300`.
- Toolbar gets a small numeric input `Refresh: [10]s` between pause and chatter; on change → POST.
- Test: `test_protocol_refresh_interval_setter` asserts subsequent ticks use the new value; `test_server_refresh_interval_endpoint` covers the HTTP surface and the validation bounds.

## Cross-cutting

- Every behavioral fix gets a covering test (TDD red → green → refactor per CLAUDE.md). Lint must be clean (`ruff check src/ test/`). Full `pytest` suite must be green before each commit.
- Doc updates: README and CLAUDE.md get a brief note for the new `/sim/refresh_interval` endpoint, the editable refresh interval, and the terminal shortcuts. Per CLAUDE.md's "only non-obvious context" rule, no other doc churn.
- Commits use conventional-commits one-liners, no co-author trailer.

## Out of scope

- Anything not in the `fixes` list (no opportunistic refactors).
- Topology-wide changes to the sample YAML — fixes go to the simulator, not the demo data.
- Replacing the current packet-tween animation with anything more elaborate than the size/duration bump.
