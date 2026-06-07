// web/terminals.test.js
// Tests for the sim:ping-result bus listener in Terminals.
// Strategy: bypass Terminals.open (it calls Sim.state / toast / DOM body) by
// directly placing a fake terminal element into Terminals._active, then firing
// the bus event and asserting the output line was appended.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bus } from './state.js';
import { Terminals, clampTermPos } from './terminals.js';
import { Sim } from './sim.js';

describe('Terminals.open — restores a saved position within the viewport', () => {
  afterEach(() => {
    Sim.state = 'idle';
    Terminals._active.clear();
    localStorage.removeItem('term.pos.h1');
    document.querySelectorAll('.term').forEach(n => n.remove());
  });

  it('clamps an off-screen saved position back on screen so the header is reachable', () => {
    // A position saved in an earlier session (dragged off-screen) must not
    // reopen out of reach.
    localStorage.setItem('term.pos.h1', JSON.stringify({ x: 99999, y: -99999 }));
    Sim.state = 'running';
    Terminals.open('h1');
    const w = Terminals._active.get('h1');
    expect(w).toBeTruthy();
    const left = parseFloat(w.style.left);
    const top = parseFloat(w.style.top);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(window.innerHeight);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(window.innerWidth);
  });
});

describe('clampTermPos — keeps a dragged terminal header on screen', () => {
  const vw = 1000, vh = 800, w = 400, h = 300, headerH = 28;

  it('clamps the top edge to 0 so the header never goes above the page', () => {
    const { y } = clampTermPos(100, -50, w, h, vw, vh, headerH);
    expect(y).toBe(0);
  });

  it('leaves an in-bounds position unchanged', () => {
    const p = clampTermPos(120, 90, w, h, vw, vh, headerH);
    expect(p).toEqual({ x: 120, y: 90 });
  });

  it('keeps the header reachable: y cannot exceed viewport height minus the header', () => {
    const { y } = clampTermPos(100, 5000, w, h, vw, vh, headerH);
    expect(y).toBe(vh - headerH);
  });

  it('keeps part of the window on screen horizontally', () => {
    expect(clampTermPos(-5000, 100, w, h, vw, vh, headerH).x).toBeGreaterThan(-w);
    expect(clampTermPos(5000, 100, w, h, vw, vh, headerH).x).toBeLessThan(vw);
  });
});

// terminals.js imports Sim from sim.js at module load; vitest resolves it via
// happy-dom.  We only need the bus listener, not the full Sim machinery.
// Suppress the module-level side-effects by mocking the two deps terminals.js
// calls synchronously at import time: Sim.state (accessed in open/applySimState)
// is not touched by the bus listener, so no mock is required for this test suite.

function makeTermWidget(initialText = '') {
  const w = document.createElement('div');
  w.className = 'term';
  const out = document.createElement('pre');
  out.className = 'term-out';
  out.textContent = initialText;
  w.appendChild(out);
  return w;
}

describe('sim:ping-result bus listener — lines paced to the reply animation', () => {
  beforeEach(() => {
    Terminals._active.clear();
    Terminals._pingBuf.clear();
    Terminals._replySeq.clear();
    Terminals._pingArrived.clear();
  });

  afterEach(() => {
    Terminals._active.clear();
    Terminals._pingBuf.clear();
    Terminals._replySeq.clear();
    Terminals._pingArrived.clear();
  });

  const emitReply = (payloadId, seq) =>
    bus.dispatchEvent(new CustomEvent('sim:packet', {
      detail: { type: 'ping_reply', payload_id: payloadId, payload: { seq, request_ts: 0 } },
    }));
  const arriveReply = (payloadId, device) =>
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId, device } }));
  const pingResult = (device, dst, seq, rtt_ms) =>
    bus.dispatchEvent(new CustomEvent('sim:ping-result', { detail: { device, dst, seq, rtt_ms } }));

  it('shows a timeout line immediately (there is no reply to wait for)', () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);
    pingResult('h1', '10.0.0.2', 2, null);
    expect(w.querySelector('.term-out').textContent).toBe('seq=2 10.0.0.2: timeout\n');
  });

  it('defers a successful line until its reply animates back to the host', () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);
    emitReply('rep1', 1);
    pingResult('h1', '10.0.0.2', 1, 12.3456);
    // Backend already resolved it, but the line waits for the visual reply.
    expect(w.querySelector('.term-out').textContent).toBe('');
    arriveReply('rep1', 'h1');
    expect(w.querySelector('.term-out').textContent).toBe('seq=1 10.0.0.2: time=12.35 ms\n');
  });

  it('flushes successful lines in seq order even if a later reply arrives first', () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);
    emitReply('rep1', 1);
    emitReply('rep2', 2);
    pingResult('h1', '10.0.0.2', 1, 12.0);
    pingResult('h1', '10.0.0.2', 2, 5.0);
    // seq=2's reply arrives first — it must NOT jump ahead of seq=1.
    arriveReply('rep2', 'h1');
    expect(w.querySelector('.term-out').textContent).toBe('');
    arriveReply('rep1', 'h1');
    expect(w.querySelector('.term-out').textContent).toBe(
      'seq=1 10.0.0.2: time=12.00 ms\n' +
      'seq=2 10.0.0.2: time=5.00 ms\n',
    );
  });

  it('handles a reply that arrives before its result line is known (race)', () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);
    emitReply('rep1', 1);
    arriveReply('rep1', 'h1');          // arrival precedes the backend result
    expect(w.querySelector('.term-out').textContent).toBe('');
    pingResult('h1', '10.0.0.2', 1, 7.0);
    expect(w.querySelector('.term-out').textContent).toBe('seq=1 10.0.0.2: time=7.00 ms\n');
  });

  it('ignores events for devices whose terminal is not open', () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);
    pingResult('h2', '10.0.0.1', 1, null);   // h2 not open
    expect(w.querySelector('.term-out').textContent).toBe('');
  });

  it('routes to the correct terminal when multiple are open', () => {
    const wH1 = makeTermWidget('');
    const wH2 = makeTermWidget('');
    Terminals._active.set('h1', wH1);
    Terminals._active.set('h2', wH2);
    emitReply('repA', 3);
    pingResult('h2', '192.168.1.1', 3, 0.75);
    arriveReply('repA', 'h2');
    expect(wH1.querySelector('.term-out').textContent).toBe('');
    expect(wH2.querySelector('.term-out').textContent).toBe('seq=3 192.168.1.1: time=0.75 ms\n');
  });

  it('falls back to showing a successful line if its reply arrival never fires', async () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);
    const orig = Terminals._pingFallbackMs;
    Terminals._pingFallbackMs = 30;
    try {
      emitReply('rep1', 1);
      pingResult('h1', '10.0.0.2', 1, 9.0);
      expect(w.querySelector('.term-out').textContent).toBe('');   // deferred
      await new Promise(r => setTimeout(r, 80));                   // past fallback
      expect(w.querySelector('.term-out').textContent).toBe('seq=1 10.0.0.2: time=9.00 ms\n');
    } finally {
      Terminals._pingFallbackMs = orig;
    }
  });
});
