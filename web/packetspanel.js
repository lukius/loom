// web/packetspanel.js
// Slide-out panel listing in-flight packets and the last 10 delivered.
// Wires the tb-packets toolbar button, mounts the panel under <body>,
// subscribes to packets:list-changed, and renders.
import { state, bus, markDirty } from './state.js';

export const PacketsPanel = {
  _wired: false,
  _panel: null,

  _reset() {
    this._wired = false;
    if (this._panel && this._panel.parentNode) this._panel.parentNode.removeChild(this._panel);
    this._panel = null;
  },

  wire() {
    if (this._wired) return;
    const btn = document.getElementById('tb-packets');
    if (!btn) return;
    btn.addEventListener('click', () => this.toggle());
    this._wired = true;
  },

  init() {
    if (state.ui && state.ui.packetsPanelOpen) this.open();
    this._syncButton();
  },

  toggle() {
    if (state.ui.packetsPanelOpen) this.close();
    else this.open();
  },

  open() {
    state.ui.packetsPanelOpen = true;
    if (!this._panel) {
      this._panel = document.createElement('aside');
      this._panel.id = 'packets-panel';
      this._panel.className = 'packets-panel';
      document.body.appendChild(this._panel);
    }
    this._panel.hidden = false;
    this.render();
    this._syncButton();
    markDirty();
  },

  close() {
    state.ui.packetsPanelOpen = false;
    if (this._panel) this._panel.hidden = true;
    this._syncButton();
    markDirty();
  },

  render() {
    if (!this._panel) return;
    // T10+ fill this in. Stub for now:
    this._panel.innerHTML = '<header class="packets-header">Packets (0)</header>';
  },

  _syncButton() {
    const btn = document.getElementById('tb-packets');
    if (btn) btn.classList.toggle('toggle-on', !!(state.ui && state.ui.packetsPanelOpen));
  },
};

bus.addEventListener('packets:list-changed', () => PacketsPanel.render());
