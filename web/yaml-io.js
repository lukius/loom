// web/yaml-io.js
//
// YAML import/export for the loom topology SPA.
// Extracted from app.js so these functions can be tested in isolation via vitest.
// app.js imports and calls these; canvas.js is NOT imported here (no DOM dependency
// beyond the state object and js-yaml).

import { state, persist } from './state.js';
import { toast } from './utils.js';

// In the browser jsyaml is loaded via CDN as a global. In the test environment
// (vitest / Node) we import it from the npm package instead.
// The global check lets the module work in both contexts without separate bundles.
import * as _jsyamlModule from 'js-yaml';
const jsyaml = (typeof globalThis.jsyaml !== 'undefined') ? globalThis.jsyaml : _jsyamlModule;

/* ---------- ensureLinkPositions ------------------------------------------
   Assigns default x,y coords to any link in state.links that lacks them.
   Strategy: use the midpoint of the two endpoint device positions; fall back
   to a fixed grid position if the endpoints don't have coords yet.
   Endpoint devices are routers + hosts whose interface has iff.link === name.
   -------------------------------------------------------------------------- */
function ensureLinkPositions() {
  const FALLBACK_X = 600, FALLBACK_Y = 400;
  for (const [name, lv] of Object.entries(state.links)) {
    if (typeof lv.x === 'number' && typeof lv.y === 'number') continue;

    // Collect devices (routers and hosts) whose interface references this link.
    const positions = [];
    for (const r of Object.values(state.routers)) {
      for (const iff of Object.values(r.interfaces || {})) {
        if (iff.link === name && typeof r.x === 'number' && typeof r.y === 'number') {
          positions.push({ x: r.x, y: r.y });
        }
      }
    }
    for (const h of Object.values(state.hosts)) {
      if (h.link === name && typeof h.x === 'number' && typeof h.y === 'number') {
        positions.push({ x: h.x, y: h.y });
      }
    }

    if (positions.length >= 2) {
      lv.x = positions.reduce((s, p) => s + p.x, 0) / positions.length;
      lv.y = positions.reduce((s, p) => s + p.y, 0) / positions.length;
    } else {
      lv.x = FALLBACK_X;
      lv.y = FALLBACK_Y;
    }
  }
}

/* ---------- exportYaml ---------------------------------------------------
   Serialises state into a YAML string that the Python parser accepts.
   Links: emitted as a top-level `links:` block when state.links is non-empty.
   Interfaces: emit `link: <name>` if iff.link is set; otherwise `network: <name>`.
   -------------------------------------------------------------------------- */
export function exportYaml() {
  const asBlock = {
    name: state.asName || 'topology',
  };

  // networks block (only when non-empty)
  if (Object.keys(state.networks).length > 0) {
    asBlock.networks = Object.fromEntries(
      Object.entries(state.networks).map(([k, v]) => [k, v.cidr || ''])
    );
  } else {
    asBlock.networks = {};
  }

  // links block (only when non-empty)
  if (Object.keys(state.links).length > 0) {
    asBlock.links = Object.fromEntries(
      Object.entries(state.links).map(([k, v]) => [k, v.cidr || ''])
    );
  }

  asBlock.hosts = Object.fromEntries(Object.entries(state.hosts).map(([k, v]) => {
    let h;
    if (v.link) {
      h = { link: v.link, address: v.address || '' };
    } else {
      h = { network: v.network || '', address: v.address || '' };
    }
    if (v.gateway) h.gateway = v.gateway;
    return [k, h];
  }));

  asBlock.routers = Object.fromEntries(Object.entries(state.routers).map(([k, v]) => [k, {
    interfaces: Object.fromEntries(Object.entries(v.interfaces || {}).map(([ifn, iff]) => {
      let iface;
      if (iff.link) {
        iface = {
          link: iff.link,
          address: iff.address || '',
          cost: typeof iff.cost === 'number' ? iff.cost : (parseInt(iff.cost, 10) || 0),
        };
      } else {
        iface = {
          network: iff.network || '',
          address: iff.address || '',
          cost: typeof iff.cost === 'number' ? iff.cost : (parseInt(iff.cost, 10) || 0),
        };
      }
      return [ifn, iface];
    })),
  }]));

  const out = { as: asBlock };
  return jsyaml.dump(out, { quotingType: '"', forceQuotes: true, lineWidth: -1, indent: 2 });
}

/* ---------- importYaml ---------------------------------------------------
   Parses a YAML string and loads it into state.
   Links: reads top-level `links:` into state.links.
   Interfaces: if iff.link is present, stores { link, address, cost };
               otherwise stores { network, address, cost } as before.
   Hosts: if v.link is present, stores { link, address, ... }; otherwise
          stores { network, address, ... }.
   After populating state, calls ensureLinkPositions() and the canvas
   ensurePositions (imported via the fitView/renderAll path in app.js).
   -------------------------------------------------------------------------- */
export function importYaml(text, { ensurePositions, fitView, renderAll } = {}) {
  let parsed;
  try { parsed = jsyaml.load(text); } catch (e) {
    toast(e.message || 'Failed to parse YAML', 'error', 'Parse error'); return false;
  }
  if (!parsed || !parsed.as) { toast('YAML root must be "as:"', 'error', 'Parse error'); return false; }
  const node = parsed.as;
  state.asName = node.name || 'unnamed_as';
  state.networks = {}; state.hosts = {}; state.routers = {}; state.links = {};

  if (node.networks && typeof node.networks === 'object') {
    for (const [n, cidr] of Object.entries(node.networks)) {
      state.networks[n] = { cidr: typeof cidr === 'string' ? cidr : String(cidr || '') };
    }
  }

  if (node.links && typeof node.links === 'object') {
    for (const [n, cidr] of Object.entries(node.links)) {
      state.links[n] = { cidr: typeof cidr === 'string' ? cidr : String(cidr || '') };
    }
  }

  if (node.hosts && typeof node.hosts === 'object') {
    for (const [n, v] of Object.entries(node.hosts)) {
      if (v?.link) {
        const h = { link: v.link, address: v?.address || '' };
        if (v?.gateway) h.gateway = v.gateway;
        state.hosts[n] = h;
      } else {
        const h = { network: v?.network || '', address: v?.address || '' };
        if (v?.gateway) h.gateway = v.gateway;
        state.hosts[n] = h;
      }
    }
  }

  if (node.routers && typeof node.routers === 'object') {
    for (const [n, v] of Object.entries(node.routers)) {
      const ifaces = {};
      if (v && v.interfaces && typeof v.interfaces === 'object') {
        for (const [ifn, iff] of Object.entries(v.interfaces)) {
          if (iff?.link) {
            ifaces[ifn] = {
              link: iff.link,
              address: iff?.address || '',
              cost: typeof iff?.cost === 'number' ? iff.cost : parseInt(iff?.cost, 10) || 0,
            };
          } else {
            ifaces[ifn] = {
              network: iff?.network || '',
              address: iff?.address || '',
              cost: typeof iff?.cost === 'number' ? iff.cost : parseInt(iff?.cost, 10) || 0,
            };
          }
        }
      }
      state.routers[n] = { interfaces: ifaces };
    }
  }

  // Place default positions: device nodes first (via ensurePositions from canvas.js),
  // then link midpoints (local helper).
  if (ensurePositions) ensurePositions();
  ensureLinkPositions();

  state.selection = null;
  const projName = document.getElementById('proj-name');
  if (projName) projName.value = state.asName;
  if (fitView) fitView();
  persist();
  if (renderAll) renderAll();
  toast('Topology imported', 'ok');
  return true;
}
