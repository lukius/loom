---
name: user-guide-update
description: Use when a change affects what the user sees or does in the loom SPA — new canvas elements, visual conventions, inspector panels, toolbar buttons, packet animation, or any UI behavior — so docs/user-guide/ pages and the screenshots they reference stay accurate.
---

# Updating the user guide

When a change is observable in the SPA, the corresponding page under
`docs/user-guide/` is part of the change and must land in the same commit.
That includes a refreshed screenshot if the visible canvas has shifted.

## When to use

- A new visual convention (e.g. a node/edge style)
- A new panel, button, hotkey, or toolbar control
- A behavior change the user can see or trigger (sim lifecycle, animation, edit flow)
- A renamed/relocated UI surface

Skip for pure internal refactors with no observable change.

## The hard rule: NO implementation detail

`docs/user-guide/` is for the user — someone who runs the SPA and wants to know **what they see** and **what to do**. It is NOT a place for:

- File or module names (`canvas.js`, `inspector.js`, `state.js`)
- CSS class names (`.private`, `.edge-iface`, `.rail-label`)
- Event/bus identifiers (`sim:nat`, `sim:packet-arrived`, `nat_table_changed`)
- HTTP/WS endpoint paths (`POST /sim/start`, `GET /topology`)
- Python class names or backend types (`Router`, `NATTable`, `RoutingMessage`)
- Wire-format field names from the JSON event shape (`payload_id`, `flow_id`, `rewritten_src`)
- Code snippets unless the user actually types them (shell commands, YAML samples)
- Patch-op names, internal helpers, threading details, queue mechanics

If you find yourself reaching for any of those, the content belongs under `docs/architecture/` — link from the user-guide page if useful (`see architecture/nat.md`), but don't inline it.

**Test:** could a user who has never opened the source tree understand and act on the sentence? If not, rewrite.

### Good vs. bad wording

| Bad (implementation) | Good (action-level) |
|---|---|
| "The `sim:nat` event fires when a router rewrites `original_src` to `rewritten_src`" | "When a packet crosses a NAT router, hover it to see the address translation in the tooltip" |
| "Networks render the `.private` CSS class on rails matching RFC1918" | "Private LANs render in a muted neutral tone" |
| "Click Reset; the server's `/topology/reset` endpoint reclones the session" | "Click Reset to discard your edits and reload the original topology" |

(See also the feedback memory `feedback_user_guide_detail` — same rule, captured earlier from user review.)

## Workflow

1. **Pick the page.** One page per surface — don't sprinkle the same fact across files:
   - `web-ui.md` — canvas, toolbar, panels, inspector, visual conventions
   - `running-simulations.md` — sim lifecycle, packet animation, NAT in user terms
   - `building-topologies.md` — drag/drop, add/remove, the editing flow
   - `routing-tables.md`, `terminals.md`, `yaml-format.md`, `shell-cli.md`, `getting-started.md` — by topic

2. **Write the section action-level.** See the rule above. The user is the audience; the source tree is not.

3. **Capture a screenshot.** Use the project tool — never re-invent the Playwright invocation inline:
   ```bash
   npm run screenshot -- docs/images/<NN>-<short-name>.png \
       [--load-yaml=samples/<topology>.yaml] \
       [--exec-file=tools/scenarios/<scenario>.mjs] \
       [--viewport=1400x900] [--selector=#canvas] [--delay=800]
   ```
   - Requires a running server (`cd src && python loom.py`).
   - `--load-yaml` drives the same import path as the Reset toolbar button, so any sample topology works.
   - Default `--selector=#canvas` clips to the SVG; switch to a panel selector (e.g. `#inspector`, `#insp-nat`, `#insp-routes`) when documenting an inspector panel.
   - `--exec-file` runs a JS scenario in the page context after the YAML is loaded and before capture — use it when the screenshot needs a setup step the canvas alone can't provide (start the sim, run a ping, select a node, pause). Scenario files live under `tools/scenarios/` and are wrapped in an async IIFE by the tool, so the body can use top-level `await` and `await import('/sim.js')` to reach the SPA's modules. See `tools/scenarios/nat-panel.mjs` for a working example.
   - Name files `<NN>-<name>.png` matching the existing sequence in `docs/images/`.

4. **Reference the image** from the doc with a one-line caption:
   ```markdown
   ![Private LANs render in a muted tone to mark the NAT boundary](../images/50-private-lan-tone.png)
   ```

5. **Commit** in the same commit as the code change (or as the very next commit if the code is already in), with a `docs(user-guide):` prefix.

## Backend-decoupling check

The user guide describes the SPA the user touches. Backend-side code/comments stay SPA-agnostic per AGENTS.md ("Backend ↔ frontend decoupling"). When you find yourself wanting to mention backend types/wire shapes in a user-guide page, that's a signal the content belongs under `docs/architecture/` instead.

## Common mistakes

| Mistake | Fix |
|---|---|
| Writing the doc but skipping the screenshot for a visual change | Run `npm run screenshot` — takes 2 seconds, makes the page actually useful |
| Capturing whatever's in the browser without a `--load-yaml` | Pass `--load-yaml=samples/<topology>.yaml` so the doc is reproducible from a clean session |
| Documenting in `web-ui.md` what really belongs in `running-simulations.md` (or vice versa) | One page per surface — keep the topic boundaries clean |
| Mentioning CSS classes, module names, bus events | Move that to `docs/architecture/`; user-guide stays action-level |
| Leaving the screenshot file uncommitted | `git add docs/images/<NN>-...png` along with the markdown change |

## Quick reference

| Step | Command / file |
|---|---|
| Capture | `npm run screenshot -- docs/images/<NN>-<name>.png --load-yaml=samples/<file>.yaml` |
| Capture with setup | add `--exec-file=tools/scenarios/<name>.mjs --selector=<panel-sel>` |
| Tool source | `tools/screenshot.mjs` (scenarios under `tools/scenarios/`) |
| Image folder | `docs/images/` |
| Pages | `docs/user-guide/*.md` |
| Commit prefix | `docs(user-guide):` |
