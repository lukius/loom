// web/packets.js
// Packet animation namespace + tooltip helpers. Listens on the shared bus for
// sim:packet events emitted by sim.js and renders short tweened SVG dots over
// the canvas. Reads Sim.state to freeze in-flight tweens while paused.
import { bus, state, NODE } from './state.js';

import { escapeHtml } from './utils.js';
import { PacketStore } from './packetstore.js';
import {
  lookupDeviceNode, lookupAddressNodeOnFabric, lookupNetworkNode,
  getNodeCenter, railTapPoint, deviceNameForEndpointOnFabric,
  collectLinkEndpoints, clipToRect, linkBezier,
} from './canvas.js';
import { Sim } from './sim.js';

// Packet glyph dimensions — wider than tall so the rectangle reads as a
// "datagram" gliding along the wire (textbook convention).
const PACKET_W = 18;
const PACKET_H = 12;

// payload_id -> { router, originator, pinged_address, received_on }
// A router-intercept event fires immediately before the reply packet event
// that carries the same payload_id; we cache it so the tooltip on that
// reply can flag "this came from a router, not the device you pinged".
const _INTERCEPT_CACHE_LIMIT = 1024;
const _interceptByPayloadId = new Map();

bus.addEventListener('sim:router-intercept', (e) => {
  const evt = e.detail;
  if (!evt || !evt.payload_id) return;
  _interceptByPayloadId.set(evt.payload_id, evt);
  if (_interceptByPayloadId.size > _INTERCEPT_CACHE_LIMIT) {
    const firstKey = _interceptByPayloadId.keys().next().value;
    _interceptByPayloadId.delete(firstKey);
  }
});

// Build a packet badge text element. Used by initial render (T7) and the
// live chatter toggle (T8) so both stay visually identical.
function makePacketBadge(payloadId, label, fillColor) {
  const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  badge.setAttribute('class', 'packet-badge');
  badge.setAttribute('text-anchor', 'middle');
  badge.setAttribute('fill', fillColor);
  badge.setAttribute('stroke', 'rgba(0,0,0,0.5)');
  badge.setAttribute('stroke-width', '0.4');
  badge.setAttribute('paint-order', 'stroke');
  badge.setAttribute('font-size', '10');
  badge.setAttribute('font-weight', '600');
  badge.style.pointerEvents = 'none';
  badge.textContent = label;
  badge.dataset.payloadId = payloadId;
  return badge;
}

// Position a packet rect and optional badge so the rect's center is at (cx, cy).
// The badge floats just above the rect.
function setPacketAnchor(rect, badge, cx, cy) {
  rect.setAttribute('x', cx - PACKET_W / 2);
  rect.setAttribute('y', cy - PACKET_H / 2);
  if (badge) {
    badge.setAttribute('x', cx);
    badge.setAttribute('y', cy - PACKET_H / 2 - 4);
  }
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
    if (evt.type === 'routing_flood' && (this.muted || !this._chatterAllowed(evt))) {
      // Throttled or muted: no animation will run. Dispatch arrival so the
      // store cleans up the entry now instead of waiting 2s for the TTL.
      const dotKey = `${evt.payload_id}|${(evt.src && evt.src.device) || '?'}|${(evt.src && evt.src.iface) || '?'}|${evt.network || '?'}`;
      bus.dispatchEvent(new CustomEvent('sim:packet-arrived', {
        detail: { payloadId: dotKey, device: null },
      }));
      return;
    }

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
    if (!srcNode) {
      if (onDone) onDone();
      return;
    }

    // Two fabric kinds: multi-access Networks have a visible rail node;
    // point-to-point Links are a direct device↔device edge with no fabric
    // node. Look up which kind this event's fabric is so we can route the
    // animation along the right geometry.
    const isLink = !!(state.links && state.links[evt.network]);
    const netNode = isLink ? null : lookupNetworkNode(evt.network);
    if (!isLink && !netNode) {
      if (onDone) onDone();
      return;
    }

    const layer = document.getElementById('packet-layer');
    if (!layer) {
      if (onDone) onDone();
      return;
    }

    const color = this.COLORS[evt.type] || { fill: '#777', opacity: 1.0 };
    // Packets render as small rounded rectangles — the typical "datagram"
    // glyph used in networking literature. The packet is centered via cx/cy
    // proxy attributes (data-cx/cy) so the tween helpers can keep using a
    // simple point-tracking API; we translate into x/y at write time.
    // Chatter packets use a composite key so each interface emission gets its
    // own distinct dot↔row binding. User traffic continues to use bare payload_id.
    const dotKey = evt.type === 'routing_flood'
      ? `${evt.payload_id}|${(evt.src && evt.src.device) || '?'}|${(evt.src && evt.src.iface) || '?'}|${evt.network || '?'}`
      : evt.payload_id;

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
    dot.dataset.payloadId = dotKey;
    dot.dataset.packetType = evt.type;
    layer.appendChild(dot);
    bus.dispatchEvent(new CustomEvent('packets:dot-appeared', {
      detail: { payloadId: evt.payload_id },
    }));

    dot.addEventListener('mouseenter', () => showPacketTooltip(evt, dot));
    dot.addEventListener('mouseleave', hidePacketTooltip);

    // Numeric badge (#N for user traffic, #R* for routing chatter when enabled).
    let badge = null;
    const id = PacketStore.idFor(evt);
    const chatterBadgesOn = document.body.dataset.chatterBadges === 'on';
    const wantBadge = id != null && (evt.type !== 'routing_flood' || chatterBadgesOn);
    if (wantBadge) {
      const label = evt.type === 'routing_flood' ? `#R${id}` : `#${id}`;
      badge = makePacketBadge(dotKey, label, color.fill);
      layer.appendChild(badge);
    }

    // Resolve the destination device once so the arrival signal can name it.
    // Networks use address-on-fabric lookup; p2p links use the structural
    // "other endpoint" since dst.address can collide with same-IP ifaces
    // on a different link.
    const srcName = evt.src && evt.src.device;
    let dstDeviceName = null;
    if (isLink) {
      const peers = collectLinkEndpoints(evt.network).filter(ep => ep.device !== srcName);
      dstDeviceName = peers.length === 1
        ? peers[0].device
        : deviceNameForEndpointOnFabric(evt.dst, evt.network);
    } else {
      dstDeviceName = deviceNameForEndpointOnFabric(evt.dst, evt.network);
    }

    const finish = () => {
      if (dot.parentNode) layer.removeChild(dot);
      // Remove every badge tied to this dot's key — covers the badge created
      // here in _render AND any badge appended later by the
      // packets:chatter-badges-changed listener while the dot was mid-tween.
      if (dotKey) {
        const sel = `text.packet-badge[data-payload-id="${CSS.escape(dotKey)}"]`;
        layer.querySelectorAll(sel).forEach(b => { if (b.parentNode) b.parentNode.removeChild(b); });
      } else if (badge && badge.parentNode) {
        // No key (defensive) — fall back to removing the closure-captured badge.
        layer.removeChild(badge);
      }
      if (dotKey) {
        // Arrival is dispatched even when the destination device couldn't be
        // resolved (chatter broadcasts have no specific destination device).
        // Downstream listeners that need a device name early-return on null.
        bus.dispatchEvent(new CustomEvent('sim:packet-arrived', {
          detail: { payloadId: dotKey, device: dstDeviceName },
        }));
      }
      if (onDone) onDone();
    };

    const segs = isLink
      ? this._segmentsForLink(evt, srcNode)
      : this._segmentsForNetwork(evt, srcNode, netNode);
    if (segs.length === 0) {
      finish();
      return;
    }

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
      if (s.kind === 'bez') this._tweenBezier(dot, badge, s.p0, s.c1, s.c2, s.p3, d, onSegDone);
      else                  this._tweenPoints(dot, badge, s.from, s.to, d, onSegDone);
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
    // Use the same bowed bezier the canvas renders so the packet rides the
    // visible wire (otherwise parallel-link packets would diverge from their
    // edge paths).
    return [{ kind: 'bez', ...linkBezier(evt.network, { x: ax, y: ay }, { x: bx, y: by }) }];
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

  // Straight-line tween between two world-space points. Freezes while paused.
  _tweenPoints(dot, badge, fp, tp, durationMs, done) {
    let elapsed = 0;
    let lastT = performance.now();
    const tick = () => {
      const now = performance.now();
      if (Sim.state !== 'paused') elapsed += (now - lastT);
      lastT = now;
      const t = Math.min(1, elapsed / durationMs);
      setPacketAnchor(dot, badge, fp.x + (tp.x - fp.x) * t, fp.y + (tp.y - fp.y) * t);
      if (t < 1) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  },

  // Cubic bezier tween — samples B(t) for each frame so the packet rides the
  // same curve drawEdge renders. Freezes while paused (same pattern as above).
  _tweenBezier(dot, badge, p0, c1, c2, p3, durationMs, done) {
    let elapsed = 0;
    let lastT = performance.now();
    const tick = () => {
      const now = performance.now();
      if (Sim.state !== 'paused') elapsed += (now - lastT);
      lastT = now;
      const t = Math.min(1, elapsed / durationMs);
      const u = 1 - t;
      const a = u*u*u, b = 3*u*u*t, c = 3*u*t*t, d = t*t*t;
      setPacketAnchor(
        dot,
        badge,
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
  const headHtml = sameAsHop
    ? escapeHtml(headline)
    : `${escapeHtml(headline)}<div class="hop">hop: ${escapeHtml(hopSrc)} → ${escapeHtml(hopDst)}</div>`;
  // NAT correlation: the server's `nat` event carries the same `payload_id` as
  // the `packet` event we're rendering for, so an exact match by id is reliable
  // across reorderings and multi-hop paths.
  const natList = PacketStore.natFor(evt.payload_id);
  const natHtml = natList.map(n => {
    if (n.direction === 'outbound') {
      return `<div class="nat">NAT @ ${escapeHtml(n.router)}: ${escapeHtml(n.original_src)} → ${escapeHtml(n.rewritten_src)}</div>`;
    }
    return `<div class="nat">NAT @ ${escapeHtml(n.router)}: ${escapeHtml(n.rewritten_dst)} → ${escapeHtml(n.original_dst)}</div>`;
  }).join('');
  const intercept = evt.payload_id && _interceptByPayloadId.get(evt.payload_id);
  const interceptHtml = intercept
    ? `<div class="intercept">Replied by router ${escapeHtml(intercept.router)} — ${escapeHtml(intercept.pinged_address)} is its ${escapeHtml(intercept.owning_iface || 'own')} address</div>`
    : '';
  tt.innerHTML = headHtml + interceptHtml + natHtml;
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

// Live chatter-badge toggle: when the body flag changes while chatter dots are
// already in flight, add or remove their badges without waiting for a re-render.
// Toggle-added badges stay at the dot's last position (no tween) — acceptable
// because chatter packets are short-lived.
bus.addEventListener('packets:chatter-badges-changed', () => {
  const layer = document.getElementById('packet-layer');
  if (!layer) return;
  const chatterOn = document.body.dataset.chatterBadges === 'on';
  const dots = layer.querySelectorAll('rect[data-packet-type="routing_flood"]');
  dots.forEach(dot => {
    // dot.dataset.payloadId is already the composite key for chatter dots.
    // Look up the row directly rather than going through idFor (which would
    // need to rebuild the composite key from evt fields not available here).
    const key = dot.dataset.payloadId;
    const row = PacketStore.chatter.get(key);
    const id = row ? row.id : null;
    const existing = layer.querySelector(`text.packet-badge[data-payload-id="${CSS.escape(key)}"]`);
    if (chatterOn && id != null && !existing) {
      const badge = makePacketBadge(key, `#R${id}`, dot.getAttribute('fill'));
      const cx = parseFloat(dot.getAttribute('x')) + PACKET_W / 2;
      const cy = parseFloat(dot.getAttribute('y')) + PACKET_H / 2;
      badge.setAttribute('x', cx);
      badge.setAttribute('y', cy - PACKET_H / 2 - 4);
      layer.appendChild(badge);
    } else if (!chatterOn && existing) {
      existing.parentNode.removeChild(existing);
    }
  });
});
