// web/terminals.test.js
// Tests for the sim:ping-result bus listener in Terminals.
// Strategy: bypass Terminals.open (it calls Sim.state / toast / DOM body) by
// directly placing a fake terminal element into Terminals._active, then firing
// the bus event and asserting the output line was appended.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bus } from './state.js';
import { Terminals } from './terminals.js';

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
