// web/packets.js
// Packet animation namespace + tooltip helpers. Listens on the shared bus for
// sim:packet events emitted by sim.js and renders short tweened SVG dots over
// the canvas. Reads Sim.state to freeze in-flight tweens while paused.
import { bus } from './state.js';
import { escapeHtml } from './utils.js';
import { lookupDeviceNode, lookupAddressNode, lookupNetworkNode, getNodeCenter } from './canvas.js';
import { Sim } from './sim.js';

/* ---------- PacketAnim ---------- */
export const PacketAnim = {
  DURATION_MS: 1800,
  COLORS: {
    routing_flood:  { fill: '#94a3b8', opacity: 0.6 },
    user_datagram:  { fill: '#22c55e', opacity: 1.0 },
    ping_request:   { fill: '#f59e0b', opacity: 1.0 },
    ping_reply:     { fill: '#fbbf24', opacity: 1.0 },
  },
  // Types whose hops should be animated sequentially. Grouped by `flow` (the
  // unordered pair of endpoint addresses) so a ping_request and its ping_reply,
  // which share the same flow, animate one after the other instead of overlapping.
  // Chatter stays parallel so the user still sees the swarm.
  _SEQUENTIAL: new Set(['user_datagram', 'ping_request', 'ping_reply']),
  _lastChatter: new Map(),
  _queues: new Map(),               // flow -> { pending: [evt, ...] }
  muted: false,

  play(evt) {
    if (evt.type === 'routing_flood' && (this.muted || !this._chatterAllowed(evt))) return;

    if (evt.flow && this._SEQUENTIAL.has(evt.type)) {
      const q = this._queues.get(evt.flow);
      if (q) { q.pending.push(evt); return; }
      this._queues.set(evt.flow, { pending: [] });
      this._render(evt, () => this._onSegmentDone(evt.flow));
      return;
    }

    this._render(evt, null);
  },

  _onSegmentDone(flow) {
    const q = this._queues.get(flow);
    if (!q) return;
    if (q.pending.length === 0) {
      this._queues.delete(flow);
      return;
    }
    const next = q.pending.shift();
    this._render(next, () => this._onSegmentDone(flow));
  },

  _render(evt, onDone) {
    const srcNode = lookupDeviceNode(evt.src && evt.src.device);
    const netNode = lookupNetworkNode(evt.network);
    if (!srcNode || !netNode) { if (onDone) onDone(); return; }

    const layer = document.getElementById('packet-layer');
    if (!layer) { if (onDone) onDone(); return; }

    const color = this.COLORS[evt.type] || { fill: '#777', opacity: 1.0 };
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', 8);
    dot.setAttribute('fill', color.fill);
    dot.setAttribute('opacity', color.opacity);
    dot.setAttribute('stroke', 'rgba(0,0,0,0.35)');
    dot.setAttribute('stroke-width', '1');
    dot.style.pointerEvents = 'all';
    dot.dataset.evt = JSON.stringify(evt);
    layer.appendChild(dot);

    dot.addEventListener('mouseenter', () => showPacketTooltip(evt, dot));
    dot.addEventListener('mouseleave', hidePacketTooltip);

    const dstNode = lookupAddressNode(evt.dst && evt.dst.address) || lookupDeviceNode(evt.dst && evt.dst.device);
    const finish = () => {
      if (dot.parentNode) layer.removeChild(dot);
      if (onDone) onDone();
    };
    this._tween(dot, srcNode, netNode, this.DURATION_MS / 2, () => {
      if (!dstNode) { finish(); return; }
      this._tween(dot, netNode, dstNode, this.DURATION_MS / 2, finish);
    });
  },

  _chatterAllowed(evt) {
    const key = `${evt.src && evt.src.device}:${evt.network}`;
    const now = performance.now();
    const last = this._lastChatter.get(key) || 0;
    if (now - last < 200) return false;
    this._lastChatter.set(key, now);
    return true;
  },

  _tween(dot, fromNode, toNode, durationMs, done) {
    const fp = getNodeCenter(fromNode);
    const tp = getNodeCenter(toNode);
    if (!fp || !tp) { done(); return; }
    // Track elapsed manually so the animation freezes while Sim is paused —
    // lets users hover/inspect packets mid-flight.
    let elapsed = 0;
    let lastT = performance.now();
    const tick = () => {
      const now = performance.now();
      if (Sim.state !== 'paused') elapsed += (now - lastT);
      lastT = now;
      const t = Math.min(1, elapsed / durationMs);
      dot.setAttribute('cx', fp.x + (tp.x - fp.x) * t);
      dot.setAttribute('cy', fp.y + (tp.y - fp.y) * t);
      if (t < 1) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  },
};

export function showPacketTooltip(evt, dot) {
  let tt = document.getElementById('packet-tooltip');
  if (!tt) {
    tt = document.createElement('div');
    tt.id = 'packet-tooltip';
    tt.className = 'packet-tt';
    document.body.appendChild(tt);
  }
  const hopSrc = (evt.src && evt.src.address) || '?';
  const hopDst = (evt.dst && evt.dst.address) || '?';
  const origSrc = evt.payload_src || hopSrc;
  const origDst = evt.payload_dst || hopDst;
  const sameAsHop = origSrc === hopSrc && origDst === hopDst;
  const headline = `${evt.type}: ${origSrc} → ${origDst}`;
  tt.innerHTML = sameAsHop
    ? escapeHtml(headline)
    : `${escapeHtml(headline)}<div class="hop">hop: ${escapeHtml(hopSrc)} → ${escapeHtml(hopDst)}</div>`;
  tt.style.display = 'block';
  const bbox = dot.getBoundingClientRect();
  tt.style.left = (bbox.right + 8) + 'px';
  tt.style.top = (bbox.top - 4) + 'px';
}

export function hidePacketTooltip() {
  const tt = document.getElementById('packet-tooltip');
  if (tt) tt.style.display = 'none';
}

// Bus wiring: replay each packet event emitted by sim.js. The inline module
// used to wire this through a bridge listener; ownership now lives here.
bus.addEventListener('sim:packet', (e) => { PacketAnim.play(e.detail); });
