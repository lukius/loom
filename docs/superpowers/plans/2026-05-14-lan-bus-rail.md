# LAN Bus Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cloud-silhouette LAN visual with a resizable, rotatable horizontal/vertical bus rail in the netrouting SPA.

**Architecture:** Single-source rendering change driven from `web/canvas.js` + `web/styles.css`. Two optional fields (`w`, `orientation`) added to `state.networks[name]`. A new pure helper `tapPointOnRail` replaces the network endpoint of every edge. All state classes (idle/hover/selected/drop-target) reuse the existing `--net` / `--accent` palette, so light + dark themes work without new tokens.

**Tech Stack:** Vanilla ES modules, SVG, CSS variables. Tests via vitest (+ happy-dom) and Playwright.

**Spec:** [`docs/superpowers/specs/2026-05-14-lan-bus-rail-design.md`](../specs/2026-05-14-lan-bus-rail-design.md)

---

## Pre-flight

Run once before starting:

```bash
npm install        # if vitest/playwright not installed yet
npm test           # baseline vitest — should be green
npm run test:e2e   # baseline playwright — should be green
ruff check src/ test/   # no python changes but verify baseline
```

If anything is red at baseline, fix that first or talk to the author.

---

## Task 1: State defaults for `w` and `orientation`

**Files:**
- Modify: `web/state.js`
- Modify: `web/state.test.js`

- [ ] **Step 1: Add a failing test for persistence of `w` and `orientation`**

Open `web/state.test.js`. Find the existing `describe('persist / restore', ...)` block (starts around line 50). Add a new test inside it:

```js
  it('round-trips optional network fields w and orientation', () => {
    state.networks.lan1 = {
      cidr: '10.0.0.0/24', x: 1, y: 2,
      w: 240, orientation: 'v',
    };
    persist();
    resetState();
    expect(restore()).toBe(true);
    expect(state.networks.lan1).toEqual({
      cidr: '10.0.0.0/24', x: 1, y: 2,
      w: 240, orientation: 'v',
    });
  });
```

- [ ] **Step 2: Run test to verify it passes (persistence is JSON-based, so it should already work)**

Run: `npm test -- state.test.js`
Expected: PASS — `restore` round-trips the whole network blob via JSON, so the new fields naturally survive. If it fails, persistence is not JSON-based, and you must investigate before continuing.

- [ ] **Step 3: Add rail-geometry constants to state.js**

Open `web/state.js`. Find the `export const NODE = { ... }` block (line ~28). Replace it and add new rail constants directly above:

```js
// Rail (LAN bus) geometry — used by canvas.js when rendering networks.
export const RAIL_DEFAULT_WIDTH = 180;
export const RAIL_MIN_WIDTH = 100;
export const RAIL_MAX_WIDTH = 800;
export const RAIL_THICKNESS = 10;            // cross-axis size of the rail
export const RAIL_ENDCAP_LEN = 14;           // cross-axis length of idle endcap
export const RAIL_HANDLE_LEN = 18;           // cross-axis length when selected (handle)
export const RAIL_TICK_INSET = 12;           // px margin from rail end inside which taps cluster
export const RAIL_TICK_LEN = 4;              // tap-tick depth inside the rail
export const RAIL_LABEL_GAP = 14;            // gap from rail's bottom to label baseline

// Per-node bounding sizes used by edge clipping and hit-rect drawing.
// For network: width is the rail's main-axis size (default), height is the thickness.
// drawNode resolves the orientation-aware real (width, height) per network at render time.
export const NODE = {
  network: { w: RAIL_DEFAULT_WIDTH, h: RAIL_THICKNESS },
  host:    { w: 40, h: 38 },
  router:  { w: 44, h: 38 },
};

export const HIT_PAD = {
  network: { x: 12, top: 12, bottom: 32 },   // hit-rect covers rail + label area below
  host:    { x: 18, top: 6,  bottom: 36 },
  router:  { x: 18, top: 6,  bottom: 38 },
};
```

Keep `host` and `router` entries unchanged from current values — if they differ in the working tree, preserve those values. Only `network` and the new constants are new.

- [ ] **Step 4: Run all state tests**

Run: `npm test -- state.test.js`
Expected: PASS — all existing tests still green, plus the new persistence test.

- [ ] **Step 5: Commit**

```bash
git add web/state.js web/state.test.js
git commit -m "feat(web): rail geometry constants + persistence of network w/orientation"
```

---

## Task 2: `tapPointOnRail` helper (horizontal only)

**Files:**
- Modify: `web/canvas.js`
- Create: `web/canvas.test.js`

- [ ] **Step 1: Write failing unit tests for the helper**

Create `web/canvas.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { tapPointOnRail } from './canvas.js';
import { RAIL_DEFAULT_WIDTH, RAIL_THICKNESS, RAIL_TICK_INSET } from './state.js';

const W = RAIL_DEFAULT_WIDTH;       // 180
const H = RAIL_THICKNESS;           // 10
const INSET = RAIL_TICK_INSET;      // 12

describe('tapPointOnRail — horizontal rail', () => {
  const rail = { x: 0, y: 0, w: W, orientation: 'h' };

  it('returns top-edge tap when device sits above the rail', () => {
    const [x, y] = tapPointOnRail({ x: 30, y: -100 }, rail);
    expect(x).toBe(30);
    expect(y).toBe(-H / 2);
  });

  it('returns bottom-edge tap when device sits below the rail', () => {
    const [x, y] = tapPointOnRail({ x: 30, y: 100 }, rail);
    expect(x).toBe(30);
    expect(y).toBe(H / 2);
  });

  it('clamps tap-x to the rail span minus inset on the right', () => {
    const [x] = tapPointOnRail({ x: 9999, y: -10 }, rail);
    expect(x).toBe(W / 2 - INSET);
  });

  it('clamps tap-x to the rail span minus inset on the left', () => {
    const [x] = tapPointOnRail({ x: -9999, y: -10 }, rail);
    expect(x).toBe(-W / 2 + INSET);
  });

  it('respects rail offset (x,y) when computing tap', () => {
    const offset = { x: 200, y: 100, w: W, orientation: 'h' };
    const [x, y] = tapPointOnRail({ x: 210, y: 50 }, offset);
    expect(x).toBe(210);                // within span, no clamp
    expect(y).toBe(100 - H / 2);        // top edge of offset rail
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- canvas.test.js`
Expected: FAIL — `tapPointOnRail` is not exported from canvas.js yet.

- [ ] **Step 3: Implement `tapPointOnRail` (horizontal only for now)**

Open `web/canvas.js`. Add the import for the new constants at the top of the file (near the existing `state.js` import):

```js
import {
  NODE, HIT_PAD,
  RAIL_THICKNESS, RAIL_TICK_INSET, RAIL_DEFAULT_WIDTH,
} from './state.js';
```

Then add this exported function near the other geometry helpers (just below `clipToRect`, around line 301):

```js
/**
 * Compute where an edge from `device` should terminate on `rail`.
 *
 * Horizontal rail (orientation 'h'): main = x, cross = y.
 *   tap-x = clamp(device.x, rail.x ± (w/2 - inset))
 *   tap-y = rail.y ± h/2 depending on which side device sits on
 *
 * Vertical rail support is added in a later task.
 */
export function tapPointOnRail(device, rail) {
  const w = rail.w ?? RAIL_DEFAULT_WIDTH;
  const h = RAIL_THICKNESS;
  const inset = RAIL_TICK_INSET;
  // Horizontal-only branch.
  const minX = rail.x - w / 2 + inset;
  const maxX = rail.x + w / 2 - inset;
  const tapX = Math.max(minX, Math.min(maxX, device.x));
  const tapY = device.y < rail.y ? rail.y - h / 2 : rail.y + h / 2;
  return [tapX, tapY];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- canvas.test.js`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add web/canvas.js web/canvas.test.js
git commit -m "feat(web): tapPointOnRail helper for LAN rail edge endpoints"
```

---

## Task 3: Replace cloud rendering with horizontal bus rail

**Files:**
- Modify: `web/canvas.js`
- Modify: `web/styles.css`
- Modify: `e2e/spa.spec.js`

**Note:** This is the visual cutover. After this task, LANs are rails (horizontal only). Selection, resize, and vertical come in later tasks.

- [ ] **Step 1: Update `drawEdge` to use `tapPointOnRail` for network endpoints**

In `web/canvas.js`, find `drawEdge` (around line 244). Replace the network endpoint clip with the rail tap point. Look at this section:

```js
export function drawEdge(a, b, kind, sel, info) {
  // a, b have x,y at center; we clip to each node's rect
  const aSize = NODE[sel.kind === 'host' ? 'host' : 'router'];
  const bSize = NODE.network;
  const [ax, ay] = clipToRect(a.x, a.y, aSize.w, aSize.h, b.x, b.y);
  const [bx, by] = clipToRect(b.x, b.y, bSize.w, bSize.h, a.x, a.y);
```

Replace with:

```js
export function drawEdge(a, b, kind, sel, info) {
  // a, b have x,y at center; clip the device end to its rect, tap the rail end.
  const aSize = NODE[sel.kind === 'host' ? 'host' : 'router'];
  const [ax, ay] = clipToRect(a.x, a.y, aSize.w, aSize.h, b.x, b.y);
  const [bx, by] = tapPointOnRail(a, b);
```

The rest of the function (bezier control points, label placement) is unchanged.

- [ ] **Step 2: Replace the cloud branch of `drawNode` with rail rendering**

In `web/canvas.js`, find the `if (kind === 'network')` branch inside `drawNode` (around line 326). Replace the entire block (from `if (kind === 'network') {` through the matching `}`) with:

```js
  if (kind === 'network') {
    const w = obj.w ?? RAIL_DEFAULT_WIDTH;
    const h = RAIL_THICKNESS;
    // rail bar
    g.appendChild(el('rect', {
      class: 'rail',
      x: -w / 2, y: -h / 2,
      width: w, height: h,
      rx: h / 2,
    }));
    // endcaps (small perpendicular bars at each rail end)
    const capW = 3, capH = RAIL_ENDCAP_LEN;
    for (const sign of [-1, 1]) {
      g.appendChild(el('rect', {
        class: 'endcap',
        x: sign * w / 2 - capW / 2, y: -capH / 2,
        width: capW, height: capH,
        rx: 1,
      }));
    }
    // tap ticks — one per attached device interface
    const devices = collectAttachedDevices(name);
    for (const dev of devices) {
      const tx = clampTapX(dev.x - obj.x, w);
      const above = dev.y < obj.y;
      const y = above ? -h / 2 : h / 2 - RAIL_TICK_LEN;
      g.appendChild(el('rect', {
        class: 'tick',
        'data-device-kind': dev.kind,
        'data-device-name': dev.name,
        x: tx - 1, y, width: 2, height: RAIL_TICK_LEN, rx: 1,
      }));
    }
    // inline label "name · cidr"
    g.appendChild(buildRailLabel(name, obj, h));
  } else {
```

Add this helper just above `drawNode` (or in the same helpers area as `clipToRect`):

```js
function collectAttachedDevices(netName) {
  const out = [];
  for (const [hn, h] of Object.entries(state.hosts)) {
    if (h.network === netName) out.push({ kind: 'host', name: hn, x: h.x, y: h.y });
  }
  for (const [rn, r] of Object.entries(state.routers)) {
    const hasIface = Object.values(r.interfaces || {}).some(i => i.network === netName);
    if (hasIface) out.push({ kind: 'router', name: rn, x: r.x, y: r.y });
  }
  return out;
}

function clampTapX(rel, w) {
  const inset = RAIL_TICK_INSET;
  return Math.max(-w / 2 + inset, Math.min(w / 2 - inset, rel));
}

function buildRailLabel(name, obj, h) {
  const cidr = obj.cidr || '';
  const text = el('text', {
    class: 'rail-label',
    x: 0, y: h / 2 + RAIL_LABEL_GAP,
    'text-anchor': 'middle',
  });
  text.appendChild(el('tspan', { class: 'name' }, name));
  text.appendChild(el('tspan', { class: 'sep' }, ' · '));
  if (cidr) {
    text.appendChild(el('tspan', { class: 'cidr' }, cidr));
  } else {
    text.appendChild(el('tspan', { class: 'cidr empty' }, '— no cidr'));
  }
  return text;
}
```

Update the imports at the top of canvas.js to include the new constants:

```js
import {
  state, bus,
  NODE, HIT_PAD,
  RAIL_THICKNESS, RAIL_TICK_INSET, RAIL_DEFAULT_WIDTH,
  RAIL_ENDCAP_LEN, RAIL_TICK_LEN, RAIL_LABEL_GAP,
} from './state.js';
```

(Adjust to whatever the actual existing import shape is — keep all the names already imported.)

- [ ] **Step 3: Replace cloud CSS with rail CSS**

Open `web/styles.css`. Find the LAN cloud block (around line 731, `/* LAN: cloud silhouette */`). Replace from the comment through the end of `.canvas .node.network.drop-target .name { ... }` (around line 756) with:

```css
/* LAN: bus rail (replaces the old cloud silhouette) */
.canvas .node.network .rail {
  fill: var(--net);
  transition: fill .12s, filter .15s;
}
.canvas .node.network .endcap {
  fill: var(--net);
  transition: fill .12s;
}
.canvas .node.network .tick {
  fill: var(--net-text);
  transition: fill .12s;
}
.canvas .node.network:hover .rail,
.canvas .node.network:hover .endcap {
  fill: color-mix(in srgb, var(--net) 88%, white);
  filter: drop-shadow(0 4px 10px rgba(0,0,0,.06));
}

/* inline label below the rail */
.canvas .node.network .rail-label { font-size: 15px; }
.canvas .node.network .rail-label .name { fill: var(--net-text); font-weight: 600; }
.canvas .node.network .rail-label .sep { fill: var(--text-3); }
.canvas .node.network .rail-label .cidr { fill: var(--text-2); font-size: 13px; }
.canvas .node.network .rail-label .cidr.empty { fill: var(--text-3); font-style: italic; }
.canvas .node.network.selected .rail-label .name { fill: var(--accent); }
```

- [ ] **Step 4: Update an existing E2E selector that references `.cloud`**

Open `e2e/spa.spec.js` and search for `cloud`. Replace any `.canvas .node.network .cloud` selector with `.canvas .node.network .rail`. Also search for any visual assertion that relied on cloud (e.g., bounding-box dimensions) and either update or remove it — describe what you found in the commit message.

- [ ] **Step 5: Add an E2E test for the new rail rendering**

Append to `e2e/spa.spec.js` inside the existing `test.describe('netrouting SPA - smoke', ...)`:

```js
  test('LAN nodes render as a bus rail with endcaps, ticks, and inline label', async ({ page }) => {
    // SAMPLE has 3 networks and 6 attachments total (3 hosts + 3 router-interfaces).
    await expect(page.locator('#nodes-layer g.node.network .rail')).toHaveCount(3);
    // 2 endcaps per LAN.
    await expect(page.locator('#nodes-layer g.node.network .endcap')).toHaveCount(6);
    // Each LAN has a label that contains a name and a separator.
    const label0 = page.locator('#nodes-layer g.node.network').first().locator('.rail-label');
    await expect(label0).toContainText('·');
  });
```

- [ ] **Step 6: Run all tests**

Run: `npm test` (vitest) — expect PASS on all suites.
Run: `npm run test:e2e` (Playwright) — expect PASS.

If a Playwright test fails because it relied on `.cloud`, that's the one you should have already updated in Step 4. Go back and fix it now.

- [ ] **Step 7: Commit**

```bash
git add web/canvas.js web/styles.css e2e/spa.spec.js
git commit -m "feat(web): render LANs as horizontal bus rails (replaces cloud silhouette)"
```

---

## Task 4: Selection visual + resize handles

**Files:**
- Modify: `web/canvas.js`
- Modify: `web/styles.css`
- Modify: `e2e/spa.spec.js`

- [ ] **Step 1: Add selection halo + handle styles to CSS**

Open `web/styles.css`. Just below the rail block from Task 3, append:

```css
/* selected state */
.canvas .node.network.selected .rail {
  filter: drop-shadow(0 0 0 2px var(--accent));
}
.canvas .node.network.selected .endcap {
  /* endcaps grow into resize handles */
  fill: var(--accent);
  stroke: var(--accent-border);
  stroke-width: 1;
}

/* handles get a slightly larger rendering via an attribute set in JS */
.canvas .node.network.selected .endcap[data-handle="true"] { cursor: ew-resize; }
.canvas .node.network.selected .endcap[data-handle="true"][data-axis="v"] { cursor: ns-resize; }
```

Note on the drop-shadow trick: `drop-shadow(0 0 0 2px var(--accent))` doesn't render a ring (drop-shadow blurs). Use an outline-style approach instead:

```css
.canvas .node.network.selected .rail {
  paint-order: stroke fill;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-opacity: 0.6;
}
```

Use this stroke-based approach — it gives a clean outer halo on a filled rect via `paint-order: stroke`.

- [ ] **Step 2: Resize endcaps when selected (JS)**

In `web/canvas.js`, update the endcap rendering loop inside `drawNode` (the section you wrote in Task 3) so the endcaps grow when the LAN is selected:

```js
    // endcaps (also serve as resize handles when LAN is selected)
    const capW = isSel ? 5 : 3;
    const capH = isSel ? RAIL_HANDLE_LEN : RAIL_ENDCAP_LEN;
    for (const sign of [-1, 1]) {
      g.appendChild(el('rect', {
        class: 'endcap',
        x: sign * w / 2 - capW / 2, y: -capH / 2,
        width: capW, height: capH,
        rx: 1,
        ...(isSel ? { 'data-handle': 'true', 'data-axis': 'h', 'data-end': sign === -1 ? 'left' : 'right' } : {}),
      }));
    }
```

Add the `RAIL_HANDLE_LEN` import to the top-of-file import block.

- [ ] **Step 3: Implement the `resize-net` drag mode**

In `web/canvas.js`, locate `attachNodeEvents` (around line 436+). It handles `pointerdown` on a node and dispatches to drag modes. Find the dispatch logic and add a branch that detects clicks on a handle:

Inside the `pointerdown` handler, before the existing node-drag branch, add:

```js
    // resize-net: pointerdown on an endcap that's wearing the data-handle attribute
    const handle = e.target.closest('rect.endcap[data-handle="true"]');
    if (handle && kind === 'network') {
      e.stopPropagation();
      const startW = state.networks[name].w ?? RAIL_DEFAULT_WIDTH;
      const startMain = e.clientX; // for horizontal; vertical task replaces this
      const end = handle.getAttribute('data-end'); // 'left' | 'right'
      const dir = end === 'right' ? 1 : -1;
      const onMove = (ev) => {
        const delta = (ev.clientX - startMain) * dir;
        const newW = clamp(startW + 2 * delta, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH);
        state.networks[name].w = newW;
        renderCanvas();
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        markDirty();
        bus.dispatchEvent(new CustomEvent('state:topology-changed'));
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      return;
    }
```

Add a `clamp` helper near the top of canvas.js (or import from utils if one exists there):

```js
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
```

Add imports for the new symbols:

```js
import {
  state, bus,
  NODE, HIT_PAD,
  RAIL_THICKNESS, RAIL_TICK_INSET, RAIL_DEFAULT_WIDTH,
  RAIL_ENDCAP_LEN, RAIL_HANDLE_LEN, RAIL_TICK_LEN, RAIL_LABEL_GAP,
  RAIL_MIN_WIDTH, RAIL_MAX_WIDTH,
} from './state.js';
import { markDirty } from './state.js';  // if not already imported
```

- [ ] **Step 4: Add E2E test for selection and resize**

In `e2e/spa.spec.js`, inside the same describe block, append:

```js
  test('clicking a LAN selects it and shows handle endcaps', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    await lan.click();
    await expect(lan).toHaveClass(/selected/);
    // selected LAN has two handles (data-handle="true")
    await expect(lan.locator('.endcap[data-handle="true"]')).toHaveCount(2);
  });

  test('dragging a right handle widens the rail and the width persists', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    await lan.click();
    const railBefore = await lan.locator('.rail').getAttribute('width');
    const handle = lan.locator('.endcap[data-handle="true"][data-end="right"]');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const railAfter = await lan.locator('.rail').getAttribute('width');
    expect(Number(railAfter)).toBeGreaterThan(Number(railBefore));
  });
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/canvas.js web/styles.css e2e/spa.spec.js
git commit -m "feat(web): selection halo + resize handles for LAN bus rail"
```

---

## Task 5: Vertical orientation support

**Files:**
- Modify: `web/canvas.js`
- Modify: `web/canvas.test.js`
- Modify: `e2e/spa.spec.js`

**Note:** This task makes the rendering and tap math axis-aware, but does NOT add the rotate button yet. Task 6 adds the rotate UI.

- [ ] **Step 1: Add failing unit tests for vertical `tapPointOnRail`**

Append to `web/canvas.test.js`:

```js
describe('tapPointOnRail — vertical rail', () => {
  const rail = { x: 0, y: 0, w: W, orientation: 'v' };

  it('returns left-edge tap when device sits to the left', () => {
    const [x, y] = tapPointOnRail({ x: -100, y: 30 }, rail);
    expect(x).toBe(-H / 2);
    expect(y).toBe(30);
  });

  it('returns right-edge tap when device sits to the right', () => {
    const [x, y] = tapPointOnRail({ x: 100, y: 30 }, rail);
    expect(x).toBe(H / 2);
    expect(y).toBe(30);
  });

  it('clamps tap-y to the rail span minus inset', () => {
    const [, y] = tapPointOnRail({ x: 10, y: 9999 }, rail);
    expect(y).toBe(W / 2 - INSET);
  });
});
```

- [ ] **Step 2: Run tests — verify the vertical cases fail**

Run: `npm test -- canvas.test.js`
Expected: 3 new tests FAIL (function ignores orientation, always treats as horizontal).

- [ ] **Step 3: Make `tapPointOnRail` axis-aware**

Replace the implementation of `tapPointOnRail` in `web/canvas.js` with:

```js
export function tapPointOnRail(device, rail) {
  const w = rail.w ?? RAIL_DEFAULT_WIDTH;
  const h = RAIL_THICKNESS;
  const inset = RAIL_TICK_INSET;
  const vertical = (rail.orientation ?? 'h') === 'v';

  if (vertical) {
    const minY = rail.y - w / 2 + inset;
    const maxY = rail.y + w / 2 - inset;
    const tapY = Math.max(minY, Math.min(maxY, device.y));
    const tapX = device.x < rail.x ? rail.x - h / 2 : rail.x + h / 2;
    return [tapX, tapY];
  }
  const minX = rail.x - w / 2 + inset;
  const maxX = rail.x + w / 2 - inset;
  const tapX = Math.max(minX, Math.min(maxX, device.x));
  const tapY = device.y < rail.y ? rail.y - h / 2 : rail.y + h / 2;
  return [tapX, tapY];
}
```

- [ ] **Step 4: Run unit tests — verify vertical tests pass**

Run: `npm test -- canvas.test.js`
Expected: All 8 tests PASS (5 horizontal + 3 vertical).

- [ ] **Step 5: Make rail rendering axis-aware in `drawNode`**

Replace the rail/endcap/tick/label block from Task 3 with an orientation-aware version. In `web/canvas.js`'s `drawNode`, replace the `if (kind === 'network') { ... }` body with:

```js
  if (kind === 'network') {
    const w = obj.w ?? RAIL_DEFAULT_WIDTH;
    const h = RAIL_THICKNESS;
    const vertical = (obj.orientation ?? 'h') === 'v';
    // axis projection: main = length along bus, cross = thickness
    const mainProp = vertical ? 'y' : 'x';
    const crossProp = vertical ? 'x' : 'y';
    const railRectAttrs = vertical
      ? { x: -h / 2, y: -w / 2, width: h, height: w, rx: h / 2 }
      : { x: -w / 2, y: -h / 2, width: w, height: h, rx: h / 2 };

    g.appendChild(el('rect', { class: 'rail', ...railRectAttrs }));

    // endcaps
    const capMain = isSel ? RAIL_HANDLE_LEN : RAIL_ENDCAP_LEN;
    const capCross = isSel ? 5 : 3;
    for (const sign of [-1, 1]) {
      const capAttrs = vertical
        ? { x: -capMain / 2, y: sign * w / 2 - capCross / 2, width: capMain, height: capCross }
        : { x: sign * w / 2 - capCross / 2, y: -capMain / 2, width: capCross, height: capMain };
      const extra = isSel
        ? { 'data-handle': 'true', 'data-axis': vertical ? 'v' : 'h', 'data-end': sign === -1 ? (vertical ? 'top' : 'left') : (vertical ? 'bottom' : 'right') }
        : {};
      g.appendChild(el('rect', { class: 'endcap', rx: 1, ...capAttrs, ...extra }));
    }

    // ticks
    const devices = collectAttachedDevices(name);
    for (const dev of devices) {
      const relMain = dev[mainProp] - obj[mainProp];
      const tapMain = clampTapX(relMain, w);
      const onNegSide = dev[crossProp] < obj[crossProp];
      const crossSign = onNegSide ? -1 : 1;
      // tick sits inside the rail, perpendicular to the main axis
      const tickAttrs = vertical
        ? { x: crossSign * h / 2 + (onNegSide ? 0 : -RAIL_TICK_LEN), y: tapMain - 1, width: RAIL_TICK_LEN, height: 2 }
        : { x: tapMain - 1, y: crossSign * h / 2 + (onNegSide ? 0 : -RAIL_TICK_LEN), width: 2, height: RAIL_TICK_LEN };
      g.appendChild(el('rect', {
        class: 'tick',
        'data-device-kind': dev.kind,
        'data-device-name': dev.name,
        rx: 1,
        ...tickAttrs,
      }));
    }

    // label — always horizontal, always below the rail's bottom-most point
    const labelY = (vertical ? w / 2 : h / 2) + RAIL_LABEL_GAP;
    g.appendChild(buildRailLabel(name, obj, labelY));
  } else {
```

Update `buildRailLabel` to take an absolute `y` rather than the rail height:

```js
function buildRailLabel(name, obj, y) {
  const cidr = obj.cidr || '';
  const text = el('text', {
    class: 'rail-label',
    x: 0, y,
    'text-anchor': 'middle',
  });
  text.appendChild(el('tspan', { class: 'name' }, name));
  text.appendChild(el('tspan', { class: 'sep' }, ' · '));
  if (cidr) {
    text.appendChild(el('tspan', { class: 'cidr' }, cidr));
  } else {
    text.appendChild(el('tspan', { class: 'cidr empty' }, '— no cidr'));
  }
  return text;
}
```

- [ ] **Step 6: Make `resize-net` drag axis-aware**

In `web/canvas.js`, update the `resize-net` branch inside `attachNodeEvents` (added in Task 4). Replace it with:

```js
    const handle = e.target.closest('rect.endcap[data-handle="true"]');
    if (handle && kind === 'network') {
      e.stopPropagation();
      const orient = state.networks[name].orientation ?? 'h';
      const vertical = orient === 'v';
      const startW = state.networks[name].w ?? RAIL_DEFAULT_WIDTH;
      const startMain = vertical ? e.clientY : e.clientX;
      const end = handle.getAttribute('data-end'); // left/right/top/bottom
      const dir = (end === 'right' || end === 'bottom') ? 1 : -1;
      const onMove = (ev) => {
        const cur = vertical ? ev.clientY : ev.clientX;
        const delta = (cur - startMain) * dir;
        const newW = clamp(startW + 2 * delta, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH);
        state.networks[name].w = newW;
        renderCanvas();
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        markDirty();
        bus.dispatchEvent(new CustomEvent('state:topology-changed'));
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      return;
    }
```

- [ ] **Step 7: Update CSS for vertical handle cursor**

The `.endcap[data-handle="true"][data-axis="v"]` rule from Task 4 already covers `ns-resize`. Verify it's in place. No additional changes needed.

- [ ] **Step 8: Add E2E test for vertical rendering**

Append to `e2e/spa.spec.js`:

```js
  test('a LAN with orientation "v" renders the rail tall instead of wide', async ({ page }) => {
    // Mutate the first network's orientation in localStorage, then reload.
    await page.evaluate(() => {
      const raw = localStorage.getItem('netrouting:state');
      const s = JSON.parse(raw);
      const firstKey = Object.keys(s.networks)[0];
      s.networks[firstKey].orientation = 'v';
      s.networks[firstKey].w = 200;
      localStorage.setItem('netrouting:state', JSON.stringify(s));
    });
    await page.reload();
    await page.waitForSelector('#nodes-layer g.node.network');
    const rail = page.locator('#nodes-layer g.node.network').first().locator('.rail');
    const widthAttr = await rail.getAttribute('width');
    const heightAttr = await rail.getAttribute('height');
    // Vertical rail: thickness is the width attribute, length is the height attribute.
    expect(Number(heightAttr)).toBeGreaterThan(Number(widthAttr));
  });
```

If the localStorage key for state isn't `'netrouting:state'`, replace with the actual `STORAGE_KEY` exported from `web/state.js` — look it up before running the test.

- [ ] **Step 9: Run all tests**

Run: `npm test`
Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add web/canvas.js web/canvas.test.js e2e/spa.spec.js
git commit -m "feat(web): support vertical orientation for LAN bus rails"
```

---

## Task 6: Rotate button (hover-revealed + inspector backup)

**Files:**
- Modify: `web/canvas.js`
- Modify: `web/styles.css`
- Modify: `web/inspector.js`
- Modify: `e2e/spa.spec.js`

- [ ] **Step 1: Render a rotate button inside the network node**

In `web/canvas.js`, at the end of the `if (kind === 'network') { ... }` body (just before the closing `}` that introduces the `else` for host/router), append:

```js
    // rotate button — hover/selected only via CSS
    const w = obj.w ?? RAIL_DEFAULT_WIDTH;
    const h = RAIL_THICKNESS;
    const vertical = (obj.orientation ?? 'h') === 'v';
    const btnPos = vertical
      ? { x: h / 2 + 18, y: -w / 2 + 9 }
      : { x: w / 2 - 9, y: -h / 2 - 18 };
    const btn = el('g', {
      class: 'rotate-btn',
      transform: `translate(${btnPos.x} ${btnPos.y})`,
      'data-rotate-btn': 'true',
    });
    btn.appendChild(el('circle', { r: 9, class: 'bg' }));
    btn.appendChild(el('path', {
      class: 'ico',
      // small curved-arrow rotate icon, ~12px viewBox centered on (0,0)
      d: 'M -4 -1 A 4 4 0 1 0 -3.4 -3.4 L -2 -3.4 M -3.4 -3.4 L -3.4 -2',
      fill: 'none',
      'stroke-width': 1.4,
    }));
    const title = el('title', {}, vertical ? 'Rotate to horizontal' : 'Rotate to vertical');
    btn.appendChild(title);
    g.appendChild(btn);
```

Note: the `r/m` substitution above doesn't matter — we're just placing children. Re-fetching `w`, `h`, `vertical` here is intentional so the rotate-button block is self-contained (you could also hoist them; keep it inline for clarity).

- [ ] **Step 2: Wire the rotate click in `attachNodeEvents`**

Inside `attachNodeEvents` (canvas.js), at the very top of the `pointerdown` handler — before the resize-handle branch added in Task 5 — add:

```js
    // rotate button has its own handler; never bubbles
    const rot = e.target.closest('[data-rotate-btn="true"]');
    if (rot && kind === 'network') {
      e.stopPropagation();
      const cur = state.networks[name].orientation ?? 'h';
      state.networks[name].orientation = cur === 'h' ? 'v' : 'h';
      markDirty();
      bus.dispatchEvent(new CustomEvent('state:topology-changed'));
      return;
    }
```

- [ ] **Step 3: Style the rotate button**

In `web/styles.css`, just below the rail-related rules, append:

```css
/* rotate button — revealed on hover or when LAN is selected */
.canvas .node.network .rotate-btn { opacity: 0; transition: opacity .12s; pointer-events: all; cursor: pointer; }
.canvas .node.network:hover .rotate-btn,
.canvas .node.network.selected .rotate-btn { opacity: 1; }
.canvas .node.network .rotate-btn .bg {
  fill: var(--bg);
  stroke: var(--border);
  stroke-width: 1;
}
.canvas .node.network .rotate-btn .ico {
  stroke: var(--text-2);
  fill: none;
  transition: stroke .12s;
}
.canvas .node.network .rotate-btn:hover .bg { fill: var(--accent-bg); stroke: var(--accent-border); }
.canvas .node.network .rotate-btn:hover .ico { stroke: var(--accent); }
```

- [ ] **Step 4: Add a Rotate button to the LAN inspector panel**

In `web/inspector.js`, find `renderNetworkInsp` (line ~294). In its `insp-body` div, just below the CIDR field, add a new field block:

```js
      <div class="field">
        <label>Orientation</label>
        <button id="f-rotate" class="btn-sec">Rotate to ${net.orientation === 'v' ? 'horizontal' : 'vertical'}</button>
        <div class="hint">Switches the rail between horizontal and vertical.</div>
      </div>
```

Then below the existing event-binding lines (around `elI.querySelector('#f-del')...`), add:

```js
  elI.querySelector('#f-rotate').addEventListener('click', () => {
    const cur = state.networks[name].orientation ?? 'h';
    state.networks[name].orientation = cur === 'h' ? 'v' : 'h';
    markDirty();
    bus.dispatchEvent(new CustomEvent('state:topology-changed'));
  });
```

If `bus` or `markDirty` isn't imported in inspector.js, add to the existing state import at the top.

- [ ] **Step 5: E2E test for rotate (both paths)**

Append to `e2e/spa.spec.js`:

```js
  test('clicking the hover rotate button toggles orientation', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    await lan.hover();
    const btn = lan.locator('[data-rotate-btn="true"]');
    await btn.waitFor({ state: 'visible' });
    const rail = lan.locator('.rail');
    const wBefore = Number(await rail.getAttribute('width'));
    const hBefore = Number(await rail.getAttribute('height'));
    await btn.click();
    const wAfter = Number(await rail.getAttribute('width'));
    const hAfter = Number(await rail.getAttribute('height'));
    expect([wAfter, hAfter]).toEqual([hBefore, wBefore]);
  });

  test('the inspector Rotate button also toggles orientation', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    await lan.click();
    const rail = lan.locator('.rail');
    const wBefore = Number(await rail.getAttribute('width'));
    const hBefore = Number(await rail.getAttribute('height'));
    await page.locator('#f-rotate').click();
    const wAfter = Number(await rail.getAttribute('width'));
    const hAfter = Number(await rail.getAttribute('height'));
    expect([wAfter, hAfter]).toEqual([hBefore, wBefore]);
  });
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/canvas.js web/styles.css web/inspector.js e2e/spa.spec.js
git commit -m "feat(web): rotate button on LAN rail (hover + inspector) toggles orientation"
```

---

## Task 7: Drop-target glow + tap-tick hover affordance

**Files:**
- Modify: `web/styles.css`
- Modify: `web/canvas.js`
- Modify: `e2e/spa.spec.js`

- [ ] **Step 1: Drop-target styles for the rail**

In `web/styles.css`, append:

```css
/* drop-target (dragging a host/router onto a LAN) */
.canvas .node.network.drop-target .rail {
  fill: var(--accent);
  filter: drop-shadow(0 0 16px var(--accent-glow));
  animation: rail-pulse 1s ease-in-out infinite alternate;
}
.canvas .node.network.drop-target .endcap {
  fill: var(--accent);
}
.canvas .node.network.drop-target .rail-label .name { fill: var(--accent); }

@keyframes rail-pulse {
  from { filter: drop-shadow(0 0 8px var(--accent-glow)); }
  to   { filter: drop-shadow(0 0 18px var(--accent-glow)); }
}
```

The existing drag-and-drop code in `canvas.js` already toggles a `drop-target` class on the network node (search for `drop-target` in the drag handler from before, around line 534). No JS changes needed.

- [ ] **Step 2: Style the tick brightening on device hover**

Append to `web/styles.css`:

```css
/* tap-tick brightens when its device is hovered */
.canvas .node.network .tick.matched-hover { fill: var(--accent); }
```

- [ ] **Step 3: Wire device-hover to tick-brighten in canvas.js**

Near the bottom of `web/canvas.js` (just after `attachNodeEvents` is defined), add:

```js
// Brighten every tick that belongs to the hovered host/router.
nodesLayer().addEventListener('mouseover', (e) => {
  const node = e.target.closest('g.node[data-kind="host"], g.node[data-kind="router"]');
  if (!node) return;
  const dn = node.getAttribute('data-name');
  const dk = node.getAttribute('data-kind');
  nodesLayer().querySelectorAll(
    `g.node.network .tick[data-device-kind="${dk}"][data-device-name="${cssEscape(dn)}"]`
  ).forEach(t => t.classList.add('matched-hover'));
});
nodesLayer().addEventListener('mouseout', (e) => {
  const node = e.target.closest('g.node[data-kind="host"], g.node[data-kind="router"]');
  if (!node) return;
  nodesLayer().querySelectorAll('.tick.matched-hover').forEach(t => t.classList.remove('matched-hover'));
});
```

If `cssEscape` is not already imported in canvas.js, add it to the import block from `./utils.js`.

If `nodesLayer()` returns a different element each render and the listener gets detached, attach the listener once on first call instead (mirror whatever pattern the existing code uses for global mouse listeners).

- [ ] **Step 4: E2E test for drop-target glow and tick highlight**

Append to `e2e/spa.spec.js`:

```js
  test('dragging a host over a LAN lights up the rail with drop-target class', async ({ page }) => {
    // Find a host that's NOT yet attached to a particular LAN to drag onto it.
    // Drag start: a host node; drop target: a different LAN.
    const host = page.locator('#nodes-layer g.node.host').first();
    const lan = page.locator('#nodes-layer g.node.network').last();
    const hb = await host.boundingBox();
    const lb = await lan.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2, { steps: 10 });
    // While the pointer is still down and over the LAN, drop-target should be set.
    await expect(lan).toHaveClass(/drop-target/);
    await page.mouse.up();
  });

  test('hovering a host highlights its matching tick on the rail', async ({ page }) => {
    const host = page.locator('#nodes-layer g.node.host').first();
    const name = await host.getAttribute('data-name');
    await host.hover();
    const matched = page.locator(`#nodes-layer g.node.network .tick[data-device-name="${name}"].matched-hover`);
    await expect(matched.first()).toBeVisible();
  });
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Run: `npm run test:e2e`
Expected: PASS. If the drop-target test fails because the existing drag handler already lifts the host out of its LAN before we check the class, drag toward the LAN but stop just shy of the drop (don't release until after the assertion); the test code above does that already.

- [ ] **Step 6: Commit**

```bash
git add web/canvas.js web/styles.css e2e/spa.spec.js
git commit -m "feat(web): drop-target glow on LAN rail + tap-tick hover affordance"
```

---

## Task 8: Cleanup, lint, docs

**Files:**
- Modify: `web/canvas.js`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove the now-unused `cloudPath` function**

In `web/canvas.js`, search for `cloudPath`. If it has no remaining callers (it shouldn't), delete the function definition and its export.

```bash
grep -n "cloudPath" web/canvas.js
# expected: zero hits after the deletion
```

Also search for `cloudPath` across the rest of the codebase to confirm no caller:

```bash
grep -rn "cloudPath" web/ e2e/
# expected: zero hits
```

- [ ] **Step 2: Run lint and the full test suites**

```bash
ruff check src/ test/        # no python changes; should be green
npm test                      # vitest
npm run test:e2e              # playwright
```

All three must pass.

- [ ] **Step 3: Update CLAUDE.md** if any key-design-decisions section is now stale

Open `CLAUDE.md` and re-read the "Key Design Decisions & Traps" list. The LAN visual change is internal — most entries (sequence-numbered flooding, NullAddress, etc.) are untouched. **Only update if** a documented trap explicitly named the cloud or the network rendering, in which case adjust the wording. If nothing is stale, do not edit CLAUDE.md.

- [ ] **Step 4: Commit cleanup**

```bash
git add web/canvas.js
git diff --quiet CLAUDE.md || git add CLAUDE.md
git commit -m "chore(web): remove dead cloudPath; finalize LAN bus rail change"
```

- [ ] **Step 5: Final manual smoke**

`cd src && python netrouting.py`, open http://127.0.0.1:8000. Walk through:

1. The sample topology loads — three LANs render as horizontal rails with name · CIDR labels.
2. Click a LAN → halo + handles appear; drag a handle → rail resizes; reload → width persists.
3. Hover a LAN → rotate button appears; click → rail flips to vertical. Click again → back to horizontal.
4. Open the inspector for a LAN → "Rotate to vertical/horizontal" button works.
5. Drag a host onto a different LAN → rail glows accent and pulses; drop attaches the host.
6. Hover a host → that host's tap-tick on the rail brightens.
7. Toggle theme (light ↔ dark) → all rail/handle/label/halo colors render correctly in both.

Report any visual issues from the smoke; otherwise the feature is done.

---

## Final self-review notes

- **Spec coverage:** Every spec section maps to a task. Geometry/state → Task 1; tapPointOnRail horizontal → Task 2; rendering + edges + label → Task 3; selection + resize → Task 4; vertical → Task 5; rotate button + inspector → Task 6; drop-target + tap-tick hover → Task 7; cleanup → Task 8.
- **TDD discipline:** Tasks 1, 2, 5 are pure-logic and follow strict red/green. Tasks 3, 4, 6, 7 are visual/interactive and follow "write the E2E assertion → run → expect failure (or pass for one already there) → make code change → re-run". This is the closest you can get to red/green for SVG interactions.
- **Commit cadence:** Eight commits, each producing a working tree where `npm test` and `npm run test:e2e` are green.
- **Theming:** Every color uses an existing `--*` variable. No new theme tokens. Light/dark verified during the final manual smoke (Step 5 of Task 8).
- **Risk areas to watch during review:**
  - Pointer-event ordering: the rotate button's stopPropagation must run before the existing click/drag handlers.
  - Resize math when the LAN's `(x, y)` changes during drag — confirm the LAN stays anchored on its center after resize (symmetric growth).
  - Localstorage key in the vertical-orientation E2E (Task 5, Step 8) — verify `STORAGE_KEY` at runtime, not by guessing.
