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

describe('sim:ping-result bus listener', () => {
  beforeEach(() => {
    Terminals._active.clear();
  });

  afterEach(() => {
    Terminals._active.clear();
  });

  it('appends a timed reply line when rtt_ms is provided', () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);

    bus.dispatchEvent(new CustomEvent('sim:ping-result', {
      detail: { device: 'h1', dst: '10.0.0.2', seq: 1, rtt_ms: 12.3456 },
    }));

    const out = w.querySelector('.term-out');
    expect(out.textContent).toBe('seq=1 10.0.0.2: time=12.35 ms\n');
  });

  it('appends a timeout line when rtt_ms is null', () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);

    bus.dispatchEvent(new CustomEvent('sim:ping-result', {
      detail: { device: 'h1', dst: '10.0.0.2', seq: 2, rtt_ms: null },
    }));

    const out = w.querySelector('.term-out');
    expect(out.textContent).toBe('seq=2 10.0.0.2: timeout\n');
  });

  it('accumulates multiple lines sequentially', () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);

    bus.dispatchEvent(new CustomEvent('sim:ping-result', {
      detail: { device: 'h1', dst: '10.0.0.2', seq: 1, rtt_ms: 5.0 },
    }));
    bus.dispatchEvent(new CustomEvent('sim:ping-result', {
      detail: { device: 'h1', dst: '10.0.0.2', seq: 2, rtt_ms: null },
    }));

    const out = w.querySelector('.term-out');
    expect(out.textContent).toBe(
      'seq=1 10.0.0.2: time=5.00 ms\n' +
      'seq=2 10.0.0.2: timeout\n',
    );
  });

  it('ignores events for devices whose terminal is not open', () => {
    // h2's terminal is not in _active; dispatching for h2 should not throw
    // and h1's terminal should remain empty.
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);

    bus.dispatchEvent(new CustomEvent('sim:ping-result', {
      detail: { device: 'h2', dst: '10.0.0.1', seq: 1, rtt_ms: 3.0 },
    }));

    const out = w.querySelector('.term-out');
    expect(out.textContent).toBe('');
  });

  it('routes to the correct terminal when multiple are open', () => {
    const wH1 = makeTermWidget('');
    const wH2 = makeTermWidget('');
    Terminals._active.set('h1', wH1);
    Terminals._active.set('h2', wH2);

    bus.dispatchEvent(new CustomEvent('sim:ping-result', {
      detail: { device: 'h2', dst: '192.168.1.1', seq: 3, rtt_ms: 0.75 },
    }));

    expect(wH1.querySelector('.term-out').textContent).toBe('');
    expect(wH2.querySelector('.term-out').textContent).toBe('seq=3 192.168.1.1: time=0.75 ms\n');
  });
});
