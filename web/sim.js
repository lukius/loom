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
  setRefreshInterval(s)  { return this._json('POST', '/sim/refresh_interval', { seconds: s }); },
  deviceCommand(n, cmd)  { return this._json('POST', `/devices/${encodeURIComponent(n)}/command`, { cmd }); },
  deviceRoutes(n)        { return this._json('GET',  `/devices/${encodeURIComponent(n)}/routes`); },
  deviceInterfaces(n)    { return this._json('GET',  `/devices/${encodeURIComponent(n)}/interfaces`); },

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
   was deleted before resume. Pure — does not mutate state. */
export function reconcilePatch(patch) {
  const out = [];
  for (const op of patch) {
    if (op.op === 'add_network') {
      const net = state.networks[op.name];
      if (!net) continue;  // dropped before resume
      out.push({ op: 'add_network', name: op.name, address: net.cidr });
    } else if (op.op === 'add_host') {
      const host = state.hosts[op.name];
      if (!host) continue;
      const o = { op: 'add_host', name: op.name, network: host.network, address: host.address };
      if (host.gateway) o.gateway = host.gateway;
      out.push(o);
    } else if (op.op === 'add_router') {
      const router = state.routers[op.name];
      if (!router) continue;
      const ifaces = Object.entries(router.interfaces || {}).map(([iname, iff]) => ({
        name: iname,
        network: iff.network,
        address: iff.address,
        cost: typeof iff.cost === 'number' ? iff.cost : (parseInt(iff.cost, 10) || 1),
      }));
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
    const refresh = document.getElementById('tb-refresh');
    if (refresh) refresh.disabled = (this.state === 'idle');
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
    bus.dispatchEvent(new CustomEvent('sim:nat', { detail: evt }));
    return;
  }
  if (evt.kind === 'nat_table_changed') {
    state.natTables[evt.device] = evt.entries || [];
    bus.dispatchEvent(new CustomEvent('sim:nat-table-changed', { detail: { device: evt.device } }));
    return;
  }
}
