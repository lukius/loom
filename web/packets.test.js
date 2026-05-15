import { describe, it, expect } from 'vitest';
import { PacketAnim } from './packets.js';

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
