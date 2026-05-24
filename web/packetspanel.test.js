import { describe, it, expect, beforeEach } from 'vitest';
import { state, bus, persist, restore, STORAGE_KEY } from './state.js';
import { PacketsPanel } from './packetspanel.js';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = `
    <div id="save-state"><span class="dot"></span> idle</div>
    <button id="tb-packets"><span class="lbl">Packets</span></button>
  `;
  state.ui = { packetsPanelOpen: false };
  PacketsPanel._reset();
});

describe('PacketsPanel — toolbar button toggle', () => {
  it('opens the panel and mounts it under <body> on first click', () => {
    PacketsPanel.wire();
    expect(document.getElementById('packets-panel')).toBeNull();
    document.getElementById('tb-packets').click();
    expect(document.getElementById('packets-panel')).not.toBeNull();
    expect(state.ui.packetsPanelOpen).toBe(true);
  });

  it('toggles closed on second click', () => {
    PacketsPanel.wire();
    document.getElementById('tb-packets').click();
    document.getElementById('tb-packets').click();
    expect(state.ui.packetsPanelOpen).toBe(false);
    const panel = document.getElementById('packets-panel');
    if (panel) expect(panel.hidden).toBe(true);
  });

  it('persists state.ui.packetsPanelOpen across persist/restore', () => {
    PacketsPanel.wire();
    document.getElementById('tb-packets').click();
    persist();
    state.ui.packetsPanelOpen = false;
    restore();
    expect(state.ui.packetsPanelOpen).toBe(true);
  });

  it('restores open panel on init when state says so', () => {
    state.ui.packetsPanelOpen = true;
    PacketsPanel.wire();
    PacketsPanel.init();
    expect(document.getElementById('packets-panel')).not.toBeNull();
    expect(document.getElementById('packets-panel').hidden).toBeFalsy();
  });
});
