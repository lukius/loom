// web/canvas.js
import {
  state, bus,
  NODE, HIT_PAD,
  LAYOUT_KEY, LAYOUT_DEF, LAYOUT_LIMITS,
  THEME_KEY,
  markDirty,
  RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH,
  RAIL_THICKNESS, RAIL_ENDCAP_LEN, RAIL_HANDLE_LEN,
  RAIL_TICK_INSET, RAIL_TICK_LEN, RAIL_LABEL_GAP,
} from './state.js';
import { el, escapeHtml, cssEscape, uniqueIface, toast } from './utils.js';
import { isTopologyLocked } from './sim.js';

export function lookupDeviceNode(name) {
  if (!name) return null;
  return document.querySelector(`#nodes-layer g[data-name="${cssEscape(name)}"][data-kind="host"], #nodes-layer g[data-name="${cssEscape(name)}"][data-kind="router"]`);
}

export function lookupNetworkNode(name) {
  if (!name) return null;
  return document.querySelector(`#nodes-layer g[data-name="${cssEscape(name)}"][data-kind="network"]`);
}

export function lookupAddressNode(address) {
  if (!address) return null;
  // Find host whose address matches
  for (const [hn, h] of Object.entries(state.hosts || {})) {
    if (h.address === address) return lookupDeviceNode(hn);
  }
  // Find router whose interface address matches
  for (const [rn, r] of Object.entries(state.routers || {})) {
    for (const iname of Object.keys(r.interfaces || {})) {
      if (r.interfaces[iname].address === address) return lookupDeviceNode(rn);
    }
  }
  return null;
}

export function getNodeCenter(g) {
  if (!g) return null;
  // Each node's <g> has transform="translate(x, y)"; the centroid is at (0,0) in local space.
  const t = g.getAttribute('transform') || '';
  const m = t.match(/translate\(([-\d.]+)[,\s]\s*([-\d.]+)\)/);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

/* ---------- layout (resizable panes) ---------- */
export function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (typeof d.navW === 'number')  document.documentElement.style.setProperty('--nav-w',  d.navW  + 'px');
    if (typeof d.inspW === 'number') document.documentElement.style.setProperty('--insp-w', d.inspW + 'px');
  } catch (_) {}
}
export function persistLayout() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const navW  = parseInt(cs.getPropertyValue('--nav-w'),  10);
    const inspW = parseInt(cs.getPropertyValue('--insp-w'), 10);
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ navW, inspW }));
  } catch (_) {}
}
export function wireResizers() {
  const setup = (sel, varName, sign, key) => {
    const handle = document.querySelector(sel);
    if (!handle) return;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('col-resizing');
      const startX = e.clientX;
      const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue(varName), 10);

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        let w = startW + dx * sign;
        const lim = LAYOUT_LIMITS[key];
        w = Math.max(lim.min, Math.min(lim.max, w));
        document.documentElement.style.setProperty(varName, w + 'px');
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('col-resizing');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        persistLayout();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty(varName, LAYOUT_DEF[key] + 'px');
      persistLayout();
    });
  };

  setup('.splitter-nav',  '--nav-w',  +1, 'navW');   // drag right widens nav
  setup('.splitter-insp', '--insp-w', -1, 'inspW');  // drag right shrinks inspector
}

/* ---------- theme ---------- */
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('[data-theme-btn]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-theme-btn') === theme);
  });
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
}
export function initTheme() {
  let t = 'light';
  try { t = localStorage.getItem(THEME_KEY) || 'light'; } catch (_) {}
  if (t !== 'dark' && t !== 'light') t = 'light';
  applyTheme(t);
}

/* ---------- layout: assign defaults to objects without positions ---------- */
export function ensurePositions() {
  // simple grid fallback
  const FALLBACK_X = 700, FALLBACK_Y = 200, GAP = 220;
  let i = 0;
  for (const [n, nv] of Object.entries(state.networks)) {
    if (typeof nv.x !== 'number' || typeof nv.y !== 'number') {
      nv.x = FALLBACK_X; nv.y = FALLBACK_Y + i * GAP;
    }
    i++;
  }
  i = 0;
  for (const [hn, h] of Object.entries(state.hosts)) {
    if (typeof h.x !== 'number' || typeof h.y !== 'number') {
      const target = state.networks[h.network];
      if (target) { h.x = target.x - 230; h.y = target.y + (i % 2 === 0 ? -20 : 20); }
      else { h.x = 220; h.y = 180 + i * 110; }
    }
    i++;
  }
  i = 0;
  for (const [rn, r] of Object.entries(state.routers)) {
    if (typeof r.x !== 'number' || typeof r.y !== 'number') {
      const ifs = Object.values(r.interfaces || {});
      const targetNets = ifs.map(f => state.networks[f.network]).filter(Boolean);
      if (targetNets.length) {
        const avgY = targetNets.reduce((a, n) => a + n.y, 0) / targetNets.length;
        r.x = (targetNets[0].x || FALLBACK_X) + 230; r.y = avgY + (i - 1) * 30;
      } else {
        r.x = 900; r.y = 200 + i * 110;
      }
    }
    i++;
  }
}

/* ---------- canvas state ---------- */
export const canvasEl    = () => document.getElementById('canvas');
export const viewportEl  = () => document.getElementById('viewport');
export const edgesLayer  = () => document.getElementById('edges-layer');
export const nodesLayer  = () => document.getElementById('nodes-layer');
export const overlayLay  = () => document.getElementById('overlay-layer');

export function applyView() {
  const v = state.view;
  viewportEl().setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.k})`);
  document.getElementById('zoom-lvl').textContent = Math.round(v.k * 100) + '%';
}

export function clientToWorld(cx, cy) {
  const svg = canvasEl();
  const rect = svg.getBoundingClientRect();
  const v = state.view;
  return { x: (cx - rect.left - v.x) / v.k, y: (cy - rect.top - v.y) / v.k };
}

export function fitView() {
  const all = [
    ...Object.entries(state.networks).map(([k, v]) => ({ ...v, k: 'network' })),
    ...Object.entries(state.hosts).map(([k, v]) => ({ ...v, k: 'host' })),
    ...Object.entries(state.routers).map(([k, v]) => ({ ...v, k: 'router' })),
  ];
  if (all.length === 0) {
    state.view = { x: 0, y: 0, k: 1 };
    applyView();
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  all.forEach(o => {
    const size = o.k === 'network' ? railRenderSize(o) : NODE[o.k];
    const w = size.width ?? size.w;
    const h = size.height ?? size.h;
    minX = Math.min(minX, o.x - w/2);
    minY = Math.min(minY, o.y - h/2);
    maxX = Math.max(maxX, o.x + w/2);
    maxY = Math.max(maxY, o.y + h/2);
  });
  const pad = 80;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const svg = canvasEl();
  const rect = svg.getBoundingClientRect();
  const k = Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY), 1.4);
  state.view = {
    k,
    x: (rect.width - (maxX - minX) * k) / 2 - minX * k,
    y: (rect.height - (maxY - minY) * k) / 2 - minY * k,
  };
  applyView();
}

/* ---------- canvas: render ---------- */
export function renderCanvas() {
  ensurePositions();
  const empty =
    Object.keys(state.networks).length === 0 &&
    Object.keys(state.hosts).length === 0 &&
    Object.keys(state.routers).length === 0;
  document.getElementById('canv-empty').hidden = !empty;

  // clear layers
  edgesLayer().innerHTML = '';
  nodesLayer().innerHTML = '';
  overlayLay().innerHTML = '';

  // edges first (drawn underneath)
  for (const [hn, h] of Object.entries(state.hosts)) {
    if (!h.network || !state.networks[h.network]) continue;
    drawEdge(h, state.networks[h.network], 'host', { kind:'host', name: hn });
  }
  for (const [rn, r] of Object.entries(state.routers)) {
    for (const [ifn, iff] of Object.entries(r.interfaces || {})) {
      if (!iff.network || !state.networks[iff.network]) continue;
      drawEdge(r, state.networks[iff.network], 'router',
        { kind:'router', name: rn }, { ifname: ifn, cost: iff.cost });
    }
  }

  // nodes — networks first so they sit "behind" devices
  for (const [name, n] of Object.entries(state.networks)) drawNode('network', name, n);
  for (const [name, h] of Object.entries(state.hosts))    drawNode('host',    name, h);
  for (const [name, r] of Object.entries(state.routers))  drawNode('router',  name, r);

  applyView();
}

export function drawEdge(a, b, kind, sel, info) {
  // a is the device (host/router) and b is the LAN. Clip the device end to
  // its rect; the LAN end taps onto the rail at the closest valid point.
  const aSize = NODE[sel.kind === 'host' ? 'host' : 'router'];
  const [ax, ay] = clipToRect(a.x, a.y, aSize.w, aSize.h, b.x, b.y);
  const [bx, by] = tapPointOnRail(a, b);
  const dx = bx - ax, dy = by - ay;
  // smooth bezier
  const c1x = ax + dx * 0.55, c1y = ay;
  const c2x = bx - dx * 0.55, c2y = by;
  const d = `M ${ax} ${ay} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${bx} ${by}`;

  const isSel = state.selection &&
    ((state.selection.kind === sel.kind && state.selection.name === sel.name) ||
     (state.selection.kind === 'network' && state.selection.name === Object.entries(state.networks).find(([n, v]) => v === b)?.[0]));
  const path = el('path', {
    class: `edge ${kind}${isSel ? ' selected' : ''}`,
    d,
  });
  edgesLayer().appendChild(path);

  if (info) {
    // midpoint for label placement
    const t = 0.5;
    const mx = bezPoint(ax, c1x, c2x, bx, t);
    const my = bezPoint(ay, c1y, c2y, by, t);
    if (info.cost != null && info.cost !== '') {
      edgesLayer().appendChild(el('text', {
        class: 'edge-cost',
        x: mx, y: my - 6,
        'text-anchor': 'middle',
      }, `c·${info.cost}`));
    }
    if (info.ifname) {
      // ifname placed near "a" side
      const tn = 0.18;
      const ix = bezPoint(ax, c1x, c2x, bx, tn);
      const iy = bezPoint(ay, c1y, c2y, by, tn);
      edgesLayer().appendChild(el('text', {
        class: 'edge-iface',
        x: ix, y: iy - 5,
        'text-anchor': 'middle',
      }, info.ifname));
    }
  }
}
export function bezPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3;
}
export function clipToRect(cx, cy, w, h, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const tw = (w / 2) / Math.max(0.0001, Math.abs(dx));
  const th = (h / 2) / Math.max(0.0001, Math.abs(dy));
  const t = Math.min(tw, th);
  return [cx + dx * t, cy + dy * t];
}

// Compute where an edge from `device` should terminate on `rail`.
// Horizontal rail: clamp tap-x to the rail span (minus inset); tap-y = top/bottom edge.
// Vertical rail:   clamp tap-y to the rail span (minus inset); tap-x = left/right edge.
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

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function drawNode(kind, name, obj) {
  const isSel = state.selection && state.selection.kind === kind && state.selection.name === name;
  const pad = HIT_PAD[kind];

  // group is centered at obj.x, obj.y
  const g = el('g', {
    class: `node ${kind}${isSel ? ' selected' : ''}`,
    transform: `translate(${obj.x} ${obj.y})`,
    'data-kind': kind,
    'data-name': name,
  });

  if (kind === 'network') {
    drawNetworkRail(g, name, obj, pad, isSel);
  } else {
    const { w, h } = NODE[kind];
    // hit rect — invisible, covers the icon + label region
    g.appendChild(el('rect', {
      class: 'hit',
      x: -w / 2 - pad.x,
      y: -h / 2 - pad.top,
      width: w + pad.x * 2,
      height: h + pad.top + pad.bottom,
      rx: 10,
    }));
    // host / router: just the icon, then name, then sub
    const icoVB = kind === 'host' ? '0 0 28 30' : '0 0 32 30';
    const ico = el('svg', {
      class: 'icon',
      x: -w / 2, y: -h / 2,
      width: w, height: h,
      viewBox: icoVB,
      'pointer-events': 'none',
    });
    ico.innerHTML = `<use href="#ico-${kind}"/>`;
    g.appendChild(ico);

    // dashed selection ring around the icon
    g.appendChild(el('rect', {
      class: 'ring',
      x: -w / 2 - 6,
      y: -h / 2 - 6,
      width: w + 12,
      height: h + 12,
      rx: 8,
    }));

    // name below the icon
    g.appendChild(el('text', {
      class: 'name',
      x: 0, y: h / 2 + 16,
      'text-anchor': 'middle',
    }, name));

    // sub below the name
    let sub;
    if (kind === 'host') sub = obj.address || '— unset';
    else {
      const c = Object.keys(obj.interfaces || {}).length;
      sub = `${c} iface${c === 1 ? '' : 's'}`;
    }
    g.appendChild(el('text', {
      class: `sub ${kind === 'host' && !obj.address ? 'empty' : ''}`,
      x: 0, y: h / 2 + 30,
      'text-anchor': 'middle',
    }, sub));
  }

  attachNodeEvents(g, kind, name);
  nodesLayer().appendChild(g);
}

/* ---------- LAN rail rendering ---------- */

// Collect every host/router that's attached to this LAN.
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

// Build the "name · cidr" label below the rail's main-axis bottom end.
function buildRailLabel(name, obj, baselineY) {
  const text = el('text', {
    class: 'rail-label',
    x: 0, y: baselineY,
    'text-anchor': 'middle',
  });
  text.appendChild(el('tspan', { class: 'name' }, name));
  text.appendChild(el('tspan', { class: 'sep' }, ' · '));
  if (obj.cidr) {
    text.appendChild(el('tspan', { class: 'cidr' }, obj.cidr));
  } else {
    text.appendChild(el('tspan', { class: 'cidr empty' }, '— no cidr'));
  }
  return text;
}

// Return the actual rendered (width, height) of a LAN rail given its state.
// The "main" axis carries length `w`; the "cross" axis carries thickness.
export function railRenderSize(obj) {
  const railLen = obj.w ?? RAIL_DEFAULT_WIDTH;
  const railThk = RAIL_THICKNESS;
  const vertical = (obj.orientation ?? 'h') === 'v';
  return vertical
    ? { width: railThk, height: railLen, vertical: true, len: railLen, thk: railThk }
    : { width: railLen, height: railThk, vertical: false, len: railLen, thk: railThk };
}

function drawNetworkRail(g, name, obj, pad, isSel) {
  const { width: renderW, height: renderH, vertical, len, thk } = railRenderSize(obj);

  // hit rect — wraps rail bounding box + label area below
  g.appendChild(el('rect', {
    class: 'hit',
    x: -renderW / 2 - pad.x,
    y: -renderH / 2 - pad.top,
    width: renderW + pad.x * 2,
    height: renderH + pad.top + pad.bottom,
    rx: 10,
  }));

  // rail bar
  g.appendChild(el('rect', {
    class: 'rail',
    x: vertical ? -thk / 2 : -len / 2,
    y: vertical ? -len / 2 : -thk / 2,
    width: vertical ? thk : len,
    height: vertical ? len : thk,
    rx: thk / 2,
  }));

  // endcaps — also act as resize handles. data-handle is always present so the
  // SVG doesn't need a re-render on selection (which would break pointer-down);
  // the resize handler gates on the parent .selected class instead.
  const capMain = RAIL_ENDCAP_LEN;
  const capCross = 3;
  for (const sign of [-1, 1]) {
    const capAttrs = vertical
      ? { x: -capMain / 2, y: sign * len / 2 - capCross / 2, width: capMain, height: capCross }
      : { x: sign * len / 2 - capCross / 2, y: -capMain / 2, width: capCross, height: capMain };
    g.appendChild(el('rect', {
      class: 'endcap',
      rx: 1,
      ...capAttrs,
      'data-handle': 'true',
      'data-axis': vertical ? 'v' : 'h',
      'data-end': sign === -1 ? (vertical ? 'top' : 'left') : (vertical ? 'bottom' : 'right'),
    }));
  }

  // tap ticks — one per attached device
  const devices = collectAttachedDevices(name);
  for (const dev of devices) {
    const relMain = (vertical ? dev.y : dev.x) - (vertical ? obj.y : obj.x);
    const tapMain = clamp(relMain, -len / 2 + RAIL_TICK_INSET, len / 2 - RAIL_TICK_INSET);
    const onNegSide = (vertical ? dev.x : dev.y) < (vertical ? obj.x : obj.y);
    // tick lives inside the rail, perpendicular to the main axis
    const tickAttrs = vertical
      ? {
          x: onNegSide ? -thk / 2 : thk / 2 - RAIL_TICK_LEN,
          y: tapMain - 1,
          width: RAIL_TICK_LEN, height: 2,
        }
      : {
          x: tapMain - 1,
          y: onNegSide ? -thk / 2 : thk / 2 - RAIL_TICK_LEN,
          width: 2, height: RAIL_TICK_LEN,
        };
    g.appendChild(el('rect', {
      class: 'tick',
      'data-device-kind': dev.kind,
      'data-device-name': dev.name,
      rx: 1,
      ...tickAttrs,
    }));
  }

  // label below the rail's bottom-most point (works for both orientations)
  const baselineY = (vertical ? len / 2 : thk / 2) + RAIL_LABEL_GAP;
  g.appendChild(buildRailLabel(name, obj, baselineY));

  // rotate button — CSS-revealed on hover / when LAN is selected
  g.appendChild(buildRotateButton(obj, vertical, len, thk));
}

function buildRotateButton(obj, vertical, len, thk) {
  // Sit at the far end of the main axis, just outside the cross-axis edge.
  const pos = vertical
    ? { x: thk / 2 + 18, y: -len / 2 + 9 }   // right of top end
    : { x: len / 2 - 9,  y: -thk / 2 - 18 }; // above right end
  const btn = el('g', {
    class: 'rotate-btn',
    transform: `translate(${pos.x} ${pos.y})`,
    'data-rotate-btn': 'true',
  });
  btn.appendChild(el('circle', { r: 9, cx: 0, cy: 0, class: 'bg' }));
  // small curved-arrow rotate glyph, ~12px viewBox centered on (0,0)
  btn.appendChild(el('path', {
    class: 'ico',
    d: 'M 4 -2 A 4 4 0 1 1 -4 -2 L -5.5 -3 M -4 -2 L -2.5 -2',
    fill: 'none',
  }));
  btn.appendChild(el('title', {},
    (obj.orientation ?? 'h') === 'v' ? 'Rotate to horizontal' : 'Rotate to vertical'));
  return btn;
}

// Flip a LAN between horizontal and vertical orientation. Shared by the
// hover rotate button (canvas) and the inspector "Rotate" button.
export function toggleNetworkOrientation(name) {
  const net = state.networks[name];
  if (!net) return;
  net.orientation = (net.orientation ?? 'h') === 'h' ? 'v' : 'h';
  markDirty();
  bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}

// Drag a rail endcap to resize the LAN. Grows symmetrically from the center,
// so the LAN stays anchored on its (x, y) coordinate.
function startRailResize(e, name, handle) {
  const net = state.networks[name];
  if (!net) return;
  const vertical = (net.orientation ?? 'h') === 'v';
  const end = handle.getAttribute('data-end'); // left/right/top/bottom
  const dirOut = (end === 'right' || end === 'bottom') ? 1 : -1;
  const startW = net.w ?? RAIL_DEFAULT_WIDTH;
  const startMain = vertical ? e.clientY : e.clientX;
  // Re-derive the world-space scale once: the SVG viewBox is 1:1 with the
  // view scale `state.view.k`, so 1 client px = 1/k world px.
  const k = state.view.k || 1;

  const onMove = (ev) => {
    const cur = vertical ? ev.clientY : ev.clientX;
    const deltaWorld = ((cur - startMain) / k) * dirOut;
    // factor 2: the rail grows symmetrically from its center
    const newW = clamp(startW + 2 * deltaWorld, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH);
    net.w = newW;
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
}


/* ---------- interaction ---------- */
let drag = null;          // active drag state
let pan  = null;          // active pan state
let rclickTimer = null;

export function attachNodeEvents(g, kind, name) {
  g.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return; // right-click handled separately

    // Rotate button — has its own handler, never bubbles. Always available
    // when visible (hover / selected) and not locked.
    const rot = e.target.closest('[data-rotate-btn="true"]');
    if (rot && kind === 'network' && !isTopologyLocked()) {
      e.stopPropagation();
      toggleNetworkOrientation(name);
      return;
    }

    // Resize-net: pointerdown on a handle endcap of an already-selected LAN.
    // Gating on .selected (not on a re-render) is what lets us keep the
    // "no canvas rebuild on selection-change" invariant intact.
    const handle = e.target.closest('rect.endcap[data-handle="true"]');
    if (handle && kind === 'network' && g.classList.contains('selected') && !isTopologyLocked()) {
      e.stopPropagation();
      startRailResize(e, name, handle);
      return;
    }

    e.stopPropagation();

    // Selection works in any sim state — users need to inspect nodes while running.
    state.selection = { kind, name };
    nodesLayer().querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'));
    g.classList.add('selected');
    bus.dispatchEvent(new CustomEvent('state:selection-changed'));

    // Drag is gated: only when topology is editable (idle or paused).
    if (isTopologyLocked()) return;

    // capture on the node itself so the synthesized click event stays on the
    // node — capturing on the canvas redirects click to the SVG, which would
    // otherwise trigger the "click background to deselect" handler.
    g.setPointerCapture?.(e.pointerId);
    const obj = ({network: state.networks, host: state.hosts, router: state.routers})[kind][name];
    const start = clientToWorld(e.clientX, e.clientY);
    drag = {
      pointerId: e.pointerId,
      kind, name, obj,
      offX: start.x - obj.x,
      offY: start.y - obj.y,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      hoverNet: null,
    };
    g.classList.add('dragging');
  });

  g.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (kind === 'host' || kind === 'router') {
      e.preventDefault();
      bus.dispatchEvent(new CustomEvent('canvas:terminal-requested', { detail: { name } }));
      return;
    }
    state.selection = { kind, name };
    bus.dispatchEvent(new CustomEvent('state:selection-changed'));
    const insp = document.getElementById('inspector');
    insp.classList.remove('flash');
    void insp.offsetWidth;
    insp.classList.add('flash');
    setTimeout(() => insp.classList.remove('flash'), 600);
    const f = insp.querySelector('input, select');
    if (f) f.focus();
  });

  g.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    state.selection = { kind, name };
    bus.dispatchEvent(new CustomEvent('state:selection-changed'));
    bus.dispatchEvent(new CustomEvent('canvas:contextmenu-requested', {
      detail: { clientX: e.clientX, clientY: e.clientY, target: { kind, name } },
    }));
  });
}

/* canvas-level drag/pan handlers (delegate via the svg) */
export function wireCanvas() {
  const svg = canvasEl();

  // pointerdown on background → pan, dismiss any ctxmenu
  svg.addEventListener('pointerdown', (e) => {
    bus.dispatchEvent(new CustomEvent('canvas:contextmenu-close-requested'));
    if (e.target.closest('.node')) return;
    if (e.button === 2) return; // right click handled by contextmenu listener
    pan = {
      pointerId: e.pointerId,
      sx: e.clientX, sy: e.clientY,
      ox: state.view.x, oy: state.view.y,
    };
    svg.classList.add('panning');
    svg.setPointerCapture?.(e.pointerId);
  });

  svg.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.node')) return;  // node menus handled at node level
    e.preventDefault();
    const w = clientToWorld(e.clientX, e.clientY);
    bus.dispatchEvent(new CustomEvent('canvas:contextmenu-requested', {
      detail: { clientX: e.clientX, clientY: e.clientY, target: null, world: w },
    }));
  });

  // pointermove — drag or pan
  document.addEventListener('pointermove', (e) => {
    if (drag) {
      // ignore tiny jitter so a click isn't mis-classified as a drag
      if (!drag.moved) {
        const dxc = e.clientX - drag.startClientX;
        const dyc = e.clientY - drag.startClientY;
        if (dxc * dxc + dyc * dyc < 16) return;  // 4px threshold
        drag.moved = true;
      }
      const w = clientToWorld(e.clientX, e.clientY);
      drag.obj.x = w.x - drag.offX;
      drag.obj.y = w.y - drag.offY;

      // for host/router: detect drop target (LAN under cursor)
      let hover = null;
      if (drag.kind === 'host' || drag.kind === 'router') {
        for (const [nn, nv] of Object.entries(state.networks)) {
          const { width: nw, height: nh } = railRenderSize(nv);
          if (Math.abs(w.x - nv.x) < nw/2 + 24 && Math.abs(w.y - nv.y) < nh/2 + 24) {
            hover = nn; break;
          }
        }
      }
      if (drag.hoverNet !== hover) {
        // re-render to flip drop-target class — cheap enough
        drag.hoverNet = hover;
        // toggle classes directly to avoid full re-render thrash
        nodesLayer().querySelectorAll('.node.network').forEach(node => {
          node.classList.toggle('drop-target', node.getAttribute('data-name') === hover);
        });
      }
      // partial: re-render edges connected to drag.obj
      reRenderEdges();
      // and update the dragged node's transform directly — the group is
      // centered at obj.x/obj.y (its inner contents are placed around 0,0),
      // so the transform is just translate(obj.x, obj.y), not offset by w/2.
      const nodeEl = nodesLayer().querySelector(`.node[data-kind="${drag.kind}"][data-name="${cssEscape(drag.name)}"]`);
      if (nodeEl) {
        nodeEl.setAttribute('transform', `translate(${drag.obj.x} ${drag.obj.y})`);
      }
      // preview link line for host/router → hovered LAN
      drawDragPreview();
    }
    if (pan) {
      state.view.x = pan.ox + (e.clientX - pan.sx);
      state.view.y = pan.oy + (e.clientY - pan.sy);
      bus.dispatchEvent(new CustomEvent('view:changed'));
    }
  });

  document.addEventListener('pointerup', (e) => {
    if (drag) {
      const node = nodesLayer().querySelector(`.node[data-kind="${drag.kind}"][data-name="${cssEscape(drag.name)}"]`);
      node?.classList.remove('dragging');

      if (drag.moved) {
        const target = drag.hoverNet;
        nodesLayer().querySelectorAll('.node.network.drop-target').forEach(n => n.classList.remove('drop-target'));
        overlayLay().innerHTML = '';

        // commit attachment
        if (target) {
          if (drag.kind === 'host') {
            if (state.hosts[drag.name].network !== target) {
              state.hosts[drag.name].network = target;
              toast(`Pinned host ${drag.name} → ${target}`, 'ok');
            }
          } else if (drag.kind === 'router') {
            const r = state.routers[drag.name];
            const has = Object.values(r.interfaces || {}).some(iff => iff.network === target);
            if (!has) {
              const newIf = uniqueIface(r.interfaces);
              r.interfaces[newIf] = { network: target, address: '', cost: 10 };
              toast(`Added ${newIf} on ${drag.name} → ${target}`, 'ok');
            }
          }
        }

        markDirty();
        bus.dispatchEvent(new CustomEvent('state:topology-changed'));
      }
      drag = null;
    }
    if (pan) {
      canvasEl().classList.remove('panning');
      pan = null;
      markDirty();
    }
  });

  // Tap-tick hover affordance — when a host/router is hovered, brighten its
  // matching ticks on every LAN. Listener lives on the layer (not the nodes)
  // so we wire it once here, not per-node on each render.
  nodesLayer().addEventListener('mouseover', (e) => {
    const node = e.target.closest('g.node[data-kind="host"], g.node[data-kind="router"]');
    if (!node) return;
    const dn = node.getAttribute('data-name');
    const dk = node.getAttribute('data-kind');
    nodesLayer().querySelectorAll(
      `g.node.network .tick[data-device-kind="${dk}"][data-device-name="${cssEscape(dn)}"]`,
    ).forEach(t => t.classList.add('matched-hover'));
  });
  nodesLayer().addEventListener('mouseout', (e) => {
    const node = e.target.closest('g.node[data-kind="host"], g.node[data-kind="router"]');
    if (!node) return;
    nodesLayer().querySelectorAll('.tick.matched-hover').forEach(t => t.classList.remove('matched-hover'));
  });

  // wheel zoom
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const w = clientToWorld(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.10 : (1 / 1.10);
    const newK = Math.max(0.25, Math.min(2.5, state.view.k * factor));
    // keep cursor world position fixed
    const rect = svg.getBoundingClientRect();
    state.view.x = (e.clientX - rect.left) - w.x * newK;
    state.view.y = (e.clientY - rect.top)  - w.y * newK;
    state.view.k = newK;
    bus.dispatchEvent(new CustomEvent('view:changed'));
  }, { passive: false });

  // dismiss menu on background click
  svg.addEventListener('click', (e) => {
    if (e.target.closest('.node')) return;
    state.selection = null;
    bus.dispatchEvent(new CustomEvent('state:selection-changed'));
  });
}

/* re-render only the edges (drag perf) */
export function reRenderEdges() {
  edgesLayer().innerHTML = '';
  for (const [hn, h] of Object.entries(state.hosts)) {
    if (!h.network || !state.networks[h.network]) continue;
    drawEdge(h, state.networks[h.network], 'host', { kind:'host', name: hn });
  }
  for (const [rn, r] of Object.entries(state.routers)) {
    for (const [ifn, iff] of Object.entries(r.interfaces || {})) {
      if (!iff.network || !state.networks[iff.network]) continue;
      drawEdge(r, state.networks[iff.network], 'router',
        { kind:'router', name: rn }, { ifname: ifn, cost: iff.cost });
    }
  }
}

export function drawDragPreview() {
  overlayLay().innerHTML = '';
  if (!drag || !drag.hoverNet) return;
  if (drag.kind !== 'host' && drag.kind !== 'router') return;
  const a = drag.obj;
  const b = state.networks[drag.hoverNet];
  if (!b) return;
  const aSize = NODE[drag.kind];
  const [ax, ay] = clipToRect(a.x, a.y, aSize.w, aSize.h, b.x, b.y);
  const [bx, by] = tapPointOnRail(a, b);
  const dx = bx - ax;
  const c1x = ax + dx * 0.55, c1y = ay;
  const c2x = bx - dx * 0.55, c2y = by;
  const d = `M ${ax} ${ay} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${bx} ${by}`;
  overlayLay().appendChild(el('path', { class: 'edge preview', d }));
}

/* ---------- bus listeners ---------- */
// renderCanvas rebuilds the entire SVG. Wiring it to state:selection-changed
// was a refactor bug: pointerdown synchronously dispatches that event, and a
// full rebuild detaches the <g> the handler is still operating on. The next
// line — `g.setPointerCapture(...)` — then throws InvalidStateError on a
// disconnected element (W3C Pointer Events §7), aborting the handler before
// `drag` is initialised. Same mechanism breaks dblclick synthesis: the second
// click lands on a different DOM node from the first. Selection changes only
// need a class toggle, not a rebuild.
function renderSelection() {
  nodesLayer().querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'));
  const sel = state.selection;
  if (!sel) return;
  const node = nodesLayer().querySelector(`.node[data-kind="${sel.kind}"][data-name="${cssEscape(sel.name)}"]`);
  if (node) node.classList.add('selected');
}

bus.addEventListener('state:topology-changed', renderCanvas);
bus.addEventListener('state:selection-changed', renderSelection);
bus.addEventListener('view:changed', applyView);
bus.addEventListener('state:topology-loaded', fitView);
