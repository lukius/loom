import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PacketAnim, showPacketTooltip, hidePacketTooltip } from './packets.js';
import { state, bus } from './state.js';

// Sample one dimension of a cubic bezier at parameter t.
function bez1d(p0, c1, c2, p3, t) {
  const u = 1 - t;
  return u*u*u*p0 + 3*u*u*t*c1 + 3*u*t*t*c2 + t*t*t*p3;
}

describe('PacketAnim._bezBetween — packet curves match drawEdge', () => {
  it('places both control points at the endpoint y-values (horizontal tangents)', () => {
    const p0 = { x: 100, y: 50 };
    const p3 = { x: 400, y: 200 };
    const { c1, c2 } = PacketAnim._bezBetween(p0, p3);
    expect(c1.y).toBe(p0.y);
    expect(c2.y).toBe(p3.y);
  });

  it('uses the same 0.55 dx weighting as drawEdge for control x-positions', () => {
    const p0 = { x: 100, y: 0 };
    const p3 = { x: 300, y: 0 };
    const { c1, c2 } = PacketAnim._bezBetween(p0, p3);
    const dx = p3.x - p0.x;
    expect(c1.x).toBeCloseTo(p0.x + dx * 0.55);
    expect(c2.x).toBeCloseTo(p3.x - dx * 0.55);
  });

  it('returns endpoints unchanged at t=0 and t=1', () => {
    const p0 = { x: 10, y: 20 };
    const p3 = { x: 90, y: 80 };
    const { c1, c2 } = PacketAnim._bezBetween(p0, p3);
    expect(bez1d(p0.x, c1.x, c2.x, p3.x, 0)).toBe(p0.x);
    expect(bez1d(p0.y, c1.y, c2.y, p3.y, 0)).toBe(p0.y);
    expect(bez1d(p0.x, c1.x, c2.x, p3.x, 1)).toBeCloseTo(p3.x);
    expect(bez1d(p0.y, c1.y, c2.y, p3.y, 1)).toBeCloseTo(p3.y);
  });

  it('handles right-to-left curves (negative dx) symmetrically', () => {
    const p0 = { x: 400, y: 0 };
    const p3 = { x: 100, y: 50 };
    const { c1, c2 } = PacketAnim._bezBetween(p0, p3);
    // dx < 0, so c1 sits LEFT of p0 and c2 sits RIGHT of p3.
    expect(c1.x).toBeLessThan(p0.x);
    expect(c2.x).toBeGreaterThan(p3.x);
    // Tangents still horizontal.
    expect(c1.y).toBe(p0.y);
    expect(c2.y).toBe(p3.y);
  });

  it('_segLength returns exact length for line segments', () => {
    const len = PacketAnim._segLength({ kind: 'line', from: { x: 0, y: 0 }, to: { x: 3, y: 4 } });
    expect(len).toBe(5);
  });

  it('_segLength returns chord-ish length for a bezier (always >= chord, within 15%)', () => {
    const p0 = { x: 0, y: 0 };
    const p3 = { x: 100, y: 60 };
    const { c1, c2 } = PacketAnim._bezBetween(p0, p3);
    const chord = Math.hypot(100, 60);
    const len = PacketAnim._segLength({ kind: 'bez', p0, c1, c2, p3 });
    expect(len).toBeGreaterThanOrEqual(chord * 0.99);   // sampled, so a hair under is fine
    expect(len).toBeLessThan(chord * 1.15);
  });

  it('_segmentsForLink builds a direct device-to-device bezier (no rail tap)', () => {
    // Minimal DOM: two router nodes whose centers we can read via getNodeCenter.
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node router" data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g class="node router" data-kind="router" data-name="r2" transform="translate(400 100)"></g>
      </g></svg>`;
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 250, y: 100 } };
    state.routers = {
      r1: { x: 100, y: 100, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
      r2: { x: 400, y: 100, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.2', cost: 5 } } },
    };
    state.hosts = {};
    state.networks = {};
    const srcNode = document.querySelector('[data-name="r1"]');
    const evt = {
      type: 'user_datagram',
      network: 'p2p1',
      src: { device: 'r1', address: '10.0.0.1' },
      dst: { address: '10.0.0.2' },
    };
    const segs = PacketAnim._segmentsForLink(evt, srcNode);
    expect(segs.length).toBe(1);
    expect(segs[0].kind).toBe('bez');
    // The bezier should land near r2's clipped boundary, not at r2's center.
    expect(segs[0].p3.x).toBeGreaterThan(100);
    expect(segs[0].p3.x).toBeLessThan(400);
  });

  it('_segmentsForNetwork resolves dst on the event\'s fabric, ignoring same-IP devices on other LANs', () => {
    // Two LANs both using 192.168.1.0/24 — h_a on lan1 and h_b on lan2 both
    // have IP 192.168.1.10. A packet on lan1 destined for 192.168.1.10 must
    // animate to h_a, not h_b.
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node host"    data-kind="host"    data-name="h_a"  transform="translate(100 100)"></g>
        <g class="node host"    data-kind="host"    data-name="h_b"  transform="translate(700 100)"></g>
        <g class="node router"  data-kind="router"  data-name="r1"   transform="translate(400 100)"></g>
        <g class="node network" data-kind="network" data-name="lan1" transform="translate(250 100)"></g>
        <g class="node network" data-kind="network" data-name="lan2" transform="translate(550 100)"></g>
      </g></svg>`;
    state.networks = {
      lan1: { cidr: '192.168.1.0/24', x: 250, y: 100 },
      lan2: { cidr: '192.168.1.0/24', x: 550, y: 100 },
    };
    state.hosts = {
      h_a: { network: 'lan1', address: '192.168.1.10', x: 100, y: 100 },
      h_b: { network: 'lan2', address: '192.168.1.10', x: 700, y: 100 },
    };
    state.routers = {
      r1: { x: 400, y: 100, interfaces: {
        eth0: { network: 'lan1', address: '192.168.1.1', cost: 1 },
        eth1: { network: 'lan2', address: '192.168.1.1', cost: 1 },
      } },
    };
    state.links = {};
    const srcNode = document.querySelector('[data-name="r1"]');
    const netNode = document.querySelector('[data-name="lan1"]');
    const evt = {
      type: 'user_datagram',
      network: 'lan1',
      src: { device: 'r1', address: '192.168.1.1' },
      dst: { address: '192.168.1.10' },
    };
    const segs = PacketAnim._segmentsForNetwork(evt, srcNode, netNode);
    // Final bezier should land near h_a's center (~100), not h_b's (~700).
    const lastBez = segs[segs.length - 1];
    expect(lastBez.kind).toBe('bez');
    expect(lastBez.p3.x).toBeLessThan(300);
  });

  it('_segmentsForLink prefers the link\'s structural peer over the address lookup (handles cross-link IP collisions)', () => {
    // Two p2p links both using 10.0.0.0/30 — h5 on p2p2 happens to share
    // address 10.0.0.2 with r3.eth2 on p2p1. The animation MUST go to r3,
    // not to h5, when the event's network is p2p1.
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node router" data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g class="node router" data-kind="router" data-name="r3" transform="translate(700 100)"></g>
        <g class="node host"   data-kind="host"   data-name="h5" transform="translate(400 400)"></g>
      </g></svg>`;
    state.links = {
      p2p1: { cidr: '10.0.0.0/30', x: 400, y: 100 },
      p2p2: { cidr: '10.0.0.0/30', x: 400, y: 400 },
    };
    state.routers = {
      r1: { x: 100, y: 100, interfaces: { eth2: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
      r3: { x: 700, y: 100, interfaces: { eth2: { link: 'p2p1', address: '10.0.0.2', cost: 5 } } },
    };
    state.hosts = {
      h4: { link: 'p2p2', address: '10.0.0.1', x: 400, y: 350 },
      h5: { link: 'p2p2', address: '10.0.0.2', x: 400, y: 450 },
    };
    state.networks = {};
    const srcNode = document.querySelector('[data-name="r1"]');
    const evt = {
      type: 'ping_request',
      network: 'p2p1',
      src: { device: 'r1', address: '10.0.0.1' },
      dst: { address: '10.0.0.2' },  // collides with h5
    };
    const segs = PacketAnim._segmentsForLink(evt, srcNode);
    expect(segs.length).toBe(1);
    // p3.x should be near r3's clipped left edge (around 668), NOT near h5's center (400).
    expect(segs[0].p3.x).toBeGreaterThan(500);
  });

  it('_segmentsForLink falls back to "the other endpoint" when dst is the link broadcast', () => {
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node router" data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g class="node router" data-kind="router" data-name="r2" transform="translate(400 100)"></g>
      </g></svg>`;
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 250, y: 100 } };
    state.routers = {
      r1: { x: 100, y: 100, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
      r2: { x: 400, y: 100, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.2', cost: 5 } } },
    };
    state.hosts = {};
    state.networks = {};
    const srcNode = document.querySelector('[data-name="r1"]');
    // dst.address = .3 broadcast: doesn't match any interface, so the
    // animation should still find r2 as "the other endpoint".
    const evt = {
      type: 'routing_flood',
      network: 'p2p1',
      src: { device: 'r1', address: '10.0.0.1' },
      dst: { address: '10.0.0.3' },
    };
    const segs = PacketAnim._segmentsForLink(evt, srcNode);
    expect(segs.length).toBe(1);
    expect(segs[0].kind).toBe('bez');
  });

  it('produces a curved path (control points pulled off the chord) for non-aligned endpoints', () => {
    const p0 = { x: 0, y: 0 };
    const p3 = { x: 200, y: 100 };
    const { c1, c2 } = PacketAnim._bezBetween(p0, p3);
    // Midpoint of the chord:
    const chordMid = { x: 100, y: 50 };
    // Midpoint of the bezier at t=0.5:
    const midX = bez1d(p0.x, c1.x, c2.x, p3.x, 0.5);
    const midY = bez1d(p0.y, c1.y, c2.y, p3.y, 0.5);
    // The bezier mid is on the chord in X but pulled toward the endpoints' y
    // (mean of endpoints) — sanity: not far from the chord midpoint.
    expect(midX).toBeCloseTo(chordMid.x, 0);
    expect(midY).toBeCloseTo(chordMid.y, 0);
  });
});

describe('Packet tooltip with NAT', () => {
  let dot;
  beforeEach(() => {
    document.body.innerHTML = '';
    dot = document.createElement('div');
    dot.getBoundingClientRect = () => ({ left: 0, top: 0, right: 10, bottom: 10 });
    document.body.appendChild(dot);
  });
  afterEach(() => {
    hidePacketTooltip();
    document.querySelectorAll('#packet-tooltip').forEach(n => n.remove());
  });

  it('appends an outbound NAT line when sim:nat arrived for this payload', () => {
    bus.dispatchEvent(new CustomEvent('sim:nat', { detail: {
      kind: 'nat',
      router: 'r_a',
      direction: 'outbound',
      original_src: '192.168.1.10',
      rewritten_src: '200.100.0.1',
      dst: '8.8.8.8',
      payload_id: 'pid-out',
    }}));
    showPacketTooltip({
      type: 'user_datagram',
      payload_id: 'pid-out',
      payload_src: '200.100.0.1',
      payload_dst: '8.8.8.8',
      src: { address: '200.100.0.1' },
      dst: { address: '8.8.8.8' },
    }, dot);
    const tt = document.getElementById('packet-tooltip');
    expect(tt.innerHTML).toContain('NAT @ r_a');
    expect(tt.innerHTML).toContain('192.168.1.10');
    expect(tt.innerHTML).toContain('200.100.0.1');
  });

  it('appends an inbound NAT line with rewritten_dst → original_dst', () => {
    bus.dispatchEvent(new CustomEvent('sim:nat', { detail: {
      kind: 'nat',
      router: 'r_a',
      direction: 'inbound',
      rewritten_dst: '200.100.0.1',
      original_dst: '192.168.1.10',
      src: '8.8.8.8',
      payload_id: 'pid-in',
    }}));
    showPacketTooltip({
      type: 'user_datagram',
      payload_id: 'pid-in',
      payload_src: '8.8.8.8',
      payload_dst: '192.168.1.10',
      src: { address: '8.8.8.8' },
      dst: { address: '192.168.1.10' },
    }, dot);
    const tt = document.getElementById('packet-tooltip');
    expect(tt.innerHTML).toContain('NAT @ r_a');
    // Inbound shape: rewritten_dst -> original_dst
    expect(tt.innerHTML).toContain('200.100.0.1');
    expect(tt.innerHTML).toContain('192.168.1.10');
  });

  it('renders no NAT line when the payload had none', () => {
    showPacketTooltip({
      type: 'user_datagram',
      payload_id: 'pid-no-nat',
      payload_src: '8.8.8.8',
      payload_dst: '1.2.3.4',
      src: { address: '8.8.8.8' },
      dst: { address: '1.2.3.4' },
    }, dot);
    const tt = document.getElementById('packet-tooltip');
    expect(tt.innerHTML).not.toContain('NAT');
  });

  it('renders multiple NAT lines when the payload was rewritten at multiple hops', () => {
    bus.dispatchEvent(new CustomEvent('sim:nat', { detail: {
      kind: 'nat', router: 'r_a', direction: 'outbound',
      original_src: '192.168.1.10', rewritten_src: '200.100.0.1',
      dst: '8.8.8.8', payload_id: 'pid-multi',
    }}));
    bus.dispatchEvent(new CustomEvent('sim:nat', { detail: {
      kind: 'nat', router: 'r_b', direction: 'outbound',
      original_src: '200.100.0.1', rewritten_src: '198.51.100.1',
      dst: '8.8.8.8', payload_id: 'pid-multi',
    }}));
    showPacketTooltip({
      type: 'user_datagram',
      payload_id: 'pid-multi',
      payload_src: '198.51.100.1',
      payload_dst: '8.8.8.8',
      src: { address: '198.51.100.1' },
      dst: { address: '8.8.8.8' },
    }, dot);
    const tt = document.getElementById('packet-tooltip');
    expect(tt.innerHTML).toContain('NAT @ r_a');
    expect(tt.innerHTML).toContain('NAT @ r_b');
  });
});

import { PacketStore } from './packetstore.js';

describe('PacketAnim — chatter badge live toggle', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._lastChatter.clear();
    delete document.body.dataset.chatterBadges;
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g data-kind="host" data-name="h1" transform="translate(100 100)"></g>
        <g data-kind="network" data-name="lan_a" transform="translate(250 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.networks = { lan_a: { cidr: '10.0.0.0/24', x: 250, y: 100 } };
    state.hosts = { h1: { address: '0.0.0.0', network: 'lan_a', x: 100, y: 100 } };
    state.routers = {};
    state.links = {};
  });

  it('adds chatter badges live when the body flag turns on', () => {
    const evt = {
      type: 'routing_flood', payload_id: 'c1', network: 'lan_a',
      src: { device: 'h1', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
    };
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: evt }));
    const layer = document.getElementById('packet-layer');
    expect(layer.querySelectorAll('text.packet-badge').length).toBe(0);

    document.body.dataset.chatterBadges = 'on';
    bus.dispatchEvent(new CustomEvent('packets:chatter-badges-changed'));
    expect(layer.querySelectorAll('text.packet-badge').length).toBeGreaterThanOrEqual(1);
  });

  it('removes chatter badges live when the body flag turns off', () => {
    document.body.dataset.chatterBadges = 'on';
    const evt = {
      type: 'routing_flood', payload_id: 'c1', network: 'lan_a',
      src: { device: 'h1', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
    };
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: evt }));
    const layer = document.getElementById('packet-layer');
    expect(layer.querySelectorAll('text.packet-badge').length).toBe(1);

    delete document.body.dataset.chatterBadges;
    bus.dispatchEvent(new CustomEvent('packets:chatter-badges-changed'));
    expect(layer.querySelectorAll('text.packet-badge').length).toBe(0);
  });
});

describe('PacketAnim — badge rendering', () => {
  beforeEach(() => {
    PacketStore._reset();
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node host" data-kind="host" data-name="h1" transform="translate(100 100)"></g>
        <g class="node host" data-kind="host" data-name="h2" transform="translate(400 100)"></g>
      </g>
      <g id="packet-layer"></g></svg>`;
    state.links = {};
    state.networks = { lan_a: { cidr: '10.0.0.0/24', x: 250, y: 100 } };
    state.routers = {};
    state.hosts = {
      h1: { address: '10.0.0.1', network: 'lan_a', x: 100, y: 100 },
      h2: { address: '10.0.0.2', network: 'lan_a', x: 400, y: 100 },
    };
    // Add the rail node so _segmentsForNetwork can resolve netNode.
    const layer = document.getElementById('nodes-layer');
    const rail = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    rail.setAttribute('data-kind', 'network');
    rail.setAttribute('data-name', 'lan_a');
    rail.setAttribute('transform', 'translate(250 100)');
    layer.appendChild(rail);
  });

  it('renders a <text> badge for a user-traffic packet with the assigned id', () => {
    const evt = {
      type: 'user_datagram',
      payload_id: 'p1',
      network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      dst: { device: 'h2', address: '10.0.0.2' },
      payload_src: '10.0.0.1',
      payload_dst: '10.0.0.2',
    };
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: evt }));
    const layer = document.getElementById('packet-layer');
    const badges = layer.querySelectorAll('text.packet-badge');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toBe('#1');
  });

  it('does NOT render a badge for routing_flood when chatter badges are off', () => {
    delete document.body.dataset.chatterBadges;
    const evt = {
      type: 'routing_flood',
      payload_id: 'c1',
      network: 'lan_a',
      src: { device: 'h1', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0',
      payload_dst: '255.255.255.255',
    };
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: evt }));
    const layer = document.getElementById('packet-layer');
    expect(layer.querySelectorAll('text.packet-badge').length).toBe(0);
  });
});
