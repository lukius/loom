import { describe, it, expect } from 'vitest';
import { validateTopology } from './preflight.js';

// A minimal, fully-valid topology: one LAN with a host on it.
function validTopo() {
  return {
    networks: { lan1: { cidr: '192.168.0.0/24' } },
    links: {},
    hosts: { h1: { network: 'lan1', address: '192.168.0.2' } },
    routers: {},
  };
}

describe('validateTopology', () => {
  it('accepts a complete topology', () => {
    expect(validateTopology(validTopo())).toEqual({ ok: true });
  });

  it('rejects an empty topology with no selection', () => {
    const r = validateTopology({ networks: {}, links: {}, hosts: {}, routers: {} });
    expect(r.ok).toBe(false);
    expect(r.selection).toBeNull();
    expect(r.message).toMatch(/add a lan/i);
  });

  it('flags a network with a blank CIDR and points at it', () => {
    const t = validTopo();
    t.networks.lan1.cidr = '';
    const r = validateTopology(t);
    expect(r.ok).toBe(false);
    expect(r.selection).toEqual({ kind: 'network', name: 'lan1' });
    expect(r.message).toContain('lan1');
    expect(r.message).toMatch(/cidr/i);
  });

  it('flags a malformed network CIDR', () => {
    const t = validTopo();
    t.networks.lan1.cidr = '192.168.0.0';   // no mask
    const r = validateTopology(t);
    expect(r.ok).toBe(false);
    expect(r.selection).toEqual({ kind: 'network', name: 'lan1' });
  });

  it('requires links to be /30 or /31', () => {
    const t = validTopo();
    t.links = { p2p1: { cidr: '10.0.0.0/24' } };
    const r = validateTopology(t);
    expect(r.ok).toBe(false);
    expect(r.selection).toEqual({ kind: 'link', name: 'p2p1' });
    expect(r.message).toMatch(/\/30|\/31/);
  });

  it('flags a host that is not attached to a LAN or link', () => {
    const t = validTopo();
    t.hosts.h1 = { network: '', address: '' };
    const r = validateTopology(t);
    expect(r.ok).toBe(false);
    expect(r.selection).toEqual({ kind: 'host', name: 'h1' });
    expect(r.message).toMatch(/lan|link/i);
  });

  it('flags a host with no address', () => {
    const t = validTopo();
    t.hosts.h1.address = '';
    const r = validateTopology(t);
    expect(r.ok).toBe(false);
    expect(r.selection).toEqual({ kind: 'host', name: 'h1' });
    expect(r.message).toMatch(/address/i);
  });

  it('flags a router interface with no address', () => {
    const t = validTopo();
    t.routers = { r1: { interfaces: { eth0: { network: 'lan1', address: '' } } } };
    const r = validateTopology(t);
    expect(r.ok).toBe(false);
    expect(r.selection).toEqual({ kind: 'router', name: 'r1' });
    expect(r.message).toMatch(/address/i);
  });
});
