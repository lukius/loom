// web/packets.js
// Packet animation namespace + tooltip helpers. Listens on the shared bus for
// sim:packet events emitted by sim.js and renders short tweened SVG dots over
// the canvas. Reads Sim.state to freeze in-flight tweens while paused.
import { bus, state, NODE } from './state.js';
import { escapeHtml } from './utils.js';
import {
  lookupDeviceNode, lookupAddressNodeOnFabric, lookupNetworkNode,
  getNodeCenter, railTapPoint, deviceNameForEndpointOnFabric,
  collectLinkEndpoints, clipToRect,
} from './canvas.js';
import { Sim } from './sim.js';

// Packet glyph dimensions — wider than tall so the rectangle reads as a
// "datagram" gliding along the wire (textbook convention).
const PACKET_W = 18;
const PACKET_H = 12;

// Position a packet rect so its center is at world (cx, cy).
function setPacketCenter(rect, cx, cy) {
  rect.setAttribute('x', cx - PACKET_W / 2);
  rect.setAttribute('y', cy - PACKET_H / 2);
}

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
    if (!srcNode) { if (onDone) onDone(); return; }

    // Two fabric kinds: multi-access Networks have a visible rail node;
    // point-to-point Links are a direct device↔device edge with no fabric
    // node. Look up which kind this event's fabric is so we can route the
    // animation along the right geometry.
    const isLink = !!(state.links && state.links[evt.network]);
    const netNode = isLink ? null : lookupNetworkNode(evt.network);
    if (!isLink && !netNode) { if (onDone) onDone(); return; }

    const layer = document.getElementById('packet-layer');
    if (!layer) { if (onDone) onDone(); return; }

    const color = this.COLORS[evt.type] || { fill: '#777', opacity: 1.0 };
    // Packets render as small rounded rectangles — the typical "datagram"
    // glyph used in networking literature. The packet is centered via cx/cy
    // proxy attributes (data-cx/cy) so the tween helpers can keep using a
    // simple point-tracking API; we translate into x/y at write time.
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    dot.setAttribute('width', PACKET_W);
    dot.setAttribute('height', PACKET_H);
    dot.setAttribute('rx', 2);
    dot.setAttribute('fill', color.fill);
    dot.setAttribute('opacity', color.opacity);
    dot.setAttribute('stroke', 'rgba(0,0,0,0.35)');
    dot.setAttribute('stroke-width', '1');
    dot.style.pointerEvents = 'all';
    dot.dataset.evt = JSON.stringify(evt);
    layer.appendChild(dot);

    dot.addEventListener('mouseenter', () => showPacketTooltip(evt, dot));
    dot.addEventListener('mouseleave', hidePacketTooltip);

    const finish = () => {
      if (dot.parentNode) layer.removeChild(dot);
      if (onDone) onDone();
    };

    const segs = isLink
      ? this._segmentsForLink(evt, srcNode)
      : this._segmentsForNetwork(evt, srcNode, netNode);
    if (segs.length === 0) { finish(); return; }

    // Weight each segment's duration by its approximate length so the packet
    // travels at a single constant velocity through the whole path — no jarring
    // speed-up or stall at the rail junctions.
    const lens = segs.map(s => this._segLength(s));
    const total = lens.reduce((a, b) => a + b, 0);
    const durs = total > 0
      ? lens.map(l => (l / total) * this.DURATION_MS)
      : segs.map(() => this.DURATION_MS / segs.length);

    let i = 0;
    const stepNext = () => {
      if (i >= segs.length) { finish(); return; }
      const s = segs[i];
      const d = durs[i];
      const onSegDone = () => { i++; stepNext(); };
      if (s.kind === 'bez') this._tweenBezier(dot, s.p0, s.c1, s.c2, s.p3, d, onSegDone);
      else                  this._tweenPoints(dot, s.from, s.to, d, onSegDone);
    };
    stepNext();
  },

  // Multi-access (LAN/rail) path:
  //   src device  →[bezier]→  src tap on rail  →[line]→  dst tap  →[bezier]→  dst device
  _segmentsForNetwork(evt, srcNode, netNode) {
    const srcCenter = getNodeCenter(srcNode);
    // Scope the address lookup to this fabric so we don't pick a same-IP
    // device from a different subnet (private IPs are intentionally
    // reusable across separate networks per RFC 1918).
    const dstNode = lookupAddressNodeOnFabric(evt.dst && evt.dst.address, evt.network)
      || lookupDeviceNode(evt.dst && evt.dst.device);
    const dstCenter = dstNode ? getNodeCenter(dstNode) : null;
    // Simulator emits `dst.address` (no `dst.device`); resolve the address
    // back to a device name to compute the rail tap point.
    const dstName = deviceNameForEndpointOnFabric(evt.dst, evt.network);
    const srcTap = railTapPoint(evt.src && evt.src.device, evt.network) || getNodeCenter(netNode);
    const dstTap = dstName
      ? (railTapPoint(dstName, evt.network) || getNodeCenter(netNode))
      : null;

    const segs = [];
    if (srcCenter && srcTap) segs.push({ kind: 'bez', ...this._bezBetween(srcCenter, srcTap) });
    if (srcTap && dstTap)    segs.push({ kind: 'line', from: srcTap, to: dstTap });
    if (dstTap && dstCenter) segs.push({ kind: 'bez', ...this._bezBetween(dstTap, dstCenter) });
    return segs;
  },

  // Point-to-point link path: a single bezier directly from src device to
  // dst device, clipped to both device rects so the packet rides the same
  // curve that drawLinkEdge renders. No rail tap.
  _segmentsForLink(evt, srcNode) {
    const srcName = evt.src && evt.src.device;
    const srcCenter = getNodeCenter(srcNode);
    if (!srcCenter || !srcName) return [];

    // Resolve the destination device. A p2p link has exactly two endpoints,
    // so the peer is structurally determined: "the endpoint of this link
    // that isn't the sender". Prefer that over an address-based lookup —
    // the address can collide with another iface elsewhere in the topology
    // (e.g. two /30 links both using 10.0.0.0/30), and the user's intent
    // is unambiguous here regardless of address.
    const peers = collectLinkEndpoints(evt.network).filter(ep => ep.device !== srcName);
    let dstName = peers.length === 1 ? peers[0].device : null;
    // Fallback: if the link's endpoint table is degenerate (0 or >1 peers,
    // shouldn't happen in a valid topology), try the address lookup.
    if (!dstName) dstName = deviceNameForEndpoint(evt.dst);
    if (!dstName) return [];
    const dstNode = lookupDeviceNode(dstName);
    const dstCenter = dstNode ? getNodeCenter(dstNode) : null;
    if (!dstCenter) return [];

    const srcKind = state.routers[srcName] ? 'router' : 'host';
    const dstKind = state.routers[dstName] ? 'router' : 'host';
    const aSize = NODE[srcKind];
    const bSize = NODE[dstKind];
    const [ax, ay] = clipToRect(srcCenter.x, srcCenter.y, aSize.w, aSize.h, dstCenter.x, dstCenter.y);
    const [bx, by] = clipToRect(dstCenter.x, dstCenter.y, bSize.w, bSize.h, srcCenter.x, srcCenter.y);
    return [{ kind: 'bez', ...this._bezBetween({ x: ax, y: ay }, { x: bx, y: by }) }];
  },

  // Cubic bezier with horizontal tangents at both ends — same shape used by
  // drawEdge in canvas.js, so packet trajectory matches the visible wire.
  _bezBetween(p0, p3) {
    const dx = p3.x - p0.x;
    return {
      p0, p3,
      c1: { x: p0.x + dx * 0.55, y: p0.y },
      c2: { x: p3.x - dx * 0.55, y: p3.y },
    };
  },

  // Approximate segment arc length. For lines: exact. For beziers: sum a
  // handful of chord lengths between sampled points — accurate enough to
  // keep packet velocity perceptually constant.
  _segLength(s) {
    if (s.kind === 'line') return Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);
    // bezier: sample 8 points along the curve and sum distances
    const N = 8;
    let prevX = s.p0.x, prevY = s.p0.y, len = 0;
    for (let k = 1; k <= N; k++) {
      const t = k / N;
      const u = 1 - t;
      const a = u*u*u, b = 3*u*u*t, c = 3*u*t*t, d = t*t*t;
      const x = a*s.p0.x + b*s.c1.x + c*s.c2.x + d*s.p3.x;
      const y = a*s.p0.y + b*s.c1.y + c*s.c2.y + d*s.p3.y;
      len += Math.hypot(x - prevX, y - prevY);
      prevX = x; prevY = y;
    }
    return len;
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
    this._tweenPoints(dot, fp, tp, durationMs, done);
  },

  // Straight-line tween between two world-space points. Freezes while paused.
  _tweenPoints(dot, fp, tp, durationMs, done) {
    let elapsed = 0;
    let lastT = performance.now();
    const tick = () => {
      const now = performance.now();
      if (Sim.state !== 'paused') elapsed += (now - lastT);
      lastT = now;
      const t = Math.min(1, elapsed / durationMs);
      setPacketCenter(dot, fp.x + (tp.x - fp.x) * t, fp.y + (tp.y - fp.y) * t);
      if (t < 1) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  },

  // Cubic bezier tween — samples B(t) for each frame so the packet rides the
  // same curve drawEdge renders. Freezes while paused (same pattern as above).
  _tweenBezier(dot, p0, c1, c2, p3, durationMs, done) {
    let elapsed = 0;
    let lastT = performance.now();
    const tick = () => {
      const now = performance.now();
      if (Sim.state !== 'paused') elapsed += (now - lastT);
      lastT = now;
      const t = Math.min(1, elapsed / durationMs);
      const u = 1 - t;
      const a = u*u*u, b = 3*u*u*t, c = 3*u*t*t, d = t*t*t;
      setPacketCenter(
        dot,
        a*p0.x + b*c1.x + c*c2.x + d*p3.x,
        a*p0.y + b*c1.y + c*c2.y + d*p3.y,
      );
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
