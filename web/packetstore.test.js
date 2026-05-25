import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PacketStore } from './packetstore.js';
import { state, bus } from './state.js';

beforeEach(() => {
  PacketStore._reset();
  state.hosts = {};
  state.routers = {};
});

describe('PacketStore — initial state and sim-stop reset', () => {
  it('starts empty with both counters at 1', () => {
    expect(PacketStore.inFlight.size).toBe(0);
    expect(PacketStore.chatter.size).toBe(0);
    expect(PacketStore.recent.length).toBe(0);
    expect(PacketStore.natByPayload.size).toBe(0);
    expect(PacketStore._nextUserId).toBe(1);
    expect(PacketStore._nextChatterId).toBe(1);
  });

  it('clears every map and resets counters when the sim goes idle', () => {
    PacketStore.inFlight.set('p1', { id: 1, hops: [], status: 'in_flight' });
    PacketStore.chatter.set('c1', { id: 1 });
    PacketStore.recent.push({ id: 2 });
    PacketStore.natByPayload.set('p1', [{ direction: 'outbound' }]);
    PacketStore._nextUserId = 5;
    PacketStore._nextChatterId = 9;

    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'idle' } }));

    expect(PacketStore.inFlight.size).toBe(0);
    expect(PacketStore.chatter.size).toBe(0);
    expect(PacketStore.recent.length).toBe(0);
    expect(PacketStore.natByPayload.size).toBe(0);
    expect(PacketStore._nextUserId).toBe(1);
    expect(PacketStore._nextChatterId).toBe(1);
  });

  it('does NOT reset on running or paused', () => {
    PacketStore.inFlight.set('p1', { id: 1 });
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'running' } }));
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'paused' } }));
    expect(PacketStore.inFlight.size).toBe(1);
  });
});

function userPacketEvt({ payload_id, type = 'user_datagram', srcDev, srcAddr, dstDev, dstAddr, network, payload_src, payload_dst }) {
  return {
    type, payload_id, network,
    src: { device: srcDev, address: srcAddr },
    dst: { device: dstDev, address: dstAddr },
    payload_src: payload_src || srcAddr,
    payload_dst: payload_dst || dstAddr,
  };
}

describe('PacketStore — user-traffic ID assignment and hop tracking', () => {
  it('assigns #1 to the first payload and #2 to the second', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1',
      dstDev: 'r1', dstAddr: '10.0.0.254', network: 'lan_a',
      payload_dst: '10.0.1.5',
    }) }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'p2', srcDev: 'h2', srcAddr: '10.0.0.2',
      dstDev: 'r1', dstAddr: '10.0.0.254', network: 'lan_a',
      payload_dst: '10.0.1.6',
    }) }));

    expect(PacketStore.inFlight.get('p1').id).toBe(1);
    expect(PacketStore.inFlight.get('p2').id).toBe(2);
  });

  it('preserves the same id and appends to hops when the same payload is seen again', () => {
    const e1 = userPacketEvt({ payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1', dstDev: 'r1', dstAddr: '10.0.0.254', network: 'lan_a', payload_dst: '10.0.1.5' });
    const e2 = userPacketEvt({ payload_id: 'p1', srcDev: 'r1', srcAddr: '10.0.1.1', dstDev: 'r2', dstAddr: '10.0.1.2', network: 'link_0', payload_src: '10.0.0.1', payload_dst: '10.0.1.5' });
    const e3 = userPacketEvt({ payload_id: 'p1', srcDev: 'r2', srcAddr: '10.0.1.2', dstDev: 'h4', dstAddr: '10.0.1.5', network: 'lan_b', payload_src: '10.0.0.1', payload_dst: '10.0.1.5' });

    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e1 }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e2 }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e3 }));

    const row = PacketStore.inFlight.get('p1');
    expect(row.id).toBe(1);
    expect(row.hops.length).toBe(3);
    expect(row.hops[0]).toEqual(expect.objectContaining({ srcDev: 'h1', dstDev: 'r1', network: 'lan_a' }));
    expect(row.hops[2]).toEqual(expect.objectContaining({ srcDev: 'r2', dstDev: 'h4', network: 'lan_b' }));
    expect(row.status).toBe('in_flight');
    expect(row.payloadSrc).toBe('10.0.0.1');
    expect(row.payloadDst).toBe('10.0.1.5');
    expect(row.type).toBe('user_datagram');
  });

  it('resolves srcLabel/dstLabel to device names when both endpoints are local', () => {
    state.hosts = {
      h1: { address: '10.0.0.1', network: 'lan_a' },
      h4: { address: '10.0.1.5', network: 'lan_b' },
    };
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1',
      dstDev: 'r1', dstAddr: '10.0.0.254', network: 'lan_a',
      payload_src: '10.0.0.1', payload_dst: '10.0.1.5',
    }) }));
    const row = PacketStore.inFlight.get('p1');
    expect(row.srcLabel).toBe('h1');
    expect(row.dstLabel).toBe('h4');
  });

  it('falls back to addresses when an endpoint is not a known local device', () => {
    state.hosts = { h1: { address: '10.0.0.1', network: 'lan_a' } };
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1',
      dstDev: 'r1', dstAddr: '10.0.0.254', network: 'lan_a',
      payload_src: '10.0.0.1', payload_dst: '8.8.8.8',
    }) }));
    const row = PacketStore.inFlight.get('p1');
    expect(row.srcLabel).toBe('h1');
    expect(row.dstLabel).toBe('8.8.8.8');
  });

  it('exposes idFor(evt) → numeric id for known user-traffic events', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1',
      dstDev: 'r1', dstAddr: '10.0.0.254', network: 'lan_a',
    }) }));
    expect(PacketStore.idFor({ payload_id: 'p1', type: 'user_datagram' })).toBe(1);
    expect(PacketStore.idFor({ payload_id: 'unknown', type: 'user_datagram' })).toBe(null);
  });

  it('resolves hop dstDev from address when wire event omits dst.device', () => {
    state.hosts = {
      h1: { address: '10.0.0.1', network: 'lan_a' },
      h2: { address: '10.0.0.2', network: 'lan_a' },
    };
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram',
      payload_id: 'p1',
      network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      // intentionally NO device on dst — matches the real backend
      dst: { address: '10.0.0.2' },
      payload_src: '10.0.0.1',
      payload_dst: '10.0.0.2',
    } }));
    const row = PacketStore.inFlight.get('p1');
    expect(row.hops[0].dstDev).toBe('h2');
  });

  it('tags each hop with isFinal (true only for the final hop)', () => {
    const e1 = userPacketEvt({ payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1', dstDev: 'r1', dstAddr: '10.0.0.254', network: 'lan_a', payload_dst: '10.0.1.5' });
    const e2 = userPacketEvt({ payload_id: 'p1', srcDev: 'r1', srcAddr: '10.0.1.1', dstDev: 'h4', dstAddr: '10.0.1.5', network: 'lan_b', payload_src: '10.0.0.1', payload_dst: '10.0.1.5' });
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e1 }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e2 }));
    const row = PacketStore.inFlight.get('p1');
    expect(row.hops[0].isFinal).toBe(false);
    expect(row.hops[1].isFinal).toBe(true);
  });
});

function arrivedEvt(payloadId, device) {
  return { payloadId, device };
}

describe('PacketStore — last-hop promotion and FIFO cap', () => {
  it('promotes a row to recent when the matching arrival fires for the final hop', () => {
    const e1 = userPacketEvt({ payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1', dstDev: 'r1', dstAddr: '10.0.0.254', network: 'lan_a', payload_dst: '10.0.1.5' });
    const e2 = userPacketEvt({ payload_id: 'p1', srcDev: 'r1', srcAddr: '10.0.1.1', dstDev: 'h4', dstAddr: '10.0.1.5', network: 'lan_b', payload_src: '10.0.0.1', payload_dst: '10.0.1.5' });

    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e1 }));
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: arrivedEvt('p1', 'r1') }));
    expect(PacketStore.inFlight.has('p1')).toBe(true);
    expect(PacketStore.recent.length).toBe(0);

    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e2 }));
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: arrivedEvt('p1', 'h4') }));
    expect(PacketStore.inFlight.has('p1')).toBe(false);
    expect(PacketStore.recent.length).toBe(1);
    expect(PacketStore.recent[0].id).toBe(1);
    expect(PacketStore.recent[0].status).toBe('delivered');
  });

  it('keeps recent FIFO-capped at 10', () => {
    for (let i = 1; i <= 11; i++) {
      const pid = `p${i}`;
      bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
        payload_id: pid, srcDev: 'h1', srcAddr: '10.0.0.1',
        dstDev: 'h2', dstAddr: '10.0.0.2', network: 'lan_a',
        payload_src: '10.0.0.1', payload_dst: '10.0.0.2',
      }) }));
      bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: arrivedEvt(pid, 'h2') }));
    }
    expect(PacketStore.recent.length).toBe(10);
    expect(PacketStore.recent[0].id).toBe(2);
    expect(PacketStore.recent[9].id).toBe(11);
  });

  it('ignores arrival events for unknown payloads', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: arrivedEvt('never-seen', 'h4') }));
    expect(PacketStore.inFlight.size).toBe(0);
    expect(PacketStore.recent.length).toBe(0);
  });

  it('does NOT promote to recent when only the first of multiple hops has arrived', () => {
    const e1 = userPacketEvt({ payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1', dstDev: 'r1', dstAddr: '10.0.0.254', network: 'lan_a', payload_dst: '10.0.1.5' });
    const e2 = userPacketEvt({ payload_id: 'p1', srcDev: 'r1', srcAddr: '10.0.1.1', dstDev: 'r2', dstAddr: '10.0.1.2', network: 'link_0', payload_src: '10.0.0.1', payload_dst: '10.0.1.5' });
    const e3 = userPacketEvt({ payload_id: 'p1', srcDev: 'r2', srcAddr: '10.0.1.2', dstDev: 'h4', dstAddr: '10.0.1.5', network: 'lan_b', payload_src: '10.0.0.1', payload_dst: '10.0.1.5' });
    // All three sim:packet events fire BEFORE any arrival (the simulator is faster than the animation).
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e1 }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e2 }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e3 }));
    // First arrival fires — represents hop 1 completing on canvas.
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId: 'p1', device: 'r1' } }));
    expect(PacketStore.inFlight.has('p1')).toBe(true);
    expect(PacketStore.recent.length).toBe(0);
    // Second arrival.
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId: 'p1', device: 'r2' } }));
    expect(PacketStore.inFlight.has('p1')).toBe(true);
    expect(PacketStore.recent.length).toBe(0);
    // Final arrival promotes.
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId: 'p1', device: 'h4' } }));
    expect(PacketStore.inFlight.has('p1')).toBe(false);
    expect(PacketStore.recent.length).toBe(1);
  });

  it('tracks _arrivedCount on the row', () => {
    const e1 = userPacketEvt({ payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1', dstDev: 'r1', dstAddr: '10.0.0.254', network: 'lan_a', payload_dst: '10.0.1.5' });
    const e2 = userPacketEvt({ payload_id: 'p1', srcDev: 'r1', srcAddr: '10.0.1.1', dstDev: 'h4', dstAddr: '10.0.1.5', network: 'lan_b', payload_src: '10.0.0.1', payload_dst: '10.0.1.5' });
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e1 }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: e2 }));
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId: 'p1', device: 'r1' } }));
    expect(PacketStore.inFlight.get('p1')._arrivedCount).toBe(1);
  });
});

function chatterEvt({ payload_id, srcDev, iface = 'eth0', network }) {
  return {
    type: 'routing_flood',
    payload_id, network,
    src: { device: srcDev, iface, address: '0.0.0.0' },
    dst: { device: null, address: '255.255.255.255' },
    payload_src: '0.0.0.0',
    payload_dst: '255.255.255.255',
  };
}

// Build the composite chatter key the same way packetstore.js does.
function chatterKey(payload_id, srcDev, iface, network) {
  return `${payload_id}|${srcDev}|${iface}|${network}`;
}

describe('PacketStore — routing chatter', () => {
  beforeEach(() => {
    state.routers = {
      r1: { interfaces: {
        eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 },
        eth1: { network: 'lan_b', address: '10.0.1.254', cost: 5 },
      } },
    };
  });

  it('lives in the chatter map with its own counter (#R1, #R2)', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatterEvt({ payload_id: 'c1', srcDev: 'r1', iface: 'eth0', network: 'lan_a' }) }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatterEvt({ payload_id: 'c2', srcDev: 'r1', iface: 'eth1', network: 'lan_b' }) }));

    const k1 = chatterKey('c1', 'r1', 'eth0', 'lan_a');
    const k2 = chatterKey('c2', 'r1', 'eth1', 'lan_b');
    expect(PacketStore.inFlight.size).toBe(0);
    expect(PacketStore.chatter.size).toBe(2);
    expect(PacketStore.chatter.get(k1).id).toBe(1);
    expect(PacketStore.chatter.get(k2).id).toBe(2);
    expect(PacketStore.chatter.get(k1).srcDev).toBe('r1');
    expect(PacketStore.chatter.get(k1).network).toBe('lan_a');
  });

  it('resolves the source iface name from state.routers', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatterEvt({ payload_id: 'c1', srcDev: 'r1', iface: 'eth1', network: 'lan_b' }) }));
    const k1 = chatterKey('c1', 'r1', 'eth1', 'lan_b');
    expect(PacketStore.chatter.get(k1).iface).toBe('eth1');
  });

  it('removes the chatter row on arrival (no recent for chatter)', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatterEvt({ payload_id: 'c1', srcDev: 'r1', iface: 'eth0', network: 'lan_a' }) }));
    const key = chatterKey('c1', 'r1', 'eth0', 'lan_a');
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', { detail: { payloadId: key, device: 'r2' } }));
    expect(PacketStore.chatter.size).toBe(0);
    expect(PacketStore.recent.length).toBe(0);
  });

  it('chatter counter is independent of the user counter', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatterEvt({ payload_id: 'c1', srcDev: 'r1', iface: 'eth0', network: 'lan_a' }) }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'u1', srcDev: 'h1', srcAddr: '10.0.0.1',
      dstDev: 'h2', dstAddr: '10.0.0.2', network: 'lan_a',
    }) }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatterEvt({ payload_id: 'c2', srcDev: 'r1', iface: 'eth0', network: 'lan_a' }) }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'u2', srcDev: 'h2', srcAddr: '10.0.0.2',
      dstDev: 'h1', dstAddr: '10.0.0.1', network: 'lan_a',
    }) }));

    const k1 = chatterKey('c1', 'r1', 'eth0', 'lan_a');
    const k2 = chatterKey('c2', 'r1', 'eth0', 'lan_a');
    expect(PacketStore.chatter.get(k1).id).toBe(1);
    expect(PacketStore.chatter.get(k2).id).toBe(2);
    expect(PacketStore.inFlight.get('u1').id).toBe(1);
    expect(PacketStore.inFlight.get('u2').id).toBe(2);
  });

  it('idFor returns the chatter id', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: chatterEvt({ payload_id: 'c1', srcDev: 'r1', iface: 'eth0', network: 'lan_a' }) }));
    expect(PacketStore.idFor({
      payload_id: 'c1', type: 'routing_flood',
      src: { device: 'r1', iface: 'eth0' }, network: 'lan_a',
    })).toBe(1);
  });
});

describe('PacketStore — NAT cache', () => {
  it('accumulates nat hops keyed by payload_id, FIFO-evicting past _NAT_CACHE_LIMIT', () => {
    bus.dispatchEvent(new CustomEvent('sim:nat', { detail: {
      payload_id: 'p1', router: 'r1', direction: 'outbound',
      original_src: '10.0.0.1', rewritten_src: '200.1.1.5',
    } }));
    bus.dispatchEvent(new CustomEvent('sim:nat', { detail: {
      payload_id: 'p1', router: 'r1', direction: 'inbound',
      rewritten_dst: '200.1.1.5', original_dst: '10.0.0.1',
    } }));

    const hops = PacketStore.natByPayload.get('p1');
    expect(hops.length).toBe(2);
    expect(hops[0].direction).toBe('outbound');
    expect(hops[1].direction).toBe('inbound');

    expect(PacketStore.natFor('p1').length).toBe(2);
    expect(PacketStore.natFor('unknown').length).toBe(0);
  });

  it('cache is bounded to _NAT_CACHE_LIMIT', () => {
    for (let i = 0; i < PacketStore._NAT_CACHE_LIMIT + 5; i++) {
      bus.dispatchEvent(new CustomEvent('sim:nat', { detail: {
        payload_id: `p${i}`, router: 'r1', direction: 'outbound',
        original_src: '10.0.0.1', rewritten_src: '200.1.1.5',
      } }));
    }
    expect(PacketStore.natByPayload.size).toBe(PacketStore._NAT_CACHE_LIMIT);
  });
});

describe('PacketStore — visibility', () => {
  it('rows start with _visible: false', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1',
      dstDev: 'h2', dstAddr: '10.0.0.2', network: 'lan_a',
    }) }));
    expect(PacketStore.inFlight.get('p1')._visible).toBe(false);
    expect(PacketStore.visibleInFlight().length).toBe(0);
  });

  it('packets:dot-appeared flips _visible to true', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1',
      dstDev: 'h2', dstAddr: '10.0.0.2', network: 'lan_a',
    }) }));
    bus.dispatchEvent(new CustomEvent('packets:dot-appeared', { detail: { payloadId: 'p1' } }));
    expect(PacketStore.inFlight.get('p1')._visible).toBe(true);
    expect(PacketStore.visibleInFlight().length).toBe(1);
  });

  it('chatter rows appear in visibleChatter immediately, no dot-appeared signal needed', () => {
    state.routers = { r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 } } } };
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: 'c1', network: 'lan_a',
      src: { device: 'r1', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
    } }));
    expect(PacketStore.visibleChatterCount()).toBe(1);
    expect(PacketStore.visibleChatter().length).toBe(1);
  });
});

describe('PacketStore — payload field', () => {
  it('captures evt.payload on the row at creation', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram', payload_id: 'p1', network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      dst: { address: '10.0.0.2' },
      payload_src: '10.0.0.1', payload_dst: '10.0.0.2',
      payload: { bytes: 13 },
    } }));
    expect(PacketStore.inFlight.get('p1').payload).toEqual({ bytes: 13 });
  });

  it('defaults payload to {} when wire event omits it', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram', payload_id: 'p1', network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      dst: { address: '10.0.0.2' },
      payload_src: '10.0.0.1', payload_dst: '10.0.0.2',
      // no payload key
    } }));
    expect(PacketStore.inFlight.get('p1').payload).toEqual({});
  });

  it('does not overwrite payload on subsequent hops', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram', payload_id: 'p1', network: 'lan_a',
      src: { device: 'h1', address: '10.0.0.1' },
      dst: { address: '10.0.0.254' },
      payload_src: '10.0.0.1', payload_dst: '10.0.1.5',
      payload: { bytes: 5 },
    } }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'user_datagram', payload_id: 'p1', network: 'link_0',
      src: { device: 'r1', address: '10.0.1.1' },
      dst: { address: '10.0.1.5' },
      payload_src: '10.0.0.1', payload_dst: '10.0.1.5',
      payload: { bytes: 999 },  // simulator wouldn't actually do this, but check we don't overwrite
    } }));
    expect(PacketStore.inFlight.get('p1').payload).toEqual({ bytes: 5 });
  });
});

import { vi } from 'vitest';

describe('PacketStore — chatter TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.routers = { r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 } } } };
  });
  afterEach(() => vi.useRealTimers());

  it('removes chatter rows after the TTL even when no sim:packet-arrived fires', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: 'c1', network: 'lan_a',
      src: { device: 'r1', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
    } }));
    expect(PacketStore.chatter.size).toBe(1);
    vi.advanceTimersByTime(1999);
    expect(PacketStore.chatter.size).toBe(1);
    vi.advanceTimersByTime(2);
    expect(PacketStore.chatter.size).toBe(0);
  });
});

describe('PacketStore — freeze during sim pause', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.routers = { r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 } } } };
  });
  afterEach(() => vi.useRealTimers());

  function chatter(pid) {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: pid, network: 'lan_a',
      src: { device: 'r1', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
    } }));
  }

  it('suppresses packets:list-changed while paused', () => {
    const spy = vi.fn();
    bus.addEventListener('packets:list-changed', spy);
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'paused' } }));
    chatter('c1');
    chatter('c2');
    vi.advanceTimersByTime(100);
    expect(spy).not.toHaveBeenCalled();
  });

  it('defers chatter TTL deletion while paused', () => {
    chatter('c1');
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'paused' } }));
    vi.advanceTimersByTime(3000);   // past TTL
    expect(PacketStore.chatter.size).toBe(1);
  });

  it('processes deferred deletions and re-emits on resume', () => {
    chatter('c1');
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'paused' } }));
    vi.advanceTimersByTime(3000);
    expect(PacketStore.chatter.size).toBe(1);   // deferred
    const spy = vi.fn();
    bus.addEventListener('packets:list-changed', spy);
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'running' } }));
    expect(PacketStore.chatter.size).toBe(0);   // deferred delete applied
    vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalled();
  });

  it('idle still resets, clearing deferred deletions', () => {
    chatter('c1');
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'paused' } }));
    vi.advanceTimersByTime(3000);
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'idle' } }));
    expect(PacketStore.chatter.size).toBe(0);
    expect(PacketStore._nextChatterId).toBe(1);
  });
});

describe('PacketStore — debounced packets:list-changed', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces a burst of three events into one emission after ~50ms', () => {
    const spy = vi.fn();
    bus.addEventListener('packets:list-changed', spy);

    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'p1', srcDev: 'h1', srcAddr: '10.0.0.1', dstDev: 'h2', dstAddr: '10.0.0.2', network: 'lan_a',
    }) }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'p2', srcDev: 'h1', srcAddr: '10.0.0.1', dstDev: 'h2', dstAddr: '10.0.0.2', network: 'lan_a',
    }) }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: userPacketEvt({
      payload_id: 'p3', srcDev: 'h1', srcAddr: '10.0.0.1', dstDev: 'h2', dstAddr: '10.0.0.2', network: 'lan_a',
    }) }));

    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emits once on sim-idle reset as well', () => {
    const spy = vi.fn();
    bus.addEventListener('packets:list-changed', spy);
    bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: 'idle' } }));
    vi.advanceTimersByTime(50);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('PacketStore — chatter payload field', () => {
  beforeEach(() => {
    state.routers = { r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 } } } };
  });

  it('captures payload on chatter rows', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: 'c1', network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
      payload: { seq: 5, destinations: [{ prefix: '10.0.0.0/24', cost: 1 }] },
    } }));
    const k1 = chatterKey('c1', 'r1', 'eth0', 'lan_a');
    expect(PacketStore.chatter.get(k1).payload).toEqual({
      seq: 5,
      destinations: [{ prefix: '10.0.0.0/24', cost: 1 }],
    });
  });

  it('defaults payload to {} when the wire event omits it', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: 'c2', network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
    } }));
    const k2 = chatterKey('c2', 'r1', 'eth0', 'lan_a');
    expect(PacketStore.chatter.get(k2).payload).toEqual({});
  });

  it('stores payloadId on the chatter row', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: 'c3', network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '0.0.0.0' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '0.0.0.0', payload_dst: '255.255.255.255',
    } }));
    const key = 'c3|r1|eth0|lan_a';
    expect(PacketStore.chatter.get(key).payloadId).toBe(key);
  });
});

describe('PacketStore — chatter grouping by payload_id', () => {
  beforeEach(() => {
    state.routers = { r1: { interfaces: {
      eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 },
      eth1: { network: 'lan_b', address: '10.0.1.254', cost: 5 },
      eth2: { network: 'lan_c', address: '10.0.2.254', cost: 5 },
    } } };
  });

  function emit(payloadId, iface, network) {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: payloadId, network,
      src: { device: 'r1', iface, address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
      payload: { seq: 42, destinations: [] },
    } }));
  }

  it('groups three emissions of the same payload_id into one group', () => {
    emit('msg-1', 'eth0', 'lan_a');
    emit('msg-1', 'eth1', 'lan_b');
    emit('msg-1', 'eth2', 'lan_c');
    const groups = PacketStore.visibleChatterGroups();
    expect(groups.length).toBe(1);
    expect(groups[0].payloadId).toBe('msg-1');
    expect(groups[0].emissionKeys.length).toBe(3);
    expect(PacketStore.visibleChatterGroupCount()).toBe(1);
  });

  it('keeps distinct payload_ids in distinct groups', () => {
    emit('msg-1', 'eth0', 'lan_a');
    emit('msg-2', 'eth0', 'lan_a');
    const groups = PacketStore.visibleChatterGroups();
    expect(groups.length).toBe(2);
    expect(groups.map(g => g.payloadId).sort()).toEqual(['msg-1', 'msg-2']);
  });

  it('group id reflects the earliest emission (lowest #R)', () => {
    emit('msg-1', 'eth0', 'lan_a');
    const firstRow = Array.from(PacketStore.chatter.values())[0];
    const firstId = firstRow.id;
    emit('msg-1', 'eth1', 'lan_b');
    const group = PacketStore.visibleChatterGroups()[0];
    expect(group.id).toBe(firstId);
  });

  // All emissions of one logical message must share one #R id. Otherwise the
  // panel row label (#RN, the group id) doesn't match the canvas badges
  // (#R{emission.id}) on the dots it halos, and the user reads it as
  // "highlighted unrelated messages". Distinct payload_ids must still get
  // distinct ids.
  it('all emissions of the same payload_id share one #R id', () => {
    emit('msg-1', 'eth0', 'lan_a');
    emit('msg-1', 'eth1', 'lan_b');
    emit('msg-1', 'eth2', 'lan_c');
    const ids = Array.from(PacketStore.chatter.values())
      .filter(r => Array.from(PacketStore.chatter.entries()).find(([k, v]) => v === r)[0].startsWith('msg-1|'))
      .map(r => r.id);
    expect(new Set(ids).size).toBe(1);
  });

  it('distinct payload_ids get distinct #R ids', () => {
    emit('msg-1', 'eth0', 'lan_a');
    emit('msg-2', 'eth0', 'lan_a');
    const ids = Array.from(PacketStore.chatter.values()).map(r => r.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('PacketStore — chatter composite key (T29)', () => {
  beforeEach(() => {
    state.routers = { r1: { interfaces: {
      eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 },
      eth1: { network: 'lan_b', address: '10.0.1.254', cost: 5 },
    } } };
  });

  it('treats multiple emissions of the same payload_id as distinct chatter rows sharing one #R id', () => {
    const sharedPayloadId = 'msg-1';
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: sharedPayloadId, network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
    } }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: sharedPayloadId, network: 'lan_b',
      src: { device: 'r1', iface: 'eth1', address: '10.0.1.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.1.254', payload_dst: '255.255.255.255',
    } }));
    expect(PacketStore.chatter.size).toBe(2);
    const rows = Array.from(PacketStore.chatter.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    // Distinct composite keys (one row per emission) — but ONE shared id.
    expect(rows[0][0]).not.toBe(rows[1][0]);
    expect(rows[0][1].id).toBe(rows[1][1].id);
    const networks = rows.map(([, r]) => r.network).sort();
    expect(networks).toEqual(['lan_a', 'lan_b']);
  });

  it('idFor returns the same id for each emission of the same payload_id', () => {
    const sharedPayloadId = 'msg-1';
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: sharedPayloadId, network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
    } }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: sharedPayloadId, network: 'lan_b',
      src: { device: 'r1', iface: 'eth1', address: '10.0.1.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.1.254', payload_dst: '255.255.255.255',
    } }));
    const idA = PacketStore.idFor({
      type: 'routing_flood', payload_id: sharedPayloadId, network: 'lan_a',
      src: { device: 'r1', iface: 'eth0' },
    });
    const idB = PacketStore.idFor({
      type: 'routing_flood', payload_id: sharedPayloadId, network: 'lan_b',
      src: { device: 'r1', iface: 'eth1' },
    });
    expect(idA).not.toBe(null);
    expect(idB).toBe(idA);
  });

  it('chatter row payloadId is the composite key, not the bare payload_id', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: 'msg-2', network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
    } }));
    const row = Array.from(PacketStore.chatter.values())[0];
    expect(row.payloadId).toBe('msg-2|r1|eth0|lan_a');
  });
});

describe('PacketStore — hello routing-chatter classification', () => {
  beforeEach(() => {
    state.routers = { r1: { interfaces: { eth0: { network: 'lan_a', address: '10.0.0.254', cost: 5 } } } };
  });

  function helloEvt({ payload_id, srcDev = 'r1', iface = 'eth0', network = 'lan_a' }) {
    return {
      type: 'hello', payload_id, network,
      src: { device: srcDev, iface, address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
      payload: { originator: 'r1', neighbours_heard: [] },
    };
  }

  it('hello event goes into the chatter map (not inFlight)', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: helloEvt({ payload_id: 'h1' }) }));
    expect(PacketStore.inFlight.size).toBe(0);
    expect(PacketStore.chatter.size).toBe(1);
  });

  it('hello chatter row stores type "hello"', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: helloEvt({ payload_id: 'h1' }) }));
    const row = Array.from(PacketStore.chatter.values())[0];
    expect(row.type).toBe('hello');
  });

  it('hello gets its own #R id (independent of routing_flood counter)', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: {
      type: 'routing_flood', payload_id: 'lsa-1', network: 'lan_a',
      src: { device: 'r1', iface: 'eth0', address: '10.0.0.254' },
      dst: { device: null, address: '255.255.255.255' },
      payload_src: '10.0.0.254', payload_dst: '255.255.255.255',
    } }));
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: helloEvt({ payload_id: 'h1' }) }));
    const rows = Array.from(PacketStore.chatter.values()).sort((a, b) => a.id - b.id);
    expect(rows[0].id).toBe(1);
    expect(rows[1].id).toBe(2);
  });

  it('idFor returns the chatter id for a hello event', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: helloEvt({ payload_id: 'h1' }) }));
    expect(PacketStore.idFor({
      type: 'hello', payload_id: 'h1',
      src: { device: 'r1', iface: 'eth0' }, network: 'lan_a',
    })).toBe(1);
  });

  it('visibleChatterGroups includes hello groups with type "hello"', () => {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: helloEvt({ payload_id: 'h1' }) }));
    const groups = PacketStore.visibleChatterGroups();
    expect(groups.length).toBe(1);
    expect(groups[0].type).toBe('hello');
  });
});
