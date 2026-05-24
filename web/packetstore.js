// web/packetstore.js
// Live registry of packets in the simulation: in-flight user traffic
// (one row per payload_id), in-flight routing chatter (kept separately so
// it can be hidden/aggregated), the last 10 delivered user packets, and
// the NAT translations seen for each payload. Owns monotonic numeric IDs
// (#1, #2, #R1, ...) used both in the Packets panel and as on-canvas
// badges. All state is reset when the simulator goes idle.
import { bus, state } from './state.js';

let _debounceTimer = null;
let _simPaused = false;
const _pendingChatterDeletes = new Set();

function _scheduleEmit() {
  if (_simPaused) return;
  if (_debounceTimer != null) return;
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    bus.dispatchEvent(new CustomEvent('packets:list-changed'));
  }, 50);
}

export const PacketStore = {
  inFlight:     new Map(),  // payload_id -> PacketRow
  chatter:      new Map(),  // payload_id -> ChatterRow
  recent:       [],          // PacketRow[], FIFO cap 10
  natByPayload: new Map(),   // payload_id -> NatHop[]
  _nextUserId: 1,
  _nextChatterId: 1,

  _reset() {
    this.inFlight.clear();
    this.chatter.clear();
    this.recent.length = 0;
    this.natByPayload.clear();
    this._nextUserId = 1;
    this._nextChatterId = 1;
    if (_debounceTimer != null) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }
    _simPaused = false;
    _pendingChatterDeletes.clear();
  },
};

bus.addEventListener('sim:status-changed', (e) => {
  const status = e.detail && e.detail.status;
  if (status === 'idle') {
    _simPaused = false;
    _pendingChatterDeletes.clear();
    PacketStore._reset();
    _scheduleEmit();
    return;
  }
  const wasPaused = _simPaused;
  _simPaused = (status === 'paused');
  if (wasPaused && status === 'running') {
    // Resume: process deferred chatter deletions.
    let mutated = false;
    for (const pid of _pendingChatterDeletes) {
      if (PacketStore.chatter.delete(pid)) mutated = true;
    }
    _pendingChatterDeletes.clear();
    if (mutated) _scheduleEmit();
    // Force one emit so the panel catches up on any state changes
    // suppressed during pause.
    _scheduleEmit();
  }
});

const USER_TYPES = new Set(['user_datagram', 'ping_request', 'ping_reply']);

function resolveDeviceLabel(address, st) {
  if (!address) return null;
  for (const [hn, h] of Object.entries(st.hosts || {})) {
    if (h.address === address) return hn;
  }
  for (const [rn, r] of Object.entries(st.routers || {})) {
    for (const iff of Object.values(r.interfaces || {})) {
      if (iff.address === address) return rn;
    }
  }
  return null;
}

function _resolveDeviceOnFabric(address, fabricName, st) {
  if (!address || !fabricName) return null;
  for (const [hn, h] of Object.entries(st.hosts || {})) {
    if (h.address === address && (h.network === fabricName || h.link === fabricName)) return hn;
  }
  for (const [rn, r] of Object.entries(st.routers || {})) {
    for (const iff of Object.values(r.interfaces || {})) {
      if (iff.address === address && (iff.network === fabricName || iff.link === fabricName)) return rn;
    }
  }
  return null;
}

function _handleUserPacket(evt, st) {
  let row = PacketStore.inFlight.get(evt.payload_id);
  if (!row) {
    const payloadSrc = evt.payload_src || (evt.src && evt.src.address) || null;
    const payloadDst = evt.payload_dst || (evt.dst && evt.dst.address) || null;
    row = {
      id: PacketStore._nextUserId++,
      payloadId: evt.payload_id,
      type: evt.type,
      payloadSrc,
      payloadDst,
      srcLabel: resolveDeviceLabel(payloadSrc, st) || payloadSrc,
      dstLabel: resolveDeviceLabel(payloadDst, st) || payloadDst,
      hops: [],
      status: 'in_flight',
      payload: (evt.payload && typeof evt.payload === 'object') ? evt.payload : {},
      _arrivedCount: 0,
      _visible: false,
    };
    PacketStore.inFlight.set(evt.payload_id, row);
  }
  const srcDev = (evt.src && evt.src.device) || _resolveDeviceOnFabric(evt.src && evt.src.address, evt.network, st) || (evt.src && evt.src.address) || '?';
  const dstDev = (evt.dst && evt.dst.device) || _resolveDeviceOnFabric(evt.dst && evt.dst.address, evt.network, st) || (evt.dst && evt.dst.address) || '?';
  row.hops.push({
    srcDev,
    dstDev,
    network: evt.network,
    t: performance.now(),
    isFinal: (evt.dst && evt.dst.address) === row.payloadDst,
  });
  _scheduleEmit();
}

function _resolveIface(srcDev, network, st) {
  const r = (st.routers || {})[srcDev];
  if (!r) return null;
  for (const [ifn, iff] of Object.entries(r.interfaces || {})) {
    if (iff.network === network || iff.link === network) return ifn;
  }
  return null;
}

function _handleChatterPacket(evt, st) {
  if (PacketStore.chatter.has(evt.payload_id)) return;
  PacketStore.chatter.set(evt.payload_id, {
    id: PacketStore._nextChatterId++,
    payloadId: evt.payload_id,
    type: 'routing_flood',
    srcDev: evt.src && evt.src.device,
    network: evt.network,
    iface: _resolveIface(evt.src && evt.src.device, evt.network, st),
    payload: (evt.payload && typeof evt.payload === 'object') ? evt.payload : {},
  });
  // TTL: muted or throttled chatter has no canvas animation, so no
  // sim:packet-arrived will fire. Clean up after the visual budget so
  // the chatter map doesn't grow without bound. For chatter that does
  // animate, finish() will dispatch sim:packet-arrived earlier and this
  // becomes a no-op. If paused at fire time, defer the deletion so the
  // panel stays frozen until resume.
  setTimeout(() => {
    if (_simPaused) {
      _pendingChatterDeletes.add(evt.payload_id);
      return;
    }
    if (PacketStore.chatter.delete(evt.payload_id)) _scheduleEmit();
  }, 2000);
  _scheduleEmit();
}

PacketStore._NAT_CACHE_LIMIT = 1024;

PacketStore.natFor = function (payloadId) {
  return this.natByPayload.get(payloadId) || [];
};

bus.addEventListener('sim:nat', (e) => {
  const evt = e.detail;
  if (!evt || !evt.payload_id) return;
  const list = PacketStore.natByPayload.get(evt.payload_id) || [];
  list.push(evt);
  PacketStore.natByPayload.set(evt.payload_id, list);
  if (PacketStore.natByPayload.size > PacketStore._NAT_CACHE_LIMIT) {
    const firstKey = PacketStore.natByPayload.keys().next().value;
    PacketStore.natByPayload.delete(firstKey);
  }
  _scheduleEmit();
});

PacketStore.idFor = function (evt) {
  if (!evt || !evt.payload_id) return null;
  if (USER_TYPES.has(evt.type)) {
    const row = this.inFlight.get(evt.payload_id);
    return row ? row.id : null;
  }
  if (evt.type === 'routing_flood') {
    const row = this.chatter.get(evt.payload_id);
    return row ? row.id : null;
  }
  return null;
};

bus.addEventListener('sim:packet', (e) => {
  const evt = e.detail;
  if (!evt || !evt.payload_id) return;
  if (USER_TYPES.has(evt.type)) _handleUserPacket(evt, state);
  else if (evt.type === 'routing_flood') _handleChatterPacket(evt, state);
});

bus.addEventListener('sim:packet-arrived', (e) => {
  const detail = e.detail || {};
  const payloadId = detail.payloadId;
  if (!payloadId) return;
  if (PacketStore.chatter.delete(payloadId)) {
    _scheduleEmit();
    return;
  }
  const row = PacketStore.inFlight.get(payloadId);
  if (!row) return;
  row._arrivedCount = (row._arrivedCount || 0) + 1;
  const lastHop = row.hops[row.hops.length - 1];
  if (row._arrivedCount >= row.hops.length && lastHop && lastHop.isFinal) {
    row.status = 'delivered';
    delete row._arrivedCount;
    PacketStore.inFlight.delete(payloadId);
    PacketStore.recent.push(row);
    if (PacketStore.recent.length > 10) PacketStore.recent.shift();
  }
  _scheduleEmit();
});

bus.addEventListener('packets:dot-appeared', (e) => {
  const payloadId = e.detail && e.detail.payloadId;
  if (!payloadId) return;
  const row = PacketStore.inFlight.get(payloadId);  // only inFlight now
  if (!row) return;
  if (row._visible) return;
  row._visible = true;
  _scheduleEmit();
});

PacketStore.visibleInFlight = function () {
  return Array.from(this.inFlight.values()).filter(r => r._visible).sort((a, b) => a.id - b.id);
};

PacketStore.visibleChatterCount = function () {
  return this.chatter.size;
};

PacketStore.visibleChatter = function () {
  return Array.from(this.chatter.values()).sort((a, b) => a.id - b.id);
};
