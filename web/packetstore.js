// web/packetstore.js
// Live registry of packets in the simulation: in-flight user traffic
// (one row per payload_id), in-flight routing chatter (kept separately so
// it can be hidden/aggregated), the last 10 delivered user packets, and
// the NAT translations seen for each payload. Owns monotonic numeric IDs
// (#1, #2, #R1, ...) used both in the Packets panel and as on-canvas
// badges. All state is reset when the simulator goes idle.
import { bus } from './state.js';

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
