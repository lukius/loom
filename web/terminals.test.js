// web/terminals.test.js
// Tests for the sim:ping-result bus listener in Terminals.
// Strategy: bypass Terminals.open (it calls Sim.state / toast / DOM body) by
// directly placing a fake terminal element into Terminals._active, then firing
// the bus event and asserting the output line was appended.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bus, state } from './state.js';
import { Terminals, clampTermPos } from './terminals.js';
import { Sim } from './sim.js';
import { PacketAnim } from './packets.js';
import { PacketStore } from './packetstore.js';

// End-to-end: the real packet animation drives sim:packet-arrived, which the
// terminal uses to release a buffered ping line. Verifies a success line waits
// for its reply to visually return, instead of appearing on the backend event.
describe('ping terminal pacing — end to end with the real animation', () => {
  beforeEach(() => {
    Terminals._active.clear();
    Terminals._pingBuf.clear();
    Terminals._replySeq.clear();
    Terminals._pingArrived.clear();
    Terminals._seqDevice.clear();
    PacketStore._reset();
    PacketAnim._reset();
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
    const w = document.createElement('div');
    w.className = 'term';
    const pre = document.createElement('pre');
    pre.className = 'term-out';
    w.appendChild(pre);
    Terminals._active.set('h1', w);
  });

  afterEach(() => {
    Terminals._active.clear();
    Terminals._pingBuf.clear();
    Terminals._replySeq.clear();
    Terminals._pingArrived.clear();
    PacketAnim._reset();
  });

  it('holds the line until the reply animation returns to the host', async () => {
    const origDur = PacketAnim.DURATION_MS;
    PacketAnim.DURATION_MS = 5;
    const out = Terminals._active.get('h1').querySelector('.term-out');
    try {
      // Backend order for one probe: request out, reply back, then ping_result.
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
        type: 'ping_request', payload_id: 'req0', flow: 'flow0', network: 'lan_a',
        src: { device: 'h1', address: '10.0.0.1' }, dst: { address: '10.0.0.2' },
        payload_src: '10.0.0.1', payload_dst: '10.0.0.2', payload: { seq: 0 },
      } }));
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
        type: 'ping_reply', payload_id: 'rep0', flow: 'flow0', network: 'lan_a',
        src: { device: 'h2', address: '10.0.0.2' }, dst: { address: '10.0.0.1' },
        payload_src: '10.0.0.2', payload_dst: '10.0.0.1', payload: { seq: 0, request_ts: 0 },
      } }));
      bus.dispatchEvent(new CustomEvent('sim:ping-result', {
        detail: { device: 'h1', dst: 'h2', seq: 0, rtt_ms: 3.2 },
      }));
      // Backend event has been received but the reply hasn't visually returned.
      expect(out.textContent).toBe('');
      await new Promise(r => setTimeout(r, 200));
      // Reply animation completed → line released.
      expect(out.textContent).toBe('seq=0 h2: time=3.20 ms\n');
    } finally {
      PacketAnim.DURATION_MS = origDur;
    }
  });
});

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
    Terminals._seqDevice.clear();
  });

  afterEach(() => {
    Terminals._active.clear();
    Terminals._pingBuf.clear();
    Terminals._replySeq.clear();
    Terminals._pingArrived.clear();
    Terminals._seqDevice.clear();
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

  it('routes a device-less arrival to the buffer that owns the seq', () => {
    // If geometry is unresolved the reply arrives with device:null; the line
    // must still release, routed via the seq→device map.
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);
    emitReply('rep1', 4);
    pingResult('h1', '10.0.0.2', 4, 2.5);
    expect(w.querySelector('.term-out').textContent).toBe('');
    arriveReply('rep1', null);
    expect(w.querySelector('.term-out').textContent).toBe('seq=4 10.0.0.2: time=2.50 ms\n');
  });

  it('defers the summary until after the per-probe line', () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);
    emitReply('rep1', 0);
    pingResult('h1', 'h2', 0, 3.2);
    const summary = '--- h2 ping statistics ---\n1 sent, 1 received, 0% loss';
    expect(Terminals._maybeDeferPingSummary('h1', 'ping h2', summary)).toBe(true);
    expect(w.querySelector('.term-out').textContent).toBe('');   // nothing yet
    arriveReply('rep1', 'h1');
    expect(w.querySelector('.term-out').textContent).toBe(
      'seq=0 h2: time=3.20 ms\n--- h2 ping statistics ---\n1 sent, 1 received, 0% loss\n');
  });

  it('releases each line on its own reply arrival and prints the summary last', () => {
    const w = makeTermWidget('');
    Terminals._active.set('h1', w);
    const out = w.querySelector('.term-out');
    emitReply('r0', 0); emitReply('r1', 1);
    pingResult('h1', 'h2', 0, 1.0);
    pingResult('h1', 'h2', 1, 2.0);
    Terminals._maybeDeferPingSummary('h1', 'ping h2 -c 2',
      '--- h2 ping statistics ---\n2 sent, 2 received, 0% loss');
    expect(out.textContent).toBe('');                       // all waiting on arrivals
    arriveReply('r0', 'h1');
    expect(out.textContent).toBe('seq=0 h2: time=1.00 ms\n'); // line 0 only, no summary
    arriveReply('r1', 'h1');
    expect(out.textContent).toBe(
      'seq=0 h2: time=1.00 ms\nseq=1 h2: time=2.00 ms\n' +
      '--- h2 ping statistics ---\n2 sent, 2 received, 0% loss\n');
  });

  it('does not defer non-ping output, or a ping error with no summary', () => {
    expect(Terminals._maybeDeferPingSummary('h1', 'ifconfig', 'eth0: addr=...')).toBe(false);
    expect(Terminals._maybeDeferPingSummary('h1', 'ping h2', 'ping: invalid destination: h2')).toBe(false);
  });
});
