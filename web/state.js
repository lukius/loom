/* ===========================================================
   loom — state, persistence, sample topology, and bus
   =========================================================== */
import { toast } from './utils.js';

export const STORAGE_KEY = 'loom.topology.v5';
export const THEME_KEY = 'loom.theme';

export const state = {
  asName: 'test_as',
  /* networks[name] = { cidr, x, y } */
  networks: {},
  /* hosts[name] = { network, address, x, y } OR { link, address, x, y }  — network and link are mutually exclusive */
  hosts: {},
  /* routers[name] = { interfaces: { ifn: { network, address, cost } OR { link, address, cost } }, x, y }
     — network and link on each interface are mutually exclusive; exactly one must be present */
  routers: {},
  /* links[name] = { cidr, x, y }  — x,y are the midpoint label's coords (draggable; used by canvas in Task 6) */
  links: {},
  selection: null,        // { kind, name }
  view: { x: 0, y: 0, k: 1 }, // pan x,y and zoom factor
  /* visibility toggles for on-canvas annotations (persisted) */
  display: { showCosts: true, showIfaces: true },
  /* transient sim state — NAT snapshots keyed by device name; populated by
     the `nat_table_changed` WS event. Not persisted; reset on loadSample. */
  natTables: {},
};

/* Defaults used when restoring a legacy session that didn't persist `display`. */
export const DISPLAY_DEFAULTS = { showCosts: true, showIfaces: true };

/* Cross-component event bus. State mutations + cross-component re-renders
   should flow through `bus`; synchronous queries and DOM helpers stay direct
   imports. */
export const bus = new EventTarget();

/* Rail (LAN bus) geometry — used by canvas.js when rendering networks.
   The rail's main-axis carries length `w` (stored per-network, optional, default RAIL_DEFAULT_WIDTH).
   The rail's cross-axis carries thickness `h` (constant RAIL_THICKNESS). */
export const RAIL_DEFAULT_WIDTH = 180;
export const RAIL_MIN_WIDTH = 100;
export const RAIL_MAX_WIDTH = 800;
export const RAIL_THICKNESS = 10;
export const RAIL_ENDCAP_LEN = 14;
export const RAIL_HANDLE_LEN = 18;
export const RAIL_TICK_INSET = 12;
export const RAIL_TICK_LEN = 4;
export const RAIL_LABEL_GAP = 18;

/* node sizes — w/h represent the icon (or rail) bounding box centered at obj.x/obj.y;
   labels render below this box and are included in a wider hit area at draw time.
   For network: width is the rail's main-axis size, height is the thickness.
   drawNode resolves the orientation-aware real (width, height) per network at render time. */
export const NODE = {
  network: { w: RAIL_DEFAULT_WIDTH, h: RAIL_THICKNESS },
  host:    { w: 56,  h: 60 },   // workstation icon
  router:  { w: 64,  h: 64 },   // router cube
};
export const HIT_PAD = { network: { x: 12, top: 12, bottom: 32 }, host: { x: 18, top: 6, bottom: 36 }, router: { x: 18, top: 6, bottom: 38 } };

export const SAMPLE = {
  asName: 'test_as',
  links: {
    p2p1: { cidr: '10.0.0.0/30', x: 920, y: 355 },
  },
  networks: {
    lan1: { cidr: '200.100.0.0/24', x: 460, y: 160 },
    lan2: { cidr: '100.200.0.0/24', x: 460, y: 360 },
    lan3: { cidr: '150.10.10.0/24', x: 460, y: 560 },
  },
  hosts: {
    h1: { network: 'lan1', address: '200.100.0.10', x: 230, y: 160 },
    h2: { network: 'lan2', address: '100.200.0.20', x: 230, y: 360 },
    h3: { network: 'lan3', address: '150.10.10.30', x: 230, y: 560 },
  },
  routers: {
    r1: { x: 720, y: 250, interfaces: {
      eth0: { network: 'lan1', address: '200.100.0.1',   cost: 10 },
      eth1: { network: 'lan2', address: '100.200.0.1',   cost: 15 },
      eth2: { link: 'p2p1',   address: '10.0.0.1',       cost: 5  },
    }},
    r2: { x: 820, y: 360, interfaces: {
      eth0: { network: 'lan1', address: '200.100.0.254', cost: 5 },
      eth1: { network: 'lan2', address: '100.200.0.2',   cost: 8 },
      eth2: { network: 'lan3', address: '150.10.10.1',   cost: 15 },
    }},
    r3: { x: 720, y: 460, interfaces: {
      eth0: { network: 'lan2', address: '100.200.0.10', cost: 20 },
      eth1: { network: 'lan3', address: '150.10.10.10', cost: 5 },
      eth2: { link: 'p2p1',   address: '10.0.0.2',      cost: 5  },
    }},
  },
};

/* ---------- layout (resizable panes) ---------- */
export const LAYOUT_KEY = 'loom.layout';
export const LAYOUT_DEF = { navW: 264, inspW: 332 };
export const LAYOUT_LIMITS = {
  navW:  { min: 200, max: 520 },
  inspW: { min: 240, max: 600 },
};

/* ---------- helpers ---------- */
export function setSave(s) { document.getElementById('save-state').lastChild.textContent = ' ' + s; }

/* ---------- persistence ---------- */
export function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      asName: state.asName,
      networks: state.networks,
      hosts: state.hosts,
      routers: state.routers,
      links: state.links,
      view: state.view,
      display: state.display,
    }));
    setSave('autosaved');
  } catch (_) {}
}
export function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    state.asName = d.asName || 'test_as';
    state.networks = d.networks || {};
    state.hosts = d.hosts || {};
    state.routers = d.routers || {};
    state.links = (d.links && typeof d.links === 'object' && !Array.isArray(d.links)) ? d.links : {};
    if (d.view) state.view = d.view;
    state.display = { ...DISPLAY_DEFAULTS, ...(d.display || {}) };
    return true;
  } catch (_) { return false; }
}
export function loadSample() {
  state.asName = SAMPLE.asName;
  state.networks = JSON.parse(JSON.stringify(SAMPLE.networks));
  state.hosts = JSON.parse(JSON.stringify(SAMPLE.hosts));
  state.routers = JSON.parse(JSON.stringify(SAMPLE.routers));
  state.links = JSON.parse(JSON.stringify(SAMPLE.links));
  state.selection = null;
  state.view = { x: 0, y: 0, k: 1 };
  state.display = { ...DISPLAY_DEFAULTS };
  state.natTables = {};
  const projName = document.getElementById('proj-name');
  if (projName) projName.value = state.asName;
  persist();
  bus.dispatchEvent(new CustomEvent('state:topology-changed'));
  bus.dispatchEvent(new CustomEvent('state:topology-loaded'));
  toast('Sample topology loaded', 'ok');
}

/* ---------- mark dirty ---------- */
export function markDirty() {
  setSave('saving…');
  clearTimeout(markDirty._t);
  markDirty._t = setTimeout(() => persist(), 200);
}
