import { describe, it, expect, beforeEach } from 'vitest';
import { tapPointOnRail, railTapPoint, deviceNameForEndpoint, deviceNameForEndpointOnFabric, lookupAddressNodeOnFabric, renderCanvas, lookupLinkMidpoint, lookupDeviceNode, shiftLinkLabelsForDeviceMove, startLinkWizard, cancelLinkWizard, finishLinkWizard, getLinkWizard, linkBezier } from './canvas.js';
import {
  state, bus,
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

describe('deviceNameForEndpointOnFabric — fabric-scoped address lookup', () => {
  beforeEach(() => {
    state.hosts = {};
    state.routers = {};
    state.networks = {};
    state.links = {};
  });

  it('prefers an explicit device field over the address lookup', () => {
    expect(deviceNameForEndpointOnFabric({ device: 'r9', address: '10.0.0.1' }, 'lan1')).toBe('r9');
  });

  it('returns the host on the matching fabric (not the same-IP host on a different fabric)', () => {
    state.networks = {
      lan1: { cidr: '192.168.1.0/24', x: 0, y: 0 },
      lan2: { cidr: '192.168.1.0/24', x: 0, y: 0 },  // intentional CIDR reuse
    };
    state.hosts = {
      h_a: { network: 'lan1', address: '192.168.1.10', x: 0, y: 0 },
      h_b: { network: 'lan2', address: '192.168.1.10', x: 0, y: 0 },  // same IP, other fabric
    };
    expect(deviceNameForEndpointOnFabric({ address: '192.168.1.10' }, 'lan1')).toBe('h_a');
    expect(deviceNameForEndpointOnFabric({ address: '192.168.1.10' }, 'lan2')).toBe('h_b');
  });

  it('returns the router with a matching iface on this fabric, ignoring same-IP iface on another fabric', () => {
    state.networks = {
      lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 },
      lan2: { cidr: '10.0.0.0/24', x: 0, y: 0 },
    };
    state.routers = {
      r_a: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.0.0.1', cost: 1 } } },
      r_b: { x: 0, y: 0, interfaces: { eth0: { network: 'lan2', address: '10.0.0.1', cost: 1 } } },
    };
    expect(deviceNameForEndpointOnFabric({ address: '10.0.0.1' }, 'lan1')).toBe('r_a');
    expect(deviceNameForEndpointOnFabric({ address: '10.0.0.1' }, 'lan2')).toBe('r_b');
  });

  it('disambiguates link endpoints that share an address with a host on a different fabric', () => {
    state.networks = {};
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers = {
      r3: { x: 0, y: 0, interfaces: { eth2: { link: 'p2p1', address: '10.0.0.2', cost: 5 } } },
    };
    state.hosts = {
      h5: { link: 'p2p2', address: '10.0.0.2', x: 0, y: 0 },
    };
    expect(deviceNameForEndpointOnFabric({ address: '10.0.0.2' }, 'p2p1')).toBe('r3');
    expect(deviceNameForEndpointOnFabric({ address: '10.0.0.2' }, 'p2p2')).toBe('h5');
  });

  it('returns null when no device on the fabric matches the address', () => {
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    expect(deviceNameForEndpointOnFabric({ address: '10.0.0.99' }, 'lan1')).toBeNull();
  });

  it('returns null when the fabric name is empty/undefined', () => {
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    expect(deviceNameForEndpointOnFabric({ address: '10.0.0.5' }, '')).toBeNull();
    expect(deviceNameForEndpointOnFabric({ address: '10.0.0.5' }, undefined)).toBeNull();
  });

  it('returns null on a falsy endpoint', () => {
    expect(deviceNameForEndpointOnFabric(null, 'lan1')).toBeNull();
    expect(deviceNameForEndpointOnFabric(undefined, 'lan1')).toBeNull();
  });
});

describe('lookupAddressNodeOnFabric — fabric-scoped DOM lookup', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <svg><g id="nodes-layer">
        <g class="node host"   data-kind="host"   data-name="h_a" transform="translate(100 100)"></g>
        <g class="node host"   data-kind="host"   data-name="h_b" transform="translate(200 200)"></g>
      </g></svg>`;
    state.hosts = {
      h_a: { network: 'lan1', address: '192.168.1.10', x: 100, y: 100 },
      h_b: { network: 'lan2', address: '192.168.1.10', x: 200, y: 200 },
    };
    state.routers = {};
    state.networks = {
      lan1: { cidr: '192.168.1.0/24', x: 0, y: 0 },
      lan2: { cidr: '192.168.1.0/24', x: 0, y: 0 },
    };
    state.links = {};
  });

  it('returns the host node on the requested fabric', () => {
    expect(lookupAddressNodeOnFabric('192.168.1.10', 'lan1')?.getAttribute('data-name')).toBe('h_a');
    expect(lookupAddressNodeOnFabric('192.168.1.10', 'lan2')?.getAttribute('data-name')).toBe('h_b');
  });

  it('returns null for an unknown address on the fabric', () => {
    expect(lookupAddressNodeOnFabric('192.168.1.99', 'lan1')).toBeNull();
  });

  it('returns null when address or fabric is missing', () => {
    expect(lookupAddressNodeOnFabric('', 'lan1')).toBeNull();
    expect(lookupAddressNodeOnFabric('192.168.1.10', '')).toBeNull();
  });
});

/* -----------------------------------------------------------------------
   p2p link rendering
   ----------------------------------------------------------------------- */

function setupMinimalDOM() {
  // Minimal SVG DOM expected by renderCanvas / drawLinkEdge / markDirty
  document.body.innerHTML = `
    <svg id="canvas" class="canvas">
      <g id="viewport">
        <g id="edges-layer"></g>
        <g id="nodes-layer"></g>
        <g id="overlay-layer"></g>
      </g>
    </svg>
    <div id="canv-empty" hidden></div>
    <div id="zoom-lvl"></div>
    <div id="save-state"><span class="dot"></span> autosaved</div>
    <div id="toasts"></div>
  `;
}

describe('linkBezier — per-link bow keeps parallel links visually distinct', () => {
  // Two near-vertical links from the same column would otherwise overlap
  // exactly, hiding the topology. The helper bows each link's bezier
  // perpendicular to the chord by a name-keyed amount so they fan apart.

  const p0 = { x: 200, y: 100 };
  const p3 = { x: 200, y: 500 }; // straight vertical chord

  it('preserves the chord endpoints exactly', () => {
    const b = linkBezier('p2p_a', p0, p3);
    expect(b.p0).toEqual(p0);
    expect(b.p3).toEqual(p3);
  });

  it('is deterministic — same name → same control points', () => {
    const a = linkBezier('p2p_a', p0, p3);
    const b = linkBezier('p2p_a', p0, p3);
    expect(a.c1).toEqual(b.c1);
    expect(a.c2).toEqual(b.c2);
  });

  it('two distinct link names sharing a chord produce distinct control points', () => {
    // The whole reason this helper exists: links sharing a column on the
    // canvas should not render the same path.
    const a = linkBezier('p2p_a', p0, p3);
    const b = linkBezier('p2p_b', p0, p3);
    const c1Diff = Math.hypot(a.c1.x - b.c1.x, a.c1.y - b.c1.y);
    const c2Diff = Math.hypot(a.c2.x - b.c2.x, a.c2.y - b.c2.y);
    expect(c1Diff).toBeGreaterThan(0);
    expect(c2Diff).toBeGreaterThan(0);
  });

  it('produces the same curve regardless of input direction', () => {
    // The visible link uses a stable endpoint order; the packet animation
    // uses the sender's direction. If linkBezier weren't direction-symmetric,
    // the two curves would mirror each other and the packet would visibly
    // float off the wire on parallel links.
    const forward = linkBezier('p2p_x', p0, p3);
    const reverse = linkBezier('p2p_x', p3, p0);
    // A bezier from p3→p0 with controls (c2, c1) traces the same curve as
    // one from p0→p3 with (c1, c2). So the swap should produce exactly that.
    expect(reverse.c1).toEqual(forward.c2);
    expect(reverse.c2).toEqual(forward.c1);
  });

  it('the bow is bounded — does not overshoot the chord length', () => {
    // A short link should not get a wildly oversized bow, and a long
    // link should not bow off the canvas.
    const short = linkBezier('whatever', { x: 0, y: 0 }, { x: 0, y: 40 });
    const long  = linkBezier('whatever-else', { x: 0, y: 0 }, { x: 0, y: 4000 });
    // Perpendicular offset of c1 from the chord (chord is x=0):
    expect(Math.abs(short.c1.x)).toBeLessThanOrEqual(40);   // <= chord length
    expect(Math.abs(long.c1.x)).toBeLessThanOrEqual(80);    // capped — not 10% of 4000
  });
});

describe('private LAN visual hint', () => {
  beforeEach(() => {
    setupMinimalDOM();
    state.hosts    = {};
    state.routers  = {};
    state.networks = {};
    state.links    = {};
    state.selection = null;
    state.view     = { x: 0, y: 0, k: 1 };
    state.display  = { showCosts: true, showIfaces: true };
  });

  it('tags a network node with class `private` when its CIDR is RFC1918', () => {
    state.networks.lan_priv = { cidr: '192.168.1.0/24', x: 200, y: 200 };
    state.networks.lan_pub  = { cidr: '200.100.0.0/24', x: 200, y: 400 };
    renderCanvas();
    const priv = document.querySelector('g.node.network[data-name="lan_priv"]');
    const pub  = document.querySelector('g.node.network[data-name="lan_pub"]');
    expect(priv.classList.contains('private')).toBe(true);
    expect(pub.classList.contains('private')).toBe(false);
  });

  it('tags the router-side iface label with `private` when the edge lands on a private LAN', () => {
    state.networks.lan_priv = { cidr: '192.168.1.0/24', x: 200, y: 200 };
    state.networks.lan_pub  = { cidr: '200.100.0.0/24', x: 200, y: 400 };
    state.routers.r1 = {
      x: 400, y: 300,
      interfaces: {
        eth0: { network: 'lan_priv', address: '192.168.1.1', cost: 1 },
        eth1: { network: 'lan_pub',  address: '200.100.0.1', cost: 1 },
      },
    };
    renderCanvas();
    const labels = Array.from(document.querySelectorAll('text.edge-iface'));
    const eth0Label = labels.find(t => t.textContent === 'eth0');
    const eth1Label = labels.find(t => t.textContent === 'eth1');
    expect(eth0Label.classList.contains('private')).toBe(true);
    expect(eth1Label.classList.contains('private')).toBe(false);
  });

  it('does not tag host nodes with `private` (hosts stay at full chroma)', () => {
    state.networks.lan_priv = { cidr: '192.168.1.0/24', x: 200, y: 200 };
    state.hosts.h_a = { network: 'lan_priv', address: '192.168.1.10', x: 100, y: 200 };
    renderCanvas();
    const node = document.querySelector('g.node.host[data-name="h_a"]');
    expect(node.classList.contains('private')).toBe(false);
  });
});

describe('p2p link rendering', () => {
  beforeEach(() => {
    setupMinimalDOM();
    state.hosts    = {};
    state.routers  = {};
    state.networks = {};
    state.links    = {};
    state.selection = null;
    state.view     = { x: 0, y: 0, k: 1 };
    state.display  = { showCosts: true, showIfaces: true };
  });

  it('no links → no p2p edges drawn', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    renderCanvas();
    expect(document.querySelectorAll('.edge.p2p').length).toBe(0);
  });

  it('one link with two router endpoints → one p2p edge + one midpoint group', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    renderCanvas();
    expect(document.querySelectorAll('.edge.p2p').length).toBe(1);
    // both the edge path and the midpoint group carry data-kind="link"
    const linkEls = document.querySelectorAll('[data-kind="link"]');
    expect(linkEls.length).toBe(2); // edge path + midpoint <g>
    expect(document.querySelectorAll('g[data-kind="link"]').length).toBe(1);
  });

  it('midpoint label honors state.links[name].x,y', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 777, y: 888 };
    state.routers.r1 = { x: 100, y: 100, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 500, y: 100, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    renderCanvas();
    const midG = document.querySelector('g[data-kind="link"]');
    expect(midG).not.toBeNull();
    const t = midG.getAttribute('transform') || '';
    expect(t).toContain('777');
    expect(t).toContain('888');
  });

  it('midpoint label shows name and CIDR', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    renderCanvas();
    const midG = document.querySelector('g[data-kind="link"]');
    const text = midG.textContent;
    expect(text).toContain('p2p1');
    expect(text).toContain('10.1.0.0/30');
  });

  it('edge has selected class when link is the current selection', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    state.selection = { kind: 'link', name: 'p2p1' };
    renderCanvas();
    const edge = document.querySelector('.edge.p2p');
    expect(edge.classList.contains('selected')).toBe(true);
  });

  it('edge path has data-kind="link" and data-name on it', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    renderCanvas();
    const edge = document.querySelector('.edge.p2p');
    expect(edge.getAttribute('data-kind')).toBe('link');
    expect(edge.getAttribute('data-name')).toBe('p2p1');
  });

  it('clicking the p2p edge path selects the link', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    renderCanvas();
    let selChanged = false;
    bus.addEventListener('state:selection-changed', () => { selChanged = true; }, { once: true });
    const edge = document.querySelector('.edge.p2p');
    edge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(state.selection).not.toBeNull();
    expect(state.selection.kind).toBe('link');
    expect(state.selection.name).toBe('p2p1');
    expect(selChanged).toBe(true);
  });

  it('clicking the midpoint label selects the link', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    renderCanvas();
    state.selection = null;
    const midG = document.querySelector('g[data-kind="link"]');
    midG.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(state.selection).not.toBeNull();
    expect(state.selection.kind).toBe('link');
    expect(state.selection.name).toBe('p2p1');
  });

  it('host-on-link is supported: renders one p2p edge', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.hosts.h1 = { link: 'p2p1', address: '10.1.0.2', x: 400, y: 200 };
    renderCanvas();
    expect(document.querySelectorAll('.edge.p2p').length).toBe(1);
    const edge = document.querySelector('.edge.p2p');
    expect(edge.getAttribute('data-name')).toBe('p2p1');
  });

  it('link with fewer than two endpoints → no p2p edge drawn', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    // Only one endpoint; canvas should skip gracefully
    renderCanvas();
    expect(document.querySelectorAll('.edge.p2p').length).toBe(0);
  });

  it('mouseenter on p2p edge path adds p2p-hovered to both endpoint device groups', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    renderCanvas();
    const edge = document.querySelector('.edge.p2p');
    edge.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    expect(lookupDeviceNode('r1').classList.contains('p2p-hovered')).toBe(true);
    expect(lookupDeviceNode('r2').classList.contains('p2p-hovered')).toBe(true);
    // mouseleave removes the class
    edge.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    expect(lookupDeviceNode('r1').classList.contains('p2p-hovered')).toBe(false);
    expect(lookupDeviceNode('r2').classList.contains('p2p-hovered')).toBe(false);
  });

  it('mouseenter on midpoint label also adds p2p-hovered to endpoint device groups', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    renderCanvas();
    const midG = document.querySelector('g[data-kind="link"]');
    midG.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    expect(lookupDeviceNode('r1').classList.contains('p2p-hovered')).toBe(true);
    expect(lookupDeviceNode('r2').classList.contains('p2p-hovered')).toBe(true);
    midG.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    expect(lookupDeviceNode('r1').classList.contains('p2p-hovered')).toBe(false);
    expect(lookupDeviceNode('r2').classList.contains('p2p-hovered')).toBe(false);
  });

  it('lookupLinkMidpoint returns the midpoint group element', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    renderCanvas();
    const g = lookupLinkMidpoint('p2p1');
    expect(g).not.toBeNull();
    expect(g.getAttribute('data-kind')).toBe('link');
    expect(g.getAttribute('data-name')).toBe('p2p1');
  });

  it('midpoint label is hidden when state.display.showIfaces is false', () => {
    state.display = { showCosts: true, showIfaces: false };
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    renderCanvas();
    // edge path still drawn — selection on the edge stays possible
    expect(document.querySelectorAll('.edge.p2p').length).toBe(1);
    // midpoint label group suppressed
    expect(document.querySelectorAll('g[data-kind="link"]').length).toBe(0);
  });

  it('shiftLinkLabelsForDeviceMove shifts label by half the device delta', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    shiftLinkLabelsForDeviceMove('r1', 40, -20);
    expect(state.links.p2p1.x).toBe(320);
    expect(state.links.p2p1.y).toBe(190);
  });

  it('shiftLinkLabelsForDeviceMove does not touch labels for unrelated devices', () => {
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 200 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    state.routers.r3 = { x: 800, y: 800, interfaces: {} };  // not on any link
    shiftLinkLabelsForDeviceMove('r3', 1000, 1000);
    expect(state.links.p2p1.x).toBe(300);
    expect(state.links.p2p1.y).toBe(200);
  });

  it('shiftLinkLabelsForDeviceMove preserves user-set offset between label and midpoint', () => {
    // Label placed 50px above the geometric midpoint (300, 200) — i.e. at (300, 150).
    state.links.p2p1 = { cidr: '10.1.0.0/30', x: 300, y: 150 };
    state.routers.r1 = { x: 200, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.1', cost: 5 },
    }};
    state.routers.r2 = { x: 400, y: 200, interfaces: {
      eth0: { link: 'p2p1', address: '10.1.0.2', cost: 5 },
    }};
    // Move r1 to (240, 200): midpoint shifts to (320, 200), label should follow to (320, 150).
    shiftLinkLabelsForDeviceMove('r1', 40, 0);
    state.routers.r1.x = 240;
    expect(state.links.p2p1.x).toBe(320);
    expect(state.links.p2p1.y).toBe(150);  // 50px-above-midpoint offset preserved
  });
});

/* -----------------------------------------------------------------------
   p2p link wizard
   ----------------------------------------------------------------------- */

describe('link wizard — startLinkWizard / cancelLinkWizard', () => {
  beforeEach(() => {
    setupMinimalDOM();
    state.hosts    = {};
    state.routers  = {};
    state.networks = {};
    state.links    = {};
    state.selection = null;
    state.view     = { x: 0, y: 0, k: 1 };
    state.display  = { showCosts: true, showIfaces: true };
    // Ensure no wizard leftover
    cancelLinkWizard();
  });

  it('getLinkWizard() returns null before any wizard starts', () => {
    expect(getLinkWizard()).toBeNull();
  });

  it('startLinkWizard sets transient wizard state', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    const w = getLinkWizard();
    expect(w).not.toBeNull();
    expect(w.source.kind).toBe('router');
    expect(w.source.name).toBe('r1');
  });

  it('startLinkWizard adds link-wizard-source class to source device group', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    const g = lookupDeviceNode('r1');
    expect(g.classList.contains('link-wizard-source')).toBe(true);
  });

  it('cancelLinkWizard clears wizard state', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    cancelLinkWizard();
    expect(getLinkWizard()).toBeNull();
  });

  it('cancelLinkWizard removes link-wizard-source class', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    cancelLinkWizard();
    const g = lookupDeviceNode('r1');
    expect(g.classList.contains('link-wizard-source')).toBe(false);
  });

  it('cancelLinkWizard is safe to call when no wizard is active', () => {
    expect(() => cancelLinkWizard()).not.toThrow();
  });

  it('startLinkWizard injects a .link-wizard-banner into document.body', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    expect(document.querySelector('.link-wizard-banner')).not.toBeNull();
    cancelLinkWizard();
  });

  it('cancelLinkWizard removes the banner', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    cancelLinkWizard();
    expect(document.querySelector('.link-wizard-banner')).toBeNull();
  });
});

describe('link wizard — finishLinkWizard: all four endpoint combinations', () => {
  beforeEach(() => {
    setupMinimalDOM();
    state.hosts    = {};
    state.routers  = {};
    state.networks = {};
    state.links    = {};
    state.selection = null;
    state.view     = { x: 0, y: 0, k: 1 };
    state.display  = { showCosts: true, showIfaces: true };
    document.body.innerHTML += '<div id="toasts"></div>';
    cancelLinkWizard();
  });

  it('router → router: creates link and allocates new interfaces on both', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    state.routers.r2 = { x: 300, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    finishLinkWizard({ kind: 'router', name: 'r2' });

    expect(Object.keys(state.links).length).toBe(1);
    const linkName = Object.keys(state.links)[0];
    const r1Iface = Object.values(state.routers.r1.interfaces).find(i => i.link === linkName);
    const r2Iface = Object.values(state.routers.r2.interfaces).find(i => i.link === linkName);
    expect(r1Iface).toBeDefined();
    expect(r2Iface).toBeDefined();
  });

  it('host → host: creates link and sets link on both hosts', () => {
    state.hosts.h1 = { network: 'lan1', address: '', x: 100, y: 100 };
    state.hosts.h2 = { network: 'lan1', address: '', x: 300, y: 100 };
    renderCanvas();
    startLinkWizard({ kind: 'host', name: 'h1' });
    finishLinkWizard({ kind: 'host', name: 'h2' });

    const linkName = Object.keys(state.links)[0];
    expect(state.hosts.h1.link).toBe(linkName);
    expect(state.hosts.h2.link).toBe(linkName);
    expect(state.hosts.h1.network).toBeUndefined();
    expect(state.hosts.h2.network).toBeUndefined();
  });

  it('router → host: creates link, allocates iface on router, sets link on host', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    state.hosts.h1 = { network: 'lan1', address: '', x: 300, y: 100 };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    finishLinkWizard({ kind: 'host', name: 'h1' });

    const linkName = Object.keys(state.links)[0];
    const rIface = Object.values(state.routers.r1.interfaces).find(i => i.link === linkName);
    expect(rIface).toBeDefined();
    expect(state.hosts.h1.link).toBe(linkName);
  });

  it('host → router: creates link, sets link on host, allocates iface on router', () => {
    state.hosts.h1 = { network: '', address: '', x: 100, y: 100 };
    state.routers.r1 = { x: 300, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'host', name: 'h1' });
    finishLinkWizard({ kind: 'router', name: 'r1' });

    const linkName = Object.keys(state.links)[0];
    expect(state.hosts.h1.link).toBe(linkName);
    const rIface = Object.values(state.routers.r1.interfaces).find(i => i.link === linkName);
    expect(rIface).toBeDefined();
  });

  it('created link has empty cidr and empty endpoint addresses', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    state.routers.r2 = { x: 300, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    finishLinkWizard({ kind: 'router', name: 'r2' });

    const link = Object.values(state.links)[0];
    expect(link.cidr).toBe('');
    const r1Iface = Object.values(state.routers.r1.interfaces)[0];
    const r2Iface = Object.values(state.routers.r2.interfaces)[0];
    expect(r1Iface.address).toBe('');
    expect(r2Iface.address).toBe('');
  });

  it('finishLinkWizard selects the new link', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    state.routers.r2 = { x: 300, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    finishLinkWizard({ kind: 'router', name: 'r2' });

    expect(state.selection).not.toBeNull();
    expect(state.selection.kind).toBe('link');
    expect(Object.keys(state.links)).toContain(state.selection.name);
  });

  it('finishLinkWizard clears wizard state', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    state.routers.r2 = { x: 300, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    finishLinkWizard({ kind: 'router', name: 'r2' });
    expect(getLinkWizard()).toBeNull();
  });

  it('positions link midpoint at geometric center of the two devices', () => {
    state.routers.r1 = { x: 100, y: 200, interfaces: {} };
    state.routers.r2 = { x: 300, y: 400, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    finishLinkWizard({ kind: 'router', name: 'r2' });

    const link = Object.values(state.links)[0];
    expect(link.x).toBe(200); // (100+300)/2
    expect(link.y).toBe(300); // (200+400)/2
  });

  it('wizard creates exactly ONE new link per invocation', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    state.routers.r2 = { x: 300, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    finishLinkWizard({ kind: 'router', name: 'r2' });
    expect(Object.keys(state.links).length).toBe(1);
  });
});

describe('link wizard — cancellation paths', () => {
  beforeEach(() => {
    setupMinimalDOM();
    state.hosts    = {};
    state.routers  = {};
    state.networks = {};
    state.links    = {};
    state.selection = null;
    state.view     = { x: 0, y: 0, k: 1 };
    state.display  = { showCosts: true, showIfaces: true };
    document.body.innerHTML += '<div id="toasts"></div>';
    cancelLinkWizard();
  });

  it('Esc keydown cancels the wizard', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    expect(getLinkWizard()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(getLinkWizard()).toBeNull();
  });

  it('clicking the source device again cancels without creating a link', () => {
    state.routers.r1 = { x: 100, y: 100, interfaces: {} };
    renderCanvas();
    startLinkWizard({ kind: 'router', name: 'r1' });
    // Simulate a click on the source device's node group
    const g = lookupDeviceNode('r1');
    g.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    expect(getLinkWizard()).toBeNull();
    expect(Object.keys(state.links).length).toBe(0);
  });
});
