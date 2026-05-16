import { describe, it, expect, beforeEach } from 'vitest';
import { tapPointOnRail, railTapPoint, deviceNameForEndpoint, renderCanvas, lookupLinkMidpoint, lookupDeviceNode, shiftLinkLabelsForDeviceMove } from './canvas.js';
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

/* -----------------------------------------------------------------------
   p2p link rendering
   ----------------------------------------------------------------------- */

function setupMinimalDOM() {
  // Minimal SVG DOM expected by renderCanvas / drawLinkEdge
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
  `;
}

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
