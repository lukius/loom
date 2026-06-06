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
  isDeviceHalted, isInterfaceDown,
} from './state.js';
import { el, escapeHtml, cssEscape, uniqueIface, uniqueName, toast, isPrivateCidr } from './utils.js';
import { isTopologyLocked } from './sim.js';

export function lookupDeviceNode(name) {
  if (!name) return null;
  return document.querySelector(`#nodes-layer g[data-name="${cssEscape(name)}"][data-kind="host"], #nodes-layer g[data-name="${cssEscape(name)}"][data-kind="router"]`);
}

export function lookupNetworkNode(name) {
  if (!name) return null;
  return document.querySelector(`#nodes-layer g[data-name="${cssEscape(name)}"][data-kind="network"]`);
}

export function lookupLinkMidpoint(name) {
  if (!name) return null;
  return document.querySelector(`#edges-layer g[data-kind="link"][data-name="${cssEscape(name)}"]`);
}

export function lookupLinkEdge(name) {
  if (!name) return null;
  return document.querySelector(`#edges-layer path.edge[data-kind="link"][data-name="${cssEscape(name)}"]`);
}

// The edge element for a router interface: for a p2p link it's the link
// edge path (data-name=fabricName); for a LAN it's the device→network path
// tagged with data-device/data-iface (set by Task 4).
export function lookupInterfaceEdge(device, iface, fabricName, isLink) {
  if (isLink) return lookupLinkEdge(fabricName);
  return document.querySelector(
    `#edges-layer path.edge[data-device="${cssEscape(device)}"][data-iface="${cssEscape(iface)}"]`,
  );
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

// Fabric-scoped variant of lookupAddressNode. Only considers devices that are
// actually attached to `fabricName` (a Network OR a Link). Necessary because
// private IPs are intentionally reusable across separate subnets: e.g. two
// LANs with 192.168.1.10 on each, or two /30 links both using 10.0.0.0/30.
// The global lookup would pick the first match in iteration order and the
// animation would land on the wrong device.
export function lookupAddressNodeOnFabric(address, fabricName) {
  if (!address || !fabricName) return null;
  for (const [hn, h] of Object.entries(state.hosts || {})) {
    if (h.address !== address) continue;
    if (h.network === fabricName || h.link === fabricName) return lookupDeviceNode(hn);
  }
  for (const [rn, r] of Object.entries(state.routers || {})) {
    for (const iff of Object.values(r.interfaces || {})) {
      if (iff.address !== address) continue;
      if (iff.network === fabricName || iff.link === fabricName) return lookupDeviceNode(rn);
    }
  }
  return null;
}

// Where a device's edge meets a LAN's rail — in world coordinates.
// Used by packet animation so packets travel along the visible wire instead
// of cutting straight through the LAN's centroid.
export function railTapPoint(deviceName, networkName) {
  const net = state.networks[networkName];
  if (!net) return null;
  const dev = state.hosts[deviceName] || state.routers[deviceName];
  if (!dev || dev.x == null || dev.y == null) return null;
  const [x, y] = tapPointOnRail({ x: dev.x, y: dev.y }, net);
  return { x, y };
}

// Resolve a packet endpoint (which may carry only `address`, only `device`,
// or both — the simulator emits address-only for dst hops) into the owning
// device's name. Used by packet animation to find the per-hop next-hop tap.
export function deviceNameForEndpoint(endpoint) {
  if (!endpoint) return null;
  if (endpoint.device) return endpoint.device;
  const address = endpoint.address;
  if (!address) return null;
  for (const [hn, h] of Object.entries(state.hosts || {})) {
    if (h.address === address) return hn;
  }
  for (const [rn, r] of Object.entries(state.routers || {})) {
    for (const ifn of Object.keys(r.interfaces || {})) {
      if (r.interfaces[ifn].address === address) return rn;
    }
  }
  return null;
}

// Fabric-scoped variant: resolve a packet endpoint to a device name, only
// considering devices attached to `fabricName`. Honours the principle that
// private IPs may legitimately be reused on separate subnets — see
// lookupAddressNodeOnFabric for the same scoping rationale.
export function deviceNameForEndpointOnFabric(endpoint, fabricName) {
  if (!endpoint) return null;
  if (endpoint.device) return endpoint.device;
  const address = endpoint.address;
  if (!address || !fabricName) return null;
  for (const [hn, h] of Object.entries(state.hosts || {})) {
    if (h.address !== address) continue;
    if (h.network === fabricName || h.link === fabricName) return hn;
  }
  for (const [rn, r] of Object.entries(state.routers || {})) {
    for (const iff of Object.values(r.interfaces || {})) {
      if (iff.address !== address) continue;
      if (iff.network === fabricName || iff.link === fabricName) return rn;
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

/* ---------- layout: assign defaults to objects without positions ----------
   Fresh import (no node has a position yet): run a force-directed (spring-
   electric) simulation so the graph spreads organically — every node repels
   every other, every edge pulls its endpoints toward a rest length. This
   gives a usable layout for non-trivial topologies (e.g. samples/mesh.yaml)
   that the previous two-column grid crowded into overlap.

   Any other case (user has dragged things around, partial topology edit):
   leave existing positions alone and fall back to the simple grid for the
   nodes that lack coordinates — re-running force-directed would jump the
   user's manual arrangement around. */
export function ensurePositions() {
  if (!_anyNodePositioned()) {
    _forceDirectedLayout();
    return;
  }
  _gridFallback();
}

function _anyNodePositioned() {
  for (const n of Object.values(state.networks || {}))
    if (typeof n.x === 'number' && typeof n.y === 'number') return true;
  for (const r of Object.values(state.routers || {}))
    if (typeof r.x === 'number' && typeof r.y === 'number') return true;
  for (const h of Object.values(state.hosts || {}))
    if (typeof h.x === 'number' && typeof h.y === 'number') return true;
  return false;
}

function _gridFallback() {
  const FALLBACK_X = 700, FALLBACK_Y = 200, GAP = 220;
  let i = 0;
  for (const [, nv] of Object.entries(state.networks)) {
    if (typeof nv.x !== 'number' || typeof nv.y !== 'number') {
      nv.x = FALLBACK_X; nv.y = FALLBACK_Y + i * GAP;
    }
    i++;
  }
  i = 0;
  for (const [, h] of Object.entries(state.hosts)) {
    if (typeof h.x !== 'number' || typeof h.y !== 'number') {
      const target = state.networks[h.network];
      if (target) { h.x = target.x - 230; h.y = target.y + (i % 2 === 0 ? -20 : 20); }
      else { h.x = 220; h.y = 180 + i * 110; }
    }
    i++;
  }
  i = 0;
  for (const [, r] of Object.entries(state.routers)) {
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

// Spring-electric layout. Tuned for the project's typical topology sizes
// (≲ 30 nodes); larger graphs may benefit from more iterations.
function _forceDirectedLayout() {
  const nodes = [];
  const idx = new Map();
  function add(key, ref) { idx.set(key, nodes.length); nodes.push({ ref, x: 0, y: 0, fx: 0, fy: 0 }); }
  // Sort keys for deterministic iteration order — same YAML → same layout.
  for (const n of Object.keys(state.networks).sort()) add(`net:${n}`, state.networks[n]);
  for (const n of Object.keys(state.routers).sort())  add(`rtr:${n}`, state.routers[n]);
  for (const n of Object.keys(state.hosts).sort())    add(`host:${n}`, state.hosts[n]);
  const N = nodes.length;
  if (N === 0) return;

  const edges = [];
  for (const [hn, h] of Object.entries(state.hosts)) {
    const hi = idx.get(`host:${hn}`);
    if (h.network && idx.has(`net:${h.network}`)) edges.push([hi, idx.get(`net:${h.network}`)]);
  }
  for (const [rn, r] of Object.entries(state.routers)) {
    const ri = idx.get(`rtr:${rn}`);
    for (const iff of Object.values(r.interfaces || {})) {
      if (iff.network && idx.has(`net:${iff.network}`)) edges.push([ri, idx.get(`net:${iff.network}`)]);
    }
  }
  // p2p links contribute direct endpoint↔endpoint edges (the link object
  // isn't a graph node — visually it's an edge between the two devices).
  for (const linkName of Object.keys(state.links || {})) {
    const endpoints = [];
    for (const [rn, r] of Object.entries(state.routers)) {
      for (const iff of Object.values(r.interfaces || {})) {
        if (iff.link === linkName) { endpoints.push(`rtr:${rn}`); break; }
      }
    }
    for (const [hn, h] of Object.entries(state.hosts)) {
      if (h.link === linkName) endpoints.push(`host:${hn}`);
    }
    for (let i = 0; i < endpoints.length; i++) {
      for (let j = i + 1; j < endpoints.length; j++) {
        edges.push([idx.get(endpoints[i]), idx.get(endpoints[j])]);
      }
    }
  }

  // Deterministic initial layout: nodes evenly around a circle whose radius
  // scales with N so dense graphs don't start at zero distance.
  const initRadius = Math.max(200, N * 55);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    nodes[i].x = initRadius * Math.cos(a);
    nodes[i].y = initRadius * Math.sin(a);
  }

  const ITERATIONS = 400;
  const REPULSION = 90000;     // inverse-square repulsion constant
  const SPRING_K = 0.05;       // spring stiffness
  const REST_LENGTH = 230;     // ideal edge length, px
  const MAX_STEP = 60;         // per-iteration displacement cap, px

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (const n of nodes) { n.fx = 0; n.fy = 0; }
    // Pairwise repulsion
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // Coincident: deterministic nudge based on index parity so the
          // simulation can split them apart instead of dividing by zero.
          dx = (i & 1) ? 0.5 : -0.5;
          dy = (j & 1) ? 0.5 : -0.5;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = REPULSION / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.fx += fx; a.fy += fy;
        b.fx -= fx; b.fy -= fy;
      }
    }
    // Spring attraction
    for (const [i, j] of edges) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const f = SPRING_K * (d - REST_LENGTH);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.fx += fx; a.fy += fy;
      b.fx -= fx; b.fy -= fy;
    }
    // Cooling: shrink the effective step over time so late iterations
    // settle nodes instead of overshooting.
    const cooling = 1 - iter / ITERATIONS;
    for (const n of nodes) {
      let dx = n.fx * cooling, dy = n.fy * cooling;
      const mag = Math.sqrt(dx * dx + dy * dy);
      if (mag > MAX_STEP) { dx = (dx / mag) * MAX_STEP; dy = (dy / mag) * MAX_STEP; }
      n.x += dx; n.y += dy;
    }
  }

  // Re-center on a canvas-friendly point (away from the origin) so the
  // initial fitView lands the graph somewhere visible.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  const offsetX = 700 - (minX + maxX) / 2;
  const offsetY = 400 - (minY + maxY) / 2;
  for (const n of nodes) {
    n.ref.x = Math.round(n.x + offsetX);
    n.ref.y = Math.round(n.y + offsetY);
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

  // p2p link edges (direct device↔device) + midpoint labels
  for (const [linkName, linkObj] of Object.entries(state.links || {})) {
    drawLinkEdge(linkName, linkObj);
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
  const ifDown = info?.ifname ? isInterfaceDown(sel.name, info.ifname) : false;
  const pathAttrs = {
    class: `edge ${kind}${isSel ? ' selected' : ''}${ifDown ? ' down' : ''}`,
    d,
    'data-device': sel.name,
  };
  if (info?.ifname) pathAttrs['data-iface'] = info.ifname;
  const path = el('path', pathAttrs);
  edgesLayer().appendChild(path);

  if (info) {
    const showCosts = state.display?.showCosts ?? true;
    const showIfaces = state.display?.showIfaces ?? true;
    // midpoint for label placement
    const t = 0.5;
    const mx = bezPoint(ax, c1x, c2x, bx, t);
    const my = bezPoint(ay, c1y, c2y, by, t);
    // Router interface edges can be administratively downed — draw the ✕ marker
    // (hidden unless down) so the live handler can toggle it in place.
    if (sel.kind === 'router' && info.ifname) {
      drawDownMarker(mx, my, ifDown, {
        'data-down-device': sel.name, 'data-down-iface': info.ifname,
      });
    }
    if (showCosts && info.cost != null && info.cost !== '') {
      edgesLayer().appendChild(el('text', {
        class: 'edge-cost',
        x: mx, y: my - 6,
        'text-anchor': 'middle',
      }, `c·${info.cost}`));
    }
    if (showIfaces && info.ifname) {
      // ifname placed near "a" side. Iface labels on the router side of a
      // private LAN get the same muted treatment as the LAN rail, so the
      // NAT boundary reads at a glance from either end of the wire.
      const tn = 0.18;
      const ix = bezPoint(ax, c1x, c2x, bx, tn);
      const iy = bezPoint(ay, c1y, c2y, by, tn);
      const isPrivIface = isPrivateCidr(b && b.cidr);
      edgesLayer().appendChild(el('text', {
        class: `edge-iface${isPrivIface ? ' private' : ''}`,
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

// Small ✕ glyph at an edge midpoint marking an admin-down link — the cue that
// (together with the gray, un-dashed stroke) distinguishes a down link from a
// normal dashed p2p edge. Drawn for every down-capable edge and shown/hidden
// via its own `.down` class, so the live sim:interface-state-changed handler can
// toggle it without recomputing geometry. `lookup` carries data-attrs matching
// the edge so that handler can find this marker again.
function drawDownMarker(mx, my, isDown, lookup) {
  edgesLayer().appendChild(el('text', {
    class: `down-x${isDown ? ' down' : ''}`,
    x: mx, y: my,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    ...lookup,
  }, '✕'));
}

// Per-link bow keyed off the link name. Parallel p2p links sharing an
// endpoint (e.g. two links from r_core in a vertical column) would otherwise
// render on top of each other and look like one wire. A small, deterministic
// perpendicular offset on the bezier control points fans them apart.
const _LINK_BOW_BINS = [0, 1, -1, 0.6, -0.6, 1.4, -1.4];
function _linkBowFactor(linkName) {
  if (!linkName) return 0;
  let h = 5381;
  for (let i = 0; i < linkName.length; i++) {
    h = ((h * 33) ^ linkName.charCodeAt(i)) | 0;
  }
  return _LINK_BOW_BINS[Math.abs(h) % _LINK_BOW_BINS.length];
}
export function linkBezier(linkName, p0, p3) {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular to the chord (rotate +90°: (dx,dy) → (-dy,dx)).
  const perpX = -dy / len;
  const perpY = dx / len;
  // Bow magnitude: a fraction of the chord, capped so short links don't
  // bulge and long links don't arc absurdly.
  const magnitude = _linkBowFactor(linkName) * Math.min(len * 0.10, 36);
  // Orientation sign canonicalizes the bow direction: when the caller flips
  // p0 and p3, both `perp` and this sign flip, so `perp * bow` stays the
  // same. Without it, drawLinkEdge (stable endpoint order) and the packet
  // animation (sender→receiver order) would render mirror-image arcs.
  const orientationSign = (dx > 0 || (dx === 0 && dy > 0)) ? 1 : -1;
  const bow = magnitude * orientationSign;
  // The bowless formula matches drawEdge's horizontal-tangent shape.
  return {
    p0, p3,
    c1: { x: p0.x + dx * 0.55 + perpX * bow, y: p0.y + perpY * bow },
    c2: { x: p3.x - dx * 0.55 + perpX * bow, y: p3.y + perpY * bow },
  };
}
export function clipToRect(cx, cy, w, h, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const tw = (w / 2) / Math.max(0.0001, Math.abs(dx));
  const th = (h / 2) / Math.max(0.0001, Math.abs(dy));
  const t = Math.min(tw, th);
  return [cx + dx * t, cy + dy * t];
}

/**
 * Collect all {device, deviceKind, iface, cost} endpoints referencing `linkName`.
 * Scans both routers (interfaces with link===linkName) and hosts (host.link===linkName).
 */
export function collectLinkEndpoints(linkName) {
  const out = [];
  for (const [hn, h] of Object.entries(state.hosts)) {
    if (h.link === linkName) {
      out.push({ device: hn, deviceKind: 'host', iface: null, cost: null, obj: h });
    }
  }
  for (const [rn, r] of Object.entries(state.routers)) {
    for (const [ifn, iff] of Object.entries(r.interfaces || {})) {
      if (iff.link === linkName) {
        out.push({ device: rn, deviceKind: 'router', iface: ifn, cost: iff.cost, obj: r });
      }
    }
  }
  return out;
}

/**
 * Shift the midpoint label of every p2p link that has `deviceName` as one of
 * its endpoints by half the supplied delta.
 *
 * Rationale: the geometric midpoint between two endpoints moves by half the
 * delta when one endpoint moves; applying that same half-delta to the label
 * preserves whatever offset the user previously set between the label and the
 * midpoint (including offset == 0, i.e. label exactly at the midpoint).
 */
export function shiftLinkLabelsForDeviceMove(deviceName, ddx, ddy) {
  if (ddx === 0 && ddy === 0) return;
  for (const [linkName, lv] of Object.entries(state.links)) {
    const endpoints = collectLinkEndpoints(linkName);
    if (!endpoints.some(ep => ep.device === deviceName)) continue;
    if (typeof lv.x === 'number') lv.x += ddx / 2;
    if (typeof lv.y === 'number') lv.y += ddy / 2;
  }
}

/**
 * Return true when either endpoint interface of a p2p link is down.
 * Delegates to collectLinkEndpoints so both drawLinkEdge and the
 * sim:interface-state-changed listener share one source of truth.
 */
function isLinkDown(linkName) {
  const endpoints = collectLinkEndpoints(linkName);
  const ep1 = endpoints[0];
  const ep2 = endpoints[1];
  return (
    (ep1?.iface ? isInterfaceDown(ep1.device, ep1.iface) : false) ||
    (ep2?.iface ? isInterfaceDown(ep2.device, ep2.iface) : false)
  );
}

/**
 * Draw a direct device↔device edge for a p2p link.
 * The midpoint label (name + CIDR) is positioned at linkObj.{x,y} and is
 * the primary selection/drag target. The edge path itself is also selectable.
 */
export function drawLinkEdge(linkName, linkObj) {
  const endpoints = collectLinkEndpoints(linkName);
  if (endpoints.length < 2) return; // need exactly two endpoints to draw

  const ep1 = endpoints[0];
  const ep2 = endpoints[1];

  const a = ep1.obj;
  const b = ep2.obj;

  const aSize = NODE[ep1.deviceKind];
  const bSize = NODE[ep2.deviceKind];

  // Clip each end to the device rect boundary
  const [ax, ay] = clipToRect(a.x, a.y, aSize.w, aSize.h, b.x, b.y);
  const [bx, by] = clipToRect(b.x, b.y, bSize.w, bSize.h, a.x, a.y);

  // Bowed bezier — each link gets a per-name perpendicular offset so
  // parallel links sharing an endpoint don't render on top of each other.
  const bz = linkBezier(linkName, { x: ax, y: ay }, { x: bx, y: by });
  const c1x = bz.c1.x, c1y = bz.c1.y;
  const c2x = bz.c2.x, c2y = bz.c2.y;
  const d = `M ${ax} ${ay} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${bx} ${by}`;

  // Edge highlights when the link itself is selected OR either of its
  // endpoint devices is selected — matches drawEdge's behavior for LAN
  // rails, so the user can see at a glance which links belong to the
  // host/router they clicked.
  const isSel = !!state.selection && (
    (state.selection.kind === 'link' && state.selection.name === linkName) ||
    (state.selection.kind === ep1.deviceKind && state.selection.name === ep1.device) ||
    (state.selection.kind === ep2.deviceKind && state.selection.name === ep2.device)
  );

  const linkDown = isLinkDown(linkName);
  const path = el('path', {
    class: `edge p2p${isSel ? ' selected' : ''}${linkDown ? ' down' : ''}`,
    d,
    'data-kind': 'link',
    'data-name': linkName,
    cursor: 'pointer',
  });
  // clicking the edge path selects the link
  path.addEventListener('click', (e) => {
    e.stopPropagation();
    state.selection = { kind: 'link', name: linkName };
    bus.dispatchEvent(new CustomEvent('state:selection-changed'));
  });

  // hover: add p2p-hovered class to both endpoint device groups (deferred lookup
  // so the nodes layer is guaranteed to exist even though edges are drawn first)
  const addP2pHover = () => {
    const g1 = lookupDeviceNode(ep1.device);
    const g2 = lookupDeviceNode(ep2.device);
    g1?.classList.add('p2p-hovered');
    g2?.classList.add('p2p-hovered');
    path.classList.add('p2p-hovered');
    lookupLinkMidpoint(linkName)?.classList.add('p2p-hovered');
  };
  const removeP2pHover = () => {
    const g1 = lookupDeviceNode(ep1.device);
    const g2 = lookupDeviceNode(ep2.device);
    g1?.classList.remove('p2p-hovered');
    g2?.classList.remove('p2p-hovered');
    path.classList.remove('p2p-hovered');
    lookupLinkMidpoint(linkName)?.classList.remove('p2p-hovered');
  };
  path.addEventListener('mouseenter', addP2pHover);
  path.addEventListener('mouseleave', removeP2pHover);

  edgesLayer().appendChild(path);

  // ✕ marker at the link midpoint, shown when the link is down.
  const mmx = bezPoint(ax, c1x, c2x, bx, 0.5);
  const mmy = bezPoint(ay, c1y, c2y, by, 0.5);
  drawDownMarker(mmx, mmy, linkDown, { 'data-down-link': linkName });

  // Per-endpoint iface/cost tags
  const showCosts  = state.display?.showCosts  ?? true;
  const showIfaces = state.display?.showIfaces ?? true;

  if (showIfaces && ep1.iface) {
    // near endpoint 1 (t≈0.12)
    const t1 = 0.12;
    const ix = bezPoint(ax, c1x, c2x, bx, t1);
    const iy = bezPoint(ay, c1y, c2y, by, t1);
    edgesLayer().appendChild(el('text', {
      class: 'edge-iface',
      x: ix, y: iy - 5,
      'text-anchor': 'middle',
    }, ep1.iface));
  }
  if (showIfaces && ep2.iface) {
    // near endpoint 2 (t≈0.88)
    const t2 = 0.88;
    const ix = bezPoint(ax, c1x, c2x, bx, t2);
    const iy = bezPoint(ay, c1y, c2y, by, t2);
    edgesLayer().appendChild(el('text', {
      class: 'edge-iface',
      x: ix, y: iy - 5,
      'text-anchor': 'middle',
    }, ep2.iface));
  }
  if (showCosts && ep1.cost != null && ep1.cost !== '') {
    const t1c = 0.25;
    const cx1 = bezPoint(ax, c1x, c2x, bx, t1c);
    const cy1 = bezPoint(ay, c1y, c2y, by, t1c);
    edgesLayer().appendChild(el('text', {
      class: 'edge-cost',
      x: cx1, y: cy1 - 6,
      'text-anchor': 'middle',
    }, `c·${ep1.cost}`));
  }
  if (showCosts && ep2.cost != null && ep2.cost !== '') {
    const t2c = 0.75;
    const cx2 = bezPoint(ax, c1x, c2x, bx, t2c);
    const cy2 = bezPoint(ay, c1y, c2y, by, t2c);
    edgesLayer().appendChild(el('text', {
      class: 'edge-cost',
      x: cx2, y: cy2 - 6,
      'text-anchor': 'middle',
    }, `c·${ep2.cost}`));
  }

  // Midpoint label group — the selection/drag target. Skip rendering entirely
  // when the iface-labels toggle is off: the per-end iface tags above are
  // already gated on the same flag, so a clean canvas hides ALL fabric-name
  // text consistently. Edge selection still works via the path itself.
  if (!showIfaces) return;

  // Fall back to geometric midpoint if no x,y stored yet (ensureLinkPositions
  // covers this at load time, but guard here for robustness)
  const mx = typeof linkObj.x === 'number' ? linkObj.x : (a.x + b.x) / 2;
  const my = typeof linkObj.y === 'number' ? linkObj.y : (a.y + b.y) / 2;

  const midG = el('g', {
    class: `link-label${isSel ? ' selected' : ''}`,
    transform: `translate(${mx} ${my})`,
    'data-kind': 'link',
    'data-name': linkName,
    cursor: 'grab',
  });

  // invisible hit rect for easier clicking
  midG.appendChild(el('rect', {
    class: 'hit',
    x: -40, y: -10,
    width: 80, height: 20,
    rx: 4,
  }));

  // name tspan
  const txt = el('text', {
    class: 'link-label-text',
    x: 0, y: 0,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
  });
  txt.appendChild(el('tspan', { class: 'name' }, linkName));
  txt.appendChild(el('tspan', { class: 'sep' }, '  '));
  txt.appendChild(el('tspan', { class: 'cidr' }, linkObj.cidr || '—'));
  midG.appendChild(txt);

  // wire click → select link
  midG.addEventListener('click', (e) => {
    e.stopPropagation();
    state.selection = { kind: 'link', name: linkName };
    bus.dispatchEvent(new CustomEvent('state:selection-changed'));
  });

  // drag: move the midpoint label (updates linkObj.{x,y})
  midG.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (isTopologyLocked()) return;
    // Dispatch selection first — this triggers reRenderEdges() which clears
    // edgesLayer and re-creates the midG element. setPointerCapture must be
    // called AFTER re-render so it targets the fresh (attached) element;
    // calling it on a detached node silently drops the capture.
    state.selection = { kind: 'link', name: linkName };
    bus.dispatchEvent(new CustomEvent('state:selection-changed'));
    // Re-query for the fresh midG after the re-render, then capture on it.
    lookupLinkMidpoint(linkName)?.setPointerCapture?.(e.pointerId);
    const start = clientToWorld(e.clientX, e.clientY);
    drag = {
      pointerId: e.pointerId,
      kind: 'link',
      name: linkName,
      obj: linkObj,
      offX: start.x - mx,
      offY: start.y - my,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      hoverNet: null,
    };
  });

  // hover: mirror p2p-hovered onto endpoint device groups (same as edge path above)
  midG.addEventListener('mouseenter', addP2pHover);
  midG.addEventListener('mouseleave', removeP2pHover);

  edgesLayer().appendChild(midG);
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
  // RFC1918 LANs get a `private` modifier so the rail + its labels can
  // render in a muted tone — a visual cue that the subnet sits behind NAT.
  const isPrivate = kind === 'network' && isPrivateCidr(obj.cidr);
  const isDown = kind !== 'network' && isDeviceHalted(name);

  // group is centered at obj.x, obj.y
  const g = el('g', {
    class: `node ${kind}${isPrivate ? ' private' : ''}${isSel ? ' selected' : ''}${isDown ? ' down' : ''}`,
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

    // sub below the name — host = address (always shown), router = "N ifaces"
    // (gated by the showIfaces display toggle).
    let sub = null;
    if (kind === 'host') {
      sub = obj.address || '— unset';
    } else if (state.display?.showIfaces ?? true) {
      const c = Object.keys(obj.interfaces || {}).length;
      sub = `${c} iface${c === 1 ? '' : 's'}`;
    }
    if (sub !== null) {
      g.appendChild(el('text', {
        class: `sub ${kind === 'host' && !obj.address ? 'empty' : ''}`,
        x: 0, y: h / 2 + 30,
        'text-anchor': 'middle',
      }, sub));
    }
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
  // Each endcap is wrapped in a <g> with a wide invisible hit-rect so the
  // 3px visible bar isn't the only grab target.
  const capMain = RAIL_ENDCAP_LEN;
  const capCross = 3;
  const hitMain = 18;   // generous click area along the cross axis
  const hitCross = 22;  // and a long stripe along the main axis end
  for (const sign of [-1, 1]) {
    const end = sign === -1 ? (vertical ? 'top' : 'left') : (vertical ? 'bottom' : 'right');
    const wrap = el('g', {
      class: 'endcap-wrap',
      'data-handle': 'true',
      'data-axis': vertical ? 'v' : 'h',
      'data-end': end,
    });
    // invisible click target — generous on both axes, centered on the endcap
    const hitAttrs = vertical
      ? { x: -hitMain / 2, y: sign * len / 2 - hitCross / 2, width: hitMain, height: hitCross }
      : { x: sign * len / 2 - hitCross / 2, y: -hitMain / 2, width: hitCross, height: hitMain };
    wrap.appendChild(el('rect', { class: 'endcap-hit', ...hitAttrs }));
    // visible endcap
    const capAttrs = vertical
      ? { x: -capMain / 2, y: sign * len / 2 - capCross / 2, width: capMain, height: capCross }
      : { x: sign * len / 2 - capCross / 2, y: -capMain / 2, width: capCross, height: capMain };
    wrap.appendChild(el('rect', { class: 'endcap', rx: 1, ...capAttrs }));
    g.appendChild(wrap);
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


/* ---------- p2p link wizard ---------- */

// Transient (never persisted) linking-mode state.
// Shape: { source: { kind, name } } or null.
let _wizard = null;

// Banner element injected into the DOM during linking mode.
let _wizardBanner = null;

/**
 * Enter linking mode: the user right-clicked on a device and chose
 * "New p2p link…". We record the source and enter a mode where the next
 * click on another host/router completes the link.
 */
export function startLinkWizard(source) {
  cancelLinkWizard(); // clear any prior wizard

  _wizard = { source };

  // Visual: add ring class to source device group
  const srcG = lookupDeviceNode(source.name);
  if (srcG) srcG.classList.add('link-wizard-source');

  // Banner
  _wizardBanner = document.createElement('div');
  _wizardBanner.className = 'link-wizard-banner';
  _wizardBanner.textContent = 'Pick the other endpoint of the new p2p link. Esc to cancel.';
  const dismiss = document.createElement('button');
  dismiss.className = 'link-wizard-banner-close';
  dismiss.textContent = '✕';
  dismiss.addEventListener('click', cancelLinkWizard);
  _wizardBanner.appendChild(dismiss);
  document.body.appendChild(_wizardBanner);
}

/**
 * Cancel linking mode — removes all transient state and visual feedback.
 * Safe to call when no wizard is active.
 */
export function cancelLinkWizard() {
  if (!_wizard) return;
  const srcG = lookupDeviceNode(_wizard.source.name);
  if (srcG) srcG.classList.remove('link-wizard-source');
  _wizard = null;
  if (_wizardBanner) { _wizardBanner.remove(); _wizardBanner = null; }
  // Remove dashed preview line
  const overlay = overlayLay();
  if (overlay) {
    const prev = overlay.querySelector('.wizard-preview');
    if (prev) prev.remove();
  }
}

/**
 * Complete the wizard: create a new p2p link between source and target.
 * Both `source` and `target` are `{ kind: 'host'|'router', name }`.
 */
export function finishLinkWizard(target) {
  if (!_wizard) return;
  const source = _wizard.source;
  cancelLinkWizard();

  // Lookup positions for midpoint calculation
  const srcObj = (source.kind === 'host' ? state.hosts : state.routers)[source.name];
  const tgtObj = (target.kind === 'host' ? state.hosts : state.routers)[target.name];
  const midX = srcObj && tgtObj ? (srcObj.x + tgtObj.x) / 2 : (srcObj?.x ?? 600);
  const midY = srcObj && tgtObj ? (srcObj.y + tgtObj.y) / 2 : (srcObj?.y ?? 400);

  const linkName = uniqueName('p2p', state.links);
  state.links[linkName] = { cidr: '', x: midX, y: midY };

  // Attach source
  if (source.kind === 'host') {
    state.hosts[source.name].link = linkName;
    delete state.hosts[source.name].network;
  } else {
    const r = state.routers[source.name];
    const ifn = uniqueIface(r.interfaces);
    r.interfaces[ifn] = { link: linkName, address: '', cost: 1 };
  }

  // Attach target
  if (target.kind === 'host') {
    state.hosts[target.name].link = linkName;
    delete state.hosts[target.name].network;
  } else {
    const r = state.routers[target.name];
    const ifn = uniqueIface(r.interfaces);
    r.interfaces[ifn] = { link: linkName, address: '', cost: 1 };
  }

  state.selection = { kind: 'link', name: linkName };
  markDirty();
  bus.dispatchEvent(new CustomEvent('state:topology-changed'));
  toast(`Created ${linkName} — set the link CIDR and endpoint IPs`, 'ok', 'new p2p link');
}

/**
 * Update the dashed "rubber-band" line from the source device's center to the
 * current cursor position (in world coordinates) while in linking mode.
 */
export function updateWizardPreview(worldX, worldY) {
  const overlay = overlayLay();
  if (!overlay) return;
  // Remove old preview
  const old = overlay.querySelector('.wizard-preview');
  if (old) old.remove();

  if (!_wizard) return;
  const srcObj = (_wizard.source.kind === 'host' ? state.hosts : state.routers)[_wizard.source.name];
  if (!srcObj) return;

  const line = el('line', {
    class: 'wizard-preview',
    x1: srcObj.x, y1: srcObj.y,
    x2: worldX, y2: worldY,
  });
  overlay.appendChild(line);
}

/** Return the current wizard state (for testing). */
export function getLinkWizard() { return _wizard; }

/* ---------- interaction ---------- */
let drag = null;          // active drag state
let pan  = null;          // active pan state
let rclickTimer = null;

export function attachNodeEvents(g, kind, name) {
  g.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return; // right-click handled separately

    // Linking wizard: if active, this click either finalizes or cancels.
    if (_wizard) {
      e.stopPropagation();
      if ((kind === 'host' || kind === 'router') && name !== _wizard.source.name) {
        finishLinkWizard({ kind, name });
      } else {
        // Clicking the source device or a non-device (network/link) → cancel
        cancelLinkWizard();
      }
      return;
    }

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
    const handle = e.target.closest('[data-handle="true"]');
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

  // pointerdown on background → pan, dismiss any ctxmenu; cancel wizard on bg click
  svg.addEventListener('pointerdown', (e) => {
    bus.dispatchEvent(new CustomEvent('canvas:contextmenu-close-requested'));
    if (e.target.closest('.node')) return;
    if (e.button === 2) return; // right click handled by contextmenu listener
    // Cancel wizard on background click (click handler also covers this, but
    // pointerdown fires first so we handle it here and avoid starting a pan).
    if (_wizard) { cancelLinkWizard(); return; }
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

  // pointermove — drag, pan, or wizard rubber-band
  document.addEventListener('pointermove', (e) => {
    if (_wizard) {
      const w = clientToWorld(e.clientX, e.clientY);
      updateWizardPreview(w.x, w.y);
      return;
    }
    if (drag) {
      // ignore tiny jitter so a click isn't mis-classified as a drag
      if (!drag.moved) {
        const dxc = e.clientX - drag.startClientX;
        const dyc = e.clientY - drag.startClientY;
        if (dxc * dxc + dyc * dyc < 16) return;  // 4px threshold
        drag.moved = true;
      }
      const w = clientToWorld(e.clientX, e.clientY);
      const newX = w.x - drag.offX;
      const newY = w.y - drag.offY;
      // Drag along the midpoint label of every p2p link that touches this
      // device.  See shiftLinkLabelsForDeviceMove for the math.
      if (drag.kind === 'host' || drag.kind === 'router') {
        shiftLinkLabelsForDeviceMove(drag.name, newX - drag.obj.x, newY - drag.obj.y);
      }
      drag.obj.x = newX;
      drag.obj.y = newY;

      if (drag.kind === 'link') {
        // p2p midpoint drag: reRenderEdges() clears and fully rebuilds edgesLayer
        // (including the midpoint group), so a direct setAttribute here would be
        // immediately discarded. Unlike node drag — where nodes live in a separate
        // layer that reRenderEdges does NOT touch — there is nothing to pre-update.
        reRenderEdges();
      } else {
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
    }
    if (pan) {
      state.view.x = pan.ox + (e.clientX - pan.sx);
      state.view.y = pan.oy + (e.clientY - pan.sy);
      bus.dispatchEvent(new CustomEvent('view:changed'));
    }
  });

  document.addEventListener('pointerup', (e) => {
    if (drag) {
      if (drag.kind === 'link') {
        // p2p midpoint drag cleanup — just persist the new position
        if (drag.moved) {
          markDirty();
          bus.dispatchEvent(new CustomEvent('state:topology-changed'));
        }
        drag = null;
      } else {
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

  // dismiss menu on background click; also cancel wizard on background click
  svg.addEventListener('click', (e) => {
    if (_wizard) {
      if (!e.target.closest('.node')) {
        cancelLinkWizard();
        return;
      }
    }
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
  for (const [linkName, linkObj] of Object.entries(state.links || {})) {
    drawLinkEdge(linkName, linkObj);
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
  if (sel) {
    const node = nodesLayer().querySelector(`.node[data-kind="${sel.kind}"][data-name="${cssEscape(sel.name)}"]`);
    if (node) node.classList.add('selected');
  }
  // Edges carry their own `.selected` class derived from state.selection, so
  // they must be rebuilt when selection changes — otherwise they stay tinted
  // until the next drag or topology mutation. Safe inside a node's pointerdown
  // handler: only the edges layer is rebuilt, the node <g> the handler
  // captured stays attached.
  reRenderEdges();
}

bus.addEventListener('state:topology-changed', renderCanvas);
bus.addEventListener('state:selection-changed', renderSelection);
bus.addEventListener('view:changed', applyView);
bus.addEventListener('state:topology-loaded', fitView);

bus.addEventListener('sim:device-state-changed', (e) => {
  const { device, up } = e.detail;
  lookupDeviceNode(device)?.classList.toggle('down', !up);
});

bus.addEventListener('sim:interface-state-changed', (e) => {
  const { device, iface, up } = e.detail;
  const r = state.routers[device];
  const iff = r && r.interfaces && r.interfaces[iface];
  if (!iff) return;
  const isLink = !!iff.link;
  const edge = lookupInterfaceEdge(device, iface, iff.link || iff.network, isLink);
  if (!edge) return;
  // For a p2p link the edge is shared by both endpoints: recompute down-state
  // from BOTH via isLinkDown so re-enabling one end while the peer is still
  // down leaves the edge gray. A LAN interface edge is down iff this iface is.
  const down = isLink ? isLinkDown(iff.link) : !up;
  edge.classList.toggle('down', down);
  // Keep the ✕ midpoint marker in sync with the edge.
  const marker = isLink
    ? document.querySelector(`#edges-layer .down-x[data-down-link="${CSS.escape(iff.link)}"]`)
    : document.querySelector(
        `#edges-layer .down-x[data-down-device="${CSS.escape(device)}"][data-down-iface="${CSS.escape(iface)}"]`);
  marker?.classList.toggle('down', down);
});

// Esc cancels the link wizard globally (not gated on wireCanvas being called)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _wizard) cancelLinkWizard();
});
