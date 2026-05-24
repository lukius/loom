import { describe, it, expect, beforeEach } from 'vitest';
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
});
