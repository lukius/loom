import { describe, it, expect, beforeEach } from 'vitest';
import { state, bus, persist, restore, STORAGE_KEY } from './state.js';
import { PacketsPanel } from './packetspanel.js';
import { PacketStore } from './packetstore.js';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = `
    <div id="save-state"><span class="dot"></span> idle</div>
    <button id="tb-packets"><span class="lbl">Packets</span></button>
    <aside id="inspector"></aside>
  `;
  state.ui = { packetsPanelOpen: false };
  PacketsPanel._reset();
});

describe('PacketsPanel — toolbar button toggle', () => {
  it('opens the panel and mounts it inside #inspector on first click', () => {
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

  it('hides inspector contents (including children inserted after open) until close', () => {
    PacketsPanel.wire();
    const host = document.getElementById('inspector');
    // Provide a real initial child.
    const orig = document.createElement('div');
    orig.className = 'insp-original-content';
    orig.textContent = 'existing inspector content';
    host.appendChild(orig);

    document.getElementById('tb-packets').click();
    // After open: host has data-packets-open; the CSS rule hides non-panel children.
    expect(host.dataset.packetsOpen).toBe('1');

    // Simulate the inspector re-rendering — e.g. selection-change rebuilds children.
    host.querySelectorAll(':scope > :not(#packets-panel)').forEach(c => c.remove());
    const fresh = document.createElement('section');
    fresh.className = 'insp-fresh-content';
    fresh.textContent = 'inspector re-rendered';
    host.appendChild(fresh);

    // Data attribute still set — CSS hides the new child too.
    expect(host.dataset.packetsOpen).toBe('1');

    // Close — attribute cleared, CSS no longer hides anything.
    document.getElementById('tb-packets').click();
    expect(host.dataset.packetsOpen).toBeUndefined();
  });
});

// Helper: emit sim:packet AND immediately signal dot-appeared so the row
// passes the visibility filter. Tests that want to check "hidden before
// dot-appeared" should use raw bus.dispatchEvent('sim:packet', …) instead.
function emitAndShow(payloadId, srcDev, srcAddr, dstDev, dstAddr, network, payloadDst) {
  bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
    type: 'user_datagram',
    payload_id: payloadId, network,
    src: { device: srcDev, address: srcAddr },
    dst: { device: dstDev, address: dstAddr },
    payload_src: srcAddr,
    payload_dst: payloadDst || dstAddr,
  } }));
  bus.dispatchEvent(new CustomEvent('packets:dot-appeared', { detail: { payloadId } }));
}

describe('PacketsPanel — in-flight user-traffic rows', () => {
  beforeEach(() => {
    PacketStore._reset();
    state.hosts = {};
    state.routers = {};
  });

  it('hides rows until packets:dot-appeared fires for them', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram',
      payload_id: 'p1', network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      dst: { device: 'h2', address: '10.0.0.2' },
      payload_src: '10.0.0.1', payload_dst: '10.0.0.2',
    } }));
    PacketsPanel.render();
    expect(document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"]')).toBeNull();
    bus.dispatchEvent(new CustomEvent('packets:dot-appeared', { detail: { payloadId: 'p1' } }));
    PacketsPanel.render();
    expect(document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"]')).not.toBeNull();
  });

  it('shows one collapsed row per in-flight payload with #N, type, src→dst, [hop K]', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShow('p1', 'h1', '10.0.0.1', 'r1', '10.0.0.254', 'lan_a', '10.0.1.5');
    emitAndShow('p1', 'r1', '10.0.1.1', 'r2', '10.0.1.2', 'link_0', '10.0.1.5');
    PacketsPanel.render();
    const rows = document.querySelectorAll('#packets-panel .pkt-row[data-payload-id="p1"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('#1');
    expect(rows[0].textContent).toContain('user_datagram');
    expect(rows[0].textContent).toContain('[hop 1]');  // current hop, not total
  });

  it('omits [hop K] for a single-hop packet', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShow('p1', 'h1', '10.0.0.1', 'h2', '10.0.0.2', 'lan_a');
    PacketsPanel.render();
    const row = document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"]');
    expect(row.textContent).not.toContain('[hop ');
  });

  it('expanding a row reveals payload and hops list', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShow('p1', 'h1', '10.0.0.1', 'r1', '10.0.0.254', 'lan_a', '10.0.1.5');
    emitAndShow('p1', 'r1', '10.0.1.1', 'h4', '10.0.1.5', 'lan_b', '10.0.1.5');
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

  it('hop counter advances on each sim:packet-arrived', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShow('p1', 'h1', '10.0.0.1', 'r1', '10.0.0.254', 'lan_a', '10.0.1.5');
    emitAndShow('p1', 'r1', '10.0.1.1', 'r2', '10.0.1.2', 'link_0', '10.0.1.5');
    emitAndShow('p1', 'r2', '10.0.1.2', 'h4', '10.0.1.5', 'lan_b', '10.0.1.5');
    PacketsPanel.render();
    expect(document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"]').textContent).toContain('[hop 1]');

    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId: 'p1', device: 'r1' } }));
    PacketsPanel.render();
    expect(document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"]').textContent).toContain('[hop 2]');
  });
});

describe('PacketsPanel — chatter section', () => {
  beforeEach(() => {
    PacketStore._reset();
    state.routers = { r1: { interfaces: {
      eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 },
    } } };
    delete document.body.dataset.chatterBadges;
  });

  function emitChatter(payloadId, srcDev, network) {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood',
      payload_id: payloadId, network,
      src: { device: srcDev, address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0',
      payload_dst: '255.255.255.255',
    } }));
    bus.dispatchEvent(new CustomEvent('packets:dot-appeared', { detail: { payloadId } }));
  }

  it('shows a collapsed summary row when chatter is in flight', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitChatter('c1', 'r1', 'lan_a');
    emitChatter('c2', 'r1', 'lan_a');
    PacketsPanel.render();
    const summary = document.querySelector('#packets-panel .pkt-chatter-summary');
    expect(summary).not.toBeNull();
    expect(summary.textContent).toContain('2');
    expect(summary.textContent.toLowerCase()).toContain('routing chatter');
  });

  it('expanding the summary sets data-chatter-badges=on and reveals #R rows', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitChatter('c1', 'r1', 'lan_a');
    PacketsPanel.render();
    document.querySelector('.pkt-chatter-summary .pkt-toggle').click();
    expect(document.body.dataset.chatterBadges).toBe('on');
    const rows = document.querySelectorAll('.pkt-chatter-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('#R1');
    expect(rows[0].textContent).toContain('r1');
    expect(rows[0].textContent).toContain('lan_a');
  });

  it('collapsing the summary clears data-chatter-badges and removes #R rows', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitChatter('c1', 'r1', 'lan_a');
    PacketsPanel.render();
    const toggle = document.querySelector('.pkt-chatter-summary .pkt-toggle');
    toggle.click();
    document.querySelector('.pkt-chatter-summary .pkt-toggle').click();  // re-query after re-render
    expect(document.body.dataset.chatterBadges).toBeUndefined();
    expect(document.querySelectorAll('.pkt-chatter-row').length).toBe(0);
  });
});

describe('PacketsPanel — recent section', () => {
  beforeEach(() => {
    PacketStore._reset();
    state.hosts = {};
  });

  function emitAndDeliver(payloadId, srcAddr, dstAddr) {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram',
      payload_id: payloadId, network: 'lan_a',
      src: { device: 'h1', address: srcAddr },
      dst: { device: 'h2', address: dstAddr },
      payload_src: srcAddr,
      payload_dst: dstAddr,
    } }));
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId, device: 'h2' } }));
  }

  it('renders a Recent section once at least one packet has been delivered', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndDeliver('p1', '10.0.0.1', '10.0.0.2');
    PacketsPanel.render();
    const headings = Array.from(document.querySelectorAll('#packets-panel .packets-section h3'))
      .map(h => h.textContent.toLowerCase());
    expect(headings.some(h => h.includes('recent'))).toBe(true);
    const rows = document.querySelectorAll('#packets-panel .pkt-row[data-payload-id="p1"]');
    expect(rows.length).toBe(1);
  });

  it('shows at most 10 entries, newest last', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    for (let i = 1; i <= 11; i++) emitAndDeliver(`p${i}`, '10.0.0.1', '10.0.0.2');
    PacketsPanel.render();
    const rows = document.querySelectorAll('#packets-panel .packets-recent .pkt-row');
    expect(rows.length).toBe(10);
    expect(rows[rows.length - 1].dataset.payloadId).toBe('p11');
  });

  it('does NOT mark the last hop as "in flight" for delivered rows in Recent', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndDeliver('p1', '10.0.0.1', '10.0.0.2');
    PacketsPanel.render();
    // Expand the recent row.
    const row = document.querySelector('#packets-panel .packets-recent .pkt-row[data-payload-id="p1"]');
    row.querySelector('.pkt-toggle').click();
    const expanded = document.querySelector('#packets-panel .packets-recent .pkt-row[data-payload-id="p1"] .pkt-detail');
    expect(expanded).not.toBeNull();
    expect(expanded.textContent).not.toContain('in flight');
  });
});

describe('PacketsPanel — hover-row halo', () => {
  beforeEach(() => {
    PacketStore._reset();
    document.body.innerHTML = `
      <div id="save-state"><span></span></div>
      <button id="tb-packets"></button>
      <aside id="inspector"></aside>
      <svg><g id="packet-layer">
        <rect data-payload-id="p1" data-packet-type="user_datagram" class="packet-dot" />
      </g></svg>`;
    PacketsPanel._reset();
  });

  it('mouseenter on a row adds .halo to the matching packet dot', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram',
      payload_id: 'p1', network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      dst: { device: 'h2', address: '10.0.0.2' },
      payload_src: '10.0.0.1', payload_dst: '10.0.0.2',
    } }));
    bus.dispatchEvent(new CustomEvent('packets:dot-appeared', { detail: { payloadId: 'p1' } }));
    PacketsPanel.render();
    const row = document.querySelector('.pkt-row[data-payload-id="p1"]');
    row.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('rect[data-payload-id="p1"]').classList.contains('halo')).toBe(true);

    row.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.querySelector('rect[data-payload-id="p1"]').classList.contains('halo')).toBe(false);
  });
});
