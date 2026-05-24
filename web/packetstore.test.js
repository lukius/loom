import { describe, it, expect, beforeEach } from 'vitest';
import { PacketStore } from './packetstore.js';
import { bus } from './state.js';

beforeEach(() => {
  PacketStore._reset();
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
