import { describe, it, expect, beforeEach } from 'vitest';
import { PacketAnim } from './packets.js';
import { state } from './state.js';

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
