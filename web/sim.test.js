import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state, bus, isInterfaceDown, isDeviceHalted, resetDownState } from './state.js';
import {
  Sim, RuntimeClient,
  setConnectionStatus, isTopologyLocked, recordPatchOp, updatePatchIndicator, reconcilePatch,
  applyEdit, finalizePendingAdd, pendingLiveAdds,
  _onEvent, _resetPendingNAT, recoverDownState,
} from './sim.js';

// ---------- bus helpers ----------
function captureEvents(name) {
  const events = [];
  const handler = (e) => events.push(e.detail);
  bus.addEventListener(name, handler);
  return { events, stop: () => bus.removeEventListener(name, handler) };
}

let listenerCleanups = [];

beforeEach(() => {
  // Reset Sim singleton
  Sim.state = 'idle';
  Sim.patch = [];
  // Reset shared state
  state.asName = 'test_as';
  state.networks = {};
  state.hosts = {};
  state.routers = {};
  state.natTables = {};
  state.selection = null;
  // Reset NAT deferral state (module-level Maps in sim.js).
  _resetPendingNAT();
  // Toolbar + banner DOM that _renderToolbar and other helpers touch.
  // #toasts is the parent for error toasts emitted by onPrimary/onSecondary/onReset.
  document.body.innerHTML = `
    <button id="tb-play"><span class="ico"><use></use></span><span class="lbl"></span></button>
    <button id="tb-pause" hidden><span class="ico"><use></use></span><span class="lbl"></span></button>
    <button id="tb-reset"></button>
    <button id="tb-add-net"></button>
    <button id="tb-add-host"></button>
    <button id="tb-add-router"></button>
    <button id="tb-refresh"></button>
    <div id="toasts"></div>
  `;
  // Stub RuntimeClient transport so refreshState() never hits the network.
  RuntimeClient._json = vi.fn(async (method, path) => {
    if (path === '/sim/state') return { state: Sim.state };
    return {};
  });
});

afterEach(() => {
  for (const cleanup of listenerCleanups) cleanup();
  listenerCleanups = [];
});

// ---------- Sim defaults ----------
describe('Sim initial state', () => {
  it('defaults to idle', () => {
    expect(Sim.state).toBe('idle');
  });

  it('has an empty patch by default', () => {
    expect(Sim.patch).toEqual([]);
  });
});

// ---------- WS event router ----------
describe('_onEvent (WS dispatcher)', () => {
  it('routes sim_state to Sim.state and dispatches sim:status-changed', () => {
    const cap = captureEvents('sim:status-changed');
    listenerCleanups.push(cap.stop);
    _onEvent({ kind: 'sim_state', state: 'running' });
    expect(Sim.state).toBe('running');
    expect(cap.events).toEqual([{ status: 'running' }]);
  });

  it('does NOT dispatch sim:status-changed when state is unchanged (idempotent)', () => {
    Sim.state = 'running';
    const cap = captureEvents('sim:status-changed');
    listenerCleanups.push(cap.stop);
    _onEvent({ kind: 'sim_state', state: 'running' });
    expect(Sim.state).toBe('running');
    expect(cap.events).toEqual([]);
  });

  it('sim_state event updates Sim.state through every transition', () => {
    const cap = captureEvents('sim:status-changed');
    listenerCleanups.push(cap.stop);
    _onEvent({ kind: 'sim_state', state: 'running' });
    _onEvent({ kind: 'sim_state', state: 'paused' });
    _onEvent({ kind: 'sim_state', state: 'idle' });
    expect(Sim.state).toBe('idle');
    expect(cap.events).toEqual([
      { status: 'running' }, { status: 'paused' }, { status: 'idle' },
    ]);
  });

  it('routes packet events to sim:packet with the full event payload', () => {
    const cap = captureEvents('sim:packet');
    listenerCleanups.push(cap.stop);
    const evt = {
      kind: 'packet', type: 'user_datagram', flow: 'f1',
      src: { device: 'h1' }, dst: { device: 'h2' }, network: 'lan1',
    };
    _onEvent(evt);
    expect(cap.events).toEqual([evt]);
  });

  it('packet events do not touch Sim.state', () => {
    Sim.state = 'running';
    _onEvent({ kind: 'packet', type: 'ping_request', src: {}, dst: {} });
    expect(Sim.state).toBe('running');
  });

  it('routes routing_table_changed events to sim:routing-table-changed carrying the device name', () => {
    const cap = captureEvents('sim:routing-table-changed');
    listenerCleanups.push(cap.stop);
    _onEvent({ kind: 'routing_table_changed', device: 'r1', rules: [] });
    expect(cap.events).toEqual([{ device: 'r1' }]);
  });

  it('ignores unknown event kinds without throwing', () => {
    expect(() => _onEvent({ kind: 'unknown_kind_xyz' })).not.toThrow();
  });

  it('ignores malformed events without a kind', () => {
    expect(() => _onEvent({})).not.toThrow();
    expect(() => _onEvent({ state: 'running' })).not.toThrow();
  });

  it('does not dispatch any sim:* bus events for unknown kinds', () => {
    const status = captureEvents('sim:status-changed');
    const packet = captureEvents('sim:packet');
    const routing = captureEvents('sim:routing-table-changed');
    const nat = captureEvents('sim:nat');
    listenerCleanups.push(status.stop, packet.stop, routing.stop, nat.stop);
    _onEvent({ kind: 'unknown_event' });
    expect(status.events).toEqual([]);
    expect(packet.events).toEqual([]);
    expect(routing.events).toEqual([]);
    expect(nat.events).toEqual([]);
  });

  it('routes kind:nat to sim:nat carrying the full event payload', () => {
    const cap = captureEvents('sim:nat');
    listenerCleanups.push(cap.stop);
    const evt = {
      kind: 'nat',
      router: 'r_a',
      direction: 'outbound',
      original_src: '192.168.1.10',
      rewritten_src: '200.100.0.1',
      dst: '8.8.8.8',
      flow_id: null,
      payload_id: 'abc-123',
    };
    _onEvent(evt);
    expect(cap.events).toEqual([evt]);
  });

  it('nat events do not touch Sim.state', () => {
    Sim.state = 'running';
    _onEvent({
      kind: 'nat', router: 'r1', direction: 'outbound',
      original_src: '10.0.0.1', rewritten_src: '1.2.3.4',
      dst: '8.8.8.8', flow_id: null, payload_id: 'p',
    });
    expect(Sim.state).toBe('running');
  });

  it('routes kind:nat_table_changed to sim:nat-table-changed and updates state.natTables', () => {
    const cap = captureEvents('sim:nat-table-changed');
    listenerCleanups.push(cap.stop);
    state.natTables = {};
    _onEvent({
      kind: 'nat_table_changed',
      device: 'r_a',
      entries: [{
        original_src: '192.168.1.10',
        rewritten_src: '200.100.0.1',
        dst: '8.8.8.8',
        flow_id: 7,
      }],
    });
    expect(state.natTables['r_a']).toBeDefined();
    expect(state.natTables['r_a'].length).toBe(1);
    expect(state.natTables['r_a'][0].rewritten_src).toBe('200.100.0.1');
    expect(cap.events).toEqual([{ device: 'r_a' }]);
  });

  it('nat_table_changed with missing entries defaults to an empty list', () => {
    state.natTables = { r1: [{ original_src: 'x', rewritten_src: 'y', dst: 'z', flow_id: null }] };
    _onEvent({ kind: 'nat_table_changed', device: 'r1' });
    expect(state.natTables['r1']).toEqual([]);
  });

  it('nat_table_changed events do not touch Sim.state', () => {
    Sim.state = 'running';
    _onEvent({ kind: 'nat_table_changed', device: 'r1', entries: [] });
    expect(Sim.state).toBe('running');
  });

  it('defers nat_table_changed until the matching packet arrives at the router', () => {
    // An outbound NAT happens at r_a for payload p1. The simulator emits the
    // `nat` event microseconds after the host pushes the packet, so the table
    // would update before the packet visually arrives at r_a if applied
    // immediately. Defer until sim:packet-arrived matches.
    const cap = captureEvents('sim:nat-table-changed');
    listenerCleanups.push(cap.stop);
    _onEvent({
      kind: 'nat', router: 'r_a', direction: 'outbound',
      original_src: '192.168.1.10', rewritten_src: '200.100.0.1',
      dst: '8.8.8.8', flow_id: null, payload_id: 'p1',
    });
    _onEvent({
      kind: 'nat_table_changed', device: 'r_a',
      entries: [{
        original_src: '192.168.1.10', rewritten_src: '200.100.0.1',
        dst: '8.8.8.8', flow_id: null,
      }],
    });
    expect(state.natTables['r_a']).toBeUndefined();
    expect(cap.events).toEqual([]);

    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', {
      detail: { payloadId: 'p1', device: 'r_a' },
    }));
    expect(state.natTables['r_a']).toBeDefined();
    expect(state.natTables['r_a'].length).toBe(1);
    expect(cap.events).toEqual([{ device: 'r_a' }]);
  });

  it('ignores sim:packet-arrived for unrelated payloads while NAT is pending', () => {
    _onEvent({
      kind: 'nat', router: 'r_a', direction: 'outbound',
      original_src: 'x', rewritten_src: 'y', dst: 'z',
      flow_id: null, payload_id: 'p1',
    });
    _onEvent({
      kind: 'nat_table_changed', device: 'r_a',
      entries: [{ original_src: 'x', rewritten_src: 'y', dst: 'z', flow_id: null }],
    });
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', {
      detail: { payloadId: 'p2-other', device: 'r_a' },
    }));
    expect(state.natTables['r_a']).toBeUndefined();
  });

  it('only inbound NAT events do not arm deferral (router never emits table change for inbound, but be safe)', () => {
    // An inbound `nat` arrives without a paired `nat_table_changed`. A later
    // standalone `nat_table_changed` (without a prior outbound nat) must
    // apply immediately — deferral should not trigger on inbound NAT alone.
    _onEvent({
      kind: 'nat', router: 'r_a', direction: 'inbound',
      rewritten_dst: '200.100.0.1', original_dst: '192.168.1.10',
      src: '8.8.8.8', flow_id: null, payload_id: 'p_reply',
    });
    _onEvent({
      kind: 'nat_table_changed', device: 'r_a',
      entries: [{ original_src: 'x', rewritten_src: 'y', dst: 'z', flow_id: null }],
    });
    expect(state.natTables['r_a']).toBeDefined();
    expect(state.natTables['r_a'].length).toBe(1);
  });

  it('clears pending NAT state when the sim returns to idle (so a reset starts clean)', () => {
    _onEvent({
      kind: 'nat', router: 'r_a', direction: 'outbound',
      original_src: 'x', rewritten_src: 'y', dst: 'z',
      flow_id: null, payload_id: 'p1',
    });
    _onEvent({
      kind: 'nat_table_changed', device: 'r_a',
      entries: [{ original_src: 'x', rewritten_src: 'y', dst: 'z', flow_id: null }],
    });
    _onEvent({ kind: 'sim_state', state: 'idle' });
    // A late-arriving packet event for the now-discarded ping must not
    // resurrect the pending table.
    bus.dispatchEvent(new CustomEvent('sim:packet-arrived', {
      detail: { payloadId: 'p1', device: 'r_a' },
    }));
    expect(state.natTables['r_a']).toBeUndefined();
  });
});

// ---------- Sim.refreshState ----------
describe('Sim.refreshState', () => {
  it('calls /sim/state via RuntimeClient', async () => {
    await Sim.refreshState();
    expect(RuntimeClient._json).toHaveBeenCalledWith('GET', '/sim/state');
  });

  it('updates Sim.state to the value returned by the server', async () => {
    RuntimeClient._json = vi.fn(async () => ({ state: 'paused' }));
    Sim.state = 'idle';
    await Sim.refreshState();
    expect(Sim.state).toBe('paused');
  });

  it('dispatches sim:status-changed when the fetched state differs', async () => {
    RuntimeClient._json = vi.fn(async () => ({ state: 'running' }));
    Sim.state = 'idle';
    const cap = captureEvents('sim:status-changed');
    listenerCleanups.push(cap.stop);
    await Sim.refreshState();
    expect(cap.events).toEqual([{ status: 'running' }]);
  });

  it('does NOT dispatch sim:status-changed when the fetched state matches', async () => {
    RuntimeClient._json = vi.fn(async () => ({ state: 'idle' }));
    Sim.state = 'idle';
    const cap = captureEvents('sim:status-changed');
    listenerCleanups.push(cap.stop);
    await Sim.refreshState();
    expect(cap.events).toEqual([]);
  });

  it('updates the toolbar after fetching state (Start label in idle)', async () => {
    RuntimeClient._json = vi.fn(async () => ({ state: 'idle' }));
    await Sim.refreshState();
    expect(document.querySelector('#tb-play .lbl').textContent).toBe('Start');
  });

  it('toggles toolbar to Stop/Pause when state becomes running', async () => {
    RuntimeClient._json = vi.fn(async () => ({ state: 'running' }));
    await Sim.refreshState();
    const play = document.getElementById('tb-play');
    const pause = document.getElementById('tb-pause');
    expect(play.querySelector('.lbl').textContent).toBe('Stop');
    expect(play.classList.contains('running')).toBe(true);
    expect(pause.hidden).toBe(false);
  });
});

// ---------- onPrimary preflight ----------
describe('Sim.onPrimary preflight', () => {
  function postCalls() {
    return RuntimeClient._json.mock.calls.map((c) => `${c[0]} ${c[1]}`);
  }

  it('blocks Start on an incomplete topology and never POSTs it', async () => {
    Sim.state = 'idle';
    // beforeEach leaves networks/hosts/routers empty → incomplete.
    await Sim.onPrimary();
    expect(postCalls()).not.toContain('POST /topology');
    expect(Sim.state).toBe('idle');
    expect(document.querySelector('#toasts .toast')).not.toBeNull();
  });

  it('selects the offending entity so it surfaces in the inspector', async () => {
    Sim.state = 'idle';
    state.networks = { lan1: { cidr: '' } };
    await Sim.onPrimary();
    expect(state.selection).toEqual({ kind: 'network', name: 'lan1' });
  });

  it('proceeds to load + start when the topology is complete', async () => {
    Sim.state = 'idle';
    state.networks = { lan1: { cidr: '192.168.0.0/24' } };
    state.hosts = { h1: { network: 'lan1', address: '192.168.0.2' } };
    const onExport = (e) => { e.detail.yaml = 'internet: {}'; };
    bus.addEventListener('sim:yaml-export-requested', onExport);
    listenerCleanups.push(() => bus.removeEventListener('sim:yaml-export-requested', onExport));
    await Sim.onPrimary();
    expect(postCalls()).toContain('POST /topology');
    expect(postCalls()).toContain('POST /sim/start');
  });
});

// ---------- isTopologyLocked ----------
describe('isTopologyLocked', () => {
  it('is false when Sim.state is idle', () => {
    Sim.state = 'idle';
    expect(isTopologyLocked()).toBe(false);
  });
  it('is true when Sim.state is running', () => {
    Sim.state = 'running';
    expect(isTopologyLocked()).toBe(true);
  });
  it('is false when Sim.state is paused (paused allows topology edits via patch)', () => {
    Sim.state = 'paused';
    expect(isTopologyLocked()).toBe(false);
  });
});

// ---------- recordPatchOp + updatePatchIndicator ----------
describe('recordPatchOp', () => {
  it('appends to Sim.patch only when paused', () => {
    Sim.state = 'paused';
    recordPatchOp({ op: 'add_network', name: 'lan1' });
    expect(Sim.patch).toEqual([{ op: 'add_network', name: 'lan1' }]);
  });

  it('is a no-op when Sim is idle', () => {
    Sim.state = 'idle';
    recordPatchOp({ op: 'add_network', name: 'lan1' });
    expect(Sim.patch).toEqual([]);
  });

  it('is a no-op when Sim is running', () => {
    Sim.state = 'running';
    recordPatchOp({ op: 'add_network', name: 'lan1' });
    expect(Sim.patch).toEqual([]);
  });

  it('refreshes the pause label with the accumulated edit count', () => {
    Sim.state = 'paused';
    recordPatchOp({ op: 'add_host', name: 'h1' });
    recordPatchOp({ op: 'add_router', name: 'r1' });
    const lbl = document.querySelector('#tb-pause .lbl');
    expect(lbl.textContent).toBe('Resume (2 edits)');
  });
});

describe('updatePatchIndicator', () => {
  it('shows the edit count when paused with pending ops', () => {
    Sim.state = 'paused';
    Sim.patch = [{ op: 'add_network' }, { op: 'add_host' }, { op: 'add_router' }];
    updatePatchIndicator();
    expect(document.querySelector('#tb-pause .lbl').textContent).toBe('Resume (3 edits)');
  });

  it('shows just "Resume" when paused with no pending ops', () => {
    Sim.state = 'paused';
    Sim.patch = [];
    updatePatchIndicator();
    expect(document.querySelector('#tb-pause .lbl').textContent).toBe('Resume');
  });

  it('uses singular "edit" when patch count is 1', () => {
    Sim.state = 'paused';
    Sim.patch = [{ op: 'add_host' }];
    updatePatchIndicator();
    expect(document.querySelector('#tb-pause .lbl').textContent).toBe('Resume (1 edit)');
  });

  it('is a no-op when the pause button is absent', () => {
    document.body.innerHTML = '';
    expect(() => updatePatchIndicator()).not.toThrow();
  });
});

// ---------- reconcilePatch ----------
describe('reconcilePatch', () => {
  it('returns an empty array for an empty patch', () => {
    expect(reconcilePatch([])).toEqual([]);
  });

  it('rewrites add_network ops to carry the current cidr from state', () => {
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    const out = reconcilePatch([{ op: 'add_network', name: 'lan1' }]);
    expect(out).toEqual([{ op: 'add_network', name: 'lan1', address: '10.0.0.0/24' }]);
  });

  it('drops add_network ops whose network was deleted before resume', () => {
    const out = reconcilePatch([{ op: 'add_network', name: 'gone' }]);
    expect(out).toEqual([]);
  });

  it('rewrites add_host ops with the current network + address from state', () => {
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.10' };
    const out = reconcilePatch([{ op: 'add_host', name: 'h1' }]);
    expect(out).toEqual([{ op: 'add_host', name: 'h1', network: 'lan1', address: '10.0.0.10' }]);
  });

  it('includes gateway in add_host output when present', () => {
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.10', gateway: '10.0.0.1' };
    const out = reconcilePatch([{ op: 'add_host', name: 'h1' }]);
    expect(out[0].gateway).toBe('10.0.0.1');
  });

  it('drops add_host ops whose host was deleted before resume', () => {
    const out = reconcilePatch([{ op: 'add_host', name: 'gone' }]);
    expect(out).toEqual([]);
  });

  it('rewrites add_router ops with normalized interface list (numeric cost)', () => {
    state.routers.r1 = {
      x: 0, y: 0,
      interfaces: {
        eth0: { network: 'lan1', address: '10.0.0.1', cost: 7 },
      },
    };
    const out = reconcilePatch([{ op: 'add_router', name: 'r1' }]);
    expect(out).toEqual([{
      op: 'add_router', name: 'r1',
      interfaces: [{ name: 'eth0', network: 'lan1', address: '10.0.0.1', cost: 7 }],
    }]);
  });

  it('coerces string cost values to integers in add_router output', () => {
    state.routers.r1 = {
      x: 0, y: 0,
      interfaces: { eth0: { network: 'lan1', address: '10.0.0.1', cost: '12' } },
    };
    const out = reconcilePatch([{ op: 'add_router', name: 'r1' }]);
    expect(out[0].interfaces[0].cost).toBe(12);
  });

  it('defaults non-numeric router interface cost to 1', () => {
    state.routers.r1 = {
      x: 0, y: 0,
      interfaces: { eth0: { network: 'lan1', address: '10.0.0.1', cost: 'whoops' } },
    };
    const out = reconcilePatch([{ op: 'add_router', name: 'r1' }]);
    expect(out[0].interfaces[0].cost).toBe(1);
  });

  it('drops add_router ops whose router was deleted before resume', () => {
    const out = reconcilePatch([{ op: 'add_router', name: 'gone' }]);
    expect(out).toEqual([]);
  });

  it('passes through unknown ops (remove_*, update_cost) verbatim', () => {
    // Note: reconcile sorts by op-class rank, so update_cost (rank 2) ends
    // up before remove_host (rank 3) — but neither op gets rewritten.
    const removeOp = { op: 'remove_host', name: 'h1' };
    const updateOp = { op: 'update_cost', router: 'r1', iface: 'eth0', cost: 5 };
    const out = reconcilePatch([removeOp, updateOp]);
    expect(out).toEqual([updateOp, removeOp]);
  });

  it('does NOT mutate state.networks/hosts/routers (read-only transform)', () => {
    state.networks.lan1 = { cidr: '10.0.0.0/24' };
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.10' };
    state.routers.r1 = { x: 0, y: 0, interfaces: {} };
    const before = JSON.parse(JSON.stringify({ n: state.networks, h: state.hosts, r: state.routers }));
    reconcilePatch([
      { op: 'add_network', name: 'lan1' },
      { op: 'add_host', name: 'h1' },
      { op: 'add_router', name: 'r1' },
    ]);
    expect({ n: state.networks, h: state.hosts, r: state.routers }).toEqual(before);
  });

  it('reorders ops by rank: fabric adds first, then device adds, then mutations, then removes', () => {
    // The server's patch validator walks ops in order. If the SPA queued a
    // host before its fabric (easy to do: click "Host" then "LAN"), naive
    // emission breaks resume. reconcilePatch buries that by sorting.
    state.networks.lan1 = { cidr: '10.0.0.0/24' };
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.5' };
    const out = reconcilePatch([
      { op: 'remove_host', name: 'h2' },
      { op: 'add_host', name: 'h1' },
      { op: 'update_cost', router: 'r1', iface: 'eth0', cost: 5 },
      { op: 'add_network', name: 'lan1' },
    ]);
    expect(out.map(o => o.op)).toEqual(['add_network', 'add_host', 'update_cost', 'remove_host']);
  });

  it('emits link: instead of network: for a host attached to a p2p link', () => {
    state.links.p2p1 = { cidr: '192.168.0.0/30' };
    state.hosts.h1 = { link: 'p2p1', address: '192.168.0.1' };
    const out = reconcilePatch([{ op: 'add_host', name: 'h1' }]);
    expect(out).toEqual([
      { op: 'add_host', name: 'h1', link: 'p2p1', address: '192.168.0.1' },
    ]);
  });

  it('emits link: per-interface for a router with mixed network + link attachments', () => {
    state.networks.lan1 = { cidr: '10.0.0.0/24' };
    state.links.p2p1 = { cidr: '192.168.0.0/30' };
    state.routers.r1 = {
      x: 0, y: 0,
      interfaces: {
        eth0: { network: 'lan1', address: '10.0.0.1', cost: 5 },
        eth1: { link: 'p2p1', address: '192.168.0.1', cost: 1 },
      },
    };
    const out = reconcilePatch([{ op: 'add_router', name: 'r1' }]);
    expect(out[0].interfaces).toEqual([
      { name: 'eth0', network: 'lan1', address: '10.0.0.1', cost: 5 },
      { name: 'eth1', link: 'p2p1', address: '192.168.0.1', cost: 1 },
    ]);
  });

  it('rewrites add_link ops to carry the current cidr from state', () => {
    state.links.p2p1 = { cidr: '192.168.5.0/30' };
    const out = reconcilePatch([{ op: 'add_link', name: 'p2p1' }]);
    expect(out).toEqual([{ op: 'add_link', name: 'p2p1', address: '192.168.5.0/30' }]);
  });

  it('drops add_link ops whose link was deleted before resume', () => {
    const out = reconcilePatch([{ op: 'add_link', name: 'gone' }]);
    expect(out).toEqual([]);
  });
});

// ---------- setConnectionStatus ----------
describe('setConnectionStatus', () => {
  it('creates a #conn-banner element on first call when missing', () => {
    expect(document.getElementById('conn-banner')).toBeNull();
    setConnectionStatus(false);
    const banner = document.getElementById('conn-banner');
    expect(banner).not.toBeNull();
  });

  it('shows a "connection lost" message and unhides the banner when disconnected', () => {
    setConnectionStatus(false);
    const banner = document.getElementById('conn-banner');
    expect(banner.textContent).toBe('connection lost — retrying');
    expect(banner.style.display).toBe('block');
  });

  it('clears the message and hides the banner when reconnected', () => {
    setConnectionStatus(false);
    setConnectionStatus(true);
    const banner = document.getElementById('conn-banner');
    expect(banner.textContent).toBe('');
    expect(banner.style.display).toBe('none');
  });

  it('reuses an existing #conn-banner if one is already in the DOM', () => {
    const pre = document.createElement('div');
    pre.id = 'conn-banner';
    document.body.appendChild(pre);
    setConnectionStatus(false);
    const banners = document.querySelectorAll('#conn-banner');
    expect(banners.length).toBe(1);
    expect(banners[0]).toBe(pre);
  });
});

// ---------- RuntimeClient REST surface ----------
describe('RuntimeClient REST helpers', () => {
  it('start() POSTs /sim/start', async () => {
    RuntimeClient._json = vi.fn(async () => ({}));
    await RuntimeClient.start();
    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/sim/start', {});
  });

  it('pause() POSTs /sim/pause', async () => {
    RuntimeClient._json = vi.fn(async () => ({}));
    await RuntimeClient.pause();
    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/sim/pause', {});
  });

  it('resume(patch) POSTs /sim/resume with the patch payload', async () => {
    RuntimeClient._json = vi.fn(async () => ({}));
    const patch = [{ op: 'add_network', name: 'lan1', address: '10.0.0.0/24' }];
    await RuntimeClient.resume(patch);
    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/sim/resume', { patch });
  });

  it('resume(undefined) POSTs an empty patch array (never null)', async () => {
    RuntimeClient._json = vi.fn(async () => ({}));
    await RuntimeClient.resume();
    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/sim/resume', { patch: [] });
  });

  it('getState() GETs /sim/state', async () => {
    RuntimeClient._json = vi.fn(async () => ({ state: 'idle' }));
    await RuntimeClient.getState();
    expect(RuntimeClient._json).toHaveBeenCalledWith('GET', '/sim/state');
  });

  it('deviceCommand encodes the device name into the URL', async () => {
    RuntimeClient._json = vi.fn(async () => ({}));
    await RuntimeClient.deviceCommand('h 1', 'ping');
    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/devices/h%201/command', { cmd: 'ping' });
  });
});

// ---------- Sim.onPrimary ----------
describe('Sim.onPrimary', () => {
  it('idle → dispatches sim:yaml-export-requested and calls loadTopology + start with the listener-supplied yaml', async () => {
    Sim.state = 'idle';
    const captured = [];
    const handler = (e) => {
      captured.push(e);
      // Listener fills in the yaml that onPrimary reads back from event.detail.
      e.detail.yaml = 'fake-yaml';
    };
    bus.addEventListener('sim:yaml-export-requested', handler);
    listenerCleanups.push(() => bus.removeEventListener('sim:yaml-export-requested', handler));

    RuntimeClient._json = vi.fn(async (method, path) => {
      if (path === '/sim/state') return { state: 'running' };
      return {};
    });

    await Sim.onPrimary();

    expect(captured.length).toBe(1);
    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/topology', { yaml: 'fake-yaml' });
    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/sim/start', {});
  });

  it('running → calls stop and clears Sim.patch', async () => {
    Sim.state = 'running';
    Sim.patch = [{ op: 'add_network', name: 'lan1' }];
    RuntimeClient._json = vi.fn(async (method, path) => {
      if (path === '/sim/state') return { state: 'idle' };
      return {};
    });

    await Sim.onPrimary();

    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/sim/stop', {});
    expect(Sim.patch).toEqual([]);
  });

  it('paused → calls stop and clears Sim.patch (non-idle branch)', async () => {
    Sim.state = 'paused';
    Sim.patch = [{ op: 'remove_host', name: 'h1' }, { op: 'add_router', name: 'r2' }];
    RuntimeClient._json = vi.fn(async (method, path) => {
      if (path === '/sim/state') return { state: 'idle' };
      return {};
    });

    await Sim.onPrimary();

    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/sim/stop', {});
    expect(Sim.patch).toEqual([]);
  });

  it('surfaces server error via toast with the "Start" label when failing in the idle branch', async () => {
    Sim.state = 'idle';
    const handler = (e) => { e.detail.yaml = ''; };
    bus.addEventListener('sim:yaml-export-requested', handler);
    listenerCleanups.push(() => bus.removeEventListener('sim:yaml-export-requested', handler));

    RuntimeClient._json = vi.fn(async (method, path) => {
      if (path === '/sim/state') return { state: 'idle' };
      throw new Error('boom');
    });

    await Sim.onPrimary();  // must not throw

    const toastEl = document.querySelector('.toast.error');
    expect(toastEl).not.toBeNull();
    expect(toastEl.textContent).toContain('boom');
    expect(toastEl.textContent).toContain('Start');
  });

  it('surfaces server error via toast with the "Stop" label and preserves Sim.patch on stop failure', async () => {
    Sim.state = 'running';
    Sim.patch = [{ op: 'add_host', name: 'h9' }];
    RuntimeClient._json = vi.fn(async (method, path) => {
      if (path === '/sim/stop') throw new Error('stop failed');
      if (path === '/sim/state') return { state: 'running' };
      return {};
    });

    await Sim.onPrimary();

    const toastEl = document.querySelector('.toast.error');
    expect(toastEl).not.toBeNull();
    expect(toastEl.textContent).toContain('stop failed');
    expect(toastEl.textContent).toContain('Stop');
    // Patch must NOT be cleared when stop() throws — the clear sits after the await.
    expect(Sim.patch).toEqual([{ op: 'add_host', name: 'h9' }]);
  });
});

// ---------- Sim.onSecondary ----------
describe('Sim.onSecondary', () => {
  it('running → calls pause', async () => {
    Sim.state = 'running';
    RuntimeClient._json = vi.fn(async (method, path) => {
      if (path === '/sim/state') return { state: 'paused' };
      return {};
    });

    await Sim.onSecondary();

    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/sim/pause', {});
  });

  it('paused → calls resume with the reconciled patch and clears Sim.patch', async () => {
    Sim.state = 'paused';
    state.networks.lan1 = { cidr: '10.0.0.0/24' };
    Sim.patch = [{ op: 'add_network', name: 'lan1' }];
    RuntimeClient._json = vi.fn(async (method, path) => {
      if (path === '/sim/state') return { state: 'running' };
      return {};
    });

    await Sim.onSecondary();

    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/sim/resume', {
      patch: [{ op: 'add_network', name: 'lan1', address: '10.0.0.0/24' }],
    });
    expect(Sim.patch).toEqual([]);
  });

  it('idle → no RuntimeClient state-changing call (only refreshState in finally)', async () => {
    Sim.state = 'idle';
    RuntimeClient._json = vi.fn(async (method, path) => {
      if (path === '/sim/state') return { state: 'idle' };
      return {};
    });

    await Sim.onSecondary();

    const paths = RuntimeClient._json.mock.calls.map(c => c[1]);
    expect(paths).not.toContain('/sim/pause');
    expect(paths).not.toContain('/sim/resume');
  });

  it('surfaces resume error via toast with the "Resume" label and preserves Sim.patch', async () => {
    Sim.state = 'paused';
    Sim.patch = [{ op: 'remove_router', name: 'r1' }];
    RuntimeClient._json = vi.fn(async (method, path) => {
      if (path === '/sim/resume') throw new Error('resume failed');
      if (path === '/sim/state') return { state: 'paused' };
      return {};
    });

    await Sim.onSecondary();

    const toastEl = document.querySelector('.toast.error');
    expect(toastEl).not.toBeNull();
    expect(toastEl.textContent).toContain('resume failed');
    expect(toastEl.textContent).toContain('Resume');
    expect(Sim.patch).toEqual([{ op: 'remove_router', name: 'r1' }]);
  });
});

// ---------- Sim.onReset ----------
describe('Sim.onReset', () => {
  it('idle → calls resetTopology, then getTopology, then dispatches sim:topology-import-requested with the fetched yaml', async () => {
    Sim.state = 'idle';
    const cap = captureEvents('sim:topology-import-requested');
    listenerCleanups.push(cap.stop);

    RuntimeClient._json = vi.fn(async (method, path) => {
      if (method === 'POST' && path === '/topology/reset') return {};
      if (method === 'GET' && path === '/topology') return { yaml: 'reset-yaml' };
      if (path === '/sim/state') return { state: 'idle' };
      return {};
    });

    await Sim.onReset();

    expect(RuntimeClient._json).toHaveBeenCalledWith('POST', '/topology/reset', {});
    expect(RuntimeClient._json).toHaveBeenCalledWith('GET', '/topology');
    expect(cap.events).toEqual([{ yaml: 'reset-yaml' }]);
  });

  it('running → no-op (guarded by Sim.state !== "idle")', async () => {
    Sim.state = 'running';
    const cap = captureEvents('sim:topology-import-requested');
    listenerCleanups.push(cap.stop);

    await Sim.onReset();

    const paths = RuntimeClient._json.mock.calls.map(c => c[1]);
    expect(paths).not.toContain('/topology/reset');
    expect(cap.events).toEqual([]);
  });

  it('paused → no-op (guarded by Sim.state !== "idle")', async () => {
    Sim.state = 'paused';
    const cap = captureEvents('sim:topology-import-requested');
    listenerCleanups.push(cap.stop);

    await Sim.onReset();

    const paths = RuntimeClient._json.mock.calls.map(c => c[1]);
    expect(paths).not.toContain('/topology/reset');
    expect(cap.events).toEqual([]);
  });

  it('surfaces server error via toast with the "Reset" label and does NOT dispatch the import event', async () => {
    Sim.state = 'idle';
    const cap = captureEvents('sim:topology-import-requested');
    listenerCleanups.push(cap.stop);

    RuntimeClient._json = vi.fn(async (method, path) => {
      if (path === '/topology/reset') throw new Error('reset failed');
      if (path === '/sim/state') return { state: 'idle' };
      return {};
    });

    await Sim.onReset();

    const toastEl = document.querySelector('.toast.error');
    expect(toastEl).not.toBeNull();
    expect(toastEl.textContent).toContain('reset failed');
    expect(toastEl.textContent).toContain('Reset');
    expect(cap.events).toEqual([]);
  });
});

// ---------- _renderToolbar contract ----------
describe('_renderToolbar no longer touches Inspector/Terminals', () => {
  it('does not depend on Inspector or Terminals being defined', () => {
    // Recent behavior change: cross-module side effects flow through `bus`,
    // so _renderToolbar must not poke Inspector.refreshRoutes or
    // Terminals._applySimState directly. Assert it survives without either global.
    delete globalThis.Inspector;
    delete globalThis.Terminals;
    Sim.state = 'running';
    expect(() => Sim._renderToolbar()).not.toThrow();
  });
});

// ---------- new WS event kinds (Task 2) ----------
describe('_onEvent: interface_state_changed / device_state_changed / ping_result', () => {
  it('routes interface_state_changed into the cache', () => {
    resetDownState();
    _onEvent({ kind: 'interface_state_changed', device: 'r1', interface: 'eth1', up: false });
    expect(isInterfaceDown('r1', 'eth1')).toBe(true);
  });

  it('routes device_state_changed into the cache', () => {
    resetDownState();
    _onEvent({ kind: 'device_state_changed', device: 'r3', up: false });
    expect(isDeviceHalted('r3')).toBe(true);
  });

  it('emits sim:ping-result for ping_result events', () => {
    const seen = [];
    const handler = (e) => seen.push(e.detail);
    bus.addEventListener('sim:ping-result', handler);
    _onEvent({ kind: 'ping_result', device: 'h1', dst: '10.0.0.2', seq: 1, rtt_ms: 2.5 });
    bus.removeEventListener('sim:ping-result', handler);
    expect(seen).toEqual([{ device: 'h1', dst: '10.0.0.2', seq: 1, rtt_ms: 2.5 }]);
  });
});

// ---------- _onEvent: topology_changed ----------
describe('_onEvent: topology_changed', () => {
  it('emits sim:topology-changed for topology_changed events', () => {
    const seen = [];
    const handler = (e) => seen.push(e.detail);
    bus.addEventListener('sim:topology-changed', handler);
    const ops = [{ op: 'add_network', name: 'lanX', address: '10.9.0.0/24' }];
    _onEvent({ kind: 'topology_changed', ops });
    bus.removeEventListener('sim:topology-changed', handler);
    expect(seen).toEqual([{ ops }]);
  });
});

// ---------- recoverDownState ----------
describe('recoverDownState', () => {
  it('seeds cache from /devices interfaces reads', async () => {
    resetDownState();
    state.routers = { r1: { x: 0, y: 0, interfaces: {} }, r2: { x: 0, y: 0, interfaces: {} } };
    const spy = vi.spyOn(RuntimeClient, 'deviceInterfaces').mockImplementation(async (n) => {
      if (n === 'r1') return { halted: true, interfaces: [{ name: 'eth0', up: false }] };
      return { halted: false, interfaces: [{ name: 'eth0', up: true }] };
    });
    await recoverDownState();
    expect(isDeviceHalted('r1')).toBe(true);
    expect(isInterfaceDown('r1', 'eth0')).toBe(true);
    expect(isDeviceHalted('r2')).toBe(false);
    expect(isInterfaceDown('r2', 'eth0')).toBe(false);
    spy.mockRestore();
  });

  it('skips routers that throw (device gone / transient error)', async () => {
    resetDownState();
    state.routers = { r1: { x: 0, y: 0, interfaces: {} }, r2: { x: 0, y: 0, interfaces: {} } };
    const spy = vi.spyOn(RuntimeClient, 'deviceInterfaces').mockImplementation(async (n) => {
      if (n === 'r1') throw new Error('not found');
      return { halted: false, interfaces: [{ name: 'eth0', up: false }] };
    });
    await recoverDownState();
    // r1 threw — should not affect r2's result
    expect(isInterfaceDown('r2', 'eth0')).toBe(true);
    spy.mockRestore();
  });

  it('is a no-op when state.routers is empty', async () => {
    resetDownState();
    state.routers = {};
    const spy = vi.spyOn(RuntimeClient, 'deviceInterfaces').mockResolvedValue({ halted: false, interfaces: [] });
    await recoverDownState();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------- applyEdit ----------
describe('applyEdit', () => {
  beforeEach(() => {
    Sim.patch = [];
    RuntimeClient._json = vi.fn(async () => ({}));
  });

  it('when running: calls editTopology with the reconciled op (not recordPatchOp)', async () => {
    Sim.state = 'running';
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'add_network', name: 'lan1' });

    expect(editSpy).toHaveBeenCalledWith([
      { op: 'add_network', name: 'lan1', address: '10.0.0.0/24' },
    ]);
    expect(Sim.patch).toEqual([]);  // NOT accumulated
    editSpy.mockRestore();
  });

  it('when paused: accumulates the op into Sim.patch (does NOT call editTopology)', async () => {
    Sim.state = 'paused';
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'remove_host', name: 'h1' });

    expect(editSpy).not.toHaveBeenCalled();
    expect(Sim.patch).toEqual([{ op: 'remove_host', name: 'h1' }]);
    editSpy.mockRestore();
  });

  it('when idle: is a no-op (does NOT call editTopology, does NOT accumulate)', async () => {
    Sim.state = 'idle';
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'add_router', name: 'r1', interfaces: [] });

    expect(editSpy).not.toHaveBeenCalled();
    expect(Sim.patch).toEqual([]);
    editSpy.mockRestore();
  });

  it('when running: a failed editTopology surfaces as a toast (does not throw)', async () => {
    Sim.state = 'running';
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockRejectedValue(new Error('edit failed'));

    await applyEdit({ op: 'add_network', name: 'lan1' });  // must not throw

    const toastEl = document.querySelector('.toast.error');
    expect(toastEl).not.toBeNull();
    expect(toastEl.textContent).toContain('edit failed');
    expect(toastEl.textContent).toContain('Live edit');
    editSpy.mockRestore();
  });

  it('when running: reconcilePatch is called — remove_router passes through verbatim', async () => {
    Sim.state = 'running';
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'remove_router', name: 'r1' });

    expect(editSpy).toHaveBeenCalledWith([{ op: 'remove_router', name: 'r1' }]);
    editSpy.mockRestore();
  });

  it('when running: update_cost passes through reconcilePatch verbatim', async () => {
    Sim.state = 'running';
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'update_cost', router: 'r1', iface: 'eth0', cost: 15 });

    expect(editSpy).toHaveBeenCalledWith([
      { op: 'update_cost', router: 'r1', iface: 'eth0', cost: 15 },
    ]);
    editSpy.mockRestore();
  });
});

// ---------- B1: pendingLiveAdds — deferred incomplete adds ----------
describe('applyEdit (B1): defers incomplete adds while running', () => {
  beforeEach(() => {
    Sim.state = 'running';
    Sim.patch = [];
    pendingLiveAdds.clear();
    RuntimeClient._json = vi.fn(async () => ({}));
  });

  it('does NOT call editTopology for an add_network with empty CIDR', async () => {
    state.networks.lan1 = { cidr: '', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'add_network', name: 'lan1' });

    expect(editSpy).not.toHaveBeenCalled();
    editSpy.mockRestore();
  });

  it('records the entity in pendingLiveAdds when the add is deferred', async () => {
    state.networks.lan1 = { cidr: '', x: 0, y: 0 };
    vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'add_network', name: 'lan1' });

    expect(pendingLiveAdds.has('network:lan1')).toBe(true);
    vi.restoreAllMocks();
  });

  it('does NOT defer an add_network with a complete CIDR', async () => {
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'add_network', name: 'lan1' });

    expect(editSpy).toHaveBeenCalled();
    expect(pendingLiveAdds.has('network:lan1')).toBe(false);
    editSpy.mockRestore();
  });

  it('defers an add_host with empty address', async () => {
    state.hosts.h1 = { network: 'lan1', address: '', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'add_host', name: 'h1' });

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('host:h1')).toBe(true);
    editSpy.mockRestore();
  });

  it('defers an add_router with no interfaces', async () => {
    state.routers.r1 = { x: 0, y: 0, interfaces: {} };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'add_router', name: 'r1' });

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('router:r1')).toBe(true);
    editSpy.mockRestore();
  });

  it('defers an add_link with empty CIDR', async () => {
    state.links.p2p1 = { cidr: '', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await applyEdit({ op: 'add_link', name: 'p2p1' });

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('link:p2p1')).toBe(true);
    editSpy.mockRestore();
  });
});

// ---------- B1: finalizePendingAdd ----------
describe('finalizePendingAdd', () => {
  beforeEach(() => {
    Sim.state = 'running';
    Sim.patch = [];
    pendingLiveAdds.clear();
    RuntimeClient._json = vi.fn(async () => ({}));
  });

  it('is a no-op when the entity is not in pendingLiveAdds', async () => {
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('network', 'lan1');

    expect(editSpy).not.toHaveBeenCalled();
    editSpy.mockRestore();
  });

  it('posts the complete add when the entity is pending and now has a CIDR', async () => {
    pendingLiveAdds.add('network:lan1');
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('network', 'lan1');

    expect(editSpy).toHaveBeenCalledWith([
      { op: 'add_network', name: 'lan1', address: '10.0.0.0/24' },
    ]);
    expect(pendingLiveAdds.has('network:lan1')).toBe(false);
    editSpy.mockRestore();
  });

  it('does NOT post if the entity is still incomplete (no CIDR yet)', async () => {
    pendingLiveAdds.add('network:lan1');
    state.networks.lan1 = { cidr: '', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('network', 'lan1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('network:lan1')).toBe(true);  // still pending
    editSpy.mockRestore();
  });

  it('posts an add_host when the host address is filled in', async () => {
    pendingLiveAdds.add('host:h1');
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('host', 'h1');

    expect(editSpy).toHaveBeenCalledWith([
      { op: 'add_host', name: 'h1', network: 'lan1', address: '10.0.0.5' },
    ]);
    expect(pendingLiveAdds.has('host:h1')).toBe(false);
    editSpy.mockRestore();
  });

  it('cleans up pendingLiveAdds without POSTing when sim is no longer running', async () => {
    pendingLiveAdds.add('network:lan1');
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    Sim.state = 'idle';  // sim stopped between add and finalize
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('network', 'lan1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('network:lan1')).toBe(false);
    editSpy.mockRestore();
  });

  // Validity-gated finalize: partial/invalid values must NOT trigger a POST.
  // This prevents the "type '1' → POST → server rejects → resync removes entity" bug.
  it('does NOT call editTopology when network CIDR is partial/invalid mid-keystroke ("1")', async () => {
    pendingLiveAdds.add('network:lan1');
    state.networks.lan1 = { cidr: '1', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('network', 'lan1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('network:lan1')).toBe(true);  // still pending
    editSpy.mockRestore();
  });

  it('does NOT call editTopology when network CIDR is partial ("10.0")', async () => {
    pendingLiveAdds.add('network:lan1');
    state.networks.lan1 = { cidr: '10.0', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('network', 'lan1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('network:lan1')).toBe(true);
    editSpy.mockRestore();
  });

  it('does NOT call editTopology when network CIDR has trailing slash ("10.0.0.0/")', async () => {
    pendingLiveAdds.add('network:lan1');
    state.networks.lan1 = { cidr: '10.0.0.0/', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('network', 'lan1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('network:lan1')).toBe(true);
    editSpy.mockRestore();
  });

  it('POSTs exactly once when network CIDR becomes a valid value ("10.0.0.0/24")', async () => {
    pendingLiveAdds.add('network:lan1');
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('network', 'lan1');

    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(pendingLiveAdds.has('network:lan1')).toBe(false);
    editSpy.mockRestore();
  });

  it('does NOT call editTopology when host address is partial ("10.0.0")', async () => {
    pendingLiveAdds.add('host:h1');
    state.hosts.h1 = { network: 'lan1', address: '10.0.0', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('host', 'h1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('host:h1')).toBe(true);
    editSpy.mockRestore();
  });

  it('POSTs exactly once when host address becomes a valid IPv4 ("10.0.0.5")', async () => {
    pendingLiveAdds.add('host:h1');
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('host', 'h1');

    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(pendingLiveAdds.has('host:h1')).toBe(false);
    editSpy.mockRestore();
  });

  // --- Link CIDR mask-range gate ---
  // The inspector shows red for /24 on a link (must be /30 or /31).
  // finalizePendingAdd must apply the same rule.

  it('does NOT POST add_link when CIDR is /24 (too wide — links need /30 or /31)', async () => {
    pendingLiveAdds.add('link:p2p1');
    state.links.p2p1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('link', 'p2p1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('link:p2p1')).toBe(true);  // still deferred
    editSpy.mockRestore();
  });

  it('POSTs exactly once when link CIDR becomes a valid /30', async () => {
    pendingLiveAdds.add('link:p2p1');
    state.links.p2p1 = { cidr: '10.0.0.0/30', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('link', 'p2p1');

    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(pendingLiveAdds.has('link:p2p1')).toBe(false);
    editSpy.mockRestore();
  });

  it('POSTs exactly once when link CIDR becomes a valid /31', async () => {
    pendingLiveAdds.add('link:p2p1');
    state.links.p2p1 = { cidr: '10.0.0.4/31', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('link', 'p2p1');

    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(pendingLiveAdds.has('link:p2p1')).toBe(false);
    editSpy.mockRestore();
  });

  // --- Host: out-of-subnet address ---
  // The inspector shows red when the address is a syntactically valid IPv4
  // but lies outside the fabric's CIDR.

  it('does NOT POST add_host when address is a valid IPv4 but outside the fabric CIDR', async () => {
    pendingLiveAdds.add('host:h1');
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    state.hosts.h1 = { network: 'lan1', address: '192.168.0.5', x: 0, y: 0 };  // not in 10.0.0.0/24
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('host', 'h1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('host:h1')).toBe(true);
    editSpy.mockRestore();
  });

  it('does NOT POST add_host when fabric has no CIDR yet (address cannot be validated)', async () => {
    pendingLiveAdds.add('host:h1');
    state.networks.lan1 = { cidr: '', x: 0, y: 0 };
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('host', 'h1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('host:h1')).toBe(true);
    editSpy.mockRestore();
  });

  // --- Host: duplicate address on the same fabric ---

  it('does NOT POST add_host when address is already used by another host on the same fabric', async () => {
    pendingLiveAdds.add('host:h2');
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 };   // already exists
    state.hosts.h2 = { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 };   // duplicate
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('host', 'h2');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('host:h2')).toBe(true);
    editSpy.mockRestore();
  });

  it('does NOT POST add_host when address is already used by a router-interface on the same fabric', async () => {
    pendingLiveAdds.add('host:h1');
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    state.routers.r1 = { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.0.0.5', cost: 10 } } };
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 };   // collides with r1/eth0
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('host', 'h1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('host:h1')).toBe(true);
    editSpy.mockRestore();
  });

  it('POSTs add_host when address is in-subnet and free (no collision)', async () => {
    pendingLiveAdds.add('host:h1');
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    state.routers.r1 = { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.0.0.1', cost: 10 } } };
    state.hosts.h1 = { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 };   // free
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('host', 'h1');

    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(pendingLiveAdds.has('host:h1')).toBe(false);
    editSpy.mockRestore();
  });

  // --- Router: interface address must pass the same fabric-aware check ---

  it('does NOT POST add_router when an interface address is outside the fabric CIDR', async () => {
    pendingLiveAdds.add('router:r1');
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    state.routers.r1 = {
      x: 0, y: 0,
      interfaces: { eth0: { network: 'lan1', address: '192.168.0.1', cost: 10 } },  // out of subnet
    };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('router', 'r1');

    expect(editSpy).not.toHaveBeenCalled();
    expect(pendingLiveAdds.has('router:r1')).toBe(true);
    editSpy.mockRestore();
  });

  it('POSTs add_router when all interface addresses are in-subnet and free', async () => {
    pendingLiveAdds.add('router:r1');
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    state.routers.r1 = {
      x: 0, y: 0,
      interfaces: { eth0: { network: 'lan1', address: '10.0.0.1', cost: 10 } },
    };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});

    await finalizePendingAdd('router', 'r1');

    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(pendingLiveAdds.has('router:r1')).toBe(false);
    editSpy.mockRestore();
  });
});

// ---------- B3: resync-on-failure ----------
describe('applyEdit (B3): resyncs topology on POST failure', () => {
  beforeEach(() => {
    Sim.state = 'running';
    Sim.patch = [];
    pendingLiveAdds.clear();
    RuntimeClient._json = vi.fn(async () => ({}));
  });

  it('dispatches sim:topology-import-requested after a failed editTopology', async () => {
    state.routers.r1 = { x: 0, y: 0, interfaces: {} };
    const editSpy = vi.spyOn(RuntimeClient, 'editTopology').mockRejectedValue(new Error('network_in_use'));
    vi.spyOn(RuntimeClient, 'getTopology').mockResolvedValue({ yaml: 'resync-yaml' });

    const importEvents = [];
    const handler = (e) => importEvents.push(e.detail);
    bus.addEventListener('sim:topology-import-requested', handler);

    await applyEdit({ op: 'remove_router', name: 'r1' });
    bus.removeEventListener('sim:topology-import-requested', handler);

    // B3 resyncs preserve view + selection so a mid-compose user doesn't lose focus.
    expect(importEvents.length).toBe(1);
    expect(importEvents[0].yaml).toBe('resync-yaml');
    expect(importEvents[0].preserveView).toBe(true);
    expect(importEvents[0].preserveSelection).toBe(true);
    editSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('does NOT resync when editTopology succeeds', async () => {
    state.routers.r1 = { x: 0, y: 0, interfaces: {} };
    vi.spyOn(RuntimeClient, 'editTopology').mockResolvedValue({});
    const getTopologySpy = vi.spyOn(RuntimeClient, 'getTopology').mockResolvedValue({ yaml: '' });

    const importEvents = [];
    const handler = (e) => importEvents.push(e.detail);
    bus.addEventListener('sim:topology-import-requested', handler);

    await applyEdit({ op: 'remove_router', name: 'r1' });
    bus.removeEventListener('sim:topology-import-requested', handler);

    expect(getTopologySpy).not.toHaveBeenCalled();
    expect(importEvents).toEqual([]);
    vi.restoreAllMocks();
  });

  it('still shows the error toast even when getTopology also fails during resync', async () => {
    state.networks.lan1 = { cidr: '10.0.0.0/24', x: 0, y: 0 };
    vi.spyOn(RuntimeClient, 'editTopology').mockRejectedValue(new Error('server error'));
    vi.spyOn(RuntimeClient, 'getTopology').mockRejectedValue(new Error('offline'));

    await applyEdit({ op: 'remove_network', name: 'lan1' });  // must not throw

    const toastEl = document.querySelector('.toast.error');
    expect(toastEl).not.toBeNull();
    expect(toastEl.textContent).toContain('server error');
    vi.restoreAllMocks();
  });
});
