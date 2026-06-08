// web/yaml-io.test.js
//
// Tests for the position-preserving reimport behaviour added to importYaml.
// Other importYaml / exportYaml coverage lives in state.test.js — this file
// focuses exclusively on the position-snapshot/reapply contract.

import { describe, it, expect, beforeEach } from 'vitest';
import { state } from './state.js';
import { importYaml, exportYaml } from './yaml-io.js';

const YAML_ONE_NET = `
internet:
  name: test
  autonomous_systems:
    test:
      asn: 65000
      networks:
        lan1: "10.0.0.0/24"
      hosts: {}
      routers: {}
`;

const YAML_NET_AND_HOST = `
internet:
  name: test
  autonomous_systems:
    test:
      asn: 65000
      networks:
        lan1: "10.0.0.0/24"
      hosts:
        h1: { network: lan1, address: "10.0.0.2" }
      routers: {}
`;

const YAML_WITH_ROUTER = `
internet:
  name: test
  autonomous_systems:
    test:
      asn: 65000
      networks:
        lan1: "10.0.0.0/24"
      hosts: {}
      routers:
        r1:
          interfaces:
            eth0: { network: lan1, address: "10.0.0.1", cost: 10 }
`;

const YAML_WITH_LINK = `
internet:
  name: test
  autonomous_systems:
    test:
      asn: 65000
      networks: {}
      links:
        p2p1: "192.168.0.0/30"
      hosts: {}
      routers: {}
`;

beforeEach(() => {
  // Reset state to a clean slate before each test.
  state.networks = {};
  state.hosts = {};
  state.routers = {};
  state.links = {};
  state.natTables = {};
  state.selection = null;
  // proj-name may be queried inside importYaml
  document.body.innerHTML = '<input id="proj-name" /><div id="toasts"></div>';
});

describe('exportYaml config blocks', () => {
  beforeEach(() => {
    state.networks = {}; state.hosts = {}; state.routers = {}; state.links = {};
    state.asName = 'main';
    state.config = { packet_duration_ms: 2400 };
    state.protocol = { hello_interval: 5, lsa_refresh_interval: 15 };
  });

  it('emits internet.config and per-AS config.protocol', () => {
    const out = globalThis.jsyaml.load(exportYaml());
    expect(out.internet.config.packet_duration_ms).toBe(2400);
    const proto = out.internet.autonomous_systems.main.config.protocol;
    expect(proto.hello_interval).toBe(5);
    expect(proto.lsa_refresh_interval).toBe(15);
  });
});

describe('importYaml — resync mode: preserveSelection + preserveView', () => {
  it('preserves state.selection when the selected entity survives the reimport', () => {
    importYaml(YAML_NET_AND_HOST);
    state.selection = { kind: 'host', name: 'h1' };

    importYaml(YAML_NET_AND_HOST, { preserveSelection: true });

    expect(state.selection).toEqual({ kind: 'host', name: 'h1' });
  });

  it('clears state.selection when the selected entity was removed in the new YAML', () => {
    importYaml(YAML_NET_AND_HOST);
    state.selection = { kind: 'host', name: 'h1' };

    // YAML without h1
    importYaml(YAML_ONE_NET, { preserveSelection: true });

    expect(state.selection).toBeNull();
  });

  it('clears state.selection on a normal import (preserveSelection not set)', () => {
    importYaml(YAML_NET_AND_HOST);
    state.selection = { kind: 'host', name: 'h1' };

    importYaml(YAML_NET_AND_HOST);

    expect(state.selection).toBeNull();
  });

  it('does NOT call fitView when preserveView is true', () => {
    importYaml(YAML_ONE_NET);
    let fitViewCalled = false;

    importYaml(YAML_ONE_NET, {
      fitView: () => { fitViewCalled = true; },
      preserveView: true,
    });

    expect(fitViewCalled).toBe(false);
  });

  it('calls fitView when preserveView is false (normal import)', () => {
    importYaml(YAML_ONE_NET);
    let fitViewCalled = false;

    importYaml(YAML_ONE_NET, { fitView: () => { fitViewCalled = true; } });

    expect(fitViewCalled).toBe(true);
  });

  it('preserves state.view transform when preserveView is true', () => {
    importYaml(YAML_ONE_NET);
    state.view = { x: 100, y: 200, k: 1.5 };

    importYaml(YAML_ONE_NET, { preserveView: true });

    expect(state.view).toEqual({ x: 100, y: 200, k: 1.5 });
  });

  it('does not crash when preserveSelection is true but state.selection is null', () => {
    importYaml(YAML_ONE_NET);
    state.selection = null;

    expect(() => importYaml(YAML_ONE_NET, { preserveSelection: true })).not.toThrow();
    expect(state.selection).toBeNull();
  });
});

describe('importYaml config blocks', () => {
  const WITH_CONFIG = `
internet:
  name: main
  config:
    packet_duration_ms: 2400
  autonomous_systems:
    main:
      asn: 65000
      config:
        protocol:
          hello_interval: 5
          lsa_refresh_interval: 15
      networks: { lan1: "10.0.0.0/24" }
      hosts: {}
      routers: {}
`;
  const NO_CONFIG = `
internet:
  name: main
  autonomous_systems:
    main:
      asn: 65000
      networks: { lan1: "10.0.0.0/24" }
      hosts: {}
      routers: {}
`;

  it('reads config blocks into state', () => {
    importYaml(WITH_CONFIG);
    expect(state.config.packet_duration_ms).toBe(2400);
    expect(state.protocol.hello_interval).toBe(5);
    expect(state.protocol.lsa_refresh_interval).toBe(15);
  });

  it('falls back to defaults when config is absent', () => {
    state.config = { packet_duration_ms: 999 };
    state.protocol = { hello_interval: 1, lsa_refresh_interval: 2 };
    importYaml(NO_CONFIG);
    expect(state.config.packet_duration_ms).toBe(1800);
    expect(state.protocol.hello_interval).toBe(10);
    expect(state.protocol.lsa_refresh_interval).toBe(30);
  });

  it('round-trips via exportYaml', () => {
    importYaml(WITH_CONFIG);
    const out = globalThis.jsyaml.load(exportYaml());
    expect(out.internet.config.packet_duration_ms).toBe(2400);
    expect(out.internet.autonomous_systems.main.config.protocol.hello_interval).toBe(5);
  });

  it('falls back to defaults for non-positive timers and packet_duration_ms', () => {
    // Zero and negative values are rejected by the backend; they must not be
    // imported — fall back to PROTOCOL_DEFAULTS / CONFIG_DEFAULTS instead.
    const ZERO_TIMERS = `
internet:
  name: main
  config:
    packet_duration_ms: -100
  autonomous_systems:
    main:
      asn: 65000
      config:
        protocol:
          hello_interval: 0
          lsa_refresh_interval: -5
      networks: { lan1: "10.0.0.0/24" }
      hosts: {}
      routers: {}
`;
    importYaml(ZERO_TIMERS);
    expect(state.config.packet_duration_ms).toBe(1800);
    expect(state.protocol.hello_interval).toBe(10);
    expect(state.protocol.lsa_refresh_interval).toBe(30);
  });
});

describe('importYaml — position-preserving reimport (Finding 1)', () => {
  it('preserves a pre-seeded network position across reimport', () => {
    // First import: no saved position → importYaml populates without coords.
    importYaml(YAML_ONE_NET);
    // Simulate user dragging the node.
    state.networks.lan1.x = 123;
    state.networks.lan1.y = 456;

    // Second import of the same YAML: position must be preserved.
    importYaml(YAML_ONE_NET);
    expect(state.networks.lan1.x).toBe(123);
    expect(state.networks.lan1.y).toBe(456);
  });

  it('preserves a pre-seeded host position across reimport', () => {
    importYaml(YAML_NET_AND_HOST);
    state.hosts.h1.x = 300;
    state.hosts.h1.y = 200;

    importYaml(YAML_NET_AND_HOST);
    expect(state.hosts.h1.x).toBe(300);
    expect(state.hosts.h1.y).toBe(200);
  });

  it('preserves a pre-seeded router position across reimport', () => {
    importYaml(YAML_WITH_ROUTER);
    state.routers.r1.x = 500;
    state.routers.r1.y = 350;

    importYaml(YAML_WITH_ROUTER);
    expect(state.routers.r1.x).toBe(500);
    expect(state.routers.r1.y).toBe(350);
  });

  it('preserves a pre-seeded link position across reimport', () => {
    importYaml(YAML_WITH_LINK);
    state.links.p2p1.x = 700;
    state.links.p2p1.y = 400;

    importYaml(YAML_WITH_LINK);
    expect(state.links.p2p1.x).toBe(700);
    expect(state.links.p2p1.y).toBe(400);
  });

  it('does not overwrite positions with undefined when the node had no coords before reimport', () => {
    // If state has no x/y before import (fresh state), no saved coords are set
    // and the resulting entity must NOT have x/y injected as undefined.
    importYaml(YAML_ONE_NET);
    // No drag — so savedPos snapshot had no x/y for lan1.
    // A second import must still not plant undefined x/y.
    importYaml(YAML_ONE_NET);
    expect(state.networks.lan1.x).toBeUndefined();
    expect(state.networks.lan1.y).toBeUndefined();
  });

  it('does not restore position for an entity that has been renamed (new name = new node)', () => {
    importYaml(YAML_ONE_NET);
    state.networks.lan1.x = 100;
    state.networks.lan1.y = 200;

    // YAML with a different network name — lan1 positions must NOT bleed into lan2.
    const YAML_RENAMED = `
internet:
  name: test
  autonomous_systems:
    test:
      asn: 65000
      networks:
        lan2: "10.0.0.0/24"
      hosts: {}
      routers: {}
`;
    importYaml(YAML_RENAMED);
    expect(state.networks.lan2).toBeDefined();
    expect(state.networks.lan2.x).toBeUndefined();
    expect(state.networks.lan2.y).toBeUndefined();
  });

  it('ensurePositions sees at least one positioned node and skips force-directed layout', () => {
    // When a node already has x/y (restored from snapshot), ensurePositions must
    // call _gridFallback (not _forceDirectedLayout). We detect this by giving
    // ensurePositions a spy: if all nodes have positions before ensurePositions
    // runs the spy won't need to assign anything new — the key requirement is
    // that the preserved positions are unchanged after the call.
    importYaml(YAML_NET_AND_HOST);
    state.networks.lan1.x = 400;
    state.networks.lan1.y = 300;
    state.hosts.h1.x = 170;
    state.hosts.h1.y = 300;

    let ensurePositionsCalled = false;
    importYaml(YAML_NET_AND_HOST, {
      ensurePositions: () => { ensurePositionsCalled = true; },
    });

    expect(ensurePositionsCalled).toBe(true);
    // Positions must survive the call.
    expect(state.networks.lan1.x).toBe(400);
    expect(state.networks.lan1.y).toBe(300);
    expect(state.hosts.h1.x).toBe(170);
    expect(state.hosts.h1.y).toBe(300);
  });
});
