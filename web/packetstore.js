// web/packetstore.js
// Live registry of packets in the simulation: in-flight user traffic
// (one row per payload_id), in-flight routing chatter (kept separately so
// it can be hidden/aggregated), the last 10 delivered user packets, and
// the NAT translations seen for each payload. Owns monotonic numeric IDs
// (#1, #2, #R1, ...) used both in the Packets panel and as on-canvas
// badges. All state is reset when the simulator goes idle.
import { bus, state } from './state.js';

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
  },
};

bus.addEventListener('sim:status-changed', (e) => {
  if (e.detail && e.detail.status === 'idle') PacketStore._reset();
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
    };
    PacketStore.inFlight.set(evt.payload_id, row);
  }
  row.hops.push({
    srcDev: evt.src && evt.src.device,
    dstDev: evt.dst && evt.dst.device,
    network: evt.network,
    t: performance.now(),
  });
  row._isLastHop = (evt.dst && evt.dst.address) === row.payloadDst;
}

PacketStore.idFor = function (evt) {
  if (!evt || !evt.payload_id) return null;
  if (USER_TYPES.has(evt.type)) {
    const row = this.inFlight.get(evt.payload_id);
    return row ? row.id : null;
  }
  return null;  // chatter handled in Task 4
};

bus.addEventListener('sim:packet', (e) => {
  const evt = e.detail;
  if (!evt || !evt.payload_id) return;
  if (USER_TYPES.has(evt.type)) _handleUserPacket(evt, state);
});

bus.addEventListener('sim:packet-arrived', (e) => {
  const detail = e.detail || {};
  const payloadId = detail.payloadId;
  if (!payloadId) return;
  const row = PacketStore.inFlight.get(payloadId);
  if (!row) return;
  if (!row._isLastHop) return;
  row.status = 'delivered';
  delete row._isLastHop;
  PacketStore.inFlight.delete(payloadId);
  PacketStore.recent.push(row);
  if (PacketStore.recent.length > 10) PacketStore.recent.shift();
});
