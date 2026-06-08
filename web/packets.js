// web/packets.js
// Packet animation namespace + tooltip helpers. Listens on the shared bus for
// sim:packet events emitted by sim.js and renders short tweened SVG dots over
// the canvas. Reads Sim.state to freeze in-flight tweens while paused.
import { bus, state, NODE, isInterfaceDown } from './state.js';
import { ROUTING_CHATTER_TYPES } from './packettypes.js';
import { escapeHtml } from './utils.js';
import { PacketStore } from './packetstore.js';
import {
  lookupDeviceNode, lookupAddressNodeOnFabric, lookupNetworkNode,
  getNodeCenter, railTapPoint, deviceNameForEndpointOnFabric,
  collectLinkEndpoints, clipToRect, linkBezier,
} from './canvas.js';
import { Sim } from './sim.js';

// Build the selector at module-load time once. If a new type is added
// to ROUTING_CHATTER_TYPES, this picks it up automatically.
const ROUTING_CHATTER_SELECTOR = [...ROUTING_CHATTER_TYPES]
    .map(t => `rect[data-packet-type="${t}"]`)
    .join(',');

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

// True when the interface that would RECEIVE this packet is administratively
// down. Only routers expose admin-down interfaces; hosts (single iface, no down
// control) are never down. On a p2p link the destination address can be
// ambiguous (broadcast, or a CIDR reused across links), so match by fabric
// alone — a link has one peer; on a LAN, match the destination address.
function destInterfaceDown(evt, dstDeviceName) {
  if (!dstDeviceName) return false;
  const r = state.routers && state.routers[dstDeviceName];
  if (!r || !r.interfaces) return false;
  const fabric = evt.network;
  const isLink = !!(state.links && state.links[fabric]);
  const addr = evt.dst && evt.dst.address;
  for (const [ifn, iff] of Object.entries(r.interfaces)) {
    const onFabric = iff.network === fabric || iff.link === fabric;
    if (!onFabric) continue;
    if (isLink || iff.address === addr) return isInterfaceDown(dstDeviceName, ifn);
  }
  return false;
}

/* ---------- PacketAnim ---------- */
export const PacketAnim = {
  DURATION_MS: 1800,
  // Packet palette convention:
  //   • Each routing protocol claims one narrow hue band (~ 2 Tailwind
  //     shades). Hellos / liveness use the lighter tone; data-bearing
  //     messages use the deeper tone, so siblings inside the same protocol
  //     read as a family.
  //   • Hue bands reserved so far (cool side of the wheel, all visually
  //     distinguishable at small swatch sizes):
  //       - loom-OSPF      → indigo  (#6366f1 / #a5b4fc)   ← in use
  //       - BGP (next)     → violet  (#8b5cf6 / #c4b5fd)   ← reserved
  //       - 3rd protocol   → cyan    (#06b6d4 / #67e8f9)   ← reserved
  //       - 4th protocol   → sky     (#0ea5e9 / #7dd3fc)   ← reserved
  //       - 5th protocol   → teal    (#14b8a6 / #5eead4)   ← reserved
  //     User traffic and pings sit in green and amber so cool hues stay
  //     free for routing protocols. Beyond five, neighbouring hues start
  //     to read as the same band at swatch scale — the natural next axis
  //     is shape / stroke (square vs triangle, solid vs dashed) rather
  //     than splitting indigo further.
  //   • If you add a routing-protocol type here, also register it in
  //     packettypes.js (`ROUTING_CHATTER_TYPES`) AND add the matching
  //     `.pkt-swatch[data-type="..."]` rule in styles.css.
  COLORS: {
    routing_flood:  { fill: '#6366f1', opacity: 0.7 },  // loom-OSPF — LSA
    hello:          { fill: '#a5b4fc', opacity: 0.9 },  // loom-OSPF — Hello
    user_datagram:  { fill: '#22c55e', opacity: 1.0 },
    ping_request:   { fill: '#f59e0b', opacity: 1.0 },
    ping_reply:     { fill: '#fbbf24', opacity: 1.0 },
  },
  // All routing-protocol chatter types (animated in parallel, throttled/muted
  // as a group). Defined in packettypes.js — import from there to stay in sync.
  _ROUTING_CHATTER_TYPES: ROUTING_CHATTER_TYPES,
  // Types whose hops should be animated sequentially. Grouped by `flow` (the
  // unordered pair of endpoint addresses) so a ping_request and its ping_reply,
  // which share the same flow, animate one after the other instead of overlapping.
  // Chatter stays parallel so the user still sees the swarm.
  _SEQUENTIAL: new Set(['user_datagram', 'ping_request', 'ping_reply']),
  _lastChatter: new Map(),
  _queues: new Map(),               // session key -> { pending: [evt, ...] }
  // flow_key -> session key. A ping -c probe (and its reply) is one flow, but
  // every probe is a *distinct* flow; to play probes one round-trip at a time we
  // group by the conversation's unordered endpoint pair instead. Memoizing per
  // flow means a flow's first hop fixes its session, so NAT-rewritten later hops
  // stay in the same queue (and animate continuously) rather than splitting.
  _flowToSession: new Map(),
  // LSA flooding sequencer: an LSA re-flood (sender !== originator) must
  // wait until its inbound — the hop that triggered this re-flood — has
  // visually arrived at the re-flooder. Otherwise origin + re-flood dots
  // ride the wires concurrently, which doesn't reflect how the protocol
  // actually propagates an update.
  _lsaArrivedAt: new Set(),         // "payload_id|router" — visual arrival has fired
  _lsaPending: new Map(),           // "payload_id|router" -> [evt, ...] re-floods waiting
  // Bumped whenever the sim goes idle. Multi-phase animations (the broadcast
  // fan-out) capture the generation when they start and abort their later
  // phases if it has changed — otherwise a fan-out mid-flight at stop time
  // would spawn fresh clones onto the just-cleared layer and dangle there.
  _gen: 0,
  muted: false,

  play(evt) {
    if (this._ROUTING_CHATTER_TYPES.has(evt.type)) {
      if (this.muted) {
        // Muted: drop the canvas animation AND the store row so the panel
        // doesn't show chatter the user explicitly muted.
        bus.dispatchEvent(new CustomEvent('sim:packet-arrived', {
          detail: { payloadId: this._chatterDotKey(evt), device: null },
        }));
        return;
      }
      if (!this._chatterAllowed(evt)) {
        // Throttled: a near-instant repeat of the *same* message on the same
        // interface (the protocol re-floods back through the origin iface).
        // Skip the canvas animation; the original emission's row covers it.
        return;
      }
      // Committed to animating this chatter packet (now, queued, or deferred).
      // Pin its store row so packetstore's fallback timer can't evict it
      // before a deferred re-flood gets its (possibly much later) turn to
      // render — its sim:packet-arrived will clean up the row instead.
      bus.dispatchEvent(new CustomEvent('packets:chatter-pin', {
        detail: { key: this._chatterDotKey(evt) },
      }));
    }

    if (this._SEQUENTIAL.has(evt.type)) {
      if (evt._t == null) evt._t = this._now();   // arrival time, for inter-probe spacing
      const session = this._sessionKey(evt);
      const q = this._queues.get(session);
      if (q) { q.pending.push(evt); return; }
      this._queues.set(session, { pending: [], curFlow: evt.flow, flowStartT: evt._t });
      this._render(evt, () => this._onSegmentDone(session));
      return;
    }

    if (this._shouldDeferReflood(evt)) return;

    this._render(evt, null);
  },

  // Composite key identifying one chatter emission (one RoutingMessage out one
  // interface). Matches packetstore's _chatterKey so the store row, on-canvas
  // dot, and arrival signal all share one identity.
  _chatterDotKey(evt) {
    const dev = (evt.src && evt.src.device) || '?';
    const iface = (evt.src && evt.src.iface) || '?';
    const net = evt.network || '?';
    return `${evt.payload_id}|${dev}|${iface}|${net}`;
  },

  _shouldDeferReflood(evt) {
    if (evt.type !== 'routing_flood') return false;
    const originator = evt.payload && evt.payload.originator;
    const sender = evt.src && evt.src.device;
    if (!originator || !sender || sender === originator) return false;
    const key = `${evt.payload_id}|${sender}`;
    if (this._lsaArrivedAt.has(key)) return false;
    let q = this._lsaPending.get(key);
    if (!q) { q = []; this._lsaPending.set(key, q); }
    q.push(evt);
    // Safety net: if the inbound that should release this re-flood is dropped
    // (muted, or geometry it never animated over) and never fires an arrival,
    // force-render after a bounded wait so the re-flood still animates and its
    // store row is cleaned up, instead of stranding in _lsaPending until idle.
    this._scheduleRefloodFallback(key, evt);
    return true;
  },

  _scheduleRefloodFallback(key, evt) {
    setTimeout(() => {
      const q = this._lsaPending.get(key);
      if (!q) return;                       // already released by an arrival
      const i = q.indexOf(evt);
      if (i === -1) return;
      q.splice(i, 1);
      if (q.length === 0) this._lsaPending.delete(key);
      this._render(evt, null);
    }, Math.max(this.DURATION_MS * 3, 100));
  },

  // Called from finish() when an LSA's animation completes. Marks every
  // router listener on the fabric as having received this LSA and drains
  // any re-floods that were waiting on those routers. Used by the
  // single-dot path; the broadcast-fan-out path marks per-listener as
  // each clone arrives instead.
  _markLSAArrivedOnFabric(evt) {
    if (evt.type !== 'routing_flood' || !evt.payload_id) return;
    const senderDev = evt.src && evt.src.device;
    const fabricName = evt.network;
    if (!fabricName) return;
    for (const [rn, r] of Object.entries(state.routers || {})) {
      if (rn === senderDev) continue;
      let onFabric = false;
      for (const iff of Object.values(r.interfaces || {})) {
        if (iff.network === fabricName || iff.link === fabricName) {
          onFabric = true;
          break;
        }
      }
      if (!onFabric) continue;
      this._markLSAArrivedAt(evt.payload_id, rn);
    }
  },

  _markLSAArrivedAt(payloadId, device) {
    if (!payloadId || !device) return;
    const key = `${payloadId}|${device}`;
    this._lsaArrivedAt.add(key);
    const queued = this._lsaPending.get(key);
    if (queued) {
      this._lsaPending.delete(key);
      for (const qEvt of queued) this._render(qEvt, null);
    }
  },

  // Routers + hosts attached to `fabricName` other than `senderDev`. Used
  // by the broadcast-chatter fan-out to know who should receive a visual
  // clone of the packet. A router whose interface on the fabric is
  // administratively down receives nothing, so it's excluded — the packet
  // doesn't travel to a down interface.
  _collectFabricListeners(fabricName, senderDev) {
    const listeners = [];
    if (!fabricName) return listeners;
    for (const [rn, r] of Object.entries(state.routers || {})) {
      if (rn === senderDev) continue;
      for (const [ifn, iff] of Object.entries(r.interfaces || {})) {
        if (iff.network === fabricName || iff.link === fabricName) {
          if (!isInterfaceDown(rn, ifn)) listeners.push(rn);
          break;
        }
      }
    }
    for (const [hn, h] of Object.entries(state.hosts || {})) {
      if (hn === senderDev) continue;
      if (h.network === fabricName || h.link === fabricName) listeners.push(hn);
    }
    return listeners;
  },

  // Build a packet dot identical to the original render path so the clone
  // shares hover behaviour, halo selector keying, and tooltip. Returns
  // { dot, badge } — badge may be null if the chatter-badge toggle is off.
  _makeDotAndBadge(evt, color, isChatter, dotKey, layer) {
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
    dot.addEventListener('mouseenter', () => showPacketTooltip(evt, dot));
    dot.addEventListener('mouseleave', hidePacketTooltip);
    let badge = null;
    const id = PacketStore.idFor(evt);
    const chatterBadgesOn = document.body.dataset.chatterBadges === 'on';
    const wantBadge = id != null && (!isChatter || chatterBadgesOn);
    if (wantBadge) {
      const label = isChatter ? `#R${id}` : `#${id}`;
      badge = makePacketBadge(dotKey, label, color.fill);
      layer.appendChild(badge);
    }
    return { dot, badge };
  },

  // Broadcast-chatter rendering. Phase 1 animates the original dot from
  // the sender to the source rail tap; Phase 2 spawns one clone per
  // listener and animates each tap → listener tap → listener centre in
  // parallel. Each clone fires its own sim:packet-arrived (device =
  // listener) so the LSA reflood sequencer releases per-listener.
  _renderBroadcastFanout(evt, srcNode, netNode, dot, badge, dotKey, color, listeners, onDone) {
    const layer = document.getElementById('packet-layer');
    const gen = this._gen;
    const sender = evt.src && evt.src.device;
    const srcName = sender;
    const fabricName = evt.network;
    const netName = fabricName;
    // Live resolvers — re-read DOM/state every frame so dots follow a dragged node.
    const netCenter = () => getNodeCenter(lookupNetworkNode(netName)) || getNodeCenter(netNode);
    const srcCenter = () => getNodeCenter(lookupDeviceNode(srcName)) || netCenter();
    const srcTap = () => railTapPoint(srcName, fabricName) || netCenter();
    // Probe once to guard on missing geometry at animation-start (presence is
    // stable; only positions move).
    if (!srcCenter() || !srcTap()) {
      // Geometry unresolved — fall back to single-arrival semantics so the
      // chatter row still cleans up.
      if (dot.parentNode) layer.removeChild(dot);
      if (badge && badge.parentNode) layer.removeChild(badge);
      if (dotKey) {
        bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId: dotKey, device: null } }));
      }
      if (onDone) onDone();
      return;
    }

    // Phase split: short ride to the rail tap, then a longer fan-out so the
    // simultaneous arrival at every listener reads clearly.
    const PHASE1_FRACTION = 0.3;
    const phase1Dur = this.DURATION_MS * PHASE1_FRACTION;
    const phase2Dur = this.DURATION_MS * (1 - PHASE1_FRACTION);

    const isChatter = this._ROUTING_CHATTER_TYPES.has(evt.type);
    // Live curve thunk — re-evaluates both endpoints every frame so the phase-1
    // dot follows the sender if it is dragged while the tween is in flight.
    const phase1CurveFn = () => this._bezBetween(srcCenter(), srcTap());

    this._tweenBezier(dot, badge, phase1CurveFn, phase1Dur, () => {
      // Retire the source dot; clones will carry the visual onward.
      if (dot.parentNode) layer.removeChild(dot);
      if (badge && badge.parentNode) layer.removeChild(badge);

      // The sim stopped (or reset) mid fan-out: the layer has been cleared, so
      // spawning clones now would just dangle them. Clean up the row and stop.
      if (gen !== this._gen) {
        if (dotKey) {
          bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId: dotKey, device: null } }));
        }
        if (onDone) onDone();
        return;
      }

      let remaining = listeners.length;
      const cloneDone = () => {
        remaining--;
        if (remaining === 0 && onDone) onDone();
      };

      for (const lis of listeners) {
        // Live resolvers keyed on the listener's device NAME so dots survive a
        // renderCanvas rebuild (e.g. on drop-commit) and track the listener if
        // it is dragged while phase 2 is in flight.
        const lisTap = () => railTapPoint(lis, fabricName) || netCenter();
        const lisCenter = () => getNodeCenter(lookupDeviceNode(lis));
        // Build the clone even when geometry is missing so we still fire
        // arrival (and clean up the chatter row).
        const { dot: cdot, badge: cbadge } = this._makeDotAndBadge(evt, color, isChatter, dotKey, layer);

        const fireArrival = () => {
          if (cdot.parentNode) layer.removeChild(cdot);
          if (cbadge && cbadge.parentNode) layer.removeChild(cbadge);
          if (dotKey) {
            bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId: dotKey, device: lis } }));
          }
          PacketAnim._markLSAArrivedAt(evt.payload_id, lis);
          cloneDone();
        };

        if (!lisCenter() || !lisTap()) { fireArrival(); continue; }

        // Position the clone at the source rail tap before animating.
        const p = srcTap();
        setPacketAnchor(cdot, cbadge, p.x, p.y);

        // Same total phase-2 duration for every clone so all listeners
        // visually receive together (broadcast intuition), even though
        // their path lengths differ.
        const railSegLen = this._segLength({ kind: 'line', from: srcTap, to: lisTap });
        const lisBezLen = this._segLength({ kind: 'bez', curve: () => this._bezBetween(lisTap(), lisCenter()) });
        const tot = (railSegLen + lisBezLen) || 1;
        const railDur = (railSegLen / tot) * phase2Dur;
        const lisDur = (lisBezLen / tot) * phase2Dur;

        this._tweenPoints(cdot, cbadge, srcTap, lisTap, railDur, () => {
          this._tweenBezier(cdot, cbadge, () => this._bezBetween(lisTap(), lisCenter()), lisDur, fireArrival);
        });
      }
    });
  },

  // Conversation key for sequenced animation. Grouped by the unordered pair of
  // end-to-end endpoints so all probes (and the reply) of one ping -c share a
  // single queue and play one round-trip at a time. Memoized by flow: a flow's
  // first hop fixes its session from its original endpoints, and later hops of
  // that flow (e.g. after a NAT src rewrite) inherit it instead of splitting off.
  _sessionKey(evt) {
    const flow = evt.flow;
    if (flow && this._flowToSession.has(flow)) return this._flowToSession.get(flow);
    const a = evt.payload_src || (evt.src && evt.src.address) || '';
    const b = evt.payload_dst || (evt.dst && evt.dst.address) || '';
    const key = [a, b].sort().join('|') || flow || '?';
    if (flow) this._flowToSession.set(flow, key);
    return key;
  },

  // Wall-clock source, indirected so tests can control inter-probe timing.
  _now() {
    return performance.now();
  },

  // Visible pause (ms) before the next queued packet animates: zero within a
  // probe (consecutive hops of one round trip are continuous), or the real
  // inter-probe gap when a new probe (a new flow) starts — so a `ping -c`'s
  // -i spacing shows as a pause between round trips instead of being collapsed
  // by the queue when the animation is slower than the interval.
  _probeGapMs(q, next) {
    if (q.curFlow === undefined || next.flow === q.curFlow) return 0;
    return Math.max(0, (next._t || 0) - (q.flowStartT || 0));
  },

  _onSegmentDone(key) {
    const q = this._queues.get(key);
    if (!q) return;
    if (q.pending.length === 0) {
      this._queues.delete(key);
      return;
    }
    const next = q.pending.shift();
    const gap = this._probeGapMs(q, next);
    if (next.flow !== q.curFlow) { q.curFlow = next.flow; q.flowStartT = next._t; }
    const gen = this._gen;
    const go = () => {
      if (gen !== this._gen) return;        // sim reset during the pause: abort
      this._render(next, () => this._onSegmentDone(key));
    };
    if (gap > 0) setTimeout(go, gap);
    else go();
  },

  _render(evt, onDone) {
    const isChatterEvt = this._ROUTING_CHATTER_TYPES.has(evt.type);
    // Geometry can't be resolved (device/network node missing): bail out, but
    // for chatter still fire arrival so the pinned store row gets cleaned up
    // instead of leaking until idle.
    const bail = () => {
      if (isChatterEvt) {
        bus.dispatchEvent(new CustomEvent('sim:packet-arrived', {
          detail: { payloadId: this._chatterDotKey(evt), device: null },
        }));
      }
      if (onDone) onDone();
    };

    const srcNode = lookupDeviceNode(evt.src && evt.src.device);
    if (!srcNode) { bail(); return; }

    // Two fabric kinds: multi-access Networks have a visible rail node;
    // point-to-point Links are a direct device↔device edge with no fabric
    // node. Look up which kind this event's fabric is so we can route the
    // animation along the right geometry.
    const isLink = !!(state.links && state.links[evt.network]);
    const netNode = isLink ? null : lookupNetworkNode(evt.network);
    if (!isLink && !netNode) { bail(); return; }

    const layer = document.getElementById('packet-layer');
    if (!layer) { bail(); return; }

    const color = this.COLORS[evt.type] || { fill: '#777', opacity: 1.0 };
    // Packets render as small rounded rectangles — the typical "datagram"
    // glyph used in networking literature. The packet is centered via cx/cy
    // proxy attributes (data-cx/cy) so the tween helpers can keep using a
    // simple point-tracking API; we translate into x/y at write time.
    // Chatter packets use a composite key so each interface emission gets its
    // own distinct dot↔row binding. User traffic continues to use bare payload_id.
    const isChatter = isChatterEvt;
    const dotKey = isChatter ? this._chatterDotKey(evt) : evt.payload_id;

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
    const wantBadge = id != null && (!isChatter || chatterBadgesOn);
    if (wantBadge) {
      const label = isChatter ? `#R${id}` : `#${id}`;
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

    // Broadcast chatter (Hello / LSA on a LAN with broadcast dst) has no
    // single destination device — the simulator emits one packet event but
    // every listener on the fabric receives it. Without fan-out the dot
    // would stop at the source rail tap. Spawn a clone per listener so the
    // visual reaches every peer, and let each clone fire its own arrival
    // so the LSA reflood sequencer releases per-listener (not all at once).
    if (!isLink && isChatter && !dstDeviceName) {
      const listeners = this._collectFabricListeners(evt.network, srcName);
      if (listeners.length > 0) {
        return this._renderBroadcastFanout(
          evt, srcNode, netNode, dot, badge, dotKey, color, listeners, onDone,
        );
      }
      // 0 listeners: fall through and use the single-segment path so the
      // packet at least travels src → rail tap and fires one arrival.
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
        // For LSAs, every router on the fabric has now visually received
        // this hop — release any re-floods that were waiting on them.
        PacketAnim._markLSAArrivedOnFabric(evt);
      }
      if (onDone) onDone();
    };

    let segs = isLink
      ? this._segmentsForLink(evt, srcNode)
      : this._segmentsForNetwork(evt, srcNode, netNode);
    if (segs.length === 0) {
      finish();
      return;
    }

    // Weight each segment's duration by its approximate length so the packet
    // travels at a single constant velocity through the whole path — no jarring
    // speed-up or stall at the rail junctions. Durations are derived from the
    // FULL path so a packet that drops early (below) keeps the same velocity.
    const lens = segs.map(s => this._segLength(s));
    const total = lens.reduce((a, b) => a + b, 0);
    let durs = total > 0
      ? lens.map(l => (l / total) * this.DURATION_MS)
      : segs.map(() => this.DURATION_MS / segs.length);

    // Receiving interface is administratively down: the packet leaves the source
    // but is dropped where it would enter the down link — it never reaches the
    // device. Trim the path to that entry point and fade the dot out there.
    let onComplete = finish;
    if (destInterfaceDown(evt, dstDeviceName)) {
      if (isLink && segs[0] && segs[0].kind === 'bez') {
        // The whole edge is the down link: keep only a short head so the dot
        // just enters the wire before dropping. Wrap _bezHead as a live thunk
        // so the truncated head still follows the wire if a node moves.
        const fullCurve = segs[0].curve;
        segs = [{ kind: 'bez', curve: () => this._bezHead(fullCurve(), 0.3) }];
        durs = [durs[0] * 0.3];
      } else if (segs.length > 1) {
        // LAN: stop at the destination's rail tap — drop the final spoke into
        // the (down) device. Slicing thunk-segments is safe; it just drops
        // the last thunk without evaluating it.
        segs = segs.slice(0, -1);
        durs = durs.slice(0, -1);
      }
      onComplete = () => this._dropDot(dot, dotKey, layer, onDone);
    }

    let i = 0;
    const stepNext = () => {
      if (i >= segs.length) { onComplete(); return; }
      const s = segs[i];
      const d = durs[i];
      const onSegDone = () => { i++; stepNext(); };
      if (s.kind === 'bez') this._tweenBezier(dot, badge, s.curve, d, onSegDone);
      else                  this._tweenPoints(dot, badge, s.from, s.to, d, onSegDone);
    };
    stepNext();
  },

  // Cubic-bezier head: the sub-curve from t=0 to t=`t` (De Casteljau split),
  // used to truncate a packet's path so it only just enters a down link.
  _bezHead(s, t) {
    const lerp = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const q0 = lerp(s.p0, s.c1);
    const q1 = lerp(s.c1, s.c2);
    const q2 = lerp(s.c2, s.p3);
    const r0 = lerp(q0, q1);
    const r1 = lerp(q1, q2);
    const b  = lerp(r0, r1);
    return { p0: s.p0, c1: q0, c2: r0, p3: b };
  },

  // Fade a dropped packet out at its drop point, then remove it and fire an
  // arrival with device:null so the packet-store row is cleaned up. The packet
  // never reached a device. Bails if the sim reset during the fade.
  _dropDot(dot, dotKey, layer, onDone) {
    const gen = this._gen;
    dot.classList.add('pkt-dropped');
    setTimeout(() => {
      if (gen !== PacketAnim._gen) return;   // sim reset mid-fade: nothing to do
      if (dot.parentNode) layer.removeChild(dot);
      if (dotKey) {
        const sel = `text.packet-badge[data-payload-id="${CSS.escape(dotKey)}"]`;
        layer.querySelectorAll(sel).forEach(b => { if (b.parentNode) b.parentNode.removeChild(b); });
        bus.dispatchEvent(new CustomEvent('sim:packet-arrived', {
          detail: { payloadId: dotKey, device: null },
        }));
      }
      if (onDone) onDone();
    }, 260);
  },

  // Multi-access (LAN/rail) path:
  //   src device  →[bezier]→  src tap on rail  →[line]→  dst tap  →[bezier]→  dst device
  // All endpoints are resolver thunks re-evaluated every animation frame so
  // the packet follows live geometry (drag, resize). Presence of each segment
  // is probed once at animation-start (stable for the life of the animation;
  // only positions move).
  _segmentsForNetwork(evt, srcNode, netNode) {
    const srcName = evt.src && evt.src.device;
    const dstName = deviceNameForEndpointOnFabric(evt.dst, evt.network);
    const netName = evt.network;
    // Live resolvers — re-read DOM/state every frame.
    const srcCenter = () => getNodeCenter(lookupDeviceNode(srcName)) || getNodeCenter(netNode);
    const netCenter = () => getNodeCenter(lookupNetworkNode(netName)) || getNodeCenter(netNode);
    const srcTap = () => railTapPoint(srcName, netName) || netCenter();
    const dstTap = () => (dstName ? (railTapPoint(dstName, netName) || netCenter()) : null);
    const dstCenter = () => {
      const n = lookupAddressNodeOnFabric(evt.dst && evt.dst.address, netName)
        || lookupDeviceNode(dstName);
      return n ? getNodeCenter(n) : null;
    };
    // Probe once to decide which segments exist (presence is stable for the
    // life of the animation; only positions move).
    const hasDst = dstName && dstTap() && dstCenter();
    const segs = [];
    segs.push({ kind: 'bez', curve: () => this._bezBetween(srcCenter(), srcTap()) });
    if (hasDst) {
      segs.push({ kind: 'line', from: srcTap, to: dstTap });
      segs.push({ kind: 'bez', curve: () => this._bezBetween(dstTap(), dstCenter()) });
    }
    return segs;
  },

  // Point-to-point link path: a single bezier directly from src device to
  // dst device, clipped to both device rects so the packet rides the same
  // curve that drawLinkEdge renders. No rail tap. The curve thunk re-reads
  // both device positions every frame so the packet follows live geometry.
  _segmentsForLink(evt, srcNode) {
    const srcName = evt.src && evt.src.device;
    if (!srcName) return [];

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
    if (!lookupDeviceNode(dstName) || !getNodeCenter(lookupDeviceNode(dstName))) return [];
    if (!getNodeCenter(lookupDeviceNode(srcName))) return [];

    const srcKind = state.routers[srcName] ? 'router' : 'host';
    const dstKind = state.routers[dstName] ? 'router' : 'host';
    const aSize = NODE[srcKind];
    const bSize = NODE[dstKind];
    // Live curve thunk — re-reads both device positions every frame so the
    // packet rides the visible wire even when a node is dragged mid-flight.
    const curve = () => {
      const sc = getNodeCenter(lookupDeviceNode(srcName));
      const dc = getNodeCenter(lookupDeviceNode(dstName));
      const [ax, ay] = clipToRect(sc.x, sc.y, aSize.w, aSize.h, dc.x, dc.y);
      const [bx, by] = clipToRect(dc.x, dc.y, bSize.w, bSize.h, sc.x, sc.y);
      return linkBezier(evt.network, { x: ax, y: ay }, { x: bx, y: by });
    };
    return [{ kind: 'bez', curve }];
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

  // Approximate segment arc length. Samples each thunk-segment once at
  // animation-start for velocity weighting — accurate enough to keep packet
  // velocity perceptually constant.
  _segLength(s) {
    if (s.kind === 'line') {
      const a = s.from(), b = s.to();
      return Math.hypot(b.x - a.x, b.y - a.y);
    }
    // bezier: sample 8 points along the curve and sum distances
    const c = s.curve();
    const N = 8;
    let prevX = c.p0.x, prevY = c.p0.y, len = 0;
    for (let k = 1; k <= N; k++) {
      const t = k / N, u = 1 - t;
      const a = u*u*u, b = 3*u*u*t, cc = 3*u*t*t, d = t*t*t;
      const x = a*c.p0.x + b*c.c1.x + cc*c.c2.x + d*c.p3.x;
      const y = a*c.p0.y + b*c.c1.y + cc*c.c2.y + d*c.p3.y;
      len += Math.hypot(x - prevX, y - prevY);
      prevX = x; prevY = y;
    }
    return len;
  },

  _chatterAllowed(evt) {
    // Key on the message identity, not just (device, network): a router
    // re-floods several *distinct* LSAs out one interface in a tight burst
    // during convergence, and each is a real message that should animate.
    // Including payload_id collapses only true repeats of the *same* message
    // (the protocol's self-reflood back through the origin iface).
    const key = `${evt.src && evt.src.device}:${evt.network}:${evt.payload_id}`;
    const now = performance.now();
    const last = this._lastChatter.get(key) || 0;
    if (now - last < 200) return false;
    this._lastChatter.set(key, now);
    return true;
  },

  // Straight-line tween between two resolver thunks. Each thunk returns the
  // current world point for its endpoint, re-evaluated every frame so the
  // packet follows live geometry (drag, resize). Freezes while paused; aborts
  // on sim reset.
  _tweenPoints(dot, badge, fromFn, toFn, durationMs, done) {
    const gen = this._gen;
    let elapsed = 0;
    let lastT = performance.now();
    const tick = () => {
      if (gen !== PacketAnim._gen) return;   // sim reset: abort, don't finish
      const now = performance.now();
      if (Sim.state !== 'paused') elapsed += (now - lastT);
      lastT = now;
      const t = Math.min(1, elapsed / durationMs);
      const fp = fromFn(), tp = toFn();
      setPacketAnchor(dot, badge, fp.x + (tp.x - fp.x) * t, fp.y + (tp.y - fp.y) * t);
      if (t < 1) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  },

  // Cubic-bezier tween. `curveFn` returns the current {p0,c1,c2,p3} each frame
  // so the packet rides the wire as endpoints move. Freezes while paused;
  // aborts on reset.
  _tweenBezier(dot, badge, curveFn, durationMs, done) {
    const gen = this._gen;
    let elapsed = 0;
    let lastT = performance.now();
    const tick = () => {
      if (gen !== PacketAnim._gen) return;   // sim reset: abort, don't finish
      const now = performance.now();
      if (Sim.state !== 'paused') elapsed += (now - lastT);
      lastT = now;
      const t = Math.min(1, elapsed / durationMs);
      const { p0, c1, c2, p3 } = curveFn();
      const u = 1 - t;
      const a = u*u*u, b = 3*u*u*t, c = 3*u*t*t, d = t*t*t;
      setPacketAnchor(dot, badge,
        a*p0.x + b*c1.x + c*c2.x + d*p3.x,
        a*p0.y + b*c1.y + c*c2.y + d*p3.y);
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

// Reset all animation state. A fresh run must not inherit stale sequencer
// markers (which would let re-floods skip their wait), and — crucially — any
// dots/badges still in flight (or frozen by a pause) must be cleared from the
// canvas; bumping the generation also aborts the rAF tweens driving them, so
// they can't run to completion and dispatch a stale arrival afterwards.
PacketAnim._reset = function () {
  this._gen++;   // invalidate any in-flight animation (tweens abort on mismatch)
  this._lsaArrivedAt.clear();
  this._lsaPending.clear();
  this._queues.clear();
  this._flowToSession.clear();
  this._lastChatter.clear();
  const layer = document.getElementById('packet-layer');
  if (layer) layer.replaceChildren();
};

bus.addEventListener('sim:status-changed', (e) => {
  const status = e.detail && e.detail.status;
  if (status === 'idle') PacketAnim._reset();
});

// Live chatter-badge toggle: when the body flag changes while chatter dots are
// already in flight, add or remove their badges without waiting for a re-render.
// Toggle-added badges stay at the dot's last position (no tween) — acceptable
// because chatter packets are short-lived.
bus.addEventListener('packets:chatter-badges-changed', () => {
  const layer = document.getElementById('packet-layer');
  if (!layer) return;
  const chatterOn = document.body.dataset.chatterBadges === 'on';
  const dots = layer.querySelectorAll(ROUTING_CHATTER_SELECTOR);
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
