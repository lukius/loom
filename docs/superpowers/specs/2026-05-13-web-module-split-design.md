# Web SPA — vanilla ES module split design

**Date:** 2026-05-13
**Branch:** `feature/web-module-split`
**Source:** user request to break `web/index.html`'s 2200-line inline `<script>` into ES modules, "few hours, unblocks future framework choice."

## Goals

- Split the inline JS in `web/index.html` (lines 1542–3766, ~2224 lines) into eight ES modules under `web/`.
- Extract the inline `<style>` (lines 13–1278, ~1265 lines) into `web/styles.css`.
- Leave `index.html` at ~200 lines of HTML markup + a single `<script type="module" src="app.js">` tag.
- Add a lightweight pub/sub bus so modules don't need to call each other to trigger re-renders.
- Add JS test infrastructure (`vitest` + `happy-dom`) and unit tests for the pure logic modules (`utils.js`, `state.js`, `sim.js`).
- Preserve all observable behavior. The existing Python suite (138 tests) and the manual smoke checklist must still pass.

## Non-goals

- No framework introduction (React/Vue/Svelte/etc.). Vanilla ES modules only.
- No build step, bundler, transpiler, or minifier. Native browser ESM, served as-is by FastAPI's existing `StaticFiles` mount.
- No state-shape refactor (state stays one mutable object).
- No DOM-snapshot or end-to-end tests for the canvas/inspector/terminal/packets renderers.
- No behavior, perf, or style changes mixed in. Pure code-move + test scaffolding.

## Decisions (user-confirmed)

- **Module comms:** event bus. `state.js` exports a single `EventTarget`-based `bus`. Mutations dispatch events; renderers listen. Sync queries (geometry lookups, DOM helpers) stay as direct imports.
- **File count:** 8 JS modules (the user's 6 + `utils.js` + `app.js`) + `styles.css` + `index.html`.
- **Test scope:** B — utils.js, state.js, sim.js state machine. Toolchain via `vitest` + `happy-dom`.
- **Test layout:** co-located. `web/state.test.js` lives next to `web/state.js`, etc.

## File layout

```
web/
├── index.html        HTML markup + <link rel="stylesheet" href="styles.css"> + <script type="module" src="app.js">
├── styles.css        Verbatim contents of the inline <style> block
├── app.js            Entrypoint: init(), wire(), keybindings, DOMContentLoaded
├── state.js          state object, persist/restore, sample, markDirty, setSave, STORAGE_KEY/THEME_KEY/LAYOUT_KEY constants, SAMPLE, NODE, HIT_PAD; exports `bus` (EventTarget)
├── utils.js          el, escapeHtml, toast, uniqueName, uniqueIface, pad2, cssEscape
├── sim.js            Sim namespace, RuntimeClient, setConnectionStatus, isTopologyLocked, recordPatchOp, updatePatchIndicator, reconcilePatch
├── canvas.js         renderCanvas, applyView, fitView, clientToWorld, attachNodeEvents, wireCanvas, drawDragPreview, reRenderEdges, ensurePositions, lookupDeviceNode/lookupNetworkNode/lookupAddressNode, getNodeCenter, applyTheme/initTheme, loadLayout/persistLayout/wireResizers
├── inspector.js      renderInspector, renderNav, renderNetworkInsp/renderHostInsp/renderRouterInsp, rename/duplicate/delete ops, addNew, centerOnSelection, openContextMenu/closeContextMenu/handleCtxAction
├── terminals.js      Terminals namespace
├── packets.js        PacketAnim namespace, showPacketTooltip/hidePacketTooltip
├── utils.test.js     Co-located vitest tests
├── state.test.js     Co-located vitest tests
└── sim.test.js       Co-located vitest tests
```

Repo-root additions:

```
package.json          name "netrouting-web", devDependencies: vitest + happy-dom, scripts: { test, test:watch }
.gitignore            adds node_modules/
```

`package.json` carries the vitest config inline (`"vitest": { "environment": "happy-dom" }`); no separate `vitest.config.js` until we outgrow the inline form.

## Module contracts

### `state.js`
- Owns: `state` mutable object, `STORAGE_KEY`, `THEME_KEY`, `LAYOUT_KEY`, `LAYOUT_DEF`, `LAYOUT_LIMITS`, `SAMPLE`, `NODE`, `HIT_PAD`.
- Exports: `state`, `bus`, `persist()`, `restore()`, `loadSample()`, `markDirty()`, `setSave()`.
- Imports: nothing.

### `utils.js`
- Pure helpers.
- Exports: `el(tag, attrs, kids)`, `escapeHtml(s)`, `uniqueName(prefix, dict)`, `uniqueIface(ifaces)`, `pad2(n)`, `cssEscape(s)`, `toast(msg, kind, label)`.
- Imports: nothing.

### `sim.js`
- Owns Sim state machine + WS/REST client.
- Exports: `Sim`, `RuntimeClient`, `setConnectionStatus`, `isTopologyLocked`, `updatePatchIndicator`.
- Imports: `state`, `bus`, `utils.toast`.
- Fires: `sim:status-changed`, `sim:packet`, `sim:routing-table-changed`, `state:topology-changed` (on `reconcilePatch`).
- Listens: nothing — driven by REST/WS callbacks and explicit calls from `app.js`.

### `canvas.js`
- Imports: `state`, `bus`, `utils` (`el`, `escapeHtml`, `cssEscape`), `sim.isTopologyLocked` (to gate drag).
- Exports: `renderCanvas`, `applyView`, `fitView`, `clientToWorld`, `attachNodeEvents`, `wireCanvas`, `drawDragPreview`, `reRenderEdges`, `ensurePositions`, `lookupDeviceNode`, `lookupNetworkNode`, `lookupAddressNode`, `getNodeCenter`, `initTheme`, `applyTheme`, `loadLayout`, `persistLayout`, `wireResizers`.
- Listens: `state:topology-changed`, `state:selection-changed`, `sim:status-changed`, `view:changed`.
- Fires: `state:selection-changed` (node click), `view:changed` (pan/zoom).

### `inspector.js`
- Imports: `state`, `bus`, `utils`, `canvas.applyView`/`canvas.getNodeCenter` (for `centerOnSelection`).
- Exports: `renderInspector`, `renderNav`, `renderNetworkInsp`, `renderHostInsp`, `renderRouterInsp`, `centerOnSelection`, `renameKey`, `renameNetwork`, `renameHost`, `renameRouter`, `duplicateNetwork`, `duplicateHost`, `duplicateRouter`, `deleteSelected`, `addNew`, `openContextMenu`, `closeContextMenu`, `handleCtxAction`.
- Listens: `state:topology-changed`, `state:selection-changed`, `sim:status-changed`, `sim:routing-table-changed`.
- Fires: `state:topology-changed` (add/rename/duplicate/delete), `state:selection-changed` (nav click).

### `terminals.js`
- Imports: `state`, `bus`, `utils.escapeHtml`, `sim.Sim` (to dispatch commands).
- Exports: `Terminals`.
- Listens: `sim:status-changed`.
- Fires: nothing on the bus.

### `packets.js`
- Imports: `state`, `bus`, `canvas.lookupDeviceNode`/`canvas.lookupAddressNode`/`canvas.getNodeCenter`, `utils.escapeHtml`.
- Exports: `PacketAnim`, `showPacketTooltip`, `hidePacketTooltip`.
- Listens: `sim:packet`, `sim:status-changed`.
- Fires: nothing.

### `app.js`
- Imports everything; thin glue.
- Side-effect entrypoint. Calls `init()` after `DOMContentLoaded`.
- `init()`: `canvas.initTheme`, `canvas.loadLayout`, `state.restore` (fall back to `state.loadSample`), `canvas.ensurePositions`, `wire()`, `canvas.wireResizers`, initial `renderCanvas`/`renderNav`/`renderInspector`, `requestAnimationFrame(fitView)`.
- `wire()`: attaches DOM listeners to toolbar buttons, sim controls, keybindings.

## Dependency graph

```
Layer 1 (leaves):   utils.js, state.js
                          ↑  (everyone imports state + utils)
                          │
Layer 2:            sim.js, canvas.js, inspector.js, terminals.js, packets.js
                          │  Cross-component synchronous imports:
                          │    packets    → canvas   (lookupDeviceNode, getNodeCenter)
                          │    inspector  → canvas   (applyView, getNodeCenter)
                          │    canvas     → sim      (isTopologyLocked)
                          │  All other cross-component coordination flows through `bus`.
                          │
Layer 3:            app.js  (imports all of layers 1+2; wires DOMContentLoaded)
```

DAG. Cross-domain synchronous imports:
- `app → all` (entry wiring).
- `packets → canvas` (`lookupDeviceNode`, `getNodeCenter` for animation coordinates).
- `inspector → canvas` (`applyView`, `getNodeCenter` for `centerOnSelection`).
- `canvas → sim` (`isTopologyLocked` to gate drag handlers).

All other cross-component coordination goes through `bus`.

### `index.html` script loading order

```
<head>
  ...
  <link rel="stylesheet" href="styles.css">
  <script src="https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js"></script>
  <script type="module" src="app.js"></script>
</head>
```

The `js-yaml` UMD bundle is kept as a classic script (it exposes the `jsyaml` global; no ESM build is consumed). Browsers defer `type="module"` scripts until after the document parses, so the classic script is guaranteed to execute first and `jsyaml` is available to `app.js` and its imports.

## Bus event taxonomy

| Event | Payload | Fired by | Listened by |
|---|---|---|---|
| `state:topology-changed` | none | inspector (add/rename/delete/duplicate), sim (`reconcilePatch`) | canvas (`renderCanvas`), inspector (`renderNav` + `renderInspector`) |
| `state:selection-changed` | none | canvas (node click), inspector (nav click, clear) | canvas (highlight), inspector (`renderInspector`) |
| `sim:status-changed` | `{ status: 'idle' \| 'running' \| 'paused' }` | sim | inspector (lock/unlock fields), canvas (lock/unlock drag, gray context menu), terminals (gate opens), packets (freeze/clear on non-running) |
| `sim:packet` | `{ flow, src, dst, hop, payload }` | sim | packets (`PacketAnim.enqueue`) |
| `sim:routing-table-changed` | `{ router }` | sim | inspector (refresh routing-table section if selected) |
| `view:changed` | none | canvas (pan/zoom) | canvas (`applyView`, `reRenderEdges`) |

Rule: state mutation + cross-component re-render → `bus`. Synchronous queries and DOM helpers → direct import.

## Data flow examples

**A. User adds a host (sim idle):**
1. Right-click canvas → `canvas.openContextMenu` (imported from `inspector`).
2. Pick "Add host" → `inspector.addNew('host')`.
3. Mutate `state.hosts`/`state.positions`, call `markDirty()`, dispatch `state:topology-changed`.
4. Listeners: `canvas.renderCanvas` redraws; `inspector.renderNav` + `inspector.renderInspector` repaint.
5. `state.persist()` writes to `localStorage` (debounced).

**B. User starts sim, clicks a router:**
1. Toolbar play button → `app.js` handler → `Sim.start()`.
2. POST `/sim/start`, flip `Sim.status = 'running'`, dispatch `sim:status-changed`.
3. Listeners: `inspector` locks inputs and rerenders if a node is selected (adds routing-table section); `canvas` adds `.sim-locked` class on `<svg>` so drag handlers no-op.
4. Click router `r1` → `canvas.attachNodeEvents` sets `state.selection`, dispatches `state:selection-changed`.
5. Listeners: `canvas` re-paints highlight; `inspector.renderInspector` builds router panel (read-only, with routing table).

**C. Server WS sends a packet event:**
1. `RuntimeClient` (in `sim.js`) parses message, calls `Sim._onPacket(evt)`.
2. `Sim._onPacket` dispatches `sim:packet`.
3. `packets.PacketAnim` listener calls `enqueue(evt)`.
4. `enqueue` resolves coords via direct `canvas.lookupDeviceNode` + `canvas.getNodeCenter`. Animates in the overlay layer.
5. Hover tooltip reads payload from event detail held in closure.
6. If user pauses → `Sim.pause()` dispatches `sim:status-changed` with `paused`; `PacketAnim` freezes the queue.

## Testing

### Toolchain

- `vitest` (chosen for native ESM, no transform) + `happy-dom` (faster, lighter than jsdom; sufficient for `localStorage` + simple DOM operations).
- `package.json` at repo root with:
  - `"devDependencies": { "vitest": "<pinned>", "happy-dom": "<pinned>" }` — both pinned to the latest stable when `npm install` is run during implementation.
  - `"scripts": { "test": "vitest run", "test:watch": "vitest" }`
  - `"vitest": { "environment": "happy-dom" }` (inline config; no separate file).
- `.gitignore` adds `node_modules/`.
- CLAUDE.md gets a "JS tests" line under Build & Run: `npm install && npm test`.
- README.md gets the same.

### `web/utils.test.js`

Pure-function coverage:
- `escapeHtml`: ampersand, angle brackets, quotes, mixed.
- `uniqueName('h', {h1:1, h2:1})` returns `'h3'`; empty dict returns `'h1'`.
- `uniqueIface({eth0:1, eth2:1})` returns `'eth1'`; empty returns `'eth0'`.
- `pad2`: single digit, two digits, zero.
- `cssEscape`: dots, brackets, plain.
- `el('div', {class: 'x'}, [el('span', {}, 'hi')])` produces the right DOM structure (verified via `outerHTML`).

### `web/state.test.js`

- `persist` writes to `localStorage` under `STORAGE_KEY`; round-trips with `restore`.
- `restore` with no key returns `false` and leaves state untouched.
- `restore` with malformed JSON returns `false` (doesn't throw).
- `loadSample` seeds `state.networks`/`hosts`/`routers` from `SAMPLE`.
- `markDirty` triggers `setSave('dirty')` synchronously; persist debounce path is not asserted (timing-fragile).
- Bus emission: when a test code path mutates state and dispatches an event, a registered listener fires with the right `type`.

### `web/sim.test.js`

State machine transitions with a fake `RuntimeClient` (stub `start`/`stop`/`pause`/`resume`/`sendCommand` to resolve immediately):
- `Sim.start()` flips status `idle → running` and fires `sim:status-changed` with `running`.
- `Sim.pause()` from `running` → `paused`; from `idle` is a no-op (status unchanged, no event).
- `Sim.resume()` from `paused` → `running`.
- `Sim.stop()` from any non-`idle` → `idle`, drains packet queue.
- `_onPacket` dispatches `sim:packet` with the event payload verbatim.
- `reconcilePatch` mutates state and dispatches `state:topology-changed`.

### Non-test verification

- `pytest` from repo root stays green (138 tests, untouched).
- Manual smoke against `docs/manual-smoke-test.md` once before the split (baseline) and once after.
- During each module move: visually diff the lifted block against the original to confirm byte-equivalence (declarations gain `export`; usage sites gain `import`; nothing else changes).

## Error handling

Unchanged from today:
- REST/WS failures in `RuntimeClient` surface via `toast()`.
- `restore()` swallows `JSON.parse` errors and falls back to the sample.
- ES module load failures surface in the browser console; we accept the dev-time signal.

No new validation or defensive checks. The refactor preserves the existing surface byte-for-byte.

## Out of scope

- JS DOM tests for canvas/inspector/terminals/packets (rendering tests are brittle; manual smoke catches more for less effort).
- TypeScript / JSDoc type annotations.
- Behavioral changes, perf tweaks, dead-code removal.
- Bundler / minifier introduction.

These belong to a follow-up after the framework choice is made.
