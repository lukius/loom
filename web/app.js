// web/app.js
//
// Entrypoint: imports (incl. exportYaml/importYaml from yaml-io.js), bus-bridge listeners,
// modal helper, wire (DOM event handlers), init (boot), DOMContentLoaded guard.

import { toast } from './utils.js';
import {
  state, bus, SAMPLE,
  persist, restore, markDirty, setSave,
  defaultExportFilename,
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
import { PacketsPanel } from './packetspanel.js';
import { importYaml as _importYaml, exportYaml } from './yaml-io.js';
import { openImportPicker, runExportSave, fetchSourceName } from './file-picker.js';

// Temporary bus wiring: bridges to module-local yaml exporter/importer. canvas.js,
// inspector.js, terminals.js, and packets.js own their own listeners.
bus.addEventListener('sim:yaml-export-requested', (e) => { e.detail.yaml = exportYaml(); });
bus.addEventListener('sim:topology-import-requested', (e) => { importYaml(e.detail.yaml); });

/* ===========================================================
   loom — interactive topology canvas
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
// exportYaml is imported from yaml-io.js above.
// importYaml wraps the yaml-io function, injecting canvas helpers that are
// unavailable in the yaml-io module (which has no DOM/canvas dependencies).
function importYaml(text) {
  return _importYaml(text, { ensurePositions, fitView, renderAll });
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
  const onImport = () => openImportPicker({
    onLoad: (text, sourceName) => {
      if (!importYaml(text)) return;
      state.sourceName = sourceName || null;
      persist();
    },
  });
  document.getElementById('btn-import').addEventListener('click', onImport);
  bus.addEventListener('ui:import-requested', onImport);
  document.getElementById('btn-export').addEventListener('click', () => {
    runExportSave({
      text: exportYaml(),
      defaultName: defaultExportFilename(state.sourceName),
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
  document.getElementById('empty-import').addEventListener('click', onImport);

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
  PacketsPanel.wire();
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
    state.links = JSON.parse(JSON.stringify(SAMPLE.links));
  }
  document.getElementById('proj-name').value = state.asName;
  setSave('autosaved');
  ensurePositions();
  // Seed Export's default filename from the server's LOOM_TOPOLOGY basename
  // when the user hasn't imported anything yet. Fire-and-forget — Export
  // works either way (it falls back to "topology.session.yaml").
  if (!state.sourceName) {
    fetchSourceName().then(name => {
      if (name && !state.sourceName) { state.sourceName = name; persist(); }
    });
  }
  wire();
  wireResizers();
  // reflect restored display toggles on the toolbar buttons
  syncToggleBtn('tb-toggle-costs',  state.display.showCosts);
  syncToggleBtn('tb-toggle-ifaces', state.display.showIfaces);
  PacketsPanel.init();
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
