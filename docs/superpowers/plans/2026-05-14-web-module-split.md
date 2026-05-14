# Web SPA Vanilla ES Module Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break `web/index.html`'s 2200-line inline `<script>` and 1265-line inline `<style>` into eight ES modules + a co-located vitest test suite, with no observable behavior change.

**Architecture:** Vanilla ES modules served by FastAPI's existing `StaticFiles` mount; cross-component coordination through an `EventTarget`-based bus exported from `state.js`; synchronous queries and DOM helpers via direct imports. Each module extraction is a byte-equivalent code move plus added `import`/`export` statements.

**Tech Stack:** Vanilla ES modules in `web/*.js`, `vitest` + `happy-dom` for JS tests, existing Python 3.11 + FastAPI backend (unchanged), pytest for Python tests, ruff for lint.

**Spec reference:** `docs/superpowers/specs/2026-05-13-web-module-split-design.md`

**Working directory:** `/home/lukius/repo/netrouting/.claude/worktrees/feature+web-module-split` (run all commands from here).

**Pre-flight (run once before Task 1):**
1. Confirm baseline: `pytest` from repo root → 138 tests pass.
2. Capture baseline by walking `docs/manual-smoke-test.md` against the current `web/index.html` and noting any pre-existing issues. The post-implementation manual smoke check (Task 13) must match this baseline exactly.

---

## Task 1: Bootstrap JS test toolchain

**Files:**
- Create: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1:** Create `package.json` at repo root:

```json
{
  "name": "netrouting-web",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "happy-dom": "^18.0.0"
  },
  "vitest": {
    "environment": "happy-dom",
    "include": ["web/**/*.test.js"]
  }
}
```

Pin to whatever `npm install` resolves; do not hand-edit the `^` versions further.

- [ ] **Step 2:** Append `node_modules/` to `.gitignore`:

```
node_modules/
```

- [ ] **Step 3:** Run `npm install` to populate `node_modules/` and produce `package-lock.json`. Expected: success, lockfile written.

- [ ] **Step 4:** Create a temporary smoke test `web/_bootstrap.test.js`:

```js
import { describe, it, expect } from 'vitest';

describe('vitest bootstrap', () => {
  it('runs', () => { expect(1 + 1).toBe(2); });
  it('has localStorage from happy-dom', () => {
    localStorage.setItem('k', 'v');
    expect(localStorage.getItem('k')).toBe('v');
    localStorage.removeItem('k');
  });
});
```

- [ ] **Step 5:** Run `npm test`. Expected: 2 tests pass.

- [ ] **Step 6:** Delete `web/_bootstrap.test.js`. Run `npm test` again. Expected: "No test files found" exits cleanly (or vitest's "no tests collected" notice — either is fine).

- [ ] **Step 7:** Commit:

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: add vitest + happy-dom for JS unit tests"
```

---

## Task 2: Extract CSS into styles.css

**Files:**
- Create: `web/styles.css`
- Modify: `web/index.html` (remove inline `<style>` block, add `<link>` tag)

- [ ] **Step 1:** Copy the contents of the inline `<style>...</style>` block in `web/index.html` (currently lines 13–1278 — the lines between the opening `<style>` and closing `</style>` tags) verbatim into a new file `web/styles.css`. Do not modify any rules.

- [ ] **Step 2:** In `web/index.html`, replace the entire `<style>...</style>` block (the two tags and everything between them) with:

```html
<link rel="stylesheet" href="styles.css">
```

- [ ] **Step 3:** Start the server (`cd src && python netrouting.py`) and open `http://127.0.0.1:8000/` in a browser. Confirm visually that the page looks identical to the baseline: layout, colors, fonts, button styles, terminal frame, toolbar. No CSS regressions.

- [ ] **Step 4:** Confirm `pytest` still passes:

```bash
pytest
```

Expected: 138 tests pass.

- [ ] **Step 5:** Commit:

```bash
git add web/styles.css web/index.html
git commit -m "refactor(web): extract inline <style> to styles.css"
```

---

## Task 3: Convert inline `<script>` to a module

**Files:**
- Modify: `web/index.html` (change the inline `<script>` tag to `<script type="module">`, adjust `init()` invocation)

- [ ] **Step 1:** In `web/index.html`, locate the inline `<script>` opening tag (currently around line 1542). Change it from `<script>` to `<script type="module">`.

- [ ] **Step 2:** At the bottom of that script (right before `</script>`), the current code ends with a bare `init();` call. Replace it with:

```js
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

`<script type="module">` is automatically deferred, so it runs after the DOM is parsed — but this guard makes the intent explicit and survives later edits.

- [ ] **Step 3:** Reload the page in the browser. Confirm the SPA still loads, the sample topology renders, all toolbar buttons work, and there are **no console errors** mentioning `import`, `export`, or `top-level await`. (The script is now a module but does not yet import anything, so it should behave identically.)

- [ ] **Step 4:** Confirm `pytest` still passes and `npm test` exits cleanly (no test files).

- [ ] **Step 5:** Commit:

```bash
git add web/index.html
git commit -m "refactor(web): make inline script a module"
```

---

## Task 4: Extract utils.js (TDD)

**Files:**
- Create: `web/utils.js`
- Create: `web/utils.test.js`
- Modify: `web/index.html` (delete extracted helpers, add `import`)

- [ ] **Step 1:** Write the failing test file `web/utils.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { escapeHtml, uniqueName, uniqueIface, pad2, cssEscape, el } from './utils.js';

describe('escapeHtml', () => {
  it('escapes ampersand and angle brackets', () => {
    expect(escapeHtml('a & b <c>')).toBe('a &amp; b &lt;c&gt;');
  });
  it('escapes quotes', () => {
    expect(escapeHtml(`"hi" 'there'`)).toBe('&quot;hi&quot; &#39;there&#39;');
  });
  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('uniqueName', () => {
  it('returns prefix+1 for empty dict', () => {
    expect(uniqueName('h', {})).toBe('h1');
  });
  it('returns next free index', () => {
    expect(uniqueName('h', { h1: 1, h2: 1 })).toBe('h3');
  });
  it('skips gaps', () => {
    expect(uniqueName('h', { h1: 1, h3: 1 })).toBe('h2');
  });
});

describe('uniqueIface', () => {
  it('returns eth0 for empty dict', () => {
    expect(uniqueIface({})).toBe('eth0');
  });
  it('skips taken indices', () => {
    expect(uniqueIface({ eth0: 1, eth2: 1 })).toBe('eth1');
  });
});

describe('pad2', () => {
  it('pads single digit', () => { expect(pad2(3)).toBe('03'); });
  it('leaves two digits alone', () => { expect(pad2(42)).toBe('42'); });
  it('pads zero', () => { expect(pad2(0)).toBe('00'); });
});

describe('cssEscape', () => {
  it('escapes dots', () => { expect(cssEscape('a.b')).toBe('a\\.b'); });
  it('escapes brackets', () => { expect(cssEscape('a[b]')).toBe('a\\[b\\]'); });
  it('leaves plain strings alone', () => { expect(cssEscape('abc')).toBe('abc'); });
});

describe('el', () => {
  it('builds a DOM element with attributes', () => {
    const node = el('div', { class: 'x', id: 'y' });
    expect(node.tagName).toBe('DIV');
    expect(node.getAttribute('class')).toBe('x');
    expect(node.id).toBe('y');
  });
  it('appends string children as text nodes', () => {
    const node = el('span', {}, 'hello');
    expect(node.textContent).toBe('hello');
  });
  it('appends array of element children', () => {
    const child = el('em', {}, 'hi');
    const node = el('p', {}, [child]);
    expect(node.firstChild).toBe(child);
  });
});
```

- [ ] **Step 2:** Run `npm test`. Expected: import error (module `./utils.js` not found).

- [ ] **Step 3:** Create `web/utils.js` by lifting the following functions verbatim from the inline `<script>` in `web/index.html` (each gains `export`):
  - `el(tag, attrs, kids)` (currently around line 2233)
  - `escapeHtml(s)` (around line 2248)
  - `uniqueName(prefix, dict)` (around line 2253)
  - `uniqueIface(ifaces)` (around line 2254)
  - `pad2(n)` (around line 2255)
  - `cssEscape(s)` (around line 2907)
  - `toast(msg, kind, label)` (around line 2299; called by many later modules, include it now to avoid a second extraction)

Resulting file structure:

```js
// web/utils.js
export function el(tag, attrs = {}, kids = null) { /* lifted body */ }
export function escapeHtml(s) { /* lifted body */ }
export function uniqueName(prefix, dict) { /* lifted body */ }
export function uniqueIface(ifaces) { /* lifted body */ }
export function pad2(n) { /* lifted body */ }
export function cssEscape(s) { /* lifted body */ }
export function toast(msg, kind = '', label = null) { /* lifted body */ }
```

- [ ] **Step 4:** Delete the original definitions of those seven functions from `web/index.html`'s inline module.

- [ ] **Step 5:** At the very top of the inline module in `web/index.html`, add:

```js
import { el, escapeHtml, uniqueName, uniqueIface, pad2, cssEscape, toast } from './utils.js';
```

- [ ] **Step 6:** Run `npm test`. Expected: utils.test.js passes (all sub-tests green).

- [ ] **Step 7:** Reload page in browser. Smoke check: page loads, topology renders, toolbar works, click around the inspector to confirm `el`/`escapeHtml` paths are exercised (right-pane labels render correctly). No console errors.

- [ ] **Step 8:** Run `pytest`. Expected: 138 pass.

- [ ] **Step 9:** Commit:

```bash
git add web/utils.js web/utils.test.js web/index.html
git commit -m "refactor(web): extract utils.js with co-located vitest tests"
```

---

## Task 5: Extract state.js (TDD, includes the bus)

**Files:**
- Create: `web/state.js`
- Create: `web/state.test.js`
- Modify: `web/index.html` (delete extracted code, add `import`)

- [ ] **Step 1:** Write `web/state.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  state, bus, persist, restore, loadSample, markDirty, setSave,
  STORAGE_KEY, SAMPLE,
} from './state.js';

function resetState() {
  state.asName = '';
  state.networks = {};
  state.hosts = {};
  state.routers = {};
  state.positions = {};
  state.selection = null;
  state.view = { x: 0, y: 0, k: 1 };
  state.run = { status: 'idle', terminals: {}, chatter: true, refreshSec: 10, animSpeed: 1 };
  state.dirty = false;
}

beforeEach(() => {
  localStorage.clear();
  resetState();
  // setSave needs a DOM target; create the minimal element it expects.
  if (!document.getElementById('save-state')) {
    const elt = document.createElement('span');
    elt.id = 'save-state';
    elt.appendChild(document.createTextNode(''));
    document.body.appendChild(elt);
  }
});

describe('persist / restore', () => {
  it('round-trips state through localStorage', () => {
    state.asName = 'AS-100';
    state.networks = { lan1: {} };
    persist();
    resetState();
    expect(restore()).toBe(true);
    expect(state.asName).toBe('AS-100');
    expect(state.networks).toEqual({ lan1: {} });
  });

  it('restore returns false when storage is empty', () => {
    expect(restore()).toBe(false);
  });

  it('restore returns false when JSON is malformed', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(restore()).toBe(false);
  });
});

describe('loadSample', () => {
  it('seeds state from SAMPLE', () => {
    loadSample();
    expect(state.asName).toBe(SAMPLE.asName);
    expect(Object.keys(state.networks).length).toBeGreaterThan(0);
  });
});

describe('markDirty / setSave', () => {
  it('markDirty flips state.dirty and calls setSave', () => {
    markDirty();
    expect(state.dirty).toBe(true);
  });
  it('setSave updates the save indicator text', () => {
    setSave('autosaved');
    expect(document.getElementById('save-state').lastChild.textContent).toBe(' autosaved');
  });
});

describe('bus', () => {
  it('is an EventTarget that delivers custom events', () => {
    let payload = null;
    bus.addEventListener('test:event', (e) => { payload = e.detail; });
    bus.dispatchEvent(new CustomEvent('test:event', { detail: { x: 1 } }));
    expect(payload).toEqual({ x: 1 });
  });
});
```

- [ ] **Step 2:** Run `npm test`. Expected: import error for `./state.js`, plus all `state.test.js` cases red.

- [ ] **Step 3:** Create `web/state.js` by lifting from `web/index.html`'s inline module:
  - Constants: `STORAGE_KEY`, `THEME_KEY`, `LAYOUT_KEY`, `LAYOUT_DEF`, `LAYOUT_LIMITS`, `SAMPLE`, `NODE`, `HIT_PAD`.
  - The `state` object (currently around line 1549).
  - Functions: `persist()`, `restore()`, `loadSample()`, `markDirty()`, `setSave()`.
  - New: `export const bus = new EventTarget();`

Every lifted name gets `export`. File top:

```js
// web/state.js

export const STORAGE_KEY = 'netrouting.topology.v4';
export const THEME_KEY = 'netrouting.theme';
export const LAYOUT_KEY = 'netrouting.layout';
export const LAYOUT_DEF = { /* lifted */ };
export const LAYOUT_LIMITS = { /* lifted */ };
export const SAMPLE = { /* lifted */ };
export const NODE = { /* lifted */ };
export const HIT_PAD = { /* lifted */ };

export const state = { /* lifted */ };
export const bus = new EventTarget();

export function persist() { /* lifted */ }
export function restore() { /* lifted */ }
export function loadSample() { /* lifted */ }
export function markDirty() { /* lifted */ }
export function setSave(s) { /* lifted */ }
```

- [ ] **Step 4:** Delete those same names from `web/index.html`'s inline module.

- [ ] **Step 5:** Update the inline-module imports in `web/index.html`. Replace the existing `import { ... } from './utils.js';` with:

```js
import { el, escapeHtml, uniqueName, uniqueIface, pad2, cssEscape, toast } from './utils.js';
import {
  state, bus,
  STORAGE_KEY, THEME_KEY, LAYOUT_KEY, LAYOUT_DEF, LAYOUT_LIMITS, SAMPLE, NODE, HIT_PAD,
  persist, restore, loadSample, markDirty, setSave,
} from './state.js';
```

- [ ] **Step 6:** Run `npm test`. Expected: utils.test.js + state.test.js all green.

- [ ] **Step 7:** Reload page. Smoke check: page loads with the sample topology (or restored state), the save indicator updates when something is edited, restore-on-reload still works. No console errors.

- [ ] **Step 8:** Run `pytest`. Expected: 138 pass.

- [ ] **Step 9:** Commit:

```bash
git add web/state.js web/state.test.js web/index.html
git commit -m "refactor(web): extract state.js with bus and co-located tests"
```

---

## Task 6: Extract sim.js (TDD)

**Files:**
- Create: `web/sim.js`
- Create: `web/sim.test.js`
- Modify: `web/index.html` (delete extracted code, add `import`, register temporary bus listeners that wrap the still-inline renderers)

**Actual `Sim` API in `web/index.html`** (from grep, at time of writing):
- `Sim.state` (string: `'idle'`, `'running'`, `'paused'`).
- `Sim.patch` (array of accumulated patch ops during pause).
- `Sim.onPrimary()` — UI handler for play/stop button (idempotent; toggles based on `Sim.state`).
- `Sim.onSecondary()` — UI handler for pause/resume button.
- `Sim.onReset()` — UI handler for reset button.
- `Sim.refreshState()` — fetches `/sim/state` and updates `Sim.state` and toolbar.
- `Sim._renderToolbar()` — updates DOM toolbar elements based on `Sim.state`.

**WS event router** (currently at lines 2225–2227, lives outside `Sim`):
```js
function _onEvent(evt) {
  if (evt.kind === 'sim_state') { Sim.state = evt.state; Sim._renderToolbar(); }
  if (evt.kind === 'packet') PacketAnim.play(evt);
  // ... other event kinds ...
}
```

After refactor, this becomes part of `sim.js` and dispatches bus events instead of calling renderers directly.

- [ ] **Step 1:** Write `web/sim.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state, bus } from './state.js';
import { Sim, RuntimeClient, _onEvent } from './sim.js';

function captureEvents(name) {
  const events = [];
  const handler = (e) => events.push(e.detail);
  bus.addEventListener(name, handler);
  return { events, stop: () => bus.removeEventListener(name, handler) };
}

beforeEach(() => {
  Sim.state = 'idle';
  Sim.patch = [];
  // Stub RuntimeClient HTTP methods so unit tests don't hit the network.
  RuntimeClient._json = vi.fn(async (method, path) => {
    if (path === '/sim/state') return { state: Sim.state };
    return {};
  });
  // Minimal DOM elements that _renderToolbar touches; tests stub these
  // to avoid wiring the whole toolbar.
  document.body.innerHTML = `
    <button id="tb-play"><span class="ico"><use></use></span><span class="lbl"></span></button>
    <button id="tb-pause" hidden><span class="ico"><use></use></span><span class="lbl"></span></button>
    <button id="tb-reset"></button>
    <span id="conn-banner"></span>
  `;
});

describe('Sim initial state', () => {
  it('defaults to idle', () => { expect(Sim.state).toBe('idle'); });
});

describe('WS event router (_onEvent)', () => {
  it('updates Sim.state and dispatches sim:status-changed on sim_state', () => {
    const cap = captureEvents('sim:status-changed');
    _onEvent({ kind: 'sim_state', state: 'running' });
    expect(Sim.state).toBe('running');
    expect(cap.events).toEqual([{ status: 'running' }]);
    cap.stop();
  });

  it('dispatches sim:packet on packet events with the full payload', () => {
    const cap = captureEvents('sim:packet');
    const evt = { kind: 'packet', type: 'user_datagram', flow: 'f1', src: { device: 'h1' }, dst: { device: 'h2' }, network: 'lan1' };
    _onEvent(evt);
    expect(cap.events).toEqual([evt]);
    cap.stop();
  });

  it('does not dispatch sim:status-changed when state is unchanged', () => {
    Sim.state = 'idle';
    const cap = captureEvents('sim:status-changed');
    _onEvent({ kind: 'sim_state', state: 'idle' });
    expect(cap.events).toEqual([]);
    cap.stop();
  });
});

describe('Sim.refreshState', () => {
  it('reads /sim/state, sets Sim.state, dispatches sim:status-changed when changed', async () => {
    RuntimeClient._json = vi.fn(async () => ({ state: 'running' }));
    Sim.state = 'idle';
    const cap = captureEvents('sim:status-changed');
    await Sim.refreshState();
    expect(Sim.state).toBe('running');
    expect(cap.events).toEqual([{ status: 'running' }]);
    cap.stop();
  });
});

describe('reconcilePatch', () => {
  it('dispatches state:topology-changed after applying ops', async () => {
    const { reconcilePatch } = await import('./sim.js');
    state.networks = {};
    const cap = captureEvents('state:topology-changed');
    reconcilePatch([{ op: 'add_network', name: 'lan1', payload: { netmask: '255.255.255.0' } }]);
    expect(cap.events.length).toBeGreaterThan(0);
    cap.stop();
  });
});
```

Note: `reconcilePatch`'s exact patch-op shape (currently iterates `this.patch` in `Sim.onSecondary` and is also referenced from `connectEvents`) must be verified against the actual function body during Step 3. If the function returns an array of resolved ops rather than applying them, adjust the test to assert on the return value instead.

- [ ] **Step 2:** Run `npm test`. Expected: sim.test.js red (module not found).

- [ ] **Step 3:** Create `web/sim.js` by lifting from `web/index.html`'s inline module:
  - `RuntimeClient` (currently around line 1600).
  - `Sim` namespace (currently around line 1725).
  - `setConnectionStatus(connected)` (around line 1658).
  - `isTopologyLocked()` (around line 1671).
  - `recordPatchOp(op)` (around line 1675).
  - `updatePatchIndicator()` (around line 1682).
  - `reconcilePatch(patch)` (around line 1694).

File top:

```js
// web/sim.js
import { state, bus } from './state.js';
import { toast } from './utils.js';

export const RuntimeClient = { /* lifted */ };
export const Sim = { /* lifted */ };
export function setConnectionStatus(connected) { /* lifted */ }
export function isTopologyLocked() { /* lifted */ }
export function recordPatchOp(op) { /* lifted */ }
export function updatePatchIndicator() { /* lifted */ }
export function reconcilePatch(patch) { /* lifted */ }
```

**Refactor inside the lifted code:** wherever the original `Sim` namespace called `renderInspector()`, `renderCanvas()`, `renderNav()`, `PacketAnim.enqueue(...)`, or any other cross-component renderer directly, replace those direct calls with `bus.dispatchEvent(new CustomEvent('<event-name>', { detail: ... }))`:

| Direct call (before)                                  | Bus dispatch (after)                                                                 |
|-------------------------------------------------------|--------------------------------------------------------------------------------------|
| Update of `state.run.status`                          | `bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: state.run.status } }))` |
| `PacketAnim.enqueue(evt)` after parsing WS packet     | `bus.dispatchEvent(new CustomEvent('sim:packet', { detail: evt }))`                  |
| `renderInspector()` after routing-table delta         | `bus.dispatchEvent(new CustomEvent('sim:routing-table-changed', { detail: { router } }))` |
| `renderCanvas()` + `renderNav()` after `reconcilePatch` applies a topology delta | `bus.dispatchEvent(new CustomEvent('state:topology-changed'))` |

- [ ] **Step 4:** Delete those names from `web/index.html`'s inline module.

- [ ] **Step 5:** Add to the imports at the top of the inline module in `web/index.html`:

```js
import { Sim, RuntimeClient, setConnectionStatus, isTopologyLocked, recordPatchOp, updatePatchIndicator, reconcilePatch } from './sim.js';
```

- [ ] **Step 6:** At the bottom of the inline module (just before the `init()` invocation), register **temporary bus listeners** that wrap the still-inline renderers. These keep the page working while the other modules are still inline; they get moved into their target modules in later tasks.

```js
bus.addEventListener('sim:status-changed', () => { renderInspector(); reRenderEdges(); });
bus.addEventListener('sim:packet', (e) => PacketAnim.enqueue(e.detail));
bus.addEventListener('sim:routing-table-changed', () => renderInspector());
bus.addEventListener('state:topology-changed', () => { renderCanvas(); renderNav(); renderInspector(); });
```

- [ ] **Step 7:** Run `npm test`. Expected: sim.test.js + utils.test.js + state.test.js all green.

- [ ] **Step 8:** Reload page. Smoke checks (each must work, equivalent to baseline):
  - Click ▶ — sim starts; status chip flips to "running"; topology becomes read-only.
  - Click ⏸ — sim pauses; chip flips to "paused"; right-pane fields read-only with `(paused)` indicators.
  - Click ⏵ — resume — chip flips back to "running".
  - Click ⏹ — sim stops; chip back to "idle"; editing re-enabled.
  - Trigger a `send` or `ping` from a terminal — packet animation appears, tooltip shows payload.

- [ ] **Step 9:** Run `pytest`. Expected: 138 pass.

- [ ] **Step 10:** Commit:

```bash
git add web/sim.js web/sim.test.js web/index.html
git commit -m "refactor(web): extract sim.js with state-machine tests and bus events"
```

---

## Task 7: Extract canvas.js

**Files:**
- Create: `web/canvas.js`
- Modify: `web/index.html` (delete extracted code, add `import`, remove the temporary canvas-related bus listener)

- [ ] **Step 1:** Create `web/canvas.js` by lifting from `web/index.html`'s inline module:
  - Canvas accessors (around line 2449): `canvasEl`, `viewportEl`, `edgesLayer`, `nodesLayer`, `overlayLay`.
  - View: `applyView`, `clientToWorld`, `fitView` (around line 2455–2501).
  - Rendering: `renderCanvas`, `drawEdge`, `bezPoint`, `clipToRect`, `drawNode`, `cloudPath`, `reRenderEdges`, `drawDragPreview` (lines 2501–2945).
  - Drag/pan state and handlers: `drag`, `pan`, `rclickTimer`, `attachNodeEvents`, `wireCanvas` (lines 2705–2906).
  - Theme: `applyTheme`, `initTheme` (lines 2391–2398).
  - Layout: `loadLayout`, `persistLayout`, `wireResizers` (lines 2331–2390).
  - Positioning: `ensurePositions` (line 2413).
  - Node lookup: `lookupDeviceNode`, `lookupNetworkNode`, `lookupAddressNode`, `getNodeCenter` (lines 2135–2160).

File top:

```js
// web/canvas.js
import { state, bus, NODE, HIT_PAD } from './state.js';
import { el, escapeHtml, cssEscape } from './utils.js';
import { isTopologyLocked } from './sim.js';
```

Every lifted function/const gets `export`.

**Refactor inside the lifted code:**

- In `attachNodeEvents`, when a click sets `state.selection = { ... }`, append:

  ```js
  bus.dispatchEvent(new CustomEvent('state:selection-changed'));
  ```

- In pan/zoom handlers (mouse wheel, drag-pan), after updating `state.view`, append:

  ```js
  bus.dispatchEvent(new CustomEvent('view:changed'));
  ```

- At module bottom (after all exports), register listeners:

  ```js
  bus.addEventListener('state:topology-changed', renderCanvas);
  bus.addEventListener('state:selection-changed', () => {
    // light highlight refresh — reuse renderCanvas() for simplicity
    renderCanvas();
  });
  bus.addEventListener('sim:status-changed', (e) => {
    document.getElementById('svg-root')?.classList.toggle('sim-locked', e.detail.status !== 'idle');
  });
  bus.addEventListener('view:changed', applyView);
  ```

  (If the existing canvas-root element ID differs from `svg-root`, use the actual ID found in `index.html`.)

- [ ] **Step 2:** Delete those names from `web/index.html`'s inline module.

- [ ] **Step 3:** Add to imports in `web/index.html`:

```js
import {
  canvasEl, viewportEl, edgesLayer, nodesLayer, overlayLay,
  applyView, clientToWorld, fitView,
  renderCanvas, reRenderEdges, drawDragPreview, ensurePositions,
  attachNodeEvents, wireCanvas,
  initTheme, applyTheme,
  loadLayout, persistLayout, wireResizers,
  lookupDeviceNode, lookupNetworkNode, lookupAddressNode, getNodeCenter,
} from './canvas.js';
```

- [ ] **Step 4:** Remove the temporary bus listener for `state:topology-changed` that called `renderCanvas()` from inline (Task 6, Step 6). canvas.js owns it now. Same for `view:changed` and the `sim:status-changed` topology-lock side-effect.

  The remaining inline-module temporary listeners after this task:

  ```js
  bus.addEventListener('sim:status-changed', () => { renderInspector(); });
  bus.addEventListener('sim:packet', (e) => PacketAnim.enqueue(e.detail));
  bus.addEventListener('sim:routing-table-changed', () => renderInspector());
  bus.addEventListener('state:topology-changed', () => { renderNav(); renderInspector(); });
  bus.addEventListener('state:selection-changed', () => { renderInspector(); });
  ```

- [ ] **Step 5:** Run `npm test`. Expected: all previously-green tests stay green.

- [ ] **Step 6:** Reload page. Smoke check:
  - Topology renders.
  - Pan with right-mouse / drag-empty works.
  - Wheel zoom works.
  - Node drag works in edit mode; is locked when sim is running.
  - Edge curves render correctly between hosts/routers/networks.
  - Fit-to-view button works.
  - Theme toggle works.
  - Resizers between nav/canvas/inspector work.

- [ ] **Step 7:** Run `pytest`. Expected: 138 pass.

- [ ] **Step 8:** Commit:

```bash
git add web/canvas.js web/index.html
git commit -m "refactor(web): extract canvas.js (SVG, drag, theme, layout) wired to bus"
```

---

## Task 8: Extract inspector.js

**Files:**
- Create: `web/inspector.js`
- Modify: `web/index.html` (delete extracted code, add `import`, remove inspector-related temporary listeners)

- [ ] **Step 1:** Create `web/inspector.js` by lifting from `web/index.html`'s inline module:
  - `renderInspector` (around line 3180).
  - `renderNetworkInsp`, `renderHostInsp`, `renderRouterInsp` (lines 3203–3450).
  - `renameKey`, `renameNetwork`, `renameHost`, `renameRouter` (lines 3452–3483).
  - `duplicateNetwork` and any sibling `duplicateHost`, `duplicateRouter` (from line 3484 down).
  - `addNew`, `deleteSelected` (locate via grep — currently below the duplicate functions).
  - `renderNav`, `centerOnSelection` (lines 3111–3179).
  - Context menu: `closeContextMenu`, `openContextMenu`, `handleCtxAction`, `_ctxEl` (lines 2946–3110).

File top:

```js
// web/inspector.js
import { state, bus, markDirty } from './state.js';
import { el, escapeHtml, uniqueName, uniqueIface, pad2, toast } from './utils.js';
import { applyView, getNodeCenter, renderCanvas, reRenderEdges, lookupDeviceNode, lookupNetworkNode } from './canvas.js';
import { Sim, isTopologyLocked } from './sim.js';
```

Every lifted name gets `export` (except `_ctxEl` which stays module-private).

**Refactor inside the lifted code:**

- After every state mutation that adds/renames/duplicates/deletes (in `addNew`, `renameNetwork`, `renameHost`, `renameRouter`, `duplicateNetwork`, `duplicateHost`, `duplicateRouter`, `deleteSelected`, `handleCtxAction`), replace direct calls to `renderCanvas()` / `renderNav()` / `renderInspector()` with:

  ```js
  bus.dispatchEvent(new CustomEvent('state:topology-changed'));
  ```

- After any change to `state.selection` (in `renderNav` click handler, in `closeContextMenu`'s clear path), add:

  ```js
  bus.dispatchEvent(new CustomEvent('state:selection-changed'));
  ```

- At module bottom, register listeners:

  ```js
  bus.addEventListener('state:topology-changed', () => { renderNav(); renderInspector(); });
  bus.addEventListener('state:selection-changed', renderInspector);
  bus.addEventListener('sim:status-changed', renderInspector);
  bus.addEventListener('sim:routing-table-changed', () => {
    if (state.selection?.kind === 'router') renderInspector();
  });
  ```

- [ ] **Step 2:** Delete those names from `web/index.html`'s inline module.

- [ ] **Step 3:** Add to imports in `web/index.html`:

```js
import {
  renderInspector, renderNav,
  renderNetworkInsp, renderHostInsp, renderRouterInsp,
  centerOnSelection,
  renameNetwork, renameHost, renameRouter,
  duplicateNetwork, duplicateHost, duplicateRouter,
  deleteSelected, addNew,
  openContextMenu, closeContextMenu, handleCtxAction,
} from './inspector.js';
```

- [ ] **Step 4:** Remove the temporary listeners from inline that inspector.js now owns. After this task, inline-module temporary listeners should be:

```js
bus.addEventListener('sim:packet', (e) => PacketAnim.enqueue(e.detail));
```

(Everything else is now owned by canvas.js / inspector.js / sim.js. Only PacketAnim remains inline.)

- [ ] **Step 5:** Run `npm test`. Expected: all green.

- [ ] **Step 6:** Reload page. Smoke check:
  - Click nodes/networks/hosts/routers → inspector renders the right panel for each.
  - Edit a host's gateway → save indicator flips dirty → state persists on reload.
  - Right-click background → "Add host/router/network" works; nodes appear.
  - Right-click a node → rename/duplicate/delete works.
  - Mid-sim: edits are locked (read-only inputs), context menu options grayed.
  - After `update_cost` from a terminal triggers a routing-table delta, the routing table section in a selected router's inspector refreshes.

- [ ] **Step 7:** Run `pytest`. Expected: 138 pass.

- [ ] **Step 8:** Commit:

```bash
git add web/inspector.js web/index.html
git commit -m "refactor(web): extract inspector.js (nav, panels, ops, context menu)"
```

---

## Task 9: Extract terminals.js

**Files:**
- Create: `web/terminals.js`
- Modify: `web/index.html`

- [ ] **Step 1:** Create `web/terminals.js` by lifting the `Terminals` namespace (currently around line 1955) verbatim, prefixed with `export const Terminals = { ... };`.

File top:

```js
// web/terminals.js
import { state, bus } from './state.js';
import { escapeHtml } from './utils.js';
import { Sim } from './sim.js';

export const Terminals = { /* lifted */ };

bus.addEventListener('sim:status-changed', (e) => {
  if (e.detail.status === 'idle') Terminals.closeAll?.();
});
```

(If a `closeAll` method exists in the original `Terminals` object, use its real name. If not, replace the close call with whatever the existing close-all behavior uses today.)

- [ ] **Step 2:** Delete `Terminals` from inline module in `web/index.html`.

- [ ] **Step 3:** Add to imports in `web/index.html`:

```js
import { Terminals } from './terminals.js';
```

- [ ] **Step 4:** Run `npm test`. Expected: all green.

- [ ] **Step 5:** Reload page. Smoke check:
  - Open a host terminal → command echoes work.
  - Pause sim → terminal input shows `(paused)` chip; input disabled.
  - Resume → input re-enabled.
  - Stop sim → all open terminals close.
  - Ctrl+D in a focused terminal closes it.

- [ ] **Step 6:** Run `pytest`. Expected: 138 pass.

- [ ] **Step 7:** Commit:

```bash
git add web/terminals.js web/index.html
git commit -m "refactor(web): extract terminals.js"
```

---

## Task 10: Extract packets.js

**Files:**
- Create: `web/packets.js`
- Modify: `web/index.html` (remove the last temporary listener)

- [ ] **Step 1:** Create `web/packets.js` by lifting from `web/index.html`'s inline module:
  - `PacketAnim` namespace (around line 1818).
  - `showPacketTooltip`, `hidePacketTooltip` (lines 2107–2134).

File top:

```js
// web/packets.js
import { state, bus } from './state.js';
import { escapeHtml } from './utils.js';
import { lookupDeviceNode, lookupAddressNode, getNodeCenter } from './canvas.js';

export const PacketAnim = { /* lifted */ };
export function showPacketTooltip(evt, dot) { /* lifted */ }
export function hidePacketTooltip() { /* lifted */ }

bus.addEventListener('sim:packet', (e) => PacketAnim.enqueue(e.detail));
bus.addEventListener('sim:status-changed', (e) => {
  if (e.detail.status === 'idle') PacketAnim.clear?.();
  // paused/running freeze behavior is already inside PacketAnim's animation loop
});
```

(Verify the actual `PacketAnim` API names — `enqueue`, `clear`, etc. — against the source. If `clear` doesn't exist, use whatever method the original used for stop-cleanup.)

- [ ] **Step 2:** Delete `PacketAnim`, `showPacketTooltip`, `hidePacketTooltip` from inline module in `web/index.html`.

- [ ] **Step 3:** Add to imports in `web/index.html`:

```js
import { PacketAnim, showPacketTooltip, hidePacketTooltip } from './packets.js';
```

- [ ] **Step 4:** Remove the **last** temporary bus listener in inline:

```js
// delete this line:
bus.addEventListener('sim:packet', (e) => PacketAnim.enqueue(e.detail));
```

After this task, the inline module has **no `bus.addEventListener` calls left** — every listener lives in its owning module.

- [ ] **Step 5:** Run `npm test`. Expected: all green.

- [ ] **Step 6:** Reload page. Smoke check:
  - Trigger a `send` or `ping` from a terminal → packet dot animates along the route.
  - Hover the dot → tooltip shows src/dst (original) and hop.
  - Pause mid-flight → dot freezes in place.
  - Resume → animation continues.
  - Stop → dots clear.

- [ ] **Step 7:** Run `pytest`. Expected: 138 pass.

- [ ] **Step 8:** Commit:

```bash
git add web/packets.js web/index.html
git commit -m "refactor(web): extract packets.js (PacketAnim, tooltips)"
```

---

## Task 11: Extract app.js and finalize index.html

**Files:**
- Create: `web/app.js`
- Modify: `web/index.html` (replace inline module body with a `<script type="module" src="app.js"></script>` tag)

- [ ] **Step 1:** Create `web/app.js`. Lift the remaining inline-module body — at this point only `init()`, `wire()`, and keybinding code, plus the `import` statements already at the top.

Resulting `web/app.js`:

```js
// web/app.js
import {
  state, bus, SAMPLE,
  persist, restore, loadSample, markDirty, setSave,
} from './state.js';
import { toast } from './utils.js';
import {
  Sim, RuntimeClient,
  setConnectionStatus, isTopologyLocked, recordPatchOp, updatePatchIndicator, reconcilePatch,
} from './sim.js';
import {
  canvasEl, viewportEl,
  applyView, fitView, clientToWorld,
  renderCanvas, reRenderEdges, drawDragPreview, ensurePositions,
  attachNodeEvents, wireCanvas,
  initTheme, applyTheme,
  loadLayout, persistLayout, wireResizers,
} from './canvas.js';
import {
  renderInspector, renderNav,
  centerOnSelection,
  addNew, deleteSelected,
  openContextMenu, closeContextMenu, handleCtxAction,
} from './inspector.js';
import { Terminals } from './terminals.js';
import { PacketAnim } from './packets.js';

function wire() {
  // ... lifted body of wire() ...
}

function init() {
  // ... lifted body of init() ...
  // Replace the original calls renderCanvas(), renderNav(), renderInspector() with:
  bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

Inside `init()`, the original code called `renderAll()` (or `renderCanvas` + `renderNav` + `renderInspector` directly). Replace those with a single `bus.dispatchEvent(new CustomEvent('state:topology-changed'))` so the bus-wired listeners do the work.

Inside `wire()`, every DOM `addEventListener` for toolbar buttons / keybindings is lifted verbatim; nothing changes in those handlers.

- [ ] **Step 2:** In `web/index.html`, replace the entire `<script type="module">...</script>` block with:

```html
<script type="module" src="app.js"></script>
```

Keep the existing `<script src="https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js"></script>` classic-script tag above it (line 12, untouched throughout this refactor).

- [ ] **Step 3:** Verify `index.html` is now under ~250 lines (target was ~200, allow some slack). Use `wc -l web/index.html`.

- [ ] **Step 4:** Run `npm test`. Expected: all green.

- [ ] **Step 5:** Hard-refresh the page (Ctrl+Shift+R to bypass cache). Smoke check:
  - Page loads.
  - All baseline behaviors work end-to-end.
  - Browser DevTools → Network tab → confirm 8 JS modules + `styles.css` are loaded.
  - Browser DevTools → Console → no warnings or errors.

- [ ] **Step 6:** Run `pytest`. Expected: 138 pass.

- [ ] **Step 7:** Run `ruff check src/ test/`. Expected: same error count as baseline (51 pre-existing, since no Python touched).

- [ ] **Step 8:** Commit:

```bash
git add web/app.js web/index.html
git commit -m "refactor(web): extract app.js entrypoint; index.html now ~200 lines + module script"
```

---

## Task 12: Update CLAUDE.md and README.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1:** Update the "Project Structure" tree in `CLAUDE.md` to reflect the new `web/` layout:

```
├── web/
│   ├── index.html        ~200-line SPA shell
│   ├── styles.css        Extracted CSS
│   ├── app.js            Entrypoint: init + DOM wiring
│   ├── state.js          State object + bus (EventTarget) + persist/restore
│   ├── utils.js          DOM/string helpers
│   ├── sim.js            Sim state machine + RuntimeClient
│   ├── canvas.js         SVG rendering, drag/pan, theme, layout
│   ├── inspector.js      Nav + right-pane panels + ops + context menu
│   ├── terminals.js      Per-node terminal popups
│   └── packets.js        PacketAnim + tooltips
```

- [ ] **Step 2:** Update "Build & Run" in `CLAUDE.md` to mention JS tests:

```
- JS tests: `npm install` once, then `npm test` from the repo root (uses vitest + happy-dom).
```

- [ ] **Step 3:** Add a one-paragraph note under "Key Design Decisions & Traps" in `CLAUDE.md`:

```
- **Web SPA uses native ES modules + an EventTarget bus.** Cross-component coordination (render after mutation, react to sim status change) flows through `bus` exported from `state.js`. Synchronous queries and DOM helpers (`canvas.lookupDeviceNode`, `utils.el`, etc.) are direct imports. The rule: state mutations + cross-component re-renders → bus; sync queries + DOM helpers → direct import. Don't reintroduce module-to-module direct render calls.
```

- [ ] **Step 4:** Update `README.md` "Quick start" to mention the JS test command:

```
- Run JS tests: `npm install` (first time only), then `npm test`.
```

- [ ] **Step 5:** Verify the CLAUDE.md line count is still under 200 (per the file's own rule). Use `wc -l CLAUDE.md`. If it has grown over, prune the older, lower-value lines.

- [ ] **Step 6:** Commit:

```bash
git add CLAUDE.md README.md
git commit -m "docs: document web module layout, JS tests, and bus convention"
```

---

## Task 13: Final verification

**Files:** none modified.

- [ ] **Step 1:** Run the full Python suite:

```bash
pytest
```

Expected: 138 tests pass.

- [ ] **Step 2:** Run the full JS suite:

```bash
npm test
```

Expected: all `utils.test.js`, `state.test.js`, `sim.test.js` cases pass.

- [ ] **Step 3:** Run `ruff check src/ test/`. Expected: same pre-existing 51 errors as baseline (Python untouched).

- [ ] **Step 4:** Start the server fresh:

```bash
cd src && python netrouting.py
```

Open `http://127.0.0.1:8000/` in a clean browser profile (or hard-refresh / clear cache). DevTools → Console must be clean.

- [ ] **Step 5:** Walk `docs/manual-smoke-test.md` end-to-end. Compare against the pre-implementation baseline captured in pre-flight. The two must match — no new regressions, no new bugs.

- [ ] **Step 6:** Sanity-check `web/index.html` size:

```bash
wc -l web/index.html
```

Expected: under ~250 lines.

- [ ] **Step 7:** Sanity-check the module dep graph is acyclic by grepping for surprising cross-imports:

```bash
grep -nE "from '\./(canvas|inspector|terminals|packets|sim|app)\.js'" web/state.js web/utils.js
```

Expected: no matches (state.js and utils.js are leaves and must not import from layer-2 modules).

```bash
grep -nE "from '\./inspector\.js'" web/canvas.js
grep -nE "from '\./canvas\.js|\./inspector\.js'" web/sim.js
```

Expected: no matches (canvas does not depend on inspector; sim does not depend on canvas or inspector).

- [ ] **Step 8:** No commit for this task (verification only). Final branch state is ready for merge to `main` via the `finishing-a-development-branch` skill.
