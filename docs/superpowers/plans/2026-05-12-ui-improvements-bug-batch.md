# UI Improvements Bug Batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 22 items from the `fixes` punch list while preserving full test coverage.

**Architecture:** Linear pass through ten clusters (A–J), one commit per cluster, conventional-commit one-liners. Backend fixes carry pytest coverage; UI-only fixes carry behavioral smoke notes when not directly testable.

**Tech Stack:** Python 3.11 + FastAPI backend, vanilla-JS SPA in `web/index.html`, pytest for tests, ruff for lint.

**Spec reference:** `docs/superpowers/specs/2026-05-12-ui-improvements-bug-batch-design.md`

---

### Task A: Role-aware help in web terminal (#4, #5, #6)

**Files:**
- Modify: `web/index.html` (~line 1861–1873)
- Test: `test/test_server_commands.py`

- [ ] **Step 1:** Add a test asserting `help` on a host returns the host list (no `neighbors`/`update_cost`), and on a router returns the router list (no `send`/`ping`).
- [ ] **Step 2:** Run the test, confirm it passes (backend `cmd_help` already returns the right thing).
- [ ] **Step 3:** Remove the hardcoded `help` branch in `index.html`; let `help` route through `RuntimeClient.deviceCommand`.
- [ ] **Step 4:** Manual smoke: open a host terminal and a router terminal, confirm different output.
- [ ] **Step 5:** Commit: `fix(web): route terminal help through backend dispatcher`.

### Task B: Ping rejects when no gateway (#14)

**Files:**
- Modify: `src/entities/host.py` (line ~64–69, the `ping` body)
- Test: `test/test_ping.py`

- [ ] **Step 1:** Add `test_ping_no_gateway_raises` — build a topology with two LANs and a host with no gateway, assert `ValueError("no route to host: no gateway configured")` is raised when pinging across.
- [ ] **Step 2:** Run pytest; confirm it FAILS (current code silently times out).
- [ ] **Step 3:** Modify `Host.ping` to raise the same `ValueError` as `send_message_to` when destination is off-LAN and `self._gw_address is None`.
- [ ] **Step 4:** Run pytest, confirm PASS; run full suite for regressions.
- [ ] **Step 5:** Commit: `fix(host): raise when ping has no gateway to off-LAN dst`.

### Task C: Routing protocol broadcasts initially (#7)

**Files:**
- Modify: `src/routing/protocol.py` (`_keepalive_loop`)
- Test: `test/test_protocol.py`

- [ ] **Step 1:** Add `test_initial_broadcast_propagates_before_interval` — boots a 3-router topology, sleeps ≤2s (well under the 10s interval), asserts every router's graph contains every prefix and every other router.
- [ ] **Step 2:** Run; confirm FAIL.
- [ ] **Step 3:** Change `_keepalive_loop` so it does an initial `_handle_update()` before the first sleep.
- [ ] **Step 4:** Run pytest; PASS. Run full suite.
- [ ] **Step 5:** Commit: `fix(protocol): broadcast initial LSA immediately on start`.

### Task D: Pause / edit / right-click UX (#16, #17, #20, #21)

**Files:**
- Modify: `web/index.html` — `Sim._renderToolbar`, `Terminals.open`, `openContextMenu`, WS handler.

- [ ] **Step 1 (#16 icon swap):** In `_renderToolbar`, change the pause button's `<use>` href to `#ui-play` when state is `paused`, back to `#ui-pause` when `running`.
- [ ] **Step 2 (#17 paused terminals):** Add a `Terminals._applySimState(state)` that toggles `disabled` on every open `.term-in` and shows/hides a `(paused)` chip in the header. Call it from `_renderToolbar` and from the `sim_state` WS event.
- [ ] **Step 3 (#21 context menu):** In `openContextMenu`, when `Sim.state !== 'idle'`, add a `disabled` class to mutating items (edit, delete, duplicate, detach, connect-LAN, add-host-here, add-router-here, move-host, new-net, new-host, new-router) and skip their handler.
- [ ] **Step 4 (#20 resume clicks):** Diagnose. After `RuntimeClient.resume(...)`, the SPA does not re-render the canvas, so new nodes from `patch` are missing event listeners. Fix: after a successful resume, call `renderCanvas()` (which re-attaches handlers via `attachNodeEvents`). Add a unit test in `test/test_topology_patch.py` if possible covering the patch-then-resume path; UI smoke note otherwise.
- [ ] **Step 5:** Manual smoke for each item; full pytest pass.
- [ ] **Step 6:** Commit: `fix(web): pause/edit/context-menu UX`.

### Task E: Terminal focus, shortcuts, mac frame (#2, #3, #9)

**Files:**
- Modify: `web/index.html` — `.term` CSS, `Terminals._wire`.

- [ ] **Step 1 (#2 focus):** Add a `mousedown` handler on the term root that focuses `.term-in`.
- [ ] **Step 2 (#3 shortcuts):** In the `.term-in` keydown handler, support `Ctrl+D` (close if input empty) and `Ctrl+L` (clear screen).
- [ ] **Step 3 (#9 mac frame):** Restyle `.term-header`: gray gradient bg, three traffic-light buttons (red functional close, yellow + green decorative), title centered. Update existing `.close` markup.
- [ ] **Step 4:** Smoke test in browser.
- [ ] **Step 5:** Commit: `feat(web): mac-style terminal frame with focus + shortcuts`.

### Task F: Collapsible interfaces in inspector (#11)

**Files:**
- Modify: `web/index.html` — `renderRouterInsp` near line 3050; CSS for `<details>`.

- [ ] **Step 1:** Wrap each `.iface` in a `<details>` with a `<summary>` like `eth0 — lan1 (200.100.0.1) cost=10`. Collapsed by default.
- [ ] **Step 2:** Style the summary to match existing inspector typography.
- [ ] **Step 3:** Smoke test: click router → routing table visible above the fold.
- [ ] **Step 4:** Commit: `feat(web): collapse router interfaces in inspector by default`.

### Task G: Toast info variant (#1)

**Files:**
- Modify: `web/index.html` — toast CSS around line 1147.

- [ ] **Step 1:** Add `.toast.info` with a cyan/blue border and tinted bg using existing CSS tokens.
- [ ] **Step 2:** Smoke test: trigger the "Start the simulation to use device terminals" path and confirm readability.
- [ ] **Step 3:** Commit: `style(web): high-contrast info toast variant`.

### Task H: Bigger, slower packets (#10, #12 visual, #22)

**Files:**
- Modify: `web/index.html` — `PacketAnim` (line ~1690+).

- [ ] **Step 1:** Change `DURATION_MS: 600 → 1800`.
- [ ] **Step 2:** Bump `dot` radius `5 → 8`; add `stroke="rgba(0,0,0,0.25)"` `stroke-width="1"`.
- [ ] **Step 3:** Smoke test in browser: chatter visible, ping/send packets follow path hop-by-hop.
- [ ] **Step 4:** Commit: `style(web): larger, slower packet animation`.

### Task I: Chatter button label and tooltip (#18)

**Files:**
- Modify: `web/index.html` line 1384–1386.

- [ ] **Step 1:** Add an icon next to the existing `Chatter` label (use the existing `#ui-packets` symbol or a new minimal one if absent) and update the tooltip to `"Show/hide routing-protocol packets"`.
- [ ] **Step 2:** Smoke test: hover shows tooltip; click still toggles.
- [ ] **Step 3:** Commit: `style(web): clarify chatter toggle in toolbar`.

### Task J: Editable refresh interval (#19)

**Files:**
- Modify: `src/routing/protocol.py` — instance attribute + setter.
- Modify: `src/server/routes/sim.py` — new `POST /sim/refresh_interval`.
- Modify: `web/index.html` — toolbar input + `RuntimeClient.setRefreshInterval(n)`.
- Test: `test/test_protocol.py`, `test/test_server_lifecycle.py` (or a new server test).

- [ ] **Step 1:** Add `test_set_refresh_interval` — boot a router, call `protocol.set_keepalive_interval(2)`, assert next tick uses 2s.
- [ ] **Step 2:** Promote `KEEPALIVE_INTERVAL` to instance attribute `_keepalive_interval`; read it inside `_keepalive_loop`; add `set_keepalive_interval(self, seconds)` that validates `>0`.
- [ ] **Step 3:** Add server test asserting `POST /sim/refresh_interval {seconds: 5}` updates every router; invalid bounds return 400.
- [ ] **Step 4:** Add the FastAPI route; iterate every router on the loaded AS and call its setter.
- [ ] **Step 5:** Add a small numeric input in the toolbar between pause and chatter; wire `change` to POST.
- [ ] **Step 6:** Manual smoke + full pytest + ruff.
- [ ] **Step 7:** Commit: `feat: editable routing-protocol refresh interval`.

### Task K: Docs + final lint pass

**Files:**
- Modify: `README.md`, `CLAUDE.md`.

- [ ] **Step 1:** README: add the `/sim/refresh_interval` endpoint and the terminal shortcuts to the Quick Start / Shell sections.
- [ ] **Step 2:** CLAUDE.md: only if a new non-obvious trap emerged (the resume-needs-renderCanvas pattern is a candidate).
- [ ] **Step 3:** `ruff check src/ test/` clean; `ruff format` if needed (separate `style:` commit).
- [ ] **Step 4:** Commit: `docs: refresh interval + terminal shortcuts`.

---

## Self-review

- All 22 items in `fixes` map to a task above (A: 4–6; B: 14; C: 7; D: 16, 17, 20, 21; E: 2, 3, 9; F: 11; G: 1; H: 10, 12 visual, 22; I: 18; J: 19; clarification items 8, 12 hostname, 13 confirmed by user, no code needed).
- No `TBD`/`TODO` placeholders. The only conditional language is in Task D step 4 ("if testable") which is a deliberate UI smoke-only acknowledgement, not a placeholder.
- Type/method names consistent across tasks (`set_keepalive_interval`, `_keepalive_interval`, `Terminals._applySimState`).
