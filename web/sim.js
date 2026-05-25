/* ===========================================================
   loom — simulation state machine + WS event router

   Owns the `Sim` state machine (idle/running/paused), the REST + WebSocket
   wrapper (`RuntimeClient`), the topology lock + patch accumulator, and the
   server-event dispatcher. Cross-module side effects (toolbar re-render,
   packet animation, route re-fetch) flow through `bus`; intra-namespace
   calls like `Sim._renderToolbar()` stay direct.
   =========================================================== */
import { state, bus } from './state.js';
import { toast } from './utils.js';

/* ---------- RuntimeClient — REST + WS wrapper ---------- */
export const RuntimeClient = {
  baseURL: '',
  ws: null,
  _wsBackoff: 500,
  _onEvent: null,

  async _json(method, path, body) {
    const r = await fetch(this.baseURL + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || r.statusText);
    return j;
  },

  getTopology()          { return this._json('GET',  '/topology'); },
  loadTopology(yaml)     { return this._json('POST', '/topology', { yaml }); },
  resetTopology()        { return this._json('POST', '/topology/reset', {}); },
  start()                { return this._json('POST', '/sim/start', {}); },
  pause()                { return this._json('POST', '/sim/pause', {}); },
  resume(patch)          { return this._json('POST', '/sim/resume', { patch: patch || [] }); },
  stop()                 { return this._json('POST', '/sim/stop', {}); },
  getState()             { return this._json('GET',  '/sim/state'); },
  setProtocolConfig({ hello, refresh }) {
    return this._json('POST', '/sim/protocol_config', {
      hello_interval: hello,
      lsa_refresh_interval: refresh,
    });
  },
  deviceCommand(n, cmd)  { return this._json('POST', `/devices/${encodeURIComponent(n)}/command`, { cmd }); },
  deviceRoutes(n)        { return this._json('GET',  `/devices/${encodeURIComponent(n)}/routes`); },
  deviceInterfaces(n)    { return this._json('GET',  `/devices/${encodeURIComponent(n)}/interfaces`); },
  deviceNatTable(n)      { return this._json('GET',  `/devices/${encodeURIComponent(n)}/nat-table`); },

  connectEvents(onEvent) {
    this._onEvent = onEvent;
    this._openWs();
  },
  _openWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws/events`);
    this.ws.onmessage = (m) => { try { this._onEvent(JSON.parse(m.data)); } catch (e) {} };
    this.ws.onopen  = () => {
      this._wsBackoff = 500;
      setConnectionStatus(true);
      // The server may have restarted while the socket was down — its sim state
      // can diverge from the SPA's cached state. Re-sync so the toolbar is honest.
      if (Sim.refreshState) {
        Sim.refreshState().catch(() => {});
      }
    };
    this.ws.onclose = () => {
      setConnectionStatus(false);
      setTimeout(() => this._openWs(), this._wsBackoff);
      this._wsBackoff = Math.min(this._wsBackoff * 2, 8000);
    };
  },
  disconnectEvents() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
  },
};

export function setConnectionStatus(connected) {
  let b = document.getElementById('conn-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'conn-banner';
    b.className = 'conn-banner';
    document.body.appendChild(b);
  }
  b.textContent = connected ? '' : 'connection lost — retrying';
  b.style.display = connected ? 'none' : 'block';
}

/* ---------- topology lock + patch accumulator ---------- */
export function isTopologyLocked() {
  return Sim && Sim.state === 'running';
}

export function recordPatchOp(op) {
  if (Sim && Sim.state === 'paused') {
    Sim.patch.push(op);
    updatePatchIndicator();
  }
}

/* Returns true when `name` is the target of a pending add_<kind> op in the
 * current pause window — meaning the server hasn't seen this entity yet.
 * Live patch ops that reference such an entity (update_cost on a new
 * router's interface, set_gateway on a new host) must be skipped, because
 * the server validates the whole patch before applying any of it. Their
 * effect is carried instead by reconcilePatch, which rebuilds the
 * pending add_<kind> op with the latest state at Resume time. */
export function hasPendingAdd(kind, name) {
  if (!Sim || Sim.state !== 'paused') return false;
  const opKind = `add_${kind}`;
  return Sim.patch.some(op => op.op === opKind && op.name === name);
}

export function updatePatchIndicator() {
  const pause = document.getElementById('tb-pause');
  if (!pause) return;
  const lbl = pause.querySelector('.lbl');
  if (Sim.state === 'paused' && Sim.patch.length > 0) {
    lbl.textContent = `Resume (${Sim.patch.length} edits)`;
  } else if (Sim.state === 'paused') {
    lbl.textContent = 'Resume';
  }
}

/* ---------- patch reconciliation ----------
   Read-only transform: rewrites add_* ops so they carry the latest values from
   `state` (cidr, address, gateway, interface costs) and drops ops whose target
   was deleted before resume. Emits the right fabric key for hosts/router
   interfaces — `link` when attached to a point-to-point link, `network`
   otherwise.

   Ops are also topologically ordered before emission: fabric adds first
   (add_network / add_link), then device adds (add_host / add_router),
   then mutations (update_cost), then removes. The user's session can
   queue adds in any sequence (e.g. host before its fabric); the server's
   patch validator walks in order, so without this reorder the host op
   would fail with "network_not_found" / "link_not_found".

   Pure — does not mutate state. */
export function reconcilePatch(patch) {
  const rank = (op) => {
    if (op.op === 'add_network' || op.op === 'add_link') return 0;
    if (op.op === 'add_host' || op.op === 'add_router') return 1;
    if (op.op === 'update_cost') return 2;
    return 3;
  };
  const ordered = [...patch].sort((a, b) => rank(a) - rank(b));
  const out = [];
  for (const op of ordered) {
    if (op.op === 'add_network') {
      const net = state.networks[op.name];
      if (!net) continue;  // dropped before resume
      out.push({ op: 'add_network', name: op.name, address: net.cidr });
    } else if (op.op === 'add_link') {
      const lk = state.links[op.name];
      if (!lk) continue;
      out.push({ op: 'add_link', name: op.name, address: lk.cidr });
    } else if (op.op === 'add_host') {
      const host = state.hosts[op.name];
      if (!host) continue;
      const o = { op: 'add_host', name: op.name, address: host.address };
      if (host.link) o.link = host.link;
      else o.network = host.network;
      if (host.gateway) o.gateway = host.gateway;
      out.push(o);
    } else if (op.op === 'add_router') {
      const router = state.routers[op.name];
      if (!router) continue;
      const ifaces = Object.entries(router.interfaces || {}).map(([iname, iff]) => {
        const base = {
          name: iname,
          address: iff.address,
          cost: typeof iff.cost === 'number' ? iff.cost : (parseInt(iff.cost, 10) || 1),
        };
        if (iff.link) base.link = iff.link;
        else base.network = iff.network;
        return base;
      });
      out.push({ op: 'add_router', name: op.name, interfaces: ifaces });
    } else {
      out.push(op);  // remove_*, update_cost — pass through
    }
  }
  return out;
}

/* ---------- Sim — start/stop/pause/resume state machine ---------- */
export const Sim = {
  state: 'idle',
  patch: [],

  async refreshState() {
    const s = await RuntimeClient.getState();
    const prev = this.state;
    this.state = s.state;
    this._renderToolbar();
    if (this.state !== prev) {
      bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: this.state } }));
    }
  },

  _renderToolbar() {
    const play = document.getElementById('tb-play');
    const pause = document.getElementById('tb-pause');
    const reset = document.getElementById('tb-reset');
    const playLbl = play.querySelector('.lbl');
    const pauseIcon = pause.querySelector('.ico use');

    if (this.state === 'idle') {
      playLbl.textContent = 'Start'; play.classList.remove('running', 'paused');
      pause.hidden = true;
      reset.disabled = false;
    } else if (this.state === 'running') {
      playLbl.textContent = 'Stop'; play.classList.add('running'); play.classList.remove('paused');
      pause.hidden = false; pause.querySelector('.lbl').textContent = 'Pause';
      pause.setAttribute('title', 'Pause simulation (P)');
      if (pauseIcon) pauseIcon.setAttribute('href', '#ui-pause');
      reset.disabled = true;
    } else if (this.state === 'paused') {
      playLbl.textContent = 'Stop'; play.classList.add('paused'); play.classList.remove('running');
      pause.hidden = false; updatePatchIndicator();
      pause.setAttribute('title', 'Resume simulation (P)');
      if (pauseIcon) pauseIcon.setAttribute('href', '#ui-play');
      reset.disabled = true;
    }
    const lockable = ['tb-add-net', 'tb-add-host', 'tb-add-router'];
    lockable.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = (this.state === 'running');
    });
    const protocol = document.getElementById('tb-protocol');
    if (protocol) protocol.disabled = (this.state === 'idle');
  },

  async onPrimary() {
    try {
      if (this.state === 'idle') {
        // exportYaml/importYaml live in still-inline modules; bridge via bus
        // until Tasks 7+ extract them. Listeners write the result back into
        // event.detail.yaml.
        const req = new CustomEvent('sim:yaml-export-requested', { detail: {} });
        bus.dispatchEvent(req);
        const yaml = req.detail.yaml;
        await RuntimeClient.loadTopology(yaml);
        await RuntimeClient.start();
      } else {
        await RuntimeClient.stop();
        this.patch = [];
      }
    } catch (err) {
      toast(err.message || String(err), 'error', this.state === 'idle' ? 'Start' : 'Stop');
    } finally {
      await this.refreshState().catch(() => {});
    }
  },

  async onSecondary() {
    try {
      if (this.state === 'running') await RuntimeClient.pause();
      else if (this.state === 'paused') {
        const resolved = reconcilePatch(this.patch);
        await RuntimeClient.resume(resolved);
        this.patch = [];
        updatePatchIndicator();
      }
    } catch (err) {
      toast(err.message || String(err), 'error', this.state === 'paused' ? 'Resume' : 'Pause');
    } finally {
      await this.refreshState().catch(() => {});
    }
  },

  async onReset() {
    if (this.state !== 'idle') return;
    try {
      await RuntimeClient.resetTopology();
      const { yaml } = await RuntimeClient.getTopology();
      bus.dispatchEvent(new CustomEvent('sim:topology-import-requested', { detail: { yaml } }));
    } catch (err) {
      toast(err.message || String(err), 'error', 'Reset');
    }
  },
};

/* ---------- pending NAT-table updates ----------
   The simulator does NAT (and emits `nat` + `nat_table_changed`) microseconds
   after the sending host pushes the packet — about one animation-duration
   before the packet visually arrives at the NAT router. Applying the table
   change on receipt would make the inspector update one full hop early.
   We defer the update until a matching `sim:packet-arrived` fires, so the
   table mutation lines up with the visible arrival. */
const _pendingNATEntries = new Map();  // device -> entries (the deferred snapshot)
const _pendingNATPayload = new Map();  // device -> payload_id we are waiting for

export function _resetPendingNAT() {
  _pendingNATEntries.clear();
  _pendingNATPayload.clear();
}

function _applyNATTableChange(device, entries) {
  state.natTables[device] = entries;
  bus.dispatchEvent(new CustomEvent('sim:nat-table-changed', { detail: { device } }));
}

bus.addEventListener('sim:packet-arrived', (e) => {
  const detail = e.detail || {};
  const { payloadId, device } = detail;
  if (!device) return;
  if (_pendingNATPayload.get(device) !== payloadId) return;
  if (!_pendingNATEntries.has(device)) return;
  const entries = _pendingNATEntries.get(device);
  _pendingNATEntries.delete(device);
  _pendingNATPayload.delete(device);
  _applyNATTableChange(device, entries);
});

/* ---------- WS event router ----------
   Translates server WebSocket events into bus events so canvas.js,
   inspector.js, and packet-animation can subscribe without coupling to the
   transport. */
export function _onEvent(evt) {
  if (!evt || !evt.kind) return;
  if (evt.kind === 'sim_state') {
    const prev = Sim.state;
    Sim.state = evt.state;
    Sim._renderToolbar();
    if (Sim.state !== prev) {
      bus.dispatchEvent(new CustomEvent('sim:status-changed', { detail: { status: Sim.state } }));
    }
    // Discard any deferred NAT state on reset, otherwise a late
    // `sim:packet-arrived` from an in-flight tween would resurrect it.
    if (Sim.state === 'idle') _resetPendingNAT();
    return;
  }
  if (evt.kind === 'packet') {
    bus.dispatchEvent(new CustomEvent('sim:packet', { detail: evt }));
    return;
  }
  if (evt.kind === 'routing_table_changed') {
    bus.dispatchEvent(new CustomEvent('sim:routing-table-changed', { detail: { device: evt.device } }));
    return;
  }
  if (evt.kind === 'nat') {
    // Only outbound NAT changes the table. Arm the deferral now so a
    // subsequent `nat_table_changed` knows which packet animation to await.
    if (evt.direction === 'outbound' && evt.router && evt.payload_id) {
      _pendingNATPayload.set(evt.router, evt.payload_id);
    }
    bus.dispatchEvent(new CustomEvent('sim:nat', { detail: evt }));
    return;
  }
  if (evt.kind === 'nat_table_changed') {
    const entries = evt.entries || [];
    if (_pendingNATPayload.has(evt.device)) {
      _pendingNATEntries.set(evt.device, entries);
    } else {
      _applyNATTableChange(evt.device, entries);
    }
    return;
  }
  if (evt.kind === 'router_intercept') {
    // A router answered an ICMP echo addressed to one of its own IPs instead
    // of forwarding. Fired right before the matching reply packet, so
    // subscribers (packets.js) can cache by payload_id and decorate the
    // reply's tooltip.
    bus.dispatchEvent(new CustomEvent('sim:router-intercept', { detail: evt }));
    return;
  }
}
