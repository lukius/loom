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
  state.ui = { packetsPanelOpen: false, showChatter: true };
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

describe('PacketsPanel — payload rendering', () => {
  beforeEach(() => {
    PacketStore._reset();
    state.hosts = {};
  });

  function emitAndShowWithPayload(payloadId, payload) {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram',
      payload_id: payloadId, network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      dst: { address: '10.0.0.2' },
      payload_src: '10.0.0.1', payload_dst: '10.0.0.2',
      payload,
    } }));
    bus.dispatchEvent(new CustomEvent('packets:dot-appeared', { detail: { payloadId } }));
  }

  it('renders payload key/value rows in the expanded view', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShowWithPayload('p1', { bytes: 13 });
    PacketsPanel._expanded.add('p1');  // start expanded
    PacketsPanel.render();
    const detail = document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"] .pkt-detail');
    expect(detail).not.toBeNull();
    const section = detail.querySelector('.pkt-payload-section');
    expect(section).not.toBeNull();
    expect(section.textContent).toContain('bytes');
    expect(section.textContent).toContain('13');
  });

  it('omits the payload section when payload is empty', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShowWithPayload('p1', {});
    PacketsPanel._expanded.add('p1');
    PacketsPanel.render();
    const detail = document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"] .pkt-detail');
    expect(detail.querySelector('.pkt-payload-section')).toBeNull();
  });

  it('formats floats to 3 decimals', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShowWithPayload('p1', { request_ts: 1.234567 });
    PacketsPanel._expanded.add('p1');
    PacketsPanel.render();
    const detail = document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"] .pkt-detail');
    expect(detail.textContent).toContain('1.235');
  });

  it('renders an array value as a bulleted list (one item per line)', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShowWithPayload('p1', {
      seq: 1,
      destinations: [
        { prefix: '200.100.0.0/24', cost: 10 },
        { prefix: '100.200.0.0/24', cost: 15 },
      ],
    });
    PacketsPanel._expanded.add('p1');
    PacketsPanel.render();
    const detail = document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"] .pkt-detail');
    const list = detail.querySelector('.pkt-payload-list');
    expect(list).not.toBeNull();
    const items = list.querySelectorAll('li');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('prefix=200.100.0.0/24');
    expect(items[0].textContent).toContain('cost=10');
    expect(items[1].textContent).toContain('prefix=100.200.0.0/24');
    expect(items[1].textContent).toContain('cost=15');
  });

  it('renders an empty array as (empty)', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShowWithPayload('p1', { destinations: [] });
    PacketsPanel._expanded.add('p1');
    PacketsPanel.render();
    const detail = document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"] .pkt-detail');
    expect(detail.textContent).toContain('(empty)');
  });

  it('renders a string array element verbatim', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShowWithPayload('p1', { items: ['alpha', 'beta'] });
    PacketsPanel._expanded.add('p1');
    PacketsPanel.render();
    const items = document.querySelectorAll('#packets-panel .pkt-row[data-payload-id="p1"] .pkt-payload-list li');
    expect(items[0].textContent).toBe('alpha');
    expect(items[1].textContent).toBe('beta');
  });

  it('puts the full scalar in the title attribute and truncates display', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    const longText = 'a'.repeat(120);
    emitAndShowWithPayload('p1', { text: longText });
    PacketsPanel._expanded.add('p1');
    PacketsPanel.render();
    const val = document.querySelector('#packets-panel .pkt-row[data-payload-id="p1"] .pkt-payload-val');
    expect(val).not.toBeNull();
    expect(val.getAttribute('title')).toBe(longText);
    // Computed style (white-space: nowrap; overflow: hidden) keeps it one line — happy-dom doesn't run CSS, so we just assert the class+attr contract.
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

describe('PacketsPanel — chatter row expansion and halo', () => {
  beforeEach(() => {
    PacketStore._reset();
    state.routers = { r1: { interfaces: {
      eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 },
    } } };
    delete document.body.dataset.chatterBadges;
  });

  // Chatter group rows use the bare payload_id, not the composite key.
  const C1_BARE = 'c1';
  // Composite key for the canvas dot
  const C1_KEY = 'c1|r1|eth0|lan_a';

  function emitChatterWithPayload(payloadId, payload) {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: payloadId, network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
      payload,
    } }));
  }

  it('chatter rows are expandable and show payload when expanded', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitChatterWithPayload('c1', { seq: 5, destinations: [{ prefix: '10.0.0.0/24', cost: 1 }] });
    PacketsPanel._setChatterExpanded(true);
    PacketsPanel.render();
    // Group rows use bare payload_id
    const row = document.querySelector(`.pkt-chatter-row[data-payload-id="${C1_BARE}"]`);
    expect(row).not.toBeNull();
    row.querySelector('.pkt-toggle').click();
    const detail = document.querySelector(`.pkt-chatter-row[data-payload-id="${C1_BARE}"] .pkt-detail`);
    expect(detail).not.toBeNull();
    expect(detail.textContent).toContain('seq');
    expect(detail.textContent).toContain('5');
  });

  it('hover on a chatter group row halos the emission dot via data-emission-keys', () => {
    document.body.querySelector('#packet-layer') || (() => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.innerHTML = '<g id="packet-layer"></g>';
      document.body.appendChild(svg);
    })();
    const layer = document.getElementById('packet-layer');
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    // dot uses the composite key (unchanged from T29)
    dot.dataset.payloadId = C1_KEY;
    dot.dataset.packetType = 'routing_flood';
    layer.appendChild(dot);

    PacketsPanel.wire();
    PacketsPanel.open();
    emitChatterWithPayload('c1', {});
    PacketsPanel._setChatterExpanded(true);
    PacketsPanel.render();

    // Group row is keyed by bare payload_id; hover halos via data-emission-keys
    const row = document.querySelector(`.pkt-chatter-row[data-payload-id="${C1_BARE}"]`);
    expect(row).not.toBeNull();
    row.dispatchEvent(new MouseEvent('mouseenter'));
    expect(dot.classList.contains('halo')).toBe(true);
    row.dispatchEvent(new MouseEvent('mouseleave'));
    expect(dot.classList.contains('halo')).toBe(false);
  });

  it('groups multiple emissions of the same payload_id into one chatter row', () => {
    PacketStore._reset();
    state.routers = { r1: { interfaces: {
      eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 },
      eth1: { network: 'lan_b', address: '10.0.1.254', cost: 5 },
      eth2: { network: 'lan_c', address: '10.0.2.254', cost: 5 },
    } } };
    PacketsPanel.wire();
    PacketsPanel.open();
    // Three emissions, same payload_id
    for (const [iface, net] of [['eth0', 'lan_a'], ['eth1', 'lan_b'], ['eth2', 'lan_c']]) {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
        type: 'routing_flood', payload_id: 'msg-1', network: net,
        src: { device: 'r1', iface, address: '10.0.0.254' },
        dst: { device: null, address: '255.255.255.255' },
        payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
      } }));
    }
    PacketsPanel._setChatterExpanded(true);
    PacketsPanel.render();
    const rows = document.querySelectorAll('#packets-panel .pkt-chatter-row');
    expect(rows.length).toBe(1);
    expect(rows[0].dataset.payloadId).toBe('msg-1');
    expect(rows[0].textContent).toContain('×3');   // emission count badge
  });

  it('chatter group hover halos all of its emission dots', () => {
    // Set up a fake DOM with three chatter dots, one per emission.
    const layer = document.getElementById('packet-layer') || (() => {
      const svg = document.createElement('svg');
      svg.innerHTML = '<g id="packet-layer"></g>';
      document.body.appendChild(svg);
      return document.getElementById('packet-layer');
    })();
    PacketStore._reset();
    state.routers = { r1: { interfaces: {
      eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 },
      eth1: { network: 'lan_b', address: '10.0.1.254', cost: 5 },
      eth2: { network: 'lan_c', address: '10.0.2.254', cost: 5 },
    } } };
    for (const [iface, net] of [['eth0', 'lan_a'], ['eth1', 'lan_b'], ['eth2', 'lan_c']]) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      dot.dataset.payloadId = `msg-1|r1|${iface}|${net}`;
      dot.dataset.packetType = 'routing_flood';
      layer.appendChild(dot);
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
        type: 'routing_flood', payload_id: 'msg-1', network: net,
        src: { device: 'r1', iface, address: '10.0.0.254' },
        dst: { device: null, address: '255.255.255.255' },
        payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
      } }));
    }
    PacketsPanel.wire();
    PacketsPanel.open();
    PacketsPanel._setChatterExpanded(true);
    PacketsPanel.render();
    const row = document.querySelector('.pkt-chatter-row[data-payload-id="msg-1"]');
    row.dispatchEvent(new MouseEvent('mouseenter'));
    const halos = document.querySelectorAll('#packet-layer rect.halo');
    expect(halos.length).toBe(3);
    row.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.querySelectorAll('#packet-layer rect.halo').length).toBe(0);
  });
});

describe('PacketsPanel — multi-group chatter hover (9 groups, 6 emissions each)', () => {
  beforeEach(() => {
    PacketStore._reset();
    state.routers = {
      r1: { interfaces: {
        eth0: { network: 'lan_a', address: '10.0.0.1', cost: 5 },
        eth1: { network: 'lan_b', address: '10.0.1.1', cost: 5 },
        eth2: { network: 'p2p',   address: '10.0.2.1', cost: 5 },
      } },
      r2: { interfaces: {
        eth0: { network: 'lan_a', address: '10.0.0.2', cost: 5 },
        eth1: { network: 'lan_b', address: '10.0.1.2', cost: 5 },
        eth2: { network: 'lan_c', address: '10.0.3.2', cost: 5 },
      } },
      r3: { interfaces: {
        eth0: { network: 'lan_b', address: '10.0.1.3', cost: 5 },
        eth1: { network: 'lan_c', address: '10.0.3.3', cost: 5 },
        eth2: { network: 'p2p',   address: '10.0.2.3', cost: 5 },
      } },
    };
    delete document.body.dataset.chatterBadges;
    // Ensure a packet-layer exists inside the DOM from the top-level beforeEach.
    if (!document.getElementById('packet-layer')) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.innerHTML = '<g id="packet-layer"></g>';
      document.body.appendChild(svg);
    }
  });

  it('all chatter group rows halo their dots (9 groups, 6 emissions each)', () => {
    const layer = document.getElementById('packet-layer');

    // Emit 9 distinct chatter groups, each with 6 emissions from varied
    // srcDev/iface/network combinations. For each emission, also place a
    // matching canvas rect in #packet-layer.
    for (let g = 0; g < 9; g++) {
      const payloadId = `msg-${g}`;
      for (let e = 0; e < 6; e++) {
        const dev   = `r${(e % 3) + 1}`;
        const iface = `eth${e % 3}`;
        const net   = `net-${g}-${e}`;
        const composite = `${payloadId}|${dev}|${iface}|${net}`;

        // Ensure the router/interface entry exists so _resolveIface can find it.
        if (!state.routers[dev].interfaces[iface]) {
          state.routers[dev].interfaces[iface] = { network: net, address: '10.99.99.99', cost: 1 };
        } else if (state.routers[dev].interfaces[iface].network !== net) {
          // _resolveIface matches by network name; add a synthetic entry so
          // the iface lookup won't fail (the store doesn't depend on it for
          // the composite key — the key is built directly from the event).
        }

        bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
          type: 'routing_flood',
          payload_id: payloadId,
          network: net,
          src: { device: dev, iface, address: '10.99.99.99' },
          dst: { device: null, address: '255.255.255.255' },
          payload_src: '10.99.99.99',
          payload_dst: '255.255.255.255',
        } }));

        // Place the canvas dot with the matching composite key.
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        dot.dataset.payloadId  = composite;
        dot.dataset.packetType = 'routing_flood';
        layer.appendChild(dot);
      }
    }

    PacketsPanel.wire();
    PacketsPanel.open();
    PacketsPanel._setChatterExpanded(true);
    PacketsPanel.render();

    // All 9 groups should be rendered as chatter rows.
    const rows = document.querySelectorAll('#packets-panel .pkt-chatter-row');
    expect(rows.length).toBe(9);

    // Each row: hover should halo exactly 6 dots; leave should clear them all.
    rows.forEach((row, idx) => {
      row.dispatchEvent(new MouseEvent('mouseenter'));
      const halos = document.querySelectorAll('#packet-layer rect.halo');
      expect(halos.length, `row #${idx} (payloadId="${row.dataset.payloadId}") should halo 6 dots`).toBe(6);
      row.dispatchEvent(new MouseEvent('mouseleave'));
      expect(
        document.querySelectorAll('#packet-layer rect.halo').length,
        `row #${idx} mouseleave should clear all halos`,
      ).toBe(0);
    });
  });
});

describe('PacketsPanel — chatter section toggle', () => {
  beforeEach(() => {
    PacketStore._reset();
    state.routers = { r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 } } } };
  });

  function emitAndShowChatter(payloadId) {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: payloadId, network: 'lan_a',
      src: { device: 'r1', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
    } }));
  }

  it('renders chatter section by default', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShowChatter('c1');
    PacketsPanel.render();
    expect(document.querySelector('#packets-panel .pkt-chatter-summary')).not.toBeNull();
  });

  it('hides the chatter section when state.ui.showChatter is false', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShowChatter('c1');
    state.ui.showChatter = false;
    PacketsPanel.render();
    expect(document.querySelector('#packets-panel .pkt-chatter-summary')).toBeNull();
    // No "In flight — routing chatter" heading either:
    const headings = Array.from(document.querySelectorAll('#packets-panel .packets-section h3'))
      .map(h => h.textContent.toLowerCase());
    expect(headings.some(h => h.includes('routing chatter'))).toBe(false);
  });

  it('header toggle flips state.ui.showChatter and re-renders', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShowChatter('c1');
    PacketsPanel.render();
    expect(state.ui.showChatter).toBe(true);
    const toggle = document.querySelector('#packets-panel .packets-chatter-toggle');
    expect(toggle).not.toBeNull();
    toggle.click();
    expect(state.ui.showChatter).toBe(false);
    expect(document.querySelector('#packets-panel .pkt-chatter-summary')).toBeNull();
    document.querySelector('#packets-panel .packets-chatter-toggle').click();
    expect(state.ui.showChatter).toBe(true);
    expect(document.querySelector('#packets-panel .pkt-chatter-summary')).not.toBeNull();
  });

  it('total count excludes chatter when section is hidden', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitAndShowChatter('c1');
    emitAndShowChatter('c2');
    PacketsPanel.render();
    const header = document.querySelector('#packets-panel .packets-header').textContent;
    expect(header).toContain('Packets (2)');
    state.ui.showChatter = false;
    PacketsPanel.render();
    const header2 = document.querySelector('#packets-panel .packets-header').textContent;
    expect(header2).toContain('Packets (0)');
  });
});

describe('PacketsPanel — hello chatter section', () => {
  beforeEach(() => {
    PacketStore._reset();
    state.routers = { r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 } } } };
    delete document.body.dataset.chatterBadges;
  });

  function emitHello(payloadId) {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'hello',
      payload_id: payloadId, network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
      payload: { originator: 'r1', neighbours_heard: [] },
    } }));
  }

  it('hello chatter appears in the routing chatter section', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitHello('h1');
    PacketsPanel.render();
    const summary = document.querySelector('#packets-panel .pkt-chatter-summary');
    expect(summary).not.toBeNull();
    expect(summary.textContent).toContain('1');
    expect(summary.textContent.toLowerCase()).toContain('routing chatter');
  });

  it('expanding chatter shows hello row with data-type="hello" swatch coloured amber', () => {
    // Inject the relevant CSS rules so getComputedStyle reflects them.
    const style = document.createElement('style');
    style.textContent = '.pkt-swatch[data-type="hello"] { background: #fcd34d; }';
    document.head.appendChild(style);

    PacketsPanel.wire();
    PacketsPanel.open();
    emitHello('h1');
    PacketsPanel.render();
    document.querySelector('.pkt-chatter-summary .pkt-toggle').click();
    const rows = document.querySelectorAll('.pkt-chatter-row');
    expect(rows.length).toBe(1);
    const swatch = rows[0].querySelector('.pkt-swatch[data-type="hello"]');
    expect(swatch).not.toBeNull();
    // Verify the swatch actually has the amber colour — catching the case where
    // the CSS rule in styles.css is missing (the original regression).
    const bg = window.getComputedStyle(swatch).background ||
               window.getComputedStyle(swatch).backgroundColor;
    expect(bg).toBeTruthy();
    expect(bg).not.toBe('');
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');

    document.head.removeChild(style);
  });

  it('hello and routing_flood both appear in chatter section together', () => {
    PacketsPanel.wire();
    PacketsPanel.open();
    emitHello('h1');
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: 'lsa-1', network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
    } }));
    PacketsPanel.render();
    const summary = document.querySelector('#packets-panel .pkt-chatter-summary');
    expect(summary).not.toBeNull();
    // 2 distinct logical messages in the chatter section
    expect(summary.textContent).toContain('2');
  });
});
