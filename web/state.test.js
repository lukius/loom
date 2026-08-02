import { describe, it, expect, beforeEach, vi, test } from 'vitest';
import {
  state, bus,
  STORAGE_KEY, THEME_KEY, LAYOUT_KEY, LAYOUT_DEF, LAYOUT_LIMITS, SAMPLE,
  NODE, HIT_PAD,
  CONFIG_DEFAULTS, PROTOCOL_DEFAULTS,
  persist, restore, loadSample, clearTopology, markDirty, setSave,
  defaultExportFilename,
  applyInterfaceStateChanged, applyDeviceStateChanged,
  isInterfaceDown, isDeviceHalted,
} from './state.js';
import { importYaml, exportYaml } from './yaml-io.js';

// Snapshot of the original `state` shape, captured once at module load.
// Tests mutate `state` and then call resetState() between cases.
const STATE_DEFAULTS = JSON.parse(JSON.stringify(state));

function resetState() {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, JSON.parse(JSON.stringify(STATE_DEFAULTS)));
}

// `loadSample` now relies on the bus (`state:topology-changed`) and on the
// imported `toast` helper from `utils.js`; the `#proj-name` lookup is
// null-safe. Tests provision only the DOM elements those side effects need.
beforeEach(() => {
  localStorage.clear();
  resetState();
  document.body.innerHTML =
    '<div id="save-state"><span class="dot"></span> idle</div>' +
    '<input id="proj-name" />' +
    '<div id="toasts"></div>';
});

describe('state object', () => {
  it('exposes top-level keys for asName/networks/hosts/routers/selection/view', () => {
    expect(typeof state.asName).toBe('string');
    expect(typeof state.networks).toBe('object');
    expect(typeof state.hosts).toBe('object');
    expect(typeof state.routers).toBe('object');
    expect(state.selection).toBeNull();
    expect(state.view).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('starts with empty topology dictionaries', () => {
    expect(state.networks).toEqual({});
    expect(state.hosts).toEqual({});
    expect(state.routers).toEqual({});
  });

  it('defaults asName to "test_as"', () => {
    expect(state.asName).toBe('test_as');
  });

  it('exposes state.natTables defaulting to {}', () => {
    expect(state.natTables).toEqual({});
  });
});

describe('state.natTables', () => {
  it('is reset to {} by loadSample', () => {
    state.natTables = { r1: [{ original_src: 'a', rewritten_src: 'b', dst: 'c', flow_id: null }] };
    loadSample();
    expect(state.natTables).toEqual({});
  });

  it('is NOT included in the persisted payload (transient sim state)', () => {
    state.natTables = { r1: [{ original_src: 'a', rewritten_src: 'b', dst: 'c', flow_id: null }] };
    persist();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(raw).not.toHaveProperty('natTables');
  });
});

describe('persist / restore', () => {
  it('round-trips asName and topology dictionaries through localStorage', () => {
    state.asName = 'AS-100';
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 1, y: 2 };
    persist();
    resetState();
    expect(restore()).toBe(true);
    expect(state.asName).toBe('AS-100');
    expect(state.networks.lan1).toEqual({ cidr: '10.0.0.0/24', x: 1, y: 2 });
  });

  it('round-trips the display toggles (showCosts/showIfaces)', () => {
    state.display.showCosts = false;
    state.display.showIfaces = true;
    persist();
    resetState();
    expect(restore()).toBe(true);
    expect(state.display.showCosts).toBe(false);
    expect(state.display.showIfaces).toBe(true);
  });

  it('falls back to display defaults when an old session lacks the field', () => {
    state.asName = 'legacy';
    persist();
    // simulate a pre-display session by stripping the field from storage
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    delete raw.display;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
    resetState();
    expect(restore()).toBe(true);
    expect(state.display).toEqual({ showCosts: true, showIfaces: true });
  });

  it('round-trips optional network fields w and orientation', () => {
    state.networks.lan1 = {
      cidr: '10.0.0.0/24', x: 1, y: 2,
      w: 240, orientation: 'v',
    };
    persist();
    resetState();
    expect(restore()).toBe(true);
    expect(state.networks.lan1).toEqual({
      cidr: '10.0.0.0/24', x: 1, y: 2,
      w: 240, orientation: 'v',
    });
  });

  it('persists to the STORAGE_KEY localStorage slot', () => {
    persist();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('persist writes only the documented subset of state (no selection)', () => {
    state.selection = { kind: 'host', name: 'h1' };
    persist();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(raw).not.toHaveProperty('selection');
    expect(raw).toHaveProperty('asName');
    expect(raw).toHaveProperty('networks');
    expect(raw).toHaveProperty('hosts');
    expect(raw).toHaveProperty('routers');
    expect(raw).toHaveProperty('view');
  });

  it('persist updates the save indicator to "autosaved"', () => {
    persist();
    expect(document.getElementById('save-state').lastChild.textContent).toBe(' autosaved');
  });

  it('restore returns false when storage is empty', () => {
    expect(restore()).toBe(false);
  });

  it('restore returns false on malformed JSON without throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(() => restore()).not.toThrow();
    expect(restore()).toBe(false);
  });

  it('restore falls back to "test_as" when asName is missing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ networks: {}, hosts: {}, routers: {} }));
    state.asName = 'changed';
    expect(restore()).toBe(true);
    expect(state.asName).toBe('test_as');
  });

  it('restore defaults missing dictionaries to empty objects', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ asName: 'X' }));
    state.networks.lingering = { cidr: '1.1.1.1/24' };
    state.hosts.lingering = {};
    state.routers.lingering = {};
    expect(restore()).toBe(true);
    expect(state.networks).toEqual({});
    expect(state.hosts).toEqual({});
    expect(state.routers).toEqual({});
  });

  it('restore preserves nested host data', () => {
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.1', x: 5, y: 6 };
    persist();
    resetState();
    restore();
    expect(state.hosts.h1).toEqual({ network: 'lan1', address: '10.0.0.1', x: 5, y: 6 });
  });

  it('restore preserves nested router interfaces map', () => {
    state.routers.r1 = {
      x: 100, y: 200,
      interfaces: { eth0: { network: 'lan1', address: '10.0.0.254', cost: 7 } },
    };
    persist();
    resetState();
    restore();
    expect(state.routers.r1.interfaces.eth0).toEqual(
      { network: 'lan1', address: '10.0.0.254', cost: 7 },
    );
  });

  it('restore keeps stored view when present', () => {
    state.view = { x: 10, y: 20, k: 1.5 };
    persist();
    resetState();
    restore();
    expect(state.view).toEqual({ x: 10, y: 20, k: 1.5 });
  });

  it('restore leaves state.view at its current value when stored view is missing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ asName: 'A' }));
    state.view = { x: 99, y: 99, k: 9 };
    restore();
    expect(state.view).toEqual({ x: 99, y: 99, k: 9 });
  });

  it('restore falls back to {x:0,y:0,k:1} when stored view.k is NaN', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      asName: 'A', networks: {}, hosts: {}, routers: {},
      view: { x: 0, y: 0, k: NaN },
    }));
    restore();
    expect(state.view).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('restore falls back to {x:0,y:0,k:1} when stored view.x is a string', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      asName: 'A', networks: {}, hosts: {}, routers: {},
      view: { x: 'bad', y: 0, k: 1 },
    }));
    restore();
    expect(state.view).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('restore falls back to {x:0,y:0,k:1} when stored view.k is zero or negative', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      asName: 'A', networks: {}, hosts: {}, routers: {},
      view: { x: 10, y: 20, k: 0 },
    }));
    restore();
    expect(state.view).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('restore keeps a valid view unchanged (regression guard)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      asName: 'A', networks: {}, hosts: {}, routers: {},
      view: { x: 50, y: -30, k: 1.5 },
    }));
    restore();
    expect(state.view).toEqual({ x: 50, y: -30, k: 1.5 });
  });

  it('round-trips non-default config.packet_duration_ms and protocol timers through persist/restore', () => {
    state.config.packet_duration_ms = 2500;
    state.protocol.hello_interval = 5;
    state.protocol.lsa_refresh_interval = 15;
    persist();
    // mutate in memory so we know restore actually applied the stored values
    state.config.packet_duration_ms = 9999;
    state.protocol.hello_interval = 9999;
    state.protocol.lsa_refresh_interval = 9999;
    expect(restore()).toBe(true);
    expect(state.config.packet_duration_ms).toBe(2500);
    expect(state.protocol.hello_interval).toBe(5);
    expect(state.protocol.lsa_refresh_interval).toBe(15);
  });

  it('restore falls back to CONFIG_DEFAULTS/PROTOCOL_DEFAULTS when legacy blob has no config/protocol keys', () => {
    // Pre-condition: mutate to non-default values so the assertion proves
    // restore() actively applied the defaults, not that resetState() left them.
    state.config = { packet_duration_ms: 999 };
    state.protocol = { hello_interval: 1, lsa_refresh_interval: 2 };
    // Simulate a pre-config/protocol session blob (no config/protocol keys).
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      asName: 'legacy_as',
      networks: {},
      hosts: {},
      routers: {},
      view: { x: 0, y: 0, k: 1 },
      display: { showCosts: true, showIfaces: true },
    }));
    expect(restore()).toBe(true);
    expect(state.config).toEqual(CONFIG_DEFAULTS);
    expect(state.protocol).toEqual(PROTOCOL_DEFAULTS);
  });

  it('round-trips a non-default state.asn through persist/restore', () => {
    state.asn = 64500;
    persist();
    // mutate in memory so we know restore actually applied the stored value
    state.asn = 9999;
    expect(restore()).toBe(true);
    expect(state.asn).toBe(64500);
  });

  it('restore falls back to 65000 when legacy blob lacks asn', () => {
    // Pre-condition: mutate to a non-default so the assertion proves restore()
    // actively applies the default, not that resetState() left 65000.
    state.asn = 64500;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      asName: 'legacy_as',
      networks: {},
      hosts: {},
      routers: {},
      view: { x: 0, y: 0, k: 1 },
      display: { showCosts: true, showIfaces: true },
    }));
    expect(restore()).toBe(true);
    expect(state.asn).toBe(65000);
  });
});

describe('loadSample', () => {
  it('seeds state.networks from SAMPLE', () => {
    loadSample();
    expect(Object.keys(state.networks).length).toBeGreaterThan(0);
    expect(state.networks).toEqual(SAMPLE.networks);
  });

  it('seeds state.hosts and state.routers from SAMPLE', () => {
    loadSample();
    expect(state.hosts).toEqual(SAMPLE.hosts);
    expect(state.routers).toEqual(SAMPLE.routers);
  });

  it('replaces existing state (does not merge)', () => {
    state.hosts.deleteMe = { network: 'old', address: 'x' };
    loadSample();
    expect(state.hosts.deleteMe).toBeUndefined();
  });

  it('clones SAMPLE — mutating state should not leak into SAMPLE', () => {
    loadSample();
    state.networks.lan1.cidr = 'mutated';
    expect(SAMPLE.networks.lan1.cidr).not.toBe('mutated');
  });

  it('resets selection to null', () => {
    state.selection = { kind: 'host', name: 'h1' };
    loadSample();
    expect(state.selection).toBeNull();
  });

  it('resets view to origin/zoom 1', () => {
    state.view = { x: 999, y: 999, k: 7 };
    loadSample();
    expect(state.view).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('writes the loaded state to localStorage via persist()', () => {
    loadSample();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(raw.asName).toBe(SAMPLE.asName);
  });

  it('dispatches state:topology-changed on loadSample', () => {
    let fired = 0;
    const handler = () => fired++;
    bus.addEventListener('state:topology-changed', handler);
    loadSample();
    bus.removeEventListener('state:topology-changed', handler);
    expect(fired).toBe(1);
  });

  it('dispatches state:topology-loaded on loadSample (separate from -changed)', () => {
    let topologyChangedFired = 0;
    let topologyLoadedFired = 0;
    const a = () => topologyChangedFired++;
    const b = () => topologyLoadedFired++;
    bus.addEventListener('state:topology-changed', a);
    bus.addEventListener('state:topology-loaded', b);
    loadSample();
    bus.removeEventListener('state:topology-changed', a);
    bus.removeEventListener('state:topology-loaded', b);
    expect(topologyChangedFired).toBe(1);
    expect(topologyLoadedFired).toBe(1);
  });

  it('does not throw without fitView/renderAll in scope', () => {
    // Sanity test: loadSample must not depend on inline-module helpers.
    // No globals are provisioned in beforeEach — calling loadSample directly
    // exercises the module-level path that the page hits in the browser.
    expect(() => loadSample()).not.toThrow();
  });

  it('inserts a toast element on success', () => {
    loadSample();
    const toastEl = document.querySelector('.toast');
    expect(toastEl).not.toBeNull();
  });
});

describe('clearTopology', () => {
  it('empties networks/hosts/routers/links/natTables', () => {
    state.networks = { lan0: { cidr: '10.0.0.0/24' } };
    state.hosts = { h1: { network: 'lan0', address: '10.0.0.2' } };
    state.routers = { r1: { interfaces: {} } };
    state.links = { l1: { cidr: '10.0.1.0/30' } };
    state.natTables = { r1: [] };
    clearTopology();
    expect(state.networks).toEqual({});
    expect(state.hosts).toEqual({});
    expect(state.routers).toEqual({});
    expect(state.links).toEqual({});
    expect(state.natTables).toEqual({});
  });

  it('resets selection, sourceName, and view', () => {
    state.selection = { kind: 'host', name: 'h1' };
    state.sourceName = 'mesh.yaml';
    state.view = { x: 999, y: 999, k: 7 };
    clearTopology();
    expect(state.selection).toBeNull();
    expect(state.sourceName).toBeNull();
    expect(state.view).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('persists the cleared state to localStorage', () => {
    state.hosts = { h1: { network: 'lan0', address: '10.0.0.2' } };
    clearTopology();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(raw.hosts).toEqual({});
  });

  it('dispatches state:topology-changed and state:topology-loaded', () => {
    let changed = 0;
    let loaded = 0;
    const a = () => changed++;
    const b = () => loaded++;
    bus.addEventListener('state:topology-changed', a);
    bus.addEventListener('state:topology-loaded', b);
    clearTopology();
    bus.removeEventListener('state:topology-changed', a);
    bus.removeEventListener('state:topology-loaded', b);
    expect(changed).toBe(1);
    expect(loaded).toBe(1);
  });

  it('does not throw without fitView/renderAll in scope', () => {
    expect(() => clearTopology()).not.toThrow();
  });

  it('resets neighborsByDevice to {}', () => {
    state.neighborsByDevice = { r1: { eth0: { r2: { state: 'two_way' } } } };
    clearTopology();
    expect(state.neighborsByDevice).toEqual({});
  });
});

describe('loadSample — neighborsByDevice reset', () => {
  it('resets neighborsByDevice to {} on loadSample', () => {
    state.neighborsByDevice = { r1: { eth0: { r2: { state: 'two_way' } } } };
    loadSample();
    expect(state.neighborsByDevice).toEqual({});
  });
});

describe('markDirty / setSave', () => {
  it('setSave updates the save indicator text in the DOM', () => {
    setSave('autosaved');
    const el = document.getElementById('save-state');
    expect(el.lastChild.textContent).toBe(' autosaved');
  });

  it('setSave preserves the preceding dot span', () => {
    setSave('saving…');
    const el = document.getElementById('save-state');
    expect(el.querySelector('.dot')).not.toBeNull();
    expect(el.lastChild.textContent).toBe(' saving…');
  });

  it('markDirty immediately flips the save indicator to "saving…"', () => {
    vi.useFakeTimers();
    try {
      markDirty();
      expect(document.getElementById('save-state').lastChild.textContent).toBe(' saving…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('markDirty debounces persist() ~200ms later', () => {
    vi.useFakeTimers();
    try {
      state.asName = 'debounced';
      markDirty();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      vi.advanceTimersByTime(200);
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      expect(raw.asName).toBe('debounced');
    } finally {
      vi.useRealTimers();
    }
  });

  it('markDirty coalesces repeated calls into a single persist()', () => {
    vi.useFakeTimers();
    try {
      // Clear any debounce handle left over from a previous test so we start
      // from a clean slate.
      clearTimeout(markDirty._t);
      markDirty._t = undefined;
      markDirty();
      markDirty();
      markDirty();
      vi.advanceTimersByTime(200);
      // After three coalesced markDirty calls + 200ms, exactly one persist
      // has run, so the storage slot is populated.
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      // The save indicator reflects the single completed persist, not a
      // half-finished debounce ("saving…").
      expect(document.getElementById('save-state').lastChild.textContent).toBe(' autosaved');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('bus', () => {
  it('is an EventTarget', () => {
    expect(bus).toBeInstanceOf(EventTarget);
  });

  it('delivers custom events with details', () => {
    let detail = null;
    const fn = (e) => { detail = e.detail; };
    bus.addEventListener('foo:bar', fn);
    bus.dispatchEvent(new CustomEvent('foo:bar', { detail: { x: 1 } }));
    expect(detail).toEqual({ x: 1 });
    bus.removeEventListener('foo:bar', fn);
  });

  it('supports multiple listeners on the same event in registration order', () => {
    const calls = [];
    const a = () => calls.push('a');
    const b = () => calls.push('b');
    bus.addEventListener('multi', a);
    bus.addEventListener('multi', b);
    bus.dispatchEvent(new CustomEvent('multi'));
    expect(calls).toEqual(['a', 'b']);
    bus.removeEventListener('multi', a);
    bus.removeEventListener('multi', b);
  });

  it('removeEventListener actually unsubscribes', () => {
    let count = 0;
    const fn = () => count++;
    bus.addEventListener('once', fn);
    bus.dispatchEvent(new CustomEvent('once'));
    bus.removeEventListener('once', fn);
    bus.dispatchEvent(new CustomEvent('once'));
    expect(count).toBe(1);
  });

  it('double-dispatch invokes the listener twice', () => {
    let count = 0;
    const fn = () => count++;
    bus.addEventListener('double', fn);
    bus.dispatchEvent(new CustomEvent('double'));
    bus.dispatchEvent(new CustomEvent('double'));
    expect(count).toBe(2);
    bus.removeEventListener('double', fn);
  });

  it('honors { once: true } option', () => {
    let count = 0;
    bus.addEventListener('once-opt', () => count++, { once: true });
    bus.dispatchEvent(new CustomEvent('once-opt'));
    bus.dispatchEvent(new CustomEvent('once-opt'));
    expect(count).toBe(1);
  });

  it('events with no detail surface as undefined detail (default)', () => {
    let detail = 'unchanged';
    const fn = (e) => { detail = e.detail; };
    bus.addEventListener('no-detail', fn);
    bus.dispatchEvent(new CustomEvent('no-detail'));
    expect(detail).toBeNull();
    bus.removeEventListener('no-detail', fn);
  });
});

describe('constants', () => {
  it('STORAGE_KEY is a non-empty string', () => {
    expect(typeof STORAGE_KEY).toBe('string');
    expect(STORAGE_KEY.length).toBeGreaterThan(0);
  });

  it('THEME_KEY, LAYOUT_KEY and STORAGE_KEY are pairwise distinct', () => {
    const keys = new Set([STORAGE_KEY, THEME_KEY, LAYOUT_KEY]);
    expect(keys.size).toBe(3);
  });

  it('LAYOUT_DEF exposes navW and inspW as numbers', () => {
    expect(typeof LAYOUT_DEF.navW).toBe('number');
    expect(typeof LAYOUT_DEF.inspW).toBe('number');
  });

  it('LAYOUT_LIMITS has navW/inspW with min < max', () => {
    expect(LAYOUT_LIMITS.navW.min).toBeLessThan(LAYOUT_LIMITS.navW.max);
    expect(LAYOUT_LIMITS.inspW.min).toBeLessThan(LAYOUT_LIMITS.inspW.max);
  });

  it('LAYOUT_DEF values fall within LAYOUT_LIMITS bounds', () => {
    expect(LAYOUT_DEF.navW).toBeGreaterThanOrEqual(LAYOUT_LIMITS.navW.min);
    expect(LAYOUT_DEF.navW).toBeLessThanOrEqual(LAYOUT_LIMITS.navW.max);
    expect(LAYOUT_DEF.inspW).toBeGreaterThanOrEqual(LAYOUT_LIMITS.inspW.min);
    expect(LAYOUT_DEF.inspW).toBeLessThanOrEqual(LAYOUT_LIMITS.inspW.max);
  });

  it('SAMPLE has asName and at least one network/host/router', () => {
    expect(SAMPLE).toHaveProperty('asName');
    expect(Object.keys(SAMPLE.networks).length).toBeGreaterThan(0);
    expect(Object.keys(SAMPLE.hosts).length).toBeGreaterThan(0);
    expect(Object.keys(SAMPLE.routers).length).toBeGreaterThan(0);
  });

  it('NODE describes bounding boxes for each kind', () => {
    for (const kind of ['network', 'host', 'router']) {
      expect(NODE[kind]).toHaveProperty('w');
      expect(NODE[kind]).toHaveProperty('h');
    }
  });

  it('HIT_PAD has x/top/bottom padding for each kind', () => {
    for (const kind of ['network', 'host', 'router']) {
      expect(HIT_PAD[kind]).toHaveProperty('x');
      expect(HIT_PAD[kind]).toHaveProperty('top');
      expect(HIT_PAD[kind]).toHaveProperty('bottom');
    }
  });

  it('SAMPLE has a links property with p2p1 entry', () => {
    expect(SAMPLE).toHaveProperty('links');
    expect(SAMPLE.links).toHaveProperty('p2p1');
    expect(SAMPLE.links.p2p1.cidr).toBe('10.0.0.0/30');
  });

  // Without a gateway a host can only reach its own LAN, so the seeded
  // topology would fail the very first off-LAN ping a new user tries.
  it('every SAMPLE host has a gateway held by a router on its own LAN', () => {
    for (const [name, host] of Object.entries(SAMPLE.hosts)) {
      expect(host.gateway, `${name} has no gateway`).toBeTruthy();
      const owners = Object.values(SAMPLE.routers).filter(r =>
        Object.values(r.interfaces || {}).some(
          iff => iff.network === host.network && iff.address === host.gateway,
        ),
      );
      expect(owners.length, `${name}: gateway ${host.gateway} is not on ${host.network}`).toBe(1);
    }
  });
});

describe('sourceName / defaultExportFilename', () => {
  it('state has a sourceName field, default null', () => {
    expect(state).toHaveProperty('sourceName');
    expect(state.sourceName).toBeNull();
  });

  it('persist/restore round-trips sourceName', () => {
    state.sourceName = 'alpha.yaml';
    persist();
    resetState();
    expect(state.sourceName).toBeNull();
    restore();
    expect(state.sourceName).toBe('alpha.yaml');
  });

  it('returns the source name unchanged when it already ends in .yaml/.yml', () => {
    expect(defaultExportFilename('sample.yaml')).toBe('sample.yaml');
    expect(defaultExportFilename('sample.yml')).toBe('sample.yml');
  });

  it('falls back to topology.yaml when sourceName is empty', () => {
    expect(defaultExportFilename(null)).toBe('topology.yaml');
    expect(defaultExportFilename('')).toBe('topology.yaml');
    expect(defaultExportFilename(undefined)).toBe('topology.yaml');
  });

  it('strips a .session stem so an imported session file maps to its source name', () => {
    // The old default was `<name>.session.yaml`. Users who already have such
    // files in their library shouldn't re-stack the suffix on Export.
    expect(defaultExportFilename('sample.session.yaml')).toBe('sample.yaml');
    expect(defaultExportFilename('sample.session.yml')).toBe('sample.yml');
  });

  it('appends a yaml extension when the source has none', () => {
    expect(defaultExportFilename('weird')).toBe('weird.yaml');
  });
});

describe('state.links', () => {
  it('exists by default as empty object', () => {
    expect(state.links).toBeDefined();
    expect(state.links).toEqual({});
  });

  it('persist + restore round-trips state.links', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 100, y: 100 } };
    persist();
    resetState();
    expect(restore()).toBe(true);
    expect(state.links.p2p1).toEqual({ cidr: '10.0.0.0/30', x: 100, y: 100 });
  });

  it('persist writes links into the stored payload', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 50, y: 50 } };
    persist();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(raw).toHaveProperty('links');
    expect(raw.links.p2p1.cidr).toBe('10.0.0.0/30');
  });

  it('restore falls back to {} when stored v5 payload lacks links field', () => {
    // Simulate a v5-era payload that predates the links field
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      asName: 'old_as',
      networks: {},
      hosts: {},
      routers: {},
      view: { x: 0, y: 0, k: 1 },
      display: { showCosts: true, showIfaces: true },
    }));
    expect(restore()).toBe(true);
    expect(state.links).toEqual({});
  });

  it('restore falls back to {} when stored links is not an object', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      asName: 'x',
      networks: {},
      hosts: {},
      routers: {},
      links: 'bad',
    }));
    expect(restore()).toBe(true);
    expect(state.links).toEqual({});
  });

  it('loadSample populates state.links with p2p1 from SAMPLE', () => {
    state.links = { existing: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    loadSample();
    expect(state.links).toHaveProperty('p2p1');
    expect(state.links.p2p1.cidr).toBe('10.0.0.0/30');
    expect(state.links).not.toHaveProperty('existing');
  });

  it('loadSample clones SAMPLE.links — mutations do not leak into SAMPLE', () => {
    loadSample();
    state.links.leaked = { cidr: '1.2.3.0/30', x: 0, y: 0 };
    expect(SAMPLE.links).not.toHaveProperty('leaked');
  });
});

/* ---- helper: minimal DOM environment for yaml-io tests ---- */
function setupYamlDom() {
  document.body.innerHTML =
    '<div id="save-state"><span class="dot"></span> idle</div>' +
    '<input id="proj-name" />' +
    '<div id="toasts"></div>' +
    '<svg id="canvas"><g id="viewport"><g id="edges-layer"></g>' +
    '<g id="nodes-layer"></g><g id="overlay-layer"></g></g></svg>' +
    '<div id="zoom-lvl"></div>';
}

describe('YAML round-trip (yaml-io.js)', () => {
  beforeEach(() => {
    setupYamlDom();
  });

  it('import — link block present populates state.links and router interface', () => {
    const yaml = `
internet:
  name: loom
  autonomous_systems:
    test_as:
      asn: 65000
      networks: {}
      links:
        p2p1: "10.0.0.0/30"
      hosts: {}
      routers:
        r1:
          interfaces:
            eth0: { network: lan1, address: "200.100.0.1", cost: 10 }
            eth1: { link: p2p1, address: "10.0.0.1", cost: 5 }
`;
    importYaml(yaml);
    expect(state.links.p2p1.cidr).toBe('10.0.0.0/30');
    expect(state.routers.r1.interfaces.eth1.link).toBe('p2p1');
    expect(state.routers.r1.interfaces.eth1).not.toHaveProperty('network');
  });

  it('import — network interface unchanged when no link key', () => {
    const yaml = `
internet:
  name: loom
  autonomous_systems:
    test_as:
      asn: 65000
      networks:
        lan1: "200.100.0.0/24"
      hosts: {}
      routers:
        r1:
          interfaces:
            eth0: { network: lan1, address: "200.100.0.1", cost: 10 }
`;
    importYaml(yaml);
    expect(state.routers.r1.interfaces.eth0.network).toBe('lan1');
    expect(state.routers.r1.interfaces.eth0).not.toHaveProperty('link');
  });

  it('import — host on link sets h.link (no network field)', () => {
    const yaml = `
internet:
  name: loom
  autonomous_systems:
    test_as:
      asn: 65000
      networks: {}
      links:
        p2p1: "10.0.0.0/30"
      hosts:
        h1: { link: p2p1, address: "10.0.0.1" }
      routers: {}
`;
    importYaml(yaml);
    expect(state.hosts.h1.link).toBe('p2p1');
    expect(state.hosts.h1).not.toHaveProperty('network');
  });

  it('import — link gets default x and y coords (numbers)', () => {
    const yaml = `
internet:
  name: loom
  autonomous_systems:
    test_as:
      asn: 65000
      networks: {}
      links:
        p2p1: "10.0.0.0/30"
      hosts: {}
      routers:
        r1:
          interfaces:
            eth1: { link: p2p1, address: "10.0.0.1", cost: 5 }
        r2:
          interfaces:
            eth0: { link: p2p1, address: "10.0.0.2", cost: 5 }
`;
    importYaml(yaml);
    expect(typeof state.links.p2p1.x).toBe('number');
    expect(typeof state.links.p2p1.y).toBe('number');
  });

  it('import — missing links block results in state.links = {}', () => {
    const yaml = `
internet:
  name: loom
  autonomous_systems:
    test_as:
      asn: 65000
      networks:
        lan1: "200.100.0.0/24"
      hosts: {}
      routers: {}
`;
    importYaml(yaml);
    expect(state.links).toEqual({});
  });

  it('export — links block emitted when state.links is non-empty', () => {
    state.asName = 'export_as';
    state.networks = {};
    state.hosts = {};
    state.routers = {
      r1: { x: 100, y: 100, interfaces: {
        eth1: { link: 'p2p1', address: '10.0.0.1', cost: 5 },
      }},
    };
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 100, y: 100 } };
    const yaml = exportYaml();
    expect(yaml).toContain('internet:');
    expect(yaml).toContain('autonomous_systems:');
    expect(yaml).toContain('export_as:');
    expect(yaml).toContain('links:');
    expect(yaml).toContain('p2p1');
    expect(yaml).toContain('10.0.0.0/30');
    expect(yaml).toContain('link:');
  });

  it('export — interface with link emits link key, not network key', () => {
    state.asName = 'test_as';
    state.networks = {};
    state.hosts = {};
    state.routers = {
      r1: { x: 100, y: 100, interfaces: {
        eth1: { link: 'p2p1', address: '10.0.0.1', cost: 5 },
      }},
    };
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 100, y: 100 } };
    const yaml = exportYaml();
    // Should have link: p2p1 but not network: for eth1
    expect(yaml).toContain('link:');
    // The exported interface should not fallback to empty network
    expect(yaml).not.toMatch(/network:\s*""\s*\n/);
  });

  it('export — host on link emits link key', () => {
    state.asName = 'test_as';
    state.networks = {};
    state.hosts = { h1: { link: 'p2p1', address: '10.0.0.1', x: 50, y: 50 } };
    state.routers = {};
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 100, y: 100 } };
    const yaml = exportYaml();
    expect(yaml).toContain('link:');
    expect(yaml).toContain('p2p1');
  });

  it('export — no links block when state.links is empty', () => {
    state.asName = 'test_as';
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 100, y: 100 } };
    state.hosts = {};
    state.routers = {};
    state.links = {};
    const yaml = exportYaml();
    expect(yaml).not.toContain('links:');
  });

  it('round-trip: import → export → import preserves links', () => {
    const yaml = `
internet:
  name: loom
  autonomous_systems:
    test_as:
      asn: 65000
      networks: {}
      links:
        p2p1: "10.0.0.0/30"
      hosts: {}
      routers:
        r1:
          interfaces:
            eth1: { link: p2p1, address: "10.0.0.1", cost: 5 }
        r2:
          interfaces:
            eth0: { link: p2p1, address: "10.0.0.2", cost: 5 }
`;
    importYaml(yaml);
    const exported = exportYaml();
    // reset state and re-import
    state.links = {};
    state.routers = {};
    importYaml(exported);
    expect(state.links.p2p1.cidr).toBe('10.0.0.0/30');
    expect(state.routers.r1.interfaces.eth1.link).toBe('p2p1');
  });

  it('clears state.natTables on import', () => {
    state.natTables = { r_a: [{ original_src: 'x', rewritten_src: 'y', dst: 'z', flow_id: null }] };
    const yaml = `
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan1: "10.0.0.0/24"
      hosts: {}
      routers: {}
`;
    const ok = importYaml(yaml);
    expect(ok).not.toBe(false);
    expect(state.natTables).toEqual({});
  });

  it('export — internet.name takes the value of state.asName (the editable header field)', () => {
    state.asName = 'my-net';
    state.networks = {};
    state.hosts = {};
    state.routers = {};
    state.links = {};
    const yaml = exportYaml();
    // The internet block's name now mirrors what the user typed at the top
    // of the SPA, instead of being hardcoded to "loom".
    expect(yaml).toMatch(/internet:\s*\n\s*name:\s*"?my-net"?/);
  });

  it('import — picks up internet.name when present and reflects it in state.asName', () => {
    // Backwards-compat: older SPA exports wrote `internet.name: loom` and
    // carried the user-typed name only as the AS key. We still accept that
    // shape, but a newer YAML with a non-default `internet.name` wins.
    const yaml = `
internet:
  name: custom-internet
  autonomous_systems:
    some_as:
      asn: 65000
      networks: {}
      hosts: {}
      routers: {}
`;
    importYaml(yaml);
    expect(state.asName).toBe('custom-internet');
  });

  it('import — falls back to the AS key when internet.name is the legacy "loom"', () => {
    const yaml = `
internet:
  name: loom
  autonomous_systems:
    my_legacy_as:
      asn: 65000
      networks: {}
      hosts: {}
      routers: {}
`;
    importYaml(yaml);
    expect(state.asName).toBe('my_legacy_as');
  });
});

test('interface down-state is tracked and queryable', () => {
  applyInterfaceStateChanged({ device: 'r1', interface: 'eth0', up: false });
  expect(isInterfaceDown('r1', 'eth0')).toBe(true);
  applyInterfaceStateChanged({ device: 'r1', interface: 'eth0', up: true });
  expect(isInterfaceDown('r1', 'eth0')).toBe(false);
});

test('device halted-state is tracked and queryable', () => {
  applyDeviceStateChanged({ device: 'r2', up: false });
  expect(isDeviceHalted('r2')).toBe(true);
  applyDeviceStateChanged({ device: 'r2', up: true });
  expect(isDeviceHalted('r2')).toBe(false);
});
