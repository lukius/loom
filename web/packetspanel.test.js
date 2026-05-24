import { describe, it, expect, beforeEach } from 'vitest';
import { state, bus, persist, restore, STORAGE_KEY } from './state.js';
import { PacketsPanel } from './packetspanel.js';
import { PacketStore } from './packetstore.js';

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

describe('PacketsPanel — in-flight user-traffic rows', () => {
  beforeEach(() => {
    PacketStore._reset();
    state.hosts = {};
    state.routers = {};
  });

  function emitUser(payloadId, srcDev, srcAddr, dstDev, dstAddr, network, payloadDst) {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram',
      payload_id: payloadId, network,
      src: { device: srcDev, address: srcAddr },
      dst: { device: dstDev, address: dstAddr },
      payload_src: srcAddr,
      payload_dst: payloadDst || dstAddr,
    } }));
  }

  it('shows one collapsed row per in-flight payload with #N, type, src→dst, [hop K]', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitUser('p1', 'h1', '10.0.0.1', 'r1', '10.0.0.254', 'lan_a', '10.0.1.5');
    emitUser('p1', 'r1', '10.0.1.1', 'r2', '10.0.1.2', 'link_0', '10.0.1.5');
    PacketsPanel.render();
    const rows = document.querySelectorAll('#packets-panel .pkt-row[data-payload-id="p1"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('#1');
    expect(rows[0].textContent).toContain('user_datagram');
    expect(rows[0].textContent).toContain('[hop 2]');
  });

  it('omits [hop K] for a single-hop packet', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitUser('p1', 'h1', '10.0.0.1', 'h2', '10.0.0.2', 'lan_a');
    PacketsPanel.render();
    const row = document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"]');
    expect(row.textContent).not.toContain('[hop ');
  });

  it('expanding a row reveals payload and hops list', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitUser('p1', 'h1', '10.0.0.1', 'r1', '10.0.0.254', 'lan_a', '10.0.1.5');
    emitUser('p1', 'r1', '10.0.1.1', 'h4', '10.0.1.5', 'lan_b', '10.0.1.5');
    PacketsPanel.render();

    document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"] .pkt-toggle').click();

    // render() rebuilds innerHTML on toggle — re-query from live DOM
    const row = document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"]');
    const expanded = row.querySelector('.pkt-detail');
    expect(expanded).not.toBeNull();
    expect(expanded.textContent).toContain('10.0.0.1');
    expect(expanded.textContent).toContain('10.0.1.5');
    expect(expanded.textContent).toContain('h1 → r1');
    expect(expanded.textContent).toContain('r1 → h4');
  });

  it('shows the empty-state message when nothing is in flight or recent', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    PacketsPanel.render();
    expect(document.getElementById('packets-panel').textContent).toContain('No packets yet');
  });
});
