import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  state, bus,
  STORAGE_KEY, THEME_KEY, LAYOUT_KEY, LAYOUT_DEF, LAYOUT_LIMITS, SAMPLE,
  NODE, HIT_PAD,
  persist, restore, loadSample, markDirty, setSave,
} from './state.js';

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
});
