import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PacketAnim, showPacketTooltip, hidePacketTooltip } from './packets.js';
import { state, bus, applyInterfaceStateChanged, resetDownState } from './state.js';

// PacketAnim tweens run on real wall-clock rAF loops. A test that starts an
// animation without awaiting its completion leaves it ticking; under load its
// later phases can fire a stale sim:packet-arrived into a subsequent test's
// measurement window. Resetting after each test bumps the generation, which
// aborts any in-flight tween before it can finish.
afterEach(() => {
  PacketAnim._reset();
});

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
    // _segLength now calls s.from()/s.to() as thunks.
    const len = PacketAnim._segLength({ kind: 'line', from: () => ({ x: 0, y: 0 }), to: () => ({ x: 3, y: 4 }) });
    expect(len).toBe(5);
  });

  it('_segLength returns chord-ish length for a bezier (always >= chord, within 15%)', () => {
    const p0 = { x: 0, y: 0 };
    const p3 = { x: 100, y: 60 };
    const { c1, c2 } = PacketAnim._bezBetween(p0, p3);
    const chord = Math.hypot(100, 60);
    // _segLength now calls s.curve() as a thunk.
    const len = PacketAnim._segLength({ kind: 'bez', curve: () => ({ p0, c1, c2, p3 }) });
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
    // The bezier is a live thunk — evaluate it to access the curve points.
    const curve = segs[0].curve();
    // The bezier should land near r2's clipped boundary, not at r2's center.
    expect(curve.p3.x).toBeGreaterThan(100);
    expect(curve.p3.x).toBeLessThan(400);
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
    // The bezier is a live thunk — evaluate it to access the curve points.
    expect(lastBez.curve().p3.x).toBeLessThan(300);
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
    // The bezier is a live thunk — evaluate it to access the curve points.
    // p3.x should be near r3's clipped left edge (around 668), NOT near h5's center (400).
    expect(segs[0].curve().p3.x).toBeGreaterThan(500);
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

describe('PacketAnim — finish dispatches sim:packet-arrived for chatter on a Network (T32)', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._lastChatter.clear();
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g data-kind="network" data-name="lan_a" transform="translate(250 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.networks = { lan_a: { cidr: '10.0.0.0/24', x: 250, y: 100 } };
    state.hosts = {};
    state.routers = { r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 } } } };
    state.links = {};
  });

  it('finish() dispatches sim:packet-arrived for chatter on a Network (broadcast, no dst device)', async () => {
    const arrivedSpy = vi.fn();
    bus.addEventListener('sim:packet-arrived', arrivedSpy);

    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
        type: 'routing_flood', payload_id: 'msg-1', network: 'lan_a',
        src: { device: 'r1', iface: 'eth0', address: '10.0.0.254' },
        dst: { device: null, address: '255.255.255.255' },
        payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
      } }));

      // Wait for the 1ms tween to complete.
      await new Promise(r => setTimeout(r, 80));

      // Arrival should have fired exactly once with the composite key, device:null.
      const chatterArrivals = arrivedSpy.mock.calls
        .map(c => c[0].detail)
        .filter(d => d.payloadId && d.payloadId.startsWith('msg-1|'));
      expect(chatterArrivals.length).toBe(1);
      expect(chatterArrivals[0].device).toBe(null);

      // Chatter store row should be gone (deleted by the arrival handler).
      expect(PacketStore.chatter.size).toBe(0);
    } finally {
      PacketAnim.DURATION_MS = origDur;
      bus.removeEventListener('sim:packet-arrived', arrivedSpy);
    }
  });
});

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

describe('PacketAnim — finish removes badges added by live toggle', () => {
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

  it('finish() removes a badge that was added by live toggle (real frame)', async () => {
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
        type: 'routing_flood', payload_id: 'c1', network: 'lan_a',
        src: { device: 'h1', address: '0.0.0.0' },
        dst: { device: null, address: '255.255.255.255' },
        payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
      } }));
      const layer = document.getElementById('packet-layer');
      // No badge yet — chatter badges are off.
      expect(layer.querySelectorAll('text.packet-badge').length).toBe(0);

      // Live-toggle adds a badge to the in-flight dot.
      document.body.dataset.chatterBadges = 'on';
      bus.dispatchEvent(new CustomEvent('packets:chatter-badges-changed'));
      expect(layer.querySelectorAll('text.packet-badge').length).toBe(1);

      // Wait long enough for the 1ms tween to fully complete.
      await new Promise(r => setTimeout(r, 80));
      // The dot finished — the toggle-added badge should be gone too.
      expect(layer.querySelectorAll('text.packet-badge').length).toBe(0);
    } finally {
      PacketAnim.DURATION_MS = origDur;
    }
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


describe('PacketAnim — throttled chatter does not dispatch arrival', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._lastChatter.clear();
    PacketAnim.muted = false;
    delete document.body.dataset.chatterBadges;
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g data-kind="network" data-name="lan_a" transform="translate(250 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.networks = { lan_a: { cidr: '10.0.0.0/24', x: 250, y: 100 } };
    state.hosts = {};
    state.routers = { r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 } } } };
    state.links = {};
  });

  function chatter(payloadId) {
    return {
      type: 'routing_flood', payload_id: payloadId, network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
    };
  }

  it('a same-message re-emission is throttled and does not dispatch arrival', () => {
    // First emission of p1 from r1/lan_a passes through and animates.
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatter('p1') }));
    expect(PacketStore.chatter.size).toBe(1);

    // Spy on sim:packet-arrived BEFORE the throttled re-emission.
    const spy = vi.fn();
    bus.addEventListener('sim:packet-arrived', spy);

    // The protocol re-floods the SAME message back through the origin iface
    // within 200ms — same composite key. It's throttled, and throttling must
    // NOT dispatch arrival, which would wipe the original's still-animating row.
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatter('p1') }));

    expect(spy).not.toHaveBeenCalled();
    expect(PacketStore.chatter.has('p1|r1|eth0|lan_a')).toBe(true);
  });

  it('dispatches sim:packet-arrived for muted chatter so the store cleans up', () => {
    PacketAnim.muted = true;
    const spy = vi.fn();
    bus.addEventListener('sim:packet-arrived', spy);

    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatter('p1') }));

    const compositeP1 = 'p1|r1|eth0|lan_a';
    const arrivalDetails = spy.mock.calls.map(c => c[0].detail);
    expect(arrivalDetails.some(d => d.payloadId === compositeP1 && d.device === null)).toBe(true);
    expect(PacketStore.chatter.has(compositeP1)).toBe(false);
  });
});

describe('PacketAnim — throttle preserves distinct chatter messages', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._lastChatter.clear();
    PacketAnim.muted = false;
    delete document.body.dataset.chatterBadges;
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g data-kind="router" data-name="r2" transform="translate(300 100)"></g>
        <g data-kind="network" data-name="lan_a" transform="translate(200 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.networks = { lan_a: { cidr: '10.0.0.0/24', x: 200, y: 100 } };
    state.hosts = {};
    state.routers = {
      r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.1', cost: 5 } } },
      r2: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.2', cost: 5 } } },
    };
    state.links = {};
  });

  function chatter(payloadId, device = 'r1', iface = 'eth0', network = 'lan_a') {
    return {
      type: 'routing_flood', payload_id: payloadId, network,
      src: { device, iface, address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
    };
  }

  // Bug: with no jitter, three routers' keepalive ticks overlap and re-floods
  // of one router's message arrive on a neighbor's (device, network) slot
  // before that neighbor originates its own message. The (device, network)
  // throttle then drops the neighbor's origination — even though it's a
  // *distinct* logical message (different payload_id).
  it('keeps distinct payload_ids from the same (device, network) within 200ms', () => {
    // First emission: r1 re-floods someone else's message on lan_a.
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatter('reflood-msg') }));
    expect(PacketStore.chatter.has('reflood-msg|r1|eth0|lan_a')).toBe(true);

    // 11ms later: r1's own keepalive originates a *different* message on lan_a.
    // The 200ms throttle keyed by (r1, lan_a) currently drops this — wrong,
    // because it's a logically distinct message with its own payload_id.
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatter('origination-msg') }));

    expect(PacketStore.chatter.has('reflood-msg|r1|eth0|lan_a')).toBe(true);
    expect(PacketStore.chatter.has('origination-msg|r1|eth0|lan_a')).toBe(true);
    expect(PacketStore.chatter.size).toBe(2);
  });

  // Bug: the routing protocol re-floods a message back into its origin iface
  // (because the LSDB dedup starts at -1, so the originator doesn't recognize
  // its own message coming back). The SPA sees a second
  // sim:packet with the *same* composite key as the original. The throttle
  // path's sim:packet-arrived dispatch deletes the original's row.
  it('does not delete the original row when a re-emission shares its composite key', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatter('msg-1') }));
    const composite = 'msg-1|r1|eth0|lan_a';
    expect(PacketStore.chatter.has(composite)).toBe(true);

    // Simulates the protocol's self-reflood loop: same payload_id arrives on
    // the same (device, iface, network) a second time.
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatter('msg-1') }));

    expect(PacketStore.chatter.has(composite)).toBe(true);
  });
});

describe('PacketAnim._chatterAllowed — throttle keys on message identity', () => {
  beforeEach(() => { PacketAnim._lastChatter.clear(); });

  function flood(payloadId, device = 'r1', network = 'lan_a') {
    return { type: 'routing_flood', payload_id: payloadId, network, src: { device, iface: 'eth0' } };
  }

  it('allows distinct payload_ids from the same device+network within 200ms', () => {
    // A router re-floods several distinct LSAs out one interface in a burst —
    // each is a real message and must be allowed to animate.
    expect(PacketAnim._chatterAllowed(flood('lsa-a'))).toBe(true);
    expect(PacketAnim._chatterAllowed(flood('lsa-b'))).toBe(true);
    expect(PacketAnim._chatterAllowed(flood('lsa-c'))).toBe(true);
  });

  it('throttles a repeat of the same payload_id within 200ms', () => {
    expect(PacketAnim._chatterAllowed(flood('lsa-a'))).toBe(true);
    expect(PacketAnim._chatterAllowed(flood('lsa-a'))).toBe(false);
  });
});

describe('PacketAnim — dot-appeared signal', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._lastChatter.clear();
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g data-kind="host" data-name="h1" transform="translate(100 100)"></g>
        <g data-kind="host" data-name="h2" transform="translate(400 100)"></g>
        <g data-kind="network" data-name="lan_a" transform="translate(250 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.networks = { lan_a: { cidr: '10.0.0.0/24', x: 250, y: 100 } };
    state.hosts = {
      h1: { address: '10.0.0.1', network: 'lan_a', x: 100, y: 100 },
      h2: { address: '10.0.0.2', network: 'lan_a', x: 400, y: 100 },
    };
    state.routers = {};
    state.links = {};
  });

  it('dispatches packets:dot-appeared after rendering the dot', () => {
    const spy = vi.fn();
    bus.addEventListener('packets:dot-appeared', spy);
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram', payload_id: 'p1', network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      dst: { device: 'h2', address: '10.0.0.2' },
      payload_src: '10.0.0.1', payload_dst: '10.0.0.2',
    } }));
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0].detail.payloadId).toBe('p1');
  });
});

describe('PacketAnim — colour map covers hello and routing_flood', () => {
  it('routing_flood has a colour entry', () => {
    expect(PacketAnim.COLORS['routing_flood']).toBeDefined();
    expect(PacketAnim.COLORS['routing_flood'].fill).toBeTruthy();
  });

  it('hello has a colour entry distinct from routing_flood', () => {
    expect(PacketAnim.COLORS['hello']).toBeDefined();
    expect(PacketAnim.COLORS['hello'].fill).toBeTruthy();
    expect(PacketAnim.COLORS['hello'].fill).not.toBe(PacketAnim.COLORS['routing_flood'].fill);
  });

  it('hello and routing_flood are listed in _ROUTING_CHATTER_TYPES', () => {
    expect(PacketAnim._ROUTING_CHATTER_TYPES.has('hello')).toBe(true);
    expect(PacketAnim._ROUTING_CHATTER_TYPES.has('routing_flood')).toBe(true);
  });
});

describe('PacketAnim — hello chatter mute/throttle branches', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._lastChatter.clear();
    PacketAnim.muted = false;
    delete document.body.dataset.chatterBadges;
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g data-kind="network" data-name="lan_a" transform="translate(250 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.networks = { lan_a: { cidr: '10.0.0.0/24', x: 250, y: 100 } };
    state.hosts = {};
    state.routers = { r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 } } } };
    state.links = {};
  });

  function helloEvt(payloadId) {
    return {
      type: 'hello', payload_id: payloadId, network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
    };
  }

  it('dispatches sim:packet-arrived for muted hello so the store cleans up', () => {
    PacketAnim.muted = true;
    const spy = vi.fn();
    bus.addEventListener('sim:packet-arrived', spy);
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: helloEvt('h1') }));
    const arrivals = spy.mock.calls.map(c => c[0].detail);
    expect(arrivals.some(d => d.payloadId && d.payloadId.startsWith('h1|') && d.device === null)).toBe(true);
    PacketAnim.muted = false;
    bus.removeEventListener('sim:packet-arrived', spy);
  });

  it('hello chatter badge uses #R prefix when chatter badges are on', () => {
    document.body.dataset.chatterBadges = 'on';
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: helloEvt('h1') }));
    const layer = document.getElementById('packet-layer');
    const badges = layer.querySelectorAll('text.packet-badge');
    expect(badges.length).toBeGreaterThanOrEqual(1);
    expect(badges[0].textContent).toMatch(/^#R/);
  });
});

describe('PacketAnim — LSA flooding is sequenced per-hop', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._lastChatter.clear();
    PacketAnim._lsaArrivedAt.clear();
    PacketAnim._lsaPending.clear();
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g data-kind="router" data-name="r2" transform="translate(250 100)"></g>
        <g data-kind="router" data-name="r3" transform="translate(400 100)"></g>
        <g data-kind="network" data-name="lan_a" transform="translate(175 200)"></g>
        <g data-kind="network" data-name="lan_b" transform="translate(325 200)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.networks = {
      lan_a: { cidr: '10.0.0.0/24', x: 175, y: 200 },
      lan_b: { cidr: '10.0.1.0/24', x: 325, y: 200 },
    };
    state.hosts = {};
    state.routers = {
      r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.1', cost: 1 } } },
      r2: { interfaces: {
        eth0: { network: 'lan_a', address: '10.0.0.2', cost: 1 },
        eth1: { network: 'lan_b', address: '10.0.1.1', cost: 1 },
      } },
      r3: { interfaces: { eth0: { network: 'lan_b', address: '10.0.1.2', cost: 1 } } },
    };
    state.links = {};
  });

  function originEvt() {
    return {
      type: 'routing_flood', payload_id: 'lsa-x', network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '10.0.0.1' },
      dst: { device: null, address: '10.0.0.255' },
      payload_src: '10.0.0.1', payload_dst: '10.0.0.255',
      payload: { originator: 'r1', seq: 7, destinations: [] },
    };
  }

  function refloodEvt() {
    return {
      type: 'routing_flood', payload_id: 'lsa-x', network: 'lan_b',
      src: { device: 'r2', iface: 'eth1', address: '10.0.1.1' },
      dst: { device: null, address: '10.0.1.255' },
      payload_src: '10.0.1.1', payload_dst: '10.0.1.255',
      payload: { originator: 'r1', seq: 7, destinations: [] },
    };
  }

  it('plays origin emission immediately (sender === originator)', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: originEvt() }));
    const layer = document.getElementById('packet-layer');
    expect(layer.querySelectorAll('rect').length).toBe(1);
    expect(PacketAnim._lsaPending.size).toBe(0);
  });

  it('queues re-flood (sender !== originator) until inbound arrives at the re-flooder', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: refloodEvt() }));
    const layer = document.getElementById('packet-layer');
    // Re-flood is held back: no dot rendered yet
    expect(layer.querySelectorAll('rect').length).toBe(0);
    expect(PacketAnim._lsaPending.get('lsa-x|r2')).toHaveLength(1);
  });

  it('drains the queue once the origin emission arrives at the re-flooder', async () => {
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: refloodEvt() }));
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: originEvt() }));
      // Wait for the origin emission's 1ms tween to complete; finish() should
      // then mark r2 as having received and dispatch the queued re-flood.
      await new Promise(r => setTimeout(r, 80));
      // Both animations are now done; the queue should be empty and there
      // should be no remaining dots.
      expect(PacketAnim._lsaPending.has('lsa-x|r2')).toBe(false);
      expect(PacketAnim._lsaArrivedAt.has('lsa-x|r2')).toBe(true);
    } finally {
      PacketAnim.DURATION_MS = origDur;
    }
  });

  it('plays re-flood immediately if origin already arrived at the re-flooder', () => {
    // Simulate prior arrival
    PacketAnim._lsaArrivedAt.add('lsa-x|r2');
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: refloodEvt() }));
    const layer = document.getElementById('packet-layer');
    expect(layer.querySelectorAll('rect').length).toBe(1);
    expect(PacketAnim._lsaPending.size).toBe(0);
  });

  it('clears LSA arrival/pending state when the sim goes idle', () => {
    PacketAnim._lsaArrivedAt.add('lsa-x|r2');
    PacketAnim._lsaPending.set('lsa-y|r3', [refloodEvt()]);
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'idle' } }));
    expect(PacketAnim._lsaArrivedAt.size).toBe(0);
    expect(PacketAnim._lsaPending.size).toBe(0);
  });

  it('empties the packet layer when the sim goes idle so nothing dangles', () => {
    // Simulate dots/badges left in flight (or frozen by a pause) at stop time.
    const layer = document.getElementById('packet-layer');
    layer.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'rect'));
    layer.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'text'));
    PacketAnim._lastChatter.set('r1:lan_a:lsa-x', 123);
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'idle' } }));
    expect(layer.children.length).toBe(0);
    expect(PacketAnim._lastChatter.size).toBe(0);
  });

  it('force-renders a deferred re-flood whose inbound never arrives (no strand)', async () => {
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;   // fallback floor is max(3, 100) = 100ms
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: refloodEvt() }));
      // Deferred: held in _lsaPending, nothing rendered, no arrival will come.
      expect(PacketAnim._lsaPending.get('lsa-x|r2')).toHaveLength(1);
      await new Promise(r => setTimeout(r, 160));   // past the fallback floor
      // The fallback force-rendered it, draining the queue.
      expect(PacketAnim._lsaPending.has('lsa-x|r2')).toBe(false);
    } finally {
      PacketAnim.DURATION_MS = origDur;
    }
  });

  it('an in-flight fan-out does not repopulate the layer after the sim goes idle', async () => {
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 40;   // phase-1 ≈ 12ms
    try {
      // r1 floods lan_a (broadcast); r2 listens there, so a fan-out clone is
      // spawned in the phase-1 completion callback.
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: originEvt() }));
      // Go idle mid phase-1: the layer is cleared and the generation bumped.
      await new Promise(r => setTimeout(r, 3));
      bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'idle' } }));
      // Let the (now-stale) phase-1 callback run; it must NOT spawn clones.
      await new Promise(r => setTimeout(r, 80));
      const layer = document.getElementById('packet-layer');
      expect(layer.querySelectorAll('rect').length).toBe(0);
    } finally {
      PacketAnim.DURATION_MS = origDur;
    }
  });

  it('going idle mid-animation aborts in-flight tweens — no stale arrival fires afterwards', async () => {
    const arrivedSpy = vi.fn();
    bus.addEventListener('sim:packet-arrived', arrivedSpy);
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 80;   // long enough to still be mid-flight at idle
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: originEvt() }));
      await new Promise(r => setTimeout(r, 5));   // mid phase-1
      // Sim stops: the layer is cleared and the generation bumped. The tween
      // still in flight must abort silently — it must NOT run to completion
      // and dispatch a (now-stale) arrival into a later run/test.
      bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'idle' } }));
      arrivedSpy.mockClear();   // ignore anything dispatched before the stop
      await new Promise(r => setTimeout(r, 200));   // well past the full duration
      expect(arrivedSpy).not.toHaveBeenCalled();
    } finally {
      PacketAnim.DURATION_MS = origDur;
      bus.removeEventListener('sim:packet-arrived', arrivedSpy);
    }
  });

  it('broadcast chatter fans out: each clone fires arrival with the listener device, not null', async () => {
    const arrivedSpy = vi.fn();
    bus.addEventListener('sim:packet-arrived', arrivedSpy);
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: originEvt() }));
      await new Promise(r => setTimeout(r, 120));
      // Match on the exact dotKey for r1's origin emission so leftover
      // animations from earlier tests (which share payload_id 'lsa-x' but
      // are emitted from different src/iface/network) don't get counted.
      const arrivals = arrivedSpy.mock.calls
        .map(c => c[0].detail)
        .filter(d => d.payloadId === 'lsa-x|r1|eth0|lan_a');
      // r1 broadcasts on lan_a; only r2 listens there. Expect exactly one
      // arrival, naming r2 as the device.
      expect(arrivals.length).toBe(1);
      expect(arrivals[0].device).toBe('r2');
    } finally {
      PacketAnim.DURATION_MS = origDur;
      bus.removeEventListener('sim:packet-arrived', arrivedSpy);
    }
  });

  it('drains the reflood queue only after the matching listener visually receives', async () => {
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      // Reflood from r2 arrives first, then the origin emit from r1.
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: refloodEvt() }));
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: originEvt() }));
      // Before the origin clone arrives at r2, the reflood is still pending.
      expect(PacketAnim._lsaPending.get('lsa-x|r2')).toHaveLength(1);
      // Wait long enough for the origin fan-out clone to reach r2.
      await new Promise(r => setTimeout(r, 120));
      expect(PacketAnim._lsaArrivedAt.has('lsa-x|r2')).toBe(true);
      expect(PacketAnim._lsaPending.has('lsa-x|r2')).toBe(false);
    } finally {
      PacketAnim.DURATION_MS = origDur;
    }
  });

  it('broadcast chatter with multiple listeners spawns one arrival per listener', async () => {
    // Add a second listener on lan_a so r1's broadcast reaches both.
    state.routers.rExtra = {
      interfaces: { eth0: { network: 'lan_a', address: '10.0.0.99', cost: 1 } },
    };
    document.querySelector('#nodes-layer').insertAdjacentHTML(
      'beforeend',
      '<g data-kind="router" data-name="rExtra" transform="translate(120 50)"></g>',
    );
    const arrivedSpy = vi.fn();
    bus.addEventListener('sim:packet-arrived', arrivedSpy);
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: originEvt() }));
      await new Promise(r => setTimeout(r, 120));
      const devices = arrivedSpy.mock.calls
        .map(c => c[0].detail)
        .filter(d => d.payloadId === 'lsa-x|r1|eth0|lan_a')
        .map(d => d.device);
      expect(devices.sort()).toEqual(['r2', 'rExtra']);
    } finally {
      PacketAnim.DURATION_MS = origDur;
      bus.removeEventListener('sim:packet-arrived', arrivedSpy);
    }
  });

  it('broadcast chatter with no listeners still animates to the rail and fires one arrival', async () => {
    // Strip every router/host off lan_a except the sender r1.
    delete state.routers.r2;
    delete state.routers.r3;
    const arrivedSpy = vi.fn();
    bus.addEventListener('sim:packet-arrived', arrivedSpy);
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: originEvt() }));
      await new Promise(r => setTimeout(r, 80));
      const arrivals = arrivedSpy.mock.calls
        .map(c => c[0].detail)
        .filter(d => d.payloadId === 'lsa-x|r1|eth0|lan_a');
      // No listeners: just the single src→tap arrival, device unresolved.
      expect(arrivals.length).toBe(1);
      expect(arrivals[0].device).toBe(null);
    } finally {
      PacketAnim.DURATION_MS = origDur;
      bus.removeEventListener('sim:packet-arrived', arrivedSpy);
    }
  });

  it('fan-out clones clean up a badge added by live toggle mid-flight (no strand)', async () => {
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 100;   // phase-1 ≈ 30ms, phase-2 ≈ 70ms
    delete document.body.dataset.chatterBadges;   // start with badges off
    try {
      // Chatter badges start off. r1 broadcasts on lan_a → r2 is a listener,
      // so this renders through the broadcast fan-out (clone per listener).
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: originEvt() }));
      const layer = document.getElementById('packet-layer');

      // Let phase-1 finish so the source dot is retired and a listener clone
      // is now mid phase-2.
      await new Promise(r => setTimeout(r, 45));
      expect(layer.querySelectorAll('text.packet-badge').length).toBe(0);

      // User toggles chatter badges on while the clone is in flight.
      document.body.dataset.chatterBadges = 'on';
      bus.dispatchEvent(new CustomEvent('packets:chatter-badges-changed'));
      expect(layer.querySelectorAll('text.packet-badge').length).toBeGreaterThanOrEqual(1);

      // Once the fan-out completes, the toggle-added badge must be gone too —
      // it must not strand on the canvas after its dot is removed.
      await new Promise(r => setTimeout(r, 160));
      expect(layer.querySelectorAll('rect').length).toBe(0);
      expect(layer.querySelectorAll('text.packet-badge').length).toBe(0);
    } finally {
      PacketAnim.DURATION_MS = origDur;
      delete document.body.dataset.chatterBadges;
    }
  });

  it('Hello chatter is not affected by LSA sequencing (plays immediately)', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'hello', payload_id: 'h1', network: 'lan_a',
      src: { device: 'r2', iface: 'eth0', address: '10.0.0.2' },
      dst: { device: null, address: '10.0.0.255' },
      payload_src: '10.0.0.2', payload_dst: '10.0.0.255',
      payload: { originator: 'r2', neighbors_heard: [] },
    } }));
    const layer = document.getElementById('packet-layer');
    expect(layer.querySelectorAll('rect').length).toBe(1);
    expect(PacketAnim._lsaPending.size).toBe(0);
  });
});

describe('PacketAnim — ping -c probes animate sequentially (one round-trip at a time)', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._reset();   // clears the sequencing queues + flow→session memo
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node host" data-kind="host" data-name="h1" transform="translate(100 100)"></g>
        <g class="node host" data-kind="host" data-name="h2" transform="translate(400 100)"></g>
        <g class="node network" data-kind="network" data-name="lan_a" transform="translate(250 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.networks = { lan_a: { cidr: '10.0.0.0/24', x: 250, y: 100 } };
    state.hosts = {
      h1: { address: '10.0.0.1', network: 'lan_a', x: 100, y: 100 },
      h2: { address: '10.0.0.2', network: 'lan_a', x: 400, y: 100 },
    };
    state.routers = {};
    state.links = {};
  });

  // Each ping -c probe is a distinct conversation (its own flow_key/payload_id),
  // but the user wants probe N+1 to leave only after probe N's round-trip ends.
  function probe(flow, payloadId, dstAddr = '10.0.0.2') {
    return {
      type: 'ping_request', payload_id: payloadId, flow, network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      dst: { address: dstAddr },
      payload_src: '10.0.0.1', payload_dst: dstAddr,
    };
  }

  it('holds back a second probe with a distinct flow but the same endpoints', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: probe('f1', 'p1') }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: probe('f2', 'p2') }));
    const layer = document.getElementById('packet-layer');
    // Only the first probe animates; the second waits in its session queue.
    expect(layer.querySelectorAll('rect').length).toBe(1);
  });

  it('animates probes to different destinations in parallel (distinct sessions)', () => {
    state.hosts.h3 = { address: '10.0.0.3', network: 'lan_a', x: 400, y: 300 };
    document.querySelector('#nodes-layer').insertAdjacentHTML('beforeend',
      '<g class="node host" data-kind="host" data-name="h3" transform="translate(400 300)"></g>');
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: probe('f1', 'p1', '10.0.0.2') }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: probe('f3', 'p3', '10.0.0.3') }));
    const layer = document.getElementById('packet-layer');
    expect(layer.querySelectorAll('rect').length).toBe(2);
  });
});

describe('PacketAnim — packets to a down interface drop at the link entry', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._reset();
    resetDownState();
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node host" data-kind="host" data-name="h1" transform="translate(100 100)"></g>
        <g class="node router" data-kind="router" data-name="r1" transform="translate(400 100)"></g>
        <g class="node network" data-kind="network" data-name="lan_a" transform="translate(250 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.networks = { lan_a: { cidr: '10.0.0.0/24', x: 250, y: 100 } };
    state.hosts = { h1: { address: '10.0.0.1', network: 'lan_a', x: 100, y: 100 } };
    state.routers = { r1: { x: 400, y: 100, interfaces: {
      eth0: { network: 'lan_a', address: '10.0.0.254', cost: 1 } } } };
    state.links = {};
  });

  function pingToR1() {
    return {
      type: 'ping_request', payload_id: 'p1', flow: 'f1', network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      dst: { address: '10.0.0.254' },
      payload_src: '10.0.0.1', payload_dst: '10.0.0.254',
    };
  }

  it('a ping to a DOWN router interface fades at the entry and never arrives at the router', async () => {
    applyInterfaceStateChanged({ device: 'r1', interface: 'eth0', up: false });
    const arrivedSpy = vi.fn();
    bus.addEventListener('sim:packet-arrived', arrivedSpy);
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: pingToR1() }));
      await new Promise(r => setTimeout(r, 400));   // past the 260ms drop fade
      const arrivals = arrivedSpy.mock.calls.map(c => c[0].detail).filter(d => d.payloadId === 'p1');
      // Exactly one arrival, and it must NOT name r1 — the packet was dropped.
      expect(arrivals.length).toBe(1);
      expect(arrivals[0].device).toBe(null);
      // The dot is gone after the fade.
      expect(document.getElementById('packet-layer').querySelectorAll('rect').length).toBe(0);
    } finally {
      PacketAnim.DURATION_MS = origDur;
      bus.removeEventListener('sim:packet-arrived', arrivedSpy);
    }
  });

  it('a ping to an UP router interface still arrives at the router', async () => {
    const arrivedSpy = vi.fn();
    bus.addEventListener('sim:packet-arrived', arrivedSpy);
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: pingToR1() }));
      await new Promise(r => setTimeout(r, 120));
      const arrivals = arrivedSpy.mock.calls.map(c => c[0].detail).filter(d => d.payloadId === 'p1');
      expect(arrivals.some(d => d.device === 'r1')).toBe(true);
    } finally {
      PacketAnim.DURATION_MS = origDur;
      bus.removeEventListener('sim:packet-arrived', arrivedSpy);
    }
  });
});

describe('PacketAnim — packets to a down p2p peer drop on the link', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._reset();
    resetDownState();
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node router" data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g class="node router" data-kind="router" data-name="r2" transform="translate(400 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 250, y: 100 } };
    state.routers = {
      r1: { x: 100, y: 100, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 1 } } },
      r2: { x: 400, y: 100, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.2', cost: 1 } } },
    };
    state.hosts = {};
    state.networks = {};
  });

  it('drops a ping across the link when the peer interface is down', async () => {
    applyInterfaceStateChanged({ device: 'r2', interface: 'eth0', up: false });
    const arrivedSpy = vi.fn();
    bus.addEventListener('sim:packet-arrived', arrivedSpy);
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
        type: 'ping_request', payload_id: 'lp', flow: 'lf', network: 'p2p1',
        src: { device: 'r1', address: '10.0.0.1' },
        dst: { address: '10.0.0.2' },
        payload_src: '10.0.0.1', payload_dst: '10.0.0.2',
      } }));
      await new Promise(r => setTimeout(r, 400));
      const arrivals = arrivedSpy.mock.calls.map(c => c[0].detail).filter(d => d.payloadId === 'lp');
      expect(arrivals.length).toBe(1);
      expect(arrivals[0].device).toBe(null);
      expect(document.getElementById('packet-layer').querySelectorAll('rect').length).toBe(0);
    } finally {
      PacketAnim.DURATION_MS = origDur;
      bus.removeEventListener('sim:packet-arrived', arrivedSpy);
    }
  });
});

describe('PacketAnim — routing chatter is also dropped at a down link', () => {
  beforeEach(() => {
    PacketStore._reset();
    PacketAnim._reset();
    resetDownState();
  });

  it('drops an LSA crossing a down p2p link instead of reaching the peer', async () => {
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node router" data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g class="node router" data-kind="router" data-name="r2" transform="translate(400 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 250, y: 100 } };
    state.routers = {
      r1: { x: 100, y: 100, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 1 } } },
      r2: { x: 400, y: 100, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.2', cost: 1 } } },
    };
    state.hosts = {}; state.networks = {};
    applyInterfaceStateChanged({ device: 'r2', interface: 'eth0', up: false });
    const arrivedSpy = vi.fn();
    bus.addEventListener('sim:packet-arrived', arrivedSpy);
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
        type: 'routing_flood', payload_id: 'lsaD', network: 'p2p1',
        src: { device: 'r1', iface: 'eth0', address: '10.0.0.1' },
        dst: { address: '10.0.0.2' },
        payload_src: '10.0.0.1', payload_dst: '10.0.0.2',
        payload: { originator: 'r1', seq: 1, destinations: [] },
      } }));
      await new Promise(r => setTimeout(r, 400));
      const arr = arrivedSpy.mock.calls.map(c => c[0].detail)
        .filter(d => d.payloadId && String(d.payloadId).startsWith('lsaD'));
      expect(arr.length).toBe(1);
      expect(arr[0].device).toBe(null);   // never reached r2
      expect(document.getElementById('packet-layer').querySelectorAll('rect').length).toBe(0);
    } finally {
      PacketAnim.DURATION_MS = origDur;
      bus.removeEventListener('sim:packet-arrived', arrivedSpy);
    }
  });

  it('does not fan a broadcast LSA out to a listener whose interface is down', async () => {
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node router" data-kind="router" data-name="r1" transform="translate(100 100)"></g>
        <g class="node router" data-kind="router" data-name="r2" transform="translate(250 200)"></g>
        <g class="node router" data-kind="router" data-name="r3" transform="translate(400 200)"></g>
        <g class="node network" data-kind="network" data-name="lan_a" transform="translate(250 100)"></g>
      </g><g id="packet-layer"></g></svg>`;
    state.networks = { lan_a: { cidr: '10.0.0.0/24', x: 250, y: 100 } };
    state.links = {}; state.hosts = {};
    state.routers = {
      r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.1', cost: 1 } } },
      r2: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.2', cost: 1 } } },
      r3: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.3', cost: 1 } } },
    };
    applyInterfaceStateChanged({ device: 'r2', interface: 'eth0', up: false });
    const arrivedSpy = vi.fn();
    bus.addEventListener('sim:packet-arrived', arrivedSpy);
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 1;
    try {
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
        type: 'routing_flood', payload_id: 'lsaB', network: 'lan_a',
        src: { device: 'r1', iface: 'eth0', address: '10.0.0.1' },
        dst: { device: null, address: '10.0.0.255' },
        payload_src: '10.0.0.1', payload_dst: '10.0.0.255',
        payload: { originator: 'r1', seq: 1, destinations: [] },
      } }));
      await new Promise(r => setTimeout(r, 120));
      const devices = arrivedSpy.mock.calls.map(c => c[0].detail)
        .filter(d => d.payloadId === 'lsaB|r1|eth0|lan_a')
        .map(d => d.device);
      expect(devices).toContain('r3');     // up listener receives
      expect(devices).not.toContain('r2'); // down listener does not
    } finally {
      PacketAnim.DURATION_MS = origDur;
      bus.removeEventListener('sim:packet-arrived', arrivedSpy);
    }
  });
});

describe('PacketAnim — _lastChatter and _lsaArrivedAt are bounded (H17)', () => {
  beforeEach(() => {
    PacketAnim._reset();
  });

  it('_lastChatter stays bounded when many distinct chatter payload_ids are seen', () => {
    // Drive 2000 distinct chatter keys through _chatterAllowed (which sets _lastChatter).
    // Without a cap the map grows to 2000; with a cap it must stay <= _LAST_CHATTER_LIMIT.
    const N = 2000;
    for (let i = 0; i < N; i++) {
      PacketAnim._chatterAllowed({
        type: 'routing_flood',
        payload_id: `lsa-${i}`,
        network: 'lan_a',
        src: { device: 'r1', iface: 'eth0' },
      });
    }
    expect(PacketAnim._lastChatter.size).toBeLessThanOrEqual(PacketAnim._LAST_CHATTER_LIMIT);
  });

  it('_lastChatter still deduplicates recent repeated entries (dedup intact after cap)', () => {
    // After driving many keys in, a same-key repeat within 200ms must still be throttled.
    const N = 500;
    for (let i = 0; i < N; i++) {
      PacketAnim._chatterAllowed({
        type: 'routing_flood', payload_id: `lsa-${i}`,
        network: 'lan_a', src: { device: 'r1', iface: 'eth0' },
      });
    }
    // The most recent key should still be in the map and cause throttling.
    const recent = `lsa-${N - 1}`;
    const allowed = PacketAnim._chatterAllowed({
      type: 'routing_flood', payload_id: recent,
      network: 'lan_a', src: { device: 'r1', iface: 'eth0' },
    });
    expect(allowed).toBe(false); // throttled — same key within 200ms
  });

  it('_lsaArrivedAt stays bounded when many distinct payload/device combos are marked', () => {
    // Drive 2000 distinct (payloadId, device) pairs through _markLSAArrivedAt.
    // Without a cap the set grows to 2000; with a cap it must stay <= _LSA_ARRIVED_LIMIT.
    const N = 2000;
    for (let i = 0; i < N; i++) {
      PacketAnim._markLSAArrivedAt(`lsa-${i}`, 'r1');
    }
    expect(PacketAnim._lsaArrivedAt.size).toBeLessThanOrEqual(PacketAnim._LSA_ARRIVED_LIMIT);
  });

  it('_lsaArrivedAt still allows a fresh entry after eviction (not a dead set)', () => {
    // Fill past the cap, then add one more. The last entry should be present.
    const N = 2000;
    for (let i = 0; i < N; i++) {
      PacketAnim._markLSAArrivedAt(`lsa-${i}`, 'r1');
    }
    PacketAnim._markLSAArrivedAt('lsa-new', 'r2');
    expect(PacketAnim._lsaArrivedAt.has('lsa-new|r2')).toBe(true);
  });
});

describe('PacketAnim._sessionKey — groups a conversation across probes and NAT', () => {
  beforeEach(() => { PacketAnim._reset(); });

  it('is the unordered endpoint pair, so request and reply share it', () => {
    const k1 = PacketAnim._sessionKey({ flow: 'f1', payload_src: '10.0.0.1', payload_dst: '10.0.0.2' });
    const k2 = PacketAnim._sessionKey({ flow: 'f2', payload_src: '10.0.0.2', payload_dst: '10.0.0.1' });
    expect(k1).toBe(k2);
  });

  it('memoizes by flow so NAT-rewritten later hops keep the original session', () => {
    const first = PacketAnim._sessionKey({ flow: 'fX', payload_src: '192.168.1.10', payload_dst: '8.8.8.8' });
    const natHop = PacketAnim._sessionKey({ flow: 'fX', payload_src: '200.100.0.1', payload_dst: '8.8.8.8' });
    expect(natHop).toBe(first);
  });
});
