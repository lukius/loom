// web/app.js
//
// Entrypoint: imports, bus-bridge listeners, exportYaml/importYaml, modal helper,
// wire (DOM event handlers), init (boot), DOMContentLoaded guard.

import { escapeHtml, toast } from './utils.js';
import {
  state, bus, SAMPLE,
  persist, restore, loadSample, markDirty, setSave,
} from './state.js';
import {
  Sim, RuntimeClient,
  setConnectionStatus,
  _onEvent,
} from './sim.js';
import {
  canvasEl,
  applyView, fitView,
  ensurePositions, wireCanvas,
  initTheme, applyTheme,
  loadLayout, wireResizers,
} from './canvas.js';
import {
  deleteSelected, addNew, worldCenter,
  closeContextMenu,
} from './inspector.js';
import './terminals.js';
import { PacketAnim } from './packets.js';

// Temporary bus wiring: bridges to module-local yaml exporter/importer. canvas.js,
// inspector.js, terminals.js, and packets.js own their own listeners.
bus.addEventListener('sim:yaml-export-requested', (e) => { e.detail.yaml = exportYaml(); });
bus.addEventListener('sim:topology-import-requested', (e) => { importYaml(e.detail.yaml); });

/* ===========================================================
   netrouting — interactive topology canvas
   =========================================================== */

document.getElementById('tb-play').addEventListener('click', () => Sim.onPrimary());
document.getElementById('tb-pause').addEventListener('click', () => Sim.onSecondary());
document.getElementById('tb-reset').addEventListener('click', () => Sim.onReset());
document.getElementById('tb-chatter').addEventListener('click', () => {
  PacketAnim.muted = !PacketAnim.muted;
  document.getElementById('tb-chatter').classList.toggle('chatter-muted', PacketAnim.muted);
});

function syncToggleBtn(id, on) {
  document.getElementById(id).classList.toggle('toggle-off', !on);
}
document.getElementById('tb-toggle-costs').addEventListener('click', () => {
  state.display.showCosts = !state.display.showCosts;
  syncToggleBtn('tb-toggle-costs', state.display.showCosts);
  markDirty();
  bus.dispatchEvent(new CustomEvent('state:topology-changed'));
});
document.getElementById('tb-toggle-ifaces').addEventListener('click', () => {
  state.display.showIfaces = !state.display.showIfaces;
  syncToggleBtn('tb-toggle-ifaces', state.display.showIfaces);
  markDirty();
  bus.dispatchEvent(new CustomEvent('state:topology-changed'));
});

(() => {
  const inp = document.getElementById('tb-refresh');
  if (!inp) return;
  let lastGood = parseInt(inp.value, 10) || 10;
  inp.addEventListener('change', async () => {
    const v = parseInt(inp.value, 10);
    if (!Number.isFinite(v) || v < 1 || v > 300) {
      toast(`Keepalive must be 1–300s`, 'error', 'Keepalive');
      inp.value = lastGood;
      return;
    }
    try {
      await RuntimeClient.setRefreshInterval(v);
      lastGood = v;
      toast(`Keepalive set to ${v}s`, 'info', 'Keepalive');
    } catch (err) {
      toast(`Failed: ${err.message}`, 'error', 'Keepalive');
      inp.value = lastGood;
    }
  });
})();

(() => {
  const inp = document.getElementById('tb-speed');
  if (!inp) return;
  // Initialize from the current PacketAnim duration so the input matches the live value.
  inp.value = PacketAnim.DURATION_MS;
  let lastGood = PacketAnim.DURATION_MS;
  inp.addEventListener('change', () => {
    const v = parseInt(inp.value, 10);
    if (!Number.isFinite(v) || v < 200 || v > 5000) {
      toast('Packet duration must be 200–5000ms', 'error', 'Packets');
      inp.value = lastGood;
      return;
    }
    PacketAnim.DURATION_MS = v;
    lastGood = v;
  });
})();

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); Sim.onPrimary(); }
  if (e.key === 'p' || e.key === 'P') { e.preventDefault(); Sim.onSecondary(); }
});

// On load: sync toolbar state from backend; failure is silent (offline mode)
Sim.refreshState().catch(() => setConnectionStatus(false));
RuntimeClient.connectEvents(_onEvent);

/* ---------- yaml ---------- */
function exportYaml() {
  const out = { as: {
    name: state.asName || 'topology',
    networks: Object.fromEntries(Object.entries(state.networks).map(([k, v]) => [k, v.cidr || ''])),
    hosts: Object.fromEntries(Object.entries(state.hosts).map(([k, v]) => {
      const h = { network: v.network || '', address: v.address || '' };
      if (v.gateway) h.gateway = v.gateway;
      return [k, h];
    })),
    routers: Object.fromEntries(Object.entries(state.routers).map(([k, v]) => [k, {
      interfaces: Object.fromEntries(Object.entries(v.interfaces || {}).map(([ifn, iff]) => [ifn, {
        network: iff.network || '',
        address: iff.address || '',
        cost: typeof iff.cost === 'number' ? iff.cost : (parseInt(iff.cost, 10) || 0),
      }])),
    }])),
  } };
  return jsyaml.dump(out, { quotingType: '"', forceQuotes: true, lineWidth: -1, indent: 2 });
}
function importYaml(text) {
  let parsed;
  try { parsed = jsyaml.load(text); } catch (e) {
    toast(e.message || 'Failed to parse YAML', 'error', 'Parse error'); return false;
  }
  if (!parsed || !parsed.as) { toast('YAML root must be "as:"', 'error', 'Parse error'); return false; }
  const node = parsed.as;
  state.asName = node.name || 'unnamed_as';
  state.networks = {}; state.hosts = {}; state.routers = {};
  if (node.networks && typeof node.networks === 'object') {
    for (const [n, cidr] of Object.entries(node.networks)) state.networks[n] = { cidr: typeof cidr === 'string' ? cidr : String(cidr || '') };
  }
  if (node.hosts && typeof node.hosts === 'object') {
    for (const [n, v] of Object.entries(node.hosts)) {
      const h = { network: v?.network || '', address: v?.address || '' };
      if (v?.gateway) h.gateway = v.gateway;
      state.hosts[n] = h;
    }
  }
  if (node.routers && typeof node.routers === 'object') {
    for (const [n, v] of Object.entries(node.routers)) {
      const ifaces = {};
      if (v && v.interfaces && typeof v.interfaces === 'object') {
        for (const [ifn, iff] of Object.entries(v.interfaces)) {
          ifaces[ifn] = {
            network: iff?.network || '', address: iff?.address || '',
            cost: typeof iff?.cost === 'number' ? iff.cost : parseInt(iff?.cost, 10) || 0,
          };
        }
      }
      state.routers[n] = { interfaces: ifaces };
    }
  }
  ensurePositions();
  state.selection = null;
  document.getElementById('proj-name').value = state.asName;
  fitView();
  persist(); renderAll();
  toast('Topology imported', 'ok');
  return true;
}

/* ---------- modal ---------- */
function openModal({ title, text, primary, onPrimary, readonly = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-bg';
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="ttl">${escapeHtml(title)}</div>
        <button class="x" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <textarea spellcheck="false" ${readonly ? 'readonly' : ''}>${escapeHtml(text || '')}</textarea>
      </div>
      <div class="modal-foot">
        <button class="btn outline cancel">Cancel</button>
        <button class="btn primary go">${escapeHtml(primary)}</button>
      </div>
    </div>
  `;
  const close = () => wrap.remove();
  wrap.querySelector('.x').addEventListener('click', close);
  wrap.querySelector('.cancel').addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('.go').addEventListener('click', () => {
    const v = wrap.querySelector('textarea').value;
    if (onPrimary(v) !== false) close();
  });
  document.body.appendChild(wrap);
  if (!readonly) wrap.querySelector('textarea').focus();
}

/* ---------- render coordinator ---------- */
function renderAll() {
  bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}

/* ---------- wire ---------- */
function wire() {
  document.querySelectorAll('[data-theme-btn]').forEach(b => {
    b.addEventListener('click', () => applyTheme(b.getAttribute('data-theme-btn')));
  });
  document.getElementById('btn-sample').addEventListener('click', loadSample);
  document.getElementById('btn-import').addEventListener('click', () => {
    openModal({
      title: 'Import YAML', text: '', primary: 'Parse & load',
      onPrimary: importYaml,
    });
  });
  document.getElementById('btn-export').addEventListener('click', () => {
    openModal({
      title: 'Export YAML', text: exportYaml(),
      primary: 'Copy to clipboard', readonly: true,
      onPrimary: (v) => {
        navigator.clipboard?.writeText(v).then(() => toast('YAML copied to clipboard', 'ok'));
        return false;
      },
    });
  });
  document.getElementById('proj-name').addEventListener('change', e => {
    state.asName = e.target.value.trim() || 'topology';
    markDirty();
  });

  document.getElementById('tb-add-net').addEventListener('click',     () => addNew('network'));
  document.getElementById('tb-add-host').addEventListener('click',    () => addNew('host'));
  document.getElementById('tb-add-router').addEventListener('click',  () => addNew('router'));
  document.getElementById('tb-fit').addEventListener('click', fitView);

  document.getElementById('zoom-in').addEventListener('click', () => {
    const c = worldCenter();
    const k = Math.min(2.5, state.view.k * 1.15);
    const rect = canvasEl().getBoundingClientRect();
    state.view.x = rect.width / 2 - c.x * k;
    state.view.y = rect.height / 2 - c.y * k;
    state.view.k = k; applyView();
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    const c = worldCenter();
    const k = Math.max(0.25, state.view.k / 1.15);
    const rect = canvasEl().getBoundingClientRect();
    state.view.x = rect.width / 2 - c.x * k;
    state.view.y = rect.height / 2 - c.y * k;
    state.view.k = k; applyView();
  });

  document.getElementById('empty-add-net').addEventListener('click', () => addNew('network'));
  document.getElementById('empty-sample').addEventListener('click', loadSample);

  document.addEventListener('keydown', (e) => {
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    if (e.key === 'Escape') { state.selection = null; closeContextMenu(); renderAll(); }
    if (e.key === 'Delete') { if (state.selection) { e.preventDefault(); deleteSelected(); } }
    // Single-letter shortcuts must not fire while a modifier is held — otherwise
    // Ctrl+R ("add router") swallows Chrome's reload, Cmd+H clashes with hide, etc.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); addNew('network'); }
    if (k === 'h') { e.preventDefault(); addNew('host'); }
    if (k === 'r') { e.preventDefault(); addNew('router'); }
    if (k === 'f') { e.preventDefault(); fitView(); }
  });

  wireCanvas();
}

/* ---------- init ---------- */
function init() {
  initTheme();
  loadLayout();
  if (!restore() ||
    (Object.keys(state.networks).length === 0 &&
     Object.keys(state.hosts).length === 0 &&
     Object.keys(state.routers).length === 0)) {
    state.asName = SAMPLE.asName;
    state.networks = JSON.parse(JSON.stringify(SAMPLE.networks));
    state.hosts = JSON.parse(JSON.stringify(SAMPLE.hosts));
    state.routers = JSON.parse(JSON.stringify(SAMPLE.routers));
  }
  document.getElementById('proj-name').value = state.asName;
  setSave('autosaved');
  ensurePositions();
  wire();
  wireResizers();
  // reflect restored display toggles on the toolbar buttons
  syncToggleBtn('tb-toggle-costs',  state.display.showCosts);
  syncToggleBtn('tb-toggle-ifaces', state.display.showIfaces);
  renderAll();
  // initial fit (after layout)
  requestAnimationFrame(() => {
    if (!state.view || (state.view.k === 1 && state.view.x === 0 && state.view.y === 0)) fitView();
    else applyView();
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
