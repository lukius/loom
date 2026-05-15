import { describe, it, expect, beforeEach } from 'vitest';
import { tapPointOnRail, railTapPoint, deviceNameForEndpoint } from './canvas.js';
import {
  state,
  RAIL_DEFAULT_WIDTH, RAIL_THICKNESS, RAIL_TICK_INSET,
} from './state.js';

const W = RAIL_DEFAULT_WIDTH; // 180
const H = RAIL_THICKNESS;     // 10
const INSET = RAIL_TICK_INSET; // 12

describe('tapPointOnRail — horizontal rail', () => {
  const rail = { x: 0, y: 0, w: W, orientation: 'h' };

  it('returns top-edge tap when device sits above the rail', () => {
    const [x, y] = tapPointOnRail({ x: 30, y: -100 }, rail);
    expect(x).toBe(30);
    expect(y).toBe(-H / 2);
  });

  it('returns bottom-edge tap when device sits below the rail', () => {
    const [x, y] = tapPointOnRail({ x: 30, y: 100 }, rail);
    expect(x).toBe(30);
    expect(y).toBe(H / 2);
  });

  it('clamps tap-x to the rail span minus inset on the right', () => {
    const [x] = tapPointOnRail({ x: 9999, y: -10 }, rail);
    expect(x).toBe(W / 2 - INSET);
  });

  it('clamps tap-x to the rail span minus inset on the left', () => {
    const [x] = tapPointOnRail({ x: -9999, y: -10 }, rail);
    expect(x).toBe(-W / 2 + INSET);
  });

  it('respects rail offset (x,y) when computing tap', () => {
    const offset = { x: 200, y: 100, w: W, orientation: 'h' };
    const [x, y] = tapPointOnRail({ x: 210, y: 50 }, offset);
    expect(x).toBe(210);          // within span, no clamp
    expect(y).toBe(100 - H / 2);  // top edge of offset rail
  });

  it('falls back to default width when rail.w is undefined', () => {
    const noW = { x: 0, y: 0, orientation: 'h' };
    const [x] = tapPointOnRail({ x: 9999, y: 0 }, noW);
    expect(x).toBe(RAIL_DEFAULT_WIDTH / 2 - INSET);
  });

  it('defaults to horizontal when rail.orientation is undefined', () => {
    const bare = { x: 0, y: 0, w: W };
    const [x, y] = tapPointOnRail({ x: 30, y: -100 }, bare);
    expect(x).toBe(30);
    expect(y).toBe(-H / 2);
  });

  it('uses a custom rail width when provided', () => {
    const wide = { x: 0, y: 0, w: 400, orientation: 'h' };
    const [x] = tapPointOnRail({ x: 250, y: -10 }, wide);
    // 250 is within 400/2 - 12 = 188? No — 250 > 188, so clamped to 188.
    expect(x).toBe(400 / 2 - INSET);
  });

  it('uses center y (rail.y) to decide above vs below', () => {
    const r = { x: 0, y: 50, w: W, orientation: 'h' };
    const [, yA] = tapPointOnRail({ x: 0, y: 49 }, r);
    const [, yB] = tapPointOnRail({ x: 0, y: 51 }, r);
    expect(yA).toBe(50 - H / 2); // device just above center -> top edge
    expect(yB).toBe(50 + H / 2); // device just below center -> bottom edge
  });
});

describe('tapPointOnRail — vertical rail', () => {
  const rail = { x: 0, y: 0, w: W, orientation: 'v' };

  it('returns left-edge tap when device sits to the left', () => {
    const [x, y] = tapPointOnRail({ x: -100, y: 30 }, rail);
    expect(x).toBe(-H / 2);
    expect(y).toBe(30);
  });

  it('returns right-edge tap when device sits to the right', () => {
    const [x, y] = tapPointOnRail({ x: 100, y: 30 }, rail);
    expect(x).toBe(H / 2);
    expect(y).toBe(30);
  });

  it('clamps tap-y to the rail span minus inset on the bottom', () => {
    const [, y] = tapPointOnRail({ x: 10, y: 9999 }, rail);
    expect(y).toBe(W / 2 - INSET);
  });

  it('clamps tap-y to the rail span minus inset on the top', () => {
    const [, y] = tapPointOnRail({ x: 10, y: -9999 }, rail);
    expect(y).toBe(-W / 2 + INSET);
  });

  it('respects rail offset (x,y) when computing tap', () => {
    const offset = { x: 200, y: 100, w: W, orientation: 'v' };
    const [x, y] = tapPointOnRail({ x: 150, y: 110 }, offset);
    expect(x).toBe(200 - H / 2); // left edge of offset rail
    expect(y).toBe(110);          // within span, no clamp
  });

  it('uses center x (rail.x) to decide left vs right', () => {
    const r = { x: 50, y: 0, w: W, orientation: 'v' };
    const [xA] = tapPointOnRail({ x: 49, y: 0 }, r);
    const [xB] = tapPointOnRail({ x: 51, y: 0 }, r);
    expect(xA).toBe(50 - H / 2);
    expect(xB).toBe(50 + H / 2);
  });
});

describe('railTapPoint — resolves device+network names to world-space tap', () => {
  beforeEach(() => {
    // Snapshot reset — these tests mutate state.hosts/routers/networks.
    state.hosts = {};
    state.routers = {};
    state.networks = {};
  });

  it('returns the same coordinates as tapPointOnRail for a host', () => {
    state.networks.lan1 = { x: 100, y: 0, cidr: '10.0.0.0/24' };
    state.hosts.h1 = { network: 'lan1', x: 0, y: -50, address: '10.0.0.1' };
    const tap = railTapPoint('h1', 'lan1');
    const [x, y] = tapPointOnRail({ x: 0, y: -50 }, state.networks.lan1);
    expect(tap).toEqual({ x, y });
  });

  it('resolves routers by name as well as hosts', () => {
    state.networks.lan2 = { x: 200, y: 200, cidr: '10.0.1.0/24' };
    state.routers.r1 = {
      x: 50, y: 50,
      interfaces: { eth0: { network: 'lan2', address: '10.0.1.1', cost: 10 } },
    };
    expect(railTapPoint('r1', 'lan2')).not.toBeNull();
  });

  it('honours per-LAN width and orientation', () => {
    state.networks.lan_v = {
      x: 0, y: 0, cidr: '10.0.2.0/24',
      w: 300, orientation: 'v',
    };
    state.hosts.h2 = { network: 'lan_v', x: 200, y: 0, address: '10.0.2.1' };
    const tap = railTapPoint('h2', 'lan_v');
    // Vertical rail: cross axis is x, so tap.x = +h/2 (device is to the right).
    expect(tap.x).toBe(RAIL_THICKNESS / 2);
    expect(tap.y).toBe(0);
  });

  it('returns null when the network is unknown', () => {
    state.hosts.h3 = { network: 'ghost', x: 10, y: 10, address: '1.1.1.1' };
    expect(railTapPoint('h3', 'ghost')).toBeNull();
  });

  it('returns null when the device is unknown', () => {
    state.networks.lan3 = { x: 0, y: 0, cidr: '10.0.3.0/24' };
    expect(railTapPoint('phantom', 'lan3')).toBeNull();
  });

  it('returns null when the device has no coordinates', () => {
    state.networks.lan4 = { x: 0, y: 0, cidr: '10.0.4.0/24' };
    state.hosts.h4 = { network: 'lan4' };
    expect(railTapPoint('h4', 'lan4')).toBeNull();
  });
});

describe('deviceNameForEndpoint — resolves packet endpoints to device names', () => {
  beforeEach(() => {
    state.hosts = {};
    state.routers = {};
    state.networks = {};
  });

  it('prefers an explicit device field when present', () => {
    state.hosts.h1 = { address: '10.0.0.1', x: 0, y: 0, network: 'lan' };
    expect(deviceNameForEndpoint({ device: 'h1', address: '10.0.0.1' })).toBe('h1');
  });

  it('looks up a host by its address when device is missing', () => {
    state.hosts.h2 = { address: '10.0.0.2', x: 0, y: 0, network: 'lan' };
    expect(deviceNameForEndpoint({ address: '10.0.0.2' })).toBe('h2');
  });

  it('looks up a router by interface address when device is missing', () => {
    state.routers.r1 = {
      x: 0, y: 0,
      interfaces: { eth0: { network: 'lan', address: '10.0.0.254', cost: 10 } },
    };
    expect(deviceNameForEndpoint({ address: '10.0.0.254' })).toBe('r1');
  });

  it('returns null on an unknown address', () => {
    expect(deviceNameForEndpoint({ address: '99.99.99.99' })).toBeNull();
  });

  it('returns null on a falsy endpoint', () => {
    expect(deviceNameForEndpoint(null)).toBeNull();
    expect(deviceNameForEndpoint(undefined)).toBeNull();
  });

  it('returns null when neither device nor address is provided', () => {
    expect(deviceNameForEndpoint({})).toBeNull();
  });
});
