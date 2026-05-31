// web/inspector.js
// Right-pane inspector, left-pane nav, add/rename/duplicate/delete ops, and
// the canvas right-click context menu. Listens on the shared bus for topology
// and selection changes, and re-renders accordingly.
import { state, bus, markDirty, isDeviceHalted, isInterfaceDown } from './state.js';
import { escapeHtml, uniqueName, uniqueIface, pad2, toast, cssEscape, isValidIpv4, isValidNetworkCidr, addressInCidr } from './utils.js';
import {
  canvasEl, applyView, clientToWorld, fitView,
  renderCanvas, toggleNetworkOrientation, collectLinkEndpoints,
  startLinkWizard,
} from './canvas.js';
import { Sim, RuntimeClient, isTopologyLocked, recordPatchOp, hasPendingAdd } from './sim.js';

/* ---------- Inline validation helpers ---------- */

/**
 * Wire inline validation on an <input> + its sibling <span class="field-error">.
 * `validate(value) → { ok, reason }` is called on every `input` event and
 * also immediately (so an already-invalid stored value shows on open).
 *
 * Empty values (`'' | null | undefined`) are treated as "no feedback" — the
 * input is neither valid-styled nor invalid-styled, matching the draft-state
 * convention where an empty field is deliberately allowed.
 */
/**
 * Find the host / router-interface that owns `addr` on the given fabric,
 * excluding `selfRef` (the entity being edited, so its own current value
 * doesn't false-positive). Returns the label to show the user
 * (`<host>` or `<router>/<iface>`), or `''` if the address is free.
 *
 * Mirrors the server's `_address_owner` check at the patch-validator layer
 * (`src/server/state.py`) — the SPA surfaces the same rule inline so the
 * user catches the collision before Resume rejects it.
 */
function findAddressOwner(addr, fabricKind, fabricName, selfRef) {
  if (!fabricKind || !fabricName) return '';
  for (const [hname, h] of Object.entries(state.hosts)) {
    if (selfRef && selfRef.kind === 'host' && selfRef.name === hname) continue;
    const hf = fabricKind === 'link' ? h.link : h.network;
    if (hf === fabricName && h.address === addr) return hname;
  }
  for (const [rname, r] of Object.entries(state.routers)) {
    for (const [ifn, iff] of Object.entries(r.interfaces || {})) {
      if (selfRef && selfRef.kind === 'router' && selfRef.name === rname && selfRef.ifaceName === ifn) continue;
      const rf = fabricKind === 'link' ? iff.link : iff.network;
      if (rf === fabricName && iff.address === addr) return `${rname}/${ifn}`;
    }
  }
  return '';
}

function addressValidatorFor(fabricKind, fabricName, selfRef) {
  return (v) => {
    if (!isValidIpv4(v)) return { ok: false, reason: 'not a valid IPv4 address' };
    // Containment: an interface address only makes sense inside its fabric's
    // CIDR. Without this check, the user could attach a router to lan1 with an
    // address from a different subnet — neighbors would still flood the bogus
    // route via link-state, but no traffic could ever reach it.
    if (fabricName) {
      const fabric = (fabricKind === 'link' ? state.links : state.networks)[fabricName];
      if (fabric) {
        if (!fabric.cidr) {
          // Flagging an empty-CIDR fabric is the early-warning the user wants:
          // without it, the server's patch validator only catches the bad
          // address on Resume, which is much later.
          return { ok: false, reason: `${fabricName} has no CIDR set yet` };
        }
        if (!addressInCidr(v, fabric.cidr)) {
          return { ok: false, reason: `not in ${fabricName} (${fabric.cidr})` };
        }
      }
    }
    const owner = findAddressOwner(v, fabricKind, fabricName, selfRef);
    if (owner) return { ok: false, reason: `already used by ${owner}` };
    return { ok: true };
  };
}

function wireFieldValidation(input, errorEl, validateFn) {
  const update = (value) => {
    const v = (value ?? '').trim();
    if (!v) {
      input.classList.remove('invalid');
      errorEl.textContent = '';
      errorEl.classList.remove('show');
      return;
    }
    const result = validateFn(v);
    if (result.ok) {
      input.classList.remove('invalid');
      errorEl.textContent = '';
      errorEl.classList.remove('show');
    } else {
      input.classList.add('invalid');
      errorEl.textContent = result.reason;
      errorEl.classList.add('show');
    }
  };
  // Validate on every keystroke
  input.addEventListener('input', () => update(input.value));
  // Validate immediately on render (catches invalid stored values)
  update(input.value);
}

/* ---------- collapsible section helpers ----------
   Track which top-level sections are open across re-renders, mirroring the
   existing per-iface openIfaces pattern. Values: 'routing' | 'nat' | 'neighbors'. */
const openSections = new Set();

function rememberOpen(elI) {
  const opens = Array.from(elI.querySelectorAll('details.insp-section[open]'))
    .map(d => d.dataset.section);
  openSections.clear();
  for (const k of opens) openSections.add(k);
}

function isOpen(key, defaultOpen = false) {
  if (openSections.has(key)) return true;
  if (defaultOpen && openSections.size === 0) return true;
  return false;
}

function wireSectionToggles(root) {
  root.querySelectorAll('details.insp-section').forEach(d => {
    d.addEventListener('toggle', () => {
      if (d.open) openSections.add(d.dataset.section);
      else openSections.delete(d.dataset.section);
    });
  });
}

/* ---------- routing table section (synchronous placeholder) ---------- */
function renderRoutingSection(deviceName) {
  // Render an empty collapsible shell synchronously; refreshRoutes() fills in
  // the real rules once the async fetch completes.  The shell guarantees the
  // <details> exists at DOM insertion time so test queries and toggle-listeners
  // can attach immediately.
  const openAttr = isOpen('routing', true) ? ' open' : '';
  return `<details class="insp-section" data-section="routing"${openAttr}>` +
    `<summary>Routing table <span class="summary-hint">(loading…)</span></summary>` +
    `<div class="insp-section-body"><div class="hint">(loading…)</div></div>` +
    `</details>`;
}

/* ---------- neighbors section ---------- */
function _otherRouterOnFabric(thisDevice, ifaceObj) {
  // True iff some router OTHER than `thisDevice` has an interface attached
  // to the same network/link as `ifaceObj`. Used to distinguish a stub
  // interface (only router on the fabric — nothing to peer with, mirrors
  // real OSPF's empty neighbor table for such interfaces) from a real
  // DOWN adjacency (a peer is expected but no Hello has arrived).
  const fabricKey = ifaceObj && ifaceObj.network !== undefined ? 'network' : 'link';
  const fabricName = ifaceObj && ifaceObj[fabricKey];
  if (!fabricName) return false;
  for (const [rn, r] of Object.entries(state.routers || {})) {
    if (rn === thisDevice) continue;
    for (const other of Object.values(r.interfaces || {})) {
      if (other[fabricKey] === fabricName) return true;
    }
  }
  return false;
}

function renderNeighborSection(device, router) {
  const data = (state.neighborsByDevice && state.neighborsByDevice[device]) || {};
  const ifaceNames = Object.keys(router.interfaces || {});
  // peers = unique peer-router names; adjacencies = total per-interface
  // entries that *represent an expected adjacency*. Stub interfaces (no
  // other router on the fabric) don't count — there's nothing to peer
  // with, so listing them as DOWN would falsely imply something is wrong.
  const peerSet = new Set();
  const counts = { down: 0, init: 0, two_way: 0 };
  const ifaceBlocks = ifaceNames.map(iface => {
    const peers = data[iface] || {};
    const peerNames = Object.keys(peers);
    if (peerNames.length === 0) {
      const ifaceObj = (router.interfaces || {})[iface];
      const isStub = !_otherRouterOnFabric(device, ifaceObj);
      if (isStub) {
        return `<div class="neigh-iface-block"><div class="iface-name">${escapeHtml(iface)}</div>` +
          `<div class="neigh-row"><span class="peer">—</span>` +
          `<span class="neigh-state stub">no other routers</span></div></div>`;
      }
      counts.down += 1;
      return `<div class="neigh-iface-block"><div class="iface-name">${escapeHtml(iface)}</div>` +
        `<div class="neigh-row"><span class="peer">—</span>` +
        `<span class="neigh-state down">DOWN</span></div></div>`;
    }
    const rows = peerNames.map(peer => {
      const n = peers[peer];
      counts[n.state] = (counts[n.state] || 0) + 1;
      peerSet.add(peer);
      // TODO: replace 'recent' with a real "Ns ago" once clock sync is available.
      const ago = n.last_hello_at != null ? 'last hello recent' : '';
      const stateClass = n.state || 'down';
      const stateLabel = (n.state || 'down').toUpperCase();
      return `<div class="neigh-row">` +
        `<span class="peer">${escapeHtml(peer)}</span>` +
        `<span class="neigh-state ${stateClass}">${stateLabel}</span>` +
        `<span class="timing">${ago}</span>` +
        `</div>`;
    }).join('');
    return `<div class="neigh-iface-block">` +
      `<div class="iface-name">${escapeHtml(iface)}</div>` +
      `${rows}` +
      `</div>`;
  }).join('');
  const peerCount = peerSet.size;
  const adjCount = counts.two_way + counts.init + counts.down;
  const peerWord = peerCount === 1 ? 'peer' : 'peers';
  const adjWord = adjCount === 1 ? 'adjacency' : 'adjacencies';
  // Zero state counts are omitted so the hint stays on one row in the common
  // (fully-converged) case. The full TWO_WAY/INIT/DOWN breakdown only shows
  // up when there's actually something to report.
  const stateParts = [];
  if (counts.two_way) stateParts.push(`${counts.two_way} TWO_WAY`);
  if (counts.init)    stateParts.push(`${counts.init} INIT`);
  if (counts.down)    stateParts.push(`${counts.down} DOWN`);
  const stateSuffix = stateParts.length ? ` · ${stateParts.join(' · ')}` : '';
  const hint = `(${peerCount} ${peerWord} · ${adjCount} ${adjWord}${stateSuffix})`;
  const openAttr = isOpen('neighbors') ? ' open' : '';
  return `<details class="insp-section" data-section="neighbors"${openAttr}>` +
    `<summary>Neighbors <span class="summary-hint">${hint}</span></summary>` +
    `<div class="insp-section-body neigh-list">${ifaceBlocks}</div>` +
    `</details>`;
}

/* ---------- Inspector ---------- */
export const Inspector = {
  async refreshRoutes(deviceName) {
    const sec = document.getElementById('insp-routes');
    if (!sec) return;
    // Hosts don't have a routing table; hide the section entirely.
    if (state.hosts && state.hosts[deviceName]) { sec.hidden = true; return; }
    if (!deviceName) { sec.hidden = true; return; }
    if (Sim.state === 'idle') {
      // Sim idle: routing table data not available. Leave the static placeholder
      // visible for routers (the section renders synchronously in the inspector
      // HTML) but update the hint so the user knows why it looks empty.
      const hint = sec.querySelector('.summary-hint');
      if (hint) hint.textContent = '(sim not running)';
      return;
    }
    try {
      const r = await RuntimeClient.deviceRoutes(deviceName);
      const rules = r.rules || [];
      const ruleCount = rules.length;
      const rows = rules.map(x =>
        `<tr><td>${escapeHtml(x.prefix)}</td><td>${escapeHtml(x.next_hop)}</td><td>${escapeHtml(x.iface)}</td></tr>`
      ).join('');
      const tableHtml = rows
        ? `<table class="insp-table"><thead><tr><th>Prefix</th><th>Next hop</th><th>Iface</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="hint">(empty)</div>';
      // Update the <details> content in place, preserving open/closed state.
      let details = sec.querySelector('details.insp-section[data-section="routing"]');
      if (!details) {
        const openAttr = isOpen('routing', true) ? ' open' : '';
        sec.innerHTML = `<details class="insp-section" data-section="routing"${openAttr}>` +
          `<summary>Routing table <span class="summary-hint"></span></summary>` +
          `<div class="insp-section-body"></div>` +
          `</details>`;
        details = sec.querySelector('details.insp-section');
        wireSectionToggles(sec);
      }
      const hint = details.querySelector('.summary-hint');
      if (hint) hint.textContent = `(${ruleCount} ${ruleCount === 1 ? 'rule' : 'rules'})`;
      const body = details.querySelector('.insp-section-body');
      if (body) body.innerHTML = tableHtml;
    } catch (_e) {
      // Server not reachable or device not found — leave the placeholder.
    }
  },

  onRouteChange(evt) {
    if (state && state.selection && state.selection.name === evt.device) {
      this.refreshRoutes(evt.device);
    }
  },

  async refreshNAT(deviceName) {
    const sec = document.getElementById('insp-nat');
    if (!sec) return;
    if (Sim.state === 'idle' || !deviceName) { sec.hidden = true; return; }
    // Hosts don't have a NAT table.
    if (state.hosts && state.hosts[deviceName]) { sec.hidden = true; return; }
    // Prime from the server on cold start. Events on the bus only carry
    // *changes*, so a fresh subscriber (page reload, late inspector mount)
    // would see an empty panel until the next translation. Once primed,
    // subsequent updates ride the `sim:nat-table-changed` event stream,
    // so we never re-fetch (avoids races where a stale fetch overwrites
    // a newer event-driven update).
    if (state.natTables[deviceName] === undefined) {
      try {
        const r = await RuntimeClient.deviceNatTable(deviceName);
        state.natTables[deviceName] = r.entries || [];
      } catch (e) {
        state.natTables[deviceName] = [];
      }
    }
    const entries = state.natTables[deviceName] || [];
    if (!entries.length) { sec.hidden = true; return; }
    sec.hidden = false;
    const rows = entries.map(e => {
      // Conversation-keyed flow_ids are UUIDs (~36 chars). Show a short
      // prefix so the column stays single-line at the default pane width;
      // keep the full id available on hover via `title`.
      let fidCell;
      if (e.flow_id === null || e.flow_id === undefined) {
        fidCell = '<td>—</td>';
      } else {
        const s = String(e.flow_id);
        const short = s.length > 10 ? s.slice(0, 8) + '…' : s;
        fidCell = `<td title="${escapeHtml(s)}">${escapeHtml(short)}</td>`;
      }
      return `<tr><td>${escapeHtml(e.original_src)}</td><td>${escapeHtml(e.rewritten_src)}</td><td>${escapeHtml(e.dst)}</td>${fidCell}</tr>`;
    }).join('');
    const openAttr = isOpen('nat') ? ' open' : '';
    sec.innerHTML = `<details class="insp-section" data-section="nat"${openAttr}>` +
      `<summary>NAT table <span class="summary-hint">(${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})</span></summary>` +
      `<div class="insp-section-body">` +
      `<table class="insp-table"><thead><tr><th>Original</th><th>Rewritten</th><th>Destination</th><th>Flow ID</th></tr></thead><tbody>${rows}</tbody></table>` +
      `</div></details>`;
    wireSectionToggles(sec);
  },

  onNATChange(evt) {
    if (state && state.selection && state.selection.name === evt.device) {
      this.refreshNAT(evt.device);
    }
  },
};

/* ---------- context menu ---------- */
let _ctxEl = null;
export function closeContextMenu() {
  if (_ctxEl) { _ctxEl.remove(); _ctxEl = null; }
}

export function openContextMenu(clientX, clientY, target, world) {
  closeContextMenu();
  const m = document.createElement('div');
  m.className = 'ctx';
  let html = '';
  const locked = isTopologyLocked();
  const mut = (a) => `data-act="${a}" ${locked ? 'disabled aria-disabled="true"' : ''}`;

  if (!target) {
    // empty canvas
    html += `
      <div class="ctx-head">Create at this point</div>
      <button class="ctx-item" ${mut('new-net')}><svg class="ico"><use href="#ui-net"/></svg>New LAN<span class="meta">N</span></button>
      <button class="ctx-item" ${mut('new-host')}><svg class="ico"><use href="#ui-host"/></svg>New host<span class="meta">H</span></button>
      <button class="ctx-item" ${mut('new-router')}><svg class="ico"><use href="#ui-router"/></svg>New router<span class="meta">R</span></button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="fit">Fit to view</button>
      <button class="ctx-item" ${mut('import')}>Import topology…</button>
    `;
  } else {
    html += `<div class="ctx-head">${escapeHtml(target.kind)} · ${escapeHtml(target.name)}</div>`;
    html += `<button class="ctx-item" ${mut('edit')}><svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 12h2l7-7-2-2-7 7v2zM9 3l2 2"/></svg>Edit<span class="meta">2×</span></button>`;
    if (target.kind === 'network') {
      html += `<button class="ctx-item" ${mut('add-host-here')}><svg class="ico"><use href="#ui-host"/></svg>Add host here</button>`;
      html += `<button class="ctx-item" ${mut('add-router-here')}><svg class="ico"><use href="#ui-router"/></svg>Add router here</button>`;
    }
    if (target.kind === 'host' || target.kind === 'router') {
      html += `<button class="ctx-item" ${mut('new-p2p-link')}><svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 7h8M9 4l3 3-3 3"/></svg>New p2p link…</button>`;
    }
    if (target.kind === 'host') {
      const obj = state.hosts[target.name];
      const opts = Object.keys(state.networks).filter(n => n !== (obj && obj.network));
      if (opts.length) {
        html += `<div class="ctx-sub${locked ? ' disabled' : ''}">
          <button class="ctx-item" data-act="" ${locked ? 'disabled aria-disabled="true"' : ''}>Move to LAN…</button>
          <div class="ctx-panel">
            ${opts.map(n => `<button class="ctx-item" ${mut('move-host')} data-net="${escapeHtml(n)}"><svg class="ico"><use href="#ui-net"/></svg>${escapeHtml(n)}</button>`).join('')}
          </div>
        </div>`;
      }
      if (obj && obj.network) {
        html += `<button class="ctx-item" ${mut('detach-host')}><svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 7h8M5 4l-2 3 2 3M9 4l2 3-2 3"/></svg>Detach from LAN</button>`;
      }
    }
    if (target.kind === 'router') {
      const obj = state.routers[target.name];
      // submenu: connect to LAN
      const used = new Set(Object.values((obj && obj.interfaces) || {}).map(i => i.network));
      const unused = Object.keys(state.networks).filter(n => !used.has(n));
      if (unused.length) {
        html += `<div class="ctx-sub${locked ? ' disabled' : ''}">
          <button class="ctx-item" data-act="" ${locked ? 'disabled aria-disabled="true"' : ''}>Connect to LAN…</button>
          <div class="ctx-panel">
            ${unused.map(n => `<button class="ctx-item" ${mut('connect-router')} data-net="${escapeHtml(n)}"><svg class="ico"><use href="#ui-net"/></svg>${escapeHtml(n)}</button>`).join('')}
          </div>
        </div>`;
      }
      if (locked) {
        html += `<div class="ctx-sep"></div>`;
        if (isDeviceHalted(target.name)) {
          html += `<button class="ctx-item" data-act="router-resume">Resume router</button>`;
        } else {
          html += `<button class="ctx-item" data-act="router-halt">Halt router (graceful)</button>`;
          html += `<button class="ctx-item danger" data-act="router-crash">Crash router</button>`;
        }
      }
    }
    // p2p link context menu — no "Add endpoint" (schema requires exactly 2)
    html += `
      <div class="ctx-sep"></div>
      <button class="ctx-item" ${mut('duplicate')}><svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="4" y="4" width="8" height="8" rx="1"/></svg>Duplicate</button>
      <button class="ctx-item danger" ${mut('delete')}><svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4h8M5 4V2.5h4V4M4.5 4l.5 7h4l.5-7"/></svg>Delete<span class="meta">⌫</span></button>
    `;
  }

  m.innerHTML = html;
  document.body.appendChild(m);
  _ctxEl = m;

  // position (clamp to viewport)
  m.style.left = '0px';
  m.style.top = '0px';
  const r = m.getBoundingClientRect();
  let x = clientX, y = clientY;
  if (x + r.width  > window.innerWidth)  x = window.innerWidth  - r.width  - 6;
  if (y + r.height > window.innerHeight) y = window.innerHeight - r.height - 6;
  m.style.left = x + 'px';
  m.style.top  = y + 'px';

  // wire actions
  m.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (!act) return; // submenu opener
    const net = btn.getAttribute('data-net');
    handleCtxAction(act, target, world, net);
    closeContextMenu();
  });
}

export function handleCtxAction(act, target, world, arg) {
  const showErr = (err) => toast(err.message || String(err), 'error');
  if (act === 'router-halt') {
    RuntimeClient.deviceCommand(target.name, 'halt').catch(showErr);
    return;
  } else if (act === 'router-resume') {
    RuntimeClient.deviceCommand(target.name, 'resume').catch(showErr);
    return;
  } else if (act === 'router-crash') {
    RuntimeClient.fail(target.name).catch(showErr);
    return;
  }
  if (isTopologyLocked()) return;
  switch (act) {
    case 'new-net':    addNew('network', world); break;
    case 'new-host':   addNew('host', world); break;
    case 'new-router': addNew('router', world); break;
    case 'fit':        fitView(); break;
    case 'import':     bus.dispatchEvent(new CustomEvent('ui:import-requested')); break;
    case 'edit':
      state.selection = { kind: target.kind, name: target.name };
      bus.dispatchEvent(new CustomEvent('state:topology-changed'));
      const f = document.getElementById('inspector').querySelector('input, select');
      if (f) f.focus();
      break;
    case 'add-host-here': {
      const net = state.networks[target.name];
      const name = uniqueName('h', state.hosts);
      state.hosts[name] = { network: target.name, address: '', x: net.x - 280, y: net.y };
      state.selection = { kind:'host', name };
      recordPatchOp({ op: 'add_host', name, network: target.name, address: '' });
      markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
      break;
    }
    case 'add-router-here': {
      const net = state.networks[target.name];
      const name = uniqueName('r', state.routers);
      state.routers[name] = {
        x: net.x + 280, y: net.y,
        interfaces: { eth0: { network: target.name, address: '', cost: 10 } },
      };
      state.selection = { kind:'router', name };
      recordPatchOp({ op: 'add_router', name, interfaces: [] });
      markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
      break;
    }
    case 'move-host': {
      state.hosts[target.name].network = arg;
      toast(`Moved ${target.name} → ${arg}`, 'ok');
      markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
      break;
    }
    case 'detach-host': {
      state.hosts[target.name].network = '';
      toast(`Detached ${target.name}`, 'ok');
      markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
      break;
    }
    case 'connect-router': {
      const r = state.routers[target.name];
      const newIf = uniqueIface(r.interfaces);
      r.interfaces[newIf] = { network: arg, address: '', cost: 10 };
      toast(`Added ${newIf} on ${target.name} → ${arg}`, 'ok');
      markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
      break;
    }
    case 'new-p2p-link':
      startLinkWizard({ kind: target.kind, name: target.name });
      break;
    case 'duplicate':
      if (target.kind === 'network') duplicateNetwork(target.name);
      else if (target.kind === 'host') duplicateHost(target.name);
      else if (target.kind === 'router') duplicateRouter(target.name);
      else if (target.kind === 'link') duplicateLink(target.name);
      break;
    case 'delete':
      state.selection = { kind: target.kind, name: target.name };
      deleteSelected();
      break;
  }
}

/* ---------- nav ---------- */
export function renderNav() {
  const elN = document.getElementById('nav');
  const sections = [
    { kind: 'network', title: 'LANs',    items: state.networks, glyph: 'ui-net',
      meta: (k, v) => v.cidr || '—' },
    { kind: 'link',    title: 'Links',   items: state.links,    glyph: 'ui-link',
      meta: (k, v) => v.cidr || '—' },
    { kind: 'host',    title: 'Hosts',    items: state.hosts,    glyph: 'ui-host',
      meta: (k, v) => v.address || '—' },
    { kind: 'router',  title: 'Routers',  items: state.routers,  glyph: 'ui-router',
      meta: (k, v) => `${Object.keys(v.interfaces || {}).length} ifaces` },
  ];
  elN.innerHTML = sections.map(sec => {
    const keys = Object.keys(sec.items);
    return `
      <div class="nav-section">
        <div class="nav-shead">
          <div class="left">
            <span class="ttl">${escapeHtml(sec.title)}</span>
            <span class="count">${pad2(keys.length)}</span>
          </div>
          <button class="add" data-add="${sec.kind}" aria-label="Add ${sec.title}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
          </button>
        </div>
        <div class="nav-list">
          ${keys.length === 0
            ? `<div class="nav-empty">No ${escapeHtml(sec.title.toLowerCase())} yet · press <kbd>+</kbd></div>`
            : keys.map(k => {
                const sel = state.selection && state.selection.kind === sec.kind && state.selection.name === k;
                return `
                  <div class="nav-row ${sel ? 'selected' : ''}" data-pick='${escapeHtml(JSON.stringify({kind: sec.kind, name: k}))}'>
                    <span class="glyph ${sec.kind}"><svg viewBox="0 0 14 14"><use href="#${sec.glyph}"/></svg></span>
                    <span class="name">${escapeHtml(k)}</span>
                    <span class="meta">${escapeHtml(sec.meta(k, sec.items[k]))}</span>
                  </div>
                `;
              }).join('')
          }
        </div>
      </div>
    `;
  }).join('');

  elN.querySelectorAll('[data-pick]').forEach(row => {
    row.addEventListener('click', () => {
      try {
        state.selection = JSON.parse(row.getAttribute('data-pick'));
        bus.dispatchEvent(new CustomEvent('state:selection-changed'));
        centerOnSelection();
      } catch (_) {}
    });
  });
  elN.querySelectorAll('[data-add]').forEach(b => {
    b.addEventListener('click', e => { e.stopPropagation(); addNew(b.getAttribute('data-add')); });
  });
}

export function centerOnSelection() {
  if (!state.selection) return;
  const { kind, name } = state.selection;
  const obj = ({network: state.networks, host: state.hosts, router: state.routers, link: state.links})[kind]?.[name];
  if (!obj) return;
  const svg = canvasEl();
  const rect = svg.getBoundingClientRect();
  state.view.x = rect.width / 2 - obj.x * state.view.k;
  state.view.y = rect.height / 2 - obj.y * state.view.k;
  applyView();
}

/* ---------- inspector (mostly unchanged) ---------- */
export function renderInspector() {
  const elI = document.getElementById('inspector');
  if (!state.selection) {
    elI.innerHTML = `
      <div class="insp-empty">
        <div class="icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 9h6v6H9z"/>
            <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>
          </svg>
        </div>
        <div class="ttl">Nothing selected</div>
        <div class="sub">Click any node to select. Double-click to edit, drag onto a LAN to attach.</div>
      </div>
    `;
    return;
  }
  const { kind, name } = state.selection;
  if (kind === 'network') return renderNetworkInsp(name, elI);
  if (kind === 'link')    return renderLinkInsp(name, elI);
  if (kind === 'host')    return renderHostInsp(name, elI);
  if (kind === 'router')  return renderRouterInsp(name, elI);
}

export function renderNetworkInsp(name, elI) {
  const net = state.networks[name];
  if (!net) { state.selection = null; return renderInspector(); }
  elI.innerHTML = `
    <div class="insp-head">
      <div class="pre"><span class="pill network">LAN</span></div>
      <div class="name">${escapeHtml(name)}</div>
    </div>
    <div class="insp-body">
      <div class="field">
        <label>Identifier</label>
        <input id="f-name" value="${escapeHtml(name)}" spellcheck="false" />
        <div class="hint">Used as the YAML key.</div>
      </div>
      <div class="field">
        <label>CIDR</label>
        <input id="f-cidr" value="${escapeHtml(net.cidr || '')}" spellcheck="false" placeholder="192.168.0.0/24" />
        <span class="field-error" id="f-cidr-err"></span>
        <div class="hint">Network address with prefix length.</div>
      </div>
      <div class="field">
        <label>Orientation</label>
        <button id="f-rotate" class="btn-sec" type="button">Rotate to ${(net.orientation ?? 'h') === 'v' ? 'horizontal' : 'vertical'}</button>
        <div class="hint">Flip the rail between horizontal and vertical.</div>
      </div>
    </div>
    <div class="insp-foot">
      <button class="dup" id="f-dup">Duplicate</button>
      <button class="del" id="f-del">Delete</button>
    </div>
  `;
  elI.querySelector('#f-name').addEventListener('change', e => renameNetwork(name, e.target.value.trim()));
  elI.querySelector('#f-cidr').addEventListener('input', e => {
    if (isTopologyLocked()) return;
    state.networks[name].cidr = e.target.value.trim();
    markDirty(); renderCanvas(); renderNav();
  });
  wireFieldValidation(
    elI.querySelector('#f-cidr'),
    elI.querySelector('#f-cidr-err'),
    v => isValidNetworkCidr(v, { allowMaskMin: 0, allowMaskMax: 32 }),
  );
  elI.querySelector('#f-rotate').addEventListener('click', () => {
    if (isTopologyLocked()) return;
    toggleNetworkOrientation(name);
  });
  elI.querySelector('#f-del').addEventListener('click', deleteSelected);
  elI.querySelector('#f-dup').addEventListener('click', () => duplicateNetwork(name));
}

export function renderLinkInsp(name, elI) {
  const link = state.links[name];
  if (!link) { state.selection = null; return renderInspector(); }
  const endpoints = collectLinkEndpoints(name);
  const epHtml = endpoints.length === 0
    ? '<div class="hint">— no endpoints attached</div>'
    : endpoints.map(ep => {
        if (ep.deviceKind === 'host') {
          const h = state.hosts[ep.device] || {};
          return `<div class="ep-row"><span class="pill">${escapeHtml(ep.device)}</span> <span class="meta">${escapeHtml(h.address || '—')}</span></div>`;
        }
        return `<div class="ep-row"><span class="pill">${escapeHtml(ep.device)}</span> · <span class="meta">${escapeHtml(ep.iface || '—')}</span> · <span class="meta">${escapeHtml((state.routers[ep.device]?.interfaces?.[ep.iface])?.address || '—')}</span></div>`;
      }).join('');
  elI.innerHTML = `
    <div class="insp-head">
      <div class="pre"><span class="pill link">link</span></div>
      <div class="name">${escapeHtml(name)}</div>
    </div>
    <div class="insp-body">
      <div class="field">
        <label>Identifier</label>
        <input id="f-name" value="${escapeHtml(name)}" spellcheck="false" />
        <div class="hint">Used as the YAML key.</div>
      </div>
      <div class="field">
        <label>CIDR</label>
        <input id="f-cidr" value="${escapeHtml(link.cidr || '')}" spellcheck="false" placeholder="10.0.0.0/30" />
        <span class="field-error" id="f-cidr-err"></span>
        <div class="hint">Must be /30 or /31. Changing width may invalidate already-set endpoint addresses.</div>
      </div>
      <div class="field">
        <label>Endpoints</label>
        <div class="ep-list">${epHtml}</div>
      </div>
    </div>
    <div class="insp-foot">
      <button class="dup" id="f-dup">Duplicate</button>
      <button class="del" id="f-del">Delete</button>
    </div>
  `;
  elI.querySelector('#f-name').addEventListener('change', e => renameLink(name, e.target.value.trim()));
  elI.querySelector('#f-cidr').addEventListener('input', e => {
    if (isTopologyLocked()) return;
    state.links[name].cidr = e.target.value.trim();
    markDirty(); renderCanvas(); renderNav();
  });
  wireFieldValidation(
    elI.querySelector('#f-cidr'),
    elI.querySelector('#f-cidr-err'),
    v => isValidNetworkCidr(v, { allowMaskMin: 30, allowMaskMax: 31 }),
  );
  elI.querySelector('#f-del').addEventListener('click', deleteSelected);
  elI.querySelector('#f-dup').addEventListener('click', () => duplicateLink(name));
}

export function renderHostInsp(name, elI) {
  const host = state.hosts[name];
  if (!host) { state.selection = null; return renderInspector(); }
  // Determine current fabric type: link or network (default to network for legacy entries)
  const fabricType = host.link !== undefined ? 'link' : 'network';
  const netOpts = Object.keys(state.networks)
    .map(n => `<option value="${escapeHtml(n)}" ${fabricType==='network'&&host.network===n?'selected':''}>${escapeHtml(n)}</option>`).join('');
  const linkOpts = Object.keys(state.links)
    .map(l => `<option value="${escapeHtml(l)}" ${fabricType==='link'&&host.link===l?'selected':''}>${escapeHtml(l)}</option>`).join('');
  const fabricNameOpts = fabricType === 'link'
    ? (linkOpts ? '<option value="">— unattached</option>' + linkOpts : '<option value="">(no links)</option>')
    : (netOpts  ? '<option value="">— unattached</option>' + netOpts  : '<option value="">(no networks)</option>');
  const gwHidden = fabricType === 'link';
  // Gateway dropdown: list every router-interface IP attached to the host's
  // fabric. Picking a known peer beats free-text typos. A "stale" entry
  // preserves a previously-set gateway whose router was since removed so
  // the user can see and replace it.
  const peerOpts = [];
  if (fabricType === 'network' && host.network) {
    for (const [rn, r] of Object.entries(state.routers)) {
      for (const [ifn, iff] of Object.entries(r.interfaces || {})) {
        if (iff.network === host.network && iff.address) {
          peerOpts.push({ ip: iff.address, label: `${rn}/${ifn} · ${iff.address}` });
        }
      }
    }
  }
  let gwOptions = '<option value="">— none</option>';
  for (const p of peerOpts) {
    const sel = host.gateway === p.ip ? 'selected' : '';
    gwOptions += `<option value="${escapeHtml(p.ip)}" ${sel}>${escapeHtml(p.label)}</option>`;
  }
  if (host.gateway && !peerOpts.some(p => p.ip === host.gateway)) {
    gwOptions += `<option value="${escapeHtml(host.gateway)}" selected>${escapeHtml(host.gateway)} · no peer</option>`;
  }
  elI.innerHTML = `
    <div class="insp-head">
      <div class="pre"><span class="pill host">host</span></div>
      <div class="name">${escapeHtml(name)}</div>
    </div>
    <div class="insp-body">
      <div class="field">
        <label>Hostname</label>
        <input id="f-name" value="${escapeHtml(name)}" spellcheck="false" />
      </div>
      <div class="field">
        <label>Fabric type</label>
        <select id="f-fabric-type">
          <option value="network" ${fabricType==='network'?'selected':''}>Network</option>
          <option value="link"    ${fabricType==='link'   ?'selected':''}>Link</option>
        </select>
      </div>
      <div class="field">
        <label id="f-fabric-label">${fabricType === 'link' ? 'Link' : 'Network'}</label>
        <div class="fabric-name-row">
          <select id="f-fabric-name">${fabricNameOpts}</select>
          ${fabricType === 'link' ? '<button id="f-new-link" type="button" class="btn-sec">+ New link</button>' : ''}
        </div>
        <div class="hint">${fabricType === 'link' ? 'Point-to-point link. Use "+ New link" to create a fresh one and attach this host to it.' : 'Pin a host to a LAN by dragging it on the canvas.'}</div>
      </div>
      <div class="field">
        <label>IP address</label>
        <input id="f-addr" value="${escapeHtml(host.address || '')}" spellcheck="false" placeholder="192.168.0.10" />
        <span class="field-error" id="f-addr-err"></span>
      </div>
      ${gwHidden ? '' : `<div class="field" id="f-gw-field">
        <label>Default gateway</label>
        <select id="f-gw">${gwOptions}</select>
        <div class="hint">Pick a router on this LAN. Empty leaves the host without a default route.</div>
      </div>`}
    </div>
    <div class="insp-routes" id="insp-routes" hidden></div>
    <div class="insp-foot">
      <button class="dup" id="f-dup">Duplicate</button>
      <button class="del" id="f-del">Delete</button>
    </div>
  `;
  elI.querySelector('#f-name').addEventListener('change', e => renameHost(name, e.target.value.trim()));
  // When the fabric type changes, update state and re-render
  elI.querySelector('#f-fabric-type').addEventListener('change', e => {
    if (isTopologyLocked()) return;
    const newType = e.target.value;
    const h = state.hosts[name];
    if (newType === 'link') {
      // Default to unattached so we don't silently inject this host as a third
      // endpoint on an existing /30 — the user must pick a link explicitly.
      h.link = '';
      delete h.network;
      // Gateways carried over from a network attachment can't possibly match
      // the new link's peer (the parser enforces gateway == peer IP), so they
      // become stale data. Drop them on the way to a link.
      delete h.gateway;
    } else {
      const firstNet = Object.keys(state.networks)[0] || '';
      h.network = firstNet;
      delete h.link;
    }
    markDirty(); renderInspector(); renderCanvas(); renderNav();
  });
  elI.querySelector('#f-fabric-name').addEventListener('change', e => {
    if (isTopologyLocked()) return;
    const h = state.hosts[name];
    const curType = elI.querySelector('#f-fabric-type').value;
    if (curType === 'link') {
      h.link = e.target.value;
      delete h.network;
    } else {
      h.network = e.target.value;
      delete h.link;
    }
    // Re-render so the address validator re-wires against the new fabric's
    // CIDR; otherwise the closure keeps pointing at the previous fabric.
    markDirty(); renderInspector(); renderCanvas(); renderNav();
  });
  const newLinkBtn = elI.querySelector('#f-new-link');
  if (newLinkBtn) {
    newLinkBtn.addEventListener('click', () => {
      if (isTopologyLocked()) return;
      const linkName = uniqueName('p2p', state.links);
      const h = state.hosts[name];
      state.links[linkName] = {
        cidr: '',
        x: (h.x ?? 600) + 80,
        y: (h.y ?? 400),
      };
      h.link = linkName;
      delete h.network;
      markDirty();
      renderInspector();
      renderCanvas();
      renderNav();
      toast(`Created ${linkName} and attached ${name}`, 'ok', 'new link');
    });
  }
  elI.querySelector('#f-addr').addEventListener('input', e => {
    if (isTopologyLocked()) return;
    state.hosts[name].address = e.target.value.trim();
    markDirty(); renderCanvas(); renderNav();
  });
  wireFieldValidation(
    elI.querySelector('#f-addr'),
    elI.querySelector('#f-addr-err'),
    addressValidatorFor(fabricType, host[fabricType], { kind: 'host', name }),
  );
  const gwInp = elI.querySelector('#f-gw');
  if (gwInp) {
    gwInp.addEventListener('change', async (e) => {
      const v = e.target.value.trim();
      // A host added during the current pause window doesn't exist on the
      // server yet (its add_host is still in Sim.patch). Skip the live shell
      // command in that case — reconcilePatch will fold the latest gateway
      // into the add_host op on Resume.
      const isPendingAdd = hasPendingAdd('host', name);
      // While the sim is running, push the new gateway live so routes update immediately.
      if (!isPendingAdd && (Sim.state === 'running' || Sim.state === 'paused')) {
        if (!v) {
          toast('Clearing the gateway requires stopping the simulation', 'info', 'Gateway');
          e.target.value = state.hosts[name].gateway || '';
          return;
        }
        try {
          const r = await RuntimeClient.deviceCommand(name, `set_gateway ${v}`);
          if (!r.ok) {
            toast(r.output, 'error', 'Gateway');
            e.target.value = state.hosts[name].gateway || '';
            return;
          }
        } catch (err) {
          toast(err.message || String(err), 'error', 'Gateway');
          e.target.value = state.hosts[name].gateway || '';
          return;
        }
      }
      if (v) state.hosts[name].gateway = v;
      else delete state.hosts[name].gateway;
      markDirty();
    });
  }
  elI.querySelector('#f-del').addEventListener('click', deleteSelected);
  elI.querySelector('#f-dup').addEventListener('click', () => duplicateHost(name));
  Inspector.refreshRoutes(name);
}

export function renderRouterInsp(name, elI) {
  const router = state.routers[name];
  if (!router) { state.selection = null; return renderInspector(); }
  const ifaces = Object.entries(router.interfaces || {});
  // Snapshot which iface <details> are currently expanded and which top-level
  // sections are open before we blow away the inspector innerHTML; we
  // re-apply open state below so the user doesn't lose their context.
  rememberOpen(elI);
  const openIfaces = new Set(
    Array.from(elI.querySelectorAll('details.iface[open]'))
      .map(d => d.getAttribute('data-iface')),
  );
  // Build fabric-type-aware option lists for a given interface
  const netOptsFor = (sel) => {
    const opts = Object.keys(state.networks)
      .map(n => `<option value="${escapeHtml(n)}" ${sel===n?'selected':''}>${escapeHtml(n)}</option>`).join('');
    return opts ? '<option value="">— none</option>' + opts : '<option value="">(no networks)</option>';
  };
  const linkOptsFor = (sel) => {
    const opts = Object.keys(state.links)
      .map(l => `<option value="${escapeHtml(l)}" ${sel===l?'selected':''}>${escapeHtml(l)}</option>`).join('');
    return opts ? '<option value="">— none</option>' + opts : '<option value="">(no links)</option>';
  };
  elI.innerHTML = `
    <div class="insp-head">
      <div class="pre"><span class="pill router">router</span> <span style="color:var(--text-3);">· ${ifaces.length} ${ifaces.length===1?'interface':'interfaces'}</span></div>
      <div class="name">${escapeHtml(name)}</div>
    </div>
    <div class="insp-body">
      <div class="field">
        <label>Identifier</label>
        <input id="f-name" value="${escapeHtml(name)}" spellcheck="false" />
      </div>
      <div class="field">
        <label>Interfaces</label>
        <div class="iflist">
          ${ifaces.map(([ifn, ifc]) => {
            // Determine current fabric type for this interface
            const ifFabric = ifc.link !== undefined ? 'link' : 'network';
            const fabricSummary = escapeHtml(ifc[ifFabric] || '—');
            const fabricNameOpts = ifFabric === 'link' ? linkOptsFor(ifc.link) : netOptsFor(ifc.network);
            const openAttr = openIfaces.has(ifn) ? ' open' : '';
            return `
            <details class="iface" data-iface="${escapeHtml(ifn)}"${openAttr}>
              <summary class="ihead">
                <span class="ttl">
                  <span class="pill">${escapeHtml(ifn)}</span>
                  <span class="iface-summary">${fabricSummary} · ${escapeHtml(ifc.address || 'no ip')}</span>
                </span>
                <button class="del" data-del-iface="${escapeHtml(ifn)}" title="Remove">
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l6 6M9 3l-6 6"/></svg>
                </button>
              </summary>
              <div class="grid full">
                <div class="pair">
                  <label>Interface name</label>
                  <input data-iface-name="${escapeHtml(ifn)}" value="${escapeHtml(ifn)}" spellcheck="false" />
                </div>
              </div>
              <div class="grid fabric-row">
                <div class="pair">
                  <label>Fabric type</label>
                  <select data-iface-fabric-type="${escapeHtml(ifn)}">
                    <option value="network" ${ifFabric==='network'?'selected':''}>Network</option>
                    <option value="link"    ${ifFabric==='link'   ?'selected':''}>Link</option>
                  </select>
                </div>
                <div class="pair">
                  <label data-iface-fabric-label="${escapeHtml(ifn)}">${ifFabric === 'link' ? 'Link' : 'Network'}</label>
                  <div class="fabric-name-row">
                    <select data-iface-fabric-name="${escapeHtml(ifn)}">${fabricNameOpts}</select>
                    ${ifFabric === 'link' ? `<button class="btn-sec" data-iface-new-link="${escapeHtml(ifn)}" type="button">+ New link</button>` : ''}
                  </div>
                </div>
              </div>
              <div class="grid addr-row">
                <div class="pair">
                  <label>IP address</label>
                  <input data-iface-addr="${escapeHtml(ifn)}" value="${escapeHtml(ifc.address || '')}" spellcheck="false" placeholder="10.0.0.1" />
                  <span class="field-error" data-iface-addr-err="${escapeHtml(ifn)}"></span>
                </div>
                <div class="pair">
                  <label>Cost</label>
                  <input type="number" min="0" data-iface-cost="${escapeHtml(ifn)}" value="${ifc.cost ?? ''}" />
                </div>
              </div>
              ${isTopologyLocked() ? (() => {
                const down = isInterfaceDown(name, ifn);
                return down
                  ? `<div class="iface-act-row"><button class="iface-act" data-iface-act="enable" data-iface="${escapeHtml(ifn)}">Enable</button></div>`
                  : `<div class="iface-act-row"><button class="iface-act" data-iface-act="disable" data-iface="${escapeHtml(ifn)}">Disable</button><button class="iface-act danger" data-iface-act="fail" data-iface="${escapeHtml(ifn)}">Fail</button></div>`;
              })() : ''}
            </details>
          `;}).join('')}
        </div>
        <button class="add-if" id="add-if" style="margin-top:8px;">+ Add interface</button>
      </div>
    </div>
    <div class="insp-neighbors">${renderNeighborSection(name, router)}</div>
    <div class="insp-routes" id="insp-routes">${renderRoutingSection(name)}</div>
    <div class="insp-nat" id="insp-nat" hidden></div>
    <div class="insp-foot">
      <button class="dup" id="f-dup">Duplicate</button>
      <button class="del" id="f-del">Delete</button>
    </div>
  `;
  elI.querySelector('#f-name').addEventListener('change', e => renameRouter(name, e.target.value.trim()));
  elI.querySelector('#add-if').addEventListener('click', () => {
    if (isTopologyLocked()) return;
    const newIf = uniqueIface(state.routers[name].interfaces);
    state.routers[name].interfaces[newIf] = {
      network: Object.keys(state.networks)[0] || '',
      address: '', cost: 0,
    };
    markDirty(); renderInspector(); renderCanvas(); renderNav();
  });
  elI.querySelectorAll('[data-del-iface]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (isTopologyLocked()) return;
      delete state.routers[name].interfaces[b.getAttribute('data-del-iface')];
      markDirty(); renderInspector(); renderCanvas(); renderNav();
    });
  });
  elI.querySelectorAll('[data-iface-name]').forEach(inp => {
    inp.addEventListener('change', () => {
      if (isTopologyLocked()) return;
      const oldIf = inp.getAttribute('data-iface-name');
      const newIf = inp.value.trim();
      if (!newIf || newIf === oldIf) return;
      if (state.routers[name].interfaces[newIf]) {
        toast(`Interface "${newIf}" already exists on ${name}`, 'error', 'Rename');
        inp.value = oldIf; return;
      }
      const cur = state.routers[name].interfaces[oldIf];
      const rebuilt = {};
      for (const [k, v] of Object.entries(state.routers[name].interfaces)) {
        rebuilt[k === oldIf ? newIf : k] = (k === oldIf ? cur : v);
      }
      state.routers[name].interfaces = rebuilt;
      markDirty(); renderInspector(); renderCanvas(); renderNav();
    });
  });
  // Fabric-type select: switching between Network and Link for an interface
  elI.querySelectorAll('[data-iface-fabric-type]').forEach(s => {
    s.addEventListener('change', () => {
      if (isTopologyLocked()) return;
      const ifn = s.getAttribute('data-iface-fabric-type');
      const iff = state.routers[name].interfaces[ifn];
      const newType = s.value;
      if (newType === 'link') {
        // Default to unattached: never silently overflow an existing /30
        // when the user just wanted to flip the fabric kind.
        iff.link = '';
        delete iff.network;
      } else {
        iff.network = Object.keys(state.networks)[0] || '';
        delete iff.link;
      }
      markDirty(); renderInspector(); renderCanvas(); renderNav();
    });
  });
  // Fabric-name select: picking which network or link for an interface
  elI.querySelectorAll('[data-iface-fabric-name]').forEach(s => {
    s.addEventListener('change', () => {
      if (isTopologyLocked()) return;
      const ifn = s.getAttribute('data-iface-fabric-name');
      const iff = state.routers[name].interfaces[ifn];
      // Determine current type from the sibling type-select in same <details>
      const details = s.closest('[data-iface]');
      const typeSelect = details && details.querySelector(`[data-iface-fabric-type="${cssEscape(ifn)}"]`);
      const curType = typeSelect ? typeSelect.value : (iff.link !== undefined ? 'link' : 'network');
      if (curType === 'link') {
        iff.link = s.value;
        delete iff.network;
      } else {
        iff.network = s.value;
        delete iff.link;
      }
      // Re-render so the iface address validator re-wires against the new
      // fabric's CIDR; otherwise the validator's closure keeps the old ref.
      markDirty(); renderInspector(); renderCanvas(); renderNav();
    });
  });
  // "+ New link" button next to each iface's fabric-name select — creates a
  // fresh link and attaches this interface to it in one click.
  elI.querySelectorAll('[data-iface-new-link]').forEach(b => {
    b.addEventListener('click', () => {
      if (isTopologyLocked()) return;
      const ifn = b.getAttribute('data-iface-new-link');
      const r = state.routers[name];
      const iff = r.interfaces[ifn];
      const linkName = uniqueName('p2p', state.links);
      state.links[linkName] = {
        cidr: '',
        x: (r.x ?? 600) + 80,
        y: (r.y ?? 400),
      };
      iff.link = linkName;
      delete iff.network;
      markDirty();
      renderInspector();
      renderCanvas();
      renderNav();
      toast(`Created ${linkName} and attached ${name}/${ifn}`, 'ok', 'new link');
    });
  });
  elI.querySelectorAll('[data-iface-addr]').forEach(i => {
    i.addEventListener('input', () => {
      if (isTopologyLocked()) return;
      state.routers[name].interfaces[i.getAttribute('data-iface-addr')].address = i.value.trim();
      markDirty(); renderCanvas();
    });
    const ifn = i.getAttribute('data-iface-addr');
    const errEl = elI.querySelector(`[data-iface-addr-err="${cssEscape(ifn)}"]`);
    if (errEl) {
      const iff = state.routers[name].interfaces[ifn] || {};
      const ifFabricKind = iff.link !== undefined ? 'link' : 'network';
      const ifFabricName = iff[ifFabricKind];
      wireFieldValidation(
        i,
        errEl,
        addressValidatorFor(ifFabricKind, ifFabricName, { kind: 'router', name, ifaceName: ifn }),
      );
    }
  });
  elI.querySelectorAll('[data-iface-cost]').forEach(i => {
    i.addEventListener('input', () => {
      const v = parseInt(i.value, 10);
      const ifn = i.getAttribute('data-iface-cost');
      state.routers[name].interfaces[ifn].cost = isNaN(v) ? 0 : v;
      // Skip update_cost when the router itself is a pending add — the server
      // doesn't know about it yet, and reconcilePatch will fold the latest
      // cost into the rebuilt add_router op on Resume.
      if (!isNaN(v) && v > 0 && !hasPendingAdd('router', name)) {
        recordPatchOp({ op: 'update_cost', router: name, iface: ifn, cost: v });
      }
      markDirty(); renderCanvas();
    });
  });
  // Per-interface Disable/Fail/Enable — only present when sim is running.
  // Wire per-element (not delegated on elI) so old listeners die with the
  // replaced innerHTML on each re-render instead of accumulating on the
  // persistent #inspector node.
  elI.querySelectorAll('[data-iface-act]').forEach((ib) => {
    ib.addEventListener('click', () => {
      const ifn = ib.getAttribute('data-iface');
      const act = ib.getAttribute('data-iface-act');
      const showErr = (err) => toast(err.message || String(err), 'error');
      if (act === 'disable') RuntimeClient.deviceCommand(name, `ifconfig ${ifn} down`).catch(showErr);
      else if (act === 'enable') RuntimeClient.deviceCommand(name, `ifconfig ${ifn} up`).catch(showErr);
      else if (act === 'fail') RuntimeClient.fail(name, ifn).catch(showErr);
    });
  });
  elI.querySelector('#f-del').addEventListener('click', deleteSelected);
  elI.querySelector('#f-dup').addEventListener('click', () => duplicateRouter(name));
  // Persist open/closed state of top-level collapsible sections across re-renders.
  wireSectionToggles(elI);
  Inspector.refreshRoutes(name);
  Inspector.refreshNAT(name);
}

/* ---------- crud ---------- */
export function renameKey(dict, oldK, newK) {
  const cur = dict[oldK];
  const out = {};
  for (const [k, v] of Object.entries(dict)) out[k === oldK ? newK : k] = (k === oldK ? cur : v);
  return out;
}
export function renameNetwork(oldName, newName) {
  if (isTopologyLocked()) return;
  if (!newName || newName === oldName) return;
  if (state.networks[newName]) { toast(`LAN "${newName}" already exists`, 'error', 'Rename'); renderInspector(); return; }
  state.networks = renameKey(state.networks, oldName, newName);
  Object.values(state.hosts).forEach(h => { if (h.network === oldName) h.network = newName; });
  Object.values(state.routers).forEach(r => Object.values(r.interfaces || {}).forEach(i => { if (i.network === oldName) i.network = newName; }));
  state.selection = { kind: 'network', name: newName };
  markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}
export function renameHost(oldName, newName) {
  if (isTopologyLocked()) return;
  if (!newName || newName === oldName) return;
  if (state.hosts[newName]) { toast(`Host "${newName}" already exists`, 'error', 'Rename'); renderInspector(); return; }
  state.hosts = renameKey(state.hosts, oldName, newName);
  state.selection = { kind: 'host', name: newName };
  markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}
export function renameRouter(oldName, newName) {
  if (isTopologyLocked()) return;
  if (!newName || newName === oldName) return;
  if (state.routers[newName]) { toast(`Router "${newName}" already exists`, 'error', 'Rename'); renderInspector(); return; }
  state.routers = renameKey(state.routers, oldName, newName);
  state.selection = { kind: 'router', name: newName };
  markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}
export function duplicateNetwork(name) {
  if (isTopologyLocked()) return;
  const newName = uniqueName(name + '_', state.networks);
  const src = state.networks[name];
  state.networks[newName] = { ...src, x: src.x + 30, y: src.y + 30 };
  state.selection = { kind: 'network', name: newName };
  recordPatchOp({ op: 'add_network', name: newName, address: src.cidr || '' });
  markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}
export function duplicateHost(name) {
  if (isTopologyLocked()) return;
  const newName = uniqueName(name + '_', state.hosts);
  const src = state.hosts[name];
  state.hosts[newName] = { ...src, x: src.x + 30, y: src.y + 30 };
  state.selection = { kind: 'host', name: newName };
  recordPatchOp({ op: 'add_host', name: newName, network: src.network || '', address: src.address || '' });
  markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}
export function renameLink(oldName, newName) {
  if (isTopologyLocked()) return;
  if (!newName || newName === oldName) return;
  if (state.links[newName]) { toast(`Link "${newName}" already exists`, 'error', 'Rename'); renderInspector(); return; }
  state.links = renameKey(state.links, oldName, newName);
  // Rewrite all router interface and host references
  Object.values(state.hosts).forEach(h => { if (h.link === oldName) h.link = newName; });
  Object.values(state.routers).forEach(r => Object.values(r.interfaces || {}).forEach(iff => { if (iff.link === oldName) iff.link = newName; }));
  state.selection = { kind: 'link', name: newName };
  markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}
export function duplicateLink(name) {
  if (isTopologyLocked()) return;
  const newName = uniqueName(name + '_', state.links);
  const src = state.links[name];
  // Clone the link entry but NOT its endpoints — a newly duplicated link has
  // no devices attached; the user must wire them up. Toast explains this.
  state.links[newName] = { cidr: src.cidr, x: src.x + 30, y: src.y + 30 };
  state.selection = { kind: 'link', name: newName };
  markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
  toast(`Link "${newName}" created (no endpoints — attach routers/hosts to use it)`, '', 'Duplicate');
}
export function duplicateRouter(name) {
  if (isTopologyLocked()) return;
  const newName = uniqueName(name + '_', state.routers);
  const src = state.routers[name];
  state.routers[newName] = JSON.parse(JSON.stringify(src));
  state.routers[newName].x = src.x + 30; state.routers[newName].y = src.y + 30;
  state.selection = { kind: 'router', name: newName };
  recordPatchOp({ op: 'add_router', name: newName, interfaces: [] });
  markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}
export function deleteSelected() {
  if (isTopologyLocked()) return;
  if (!state.selection) return;
  const { kind, name } = state.selection;
  if (kind === 'network') {
    const usedBy = [];
    Object.entries(state.hosts).forEach(([hn, h]) => { if (h.network === name) usedBy.push(`host ${hn}`); });
    Object.entries(state.routers).forEach(([rn, r]) => {
      Object.entries(r.interfaces || {}).forEach(([ifn, iff]) => { if (iff.network === name) usedBy.push(`${rn}/${ifn}`); });
    });
    if (usedBy.length && !confirm(`LAN "${name}" is used by:\n  ${usedBy.join('\n  ')}\n\nDelete anyway? Their network field will be cleared.`)) return;
    Object.values(state.hosts).forEach(h => { if (h.network === name) h.network = ''; });
    Object.values(state.routers).forEach(r => Object.values(r.interfaces || {}).forEach(i => { if (i.network === name) i.network = ''; }));
    delete state.networks[name];
    recordPatchOp({ op: 'remove_network', name });
  } else if (kind === 'link') {
    const linkUsedBy = [];
    Object.entries(state.hosts).forEach(([hn, h]) => { if (h.link === name) linkUsedBy.push(`host ${hn}`); });
    Object.entries(state.routers).forEach(([rn, r]) => {
      Object.entries(r.interfaces || {}).forEach(([ifn, iff]) => { if (iff.link === name) linkUsedBy.push(`${rn}/${ifn}`); });
    });
    if (linkUsedBy.length && !confirm(`Link "${name}" is used by:\n  ${linkUsedBy.join('\n  ')}\n\nDelete anyway? Their link field will be cleared.`)) return;
    // Clear link references from hosts and router interfaces
    Object.values(state.hosts).forEach(h => { if (h.link === name) { h.network = ''; delete h.link; } });
    Object.values(state.routers).forEach(r => Object.values(r.interfaces || {}).forEach(iff => {
      if (iff.link === name) { iff.network = ''; delete iff.link; }
    }));
    delete state.links[name];
  } else if (kind === 'host') {
    delete state.hosts[name];
    recordPatchOp({ op: 'remove_host', name });
  } else if (kind === 'router') {
    delete state.routers[name];
    recordPatchOp({ op: 'remove_router', name });
  }
  state.selection = null;
  markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
  toast(`${kind === 'network' ? 'LAN' : kind} "${name}" deleted`, 'ok');
}
export function addNew(kind, world) {
  if (isTopologyLocked()) return;
  const def = world || worldCenter();
  if (kind === 'network') {
    const name = uniqueName('lan', state.networks);
    state.networks[name] = { cidr: '', x: def.x, y: def.y };
    state.selection = { kind, name };
    recordPatchOp({ op: 'add_network', name, address: '' });
  } else if (kind === 'link') {
    const name = uniqueName('p2p', state.links);
    state.links[name] = { cidr: '', x: def.x, y: def.y };
    state.selection = { kind, name };
    recordPatchOp({ op: 'add_link', name, address: '' });
    toast(`Created ${name} — assign two router/host interfaces to use it`, '', 'new link');
  } else if (kind === 'host') {
    const name = uniqueName('h', state.hosts);
    state.hosts[name] = { network: '', address: '', x: def.x, y: def.y };
    state.selection = { kind, name };
    recordPatchOp({ op: 'add_host', name, network: '', address: '' });
    if (Object.keys(state.networks).length > 0) {
      toast(`Created ${name} — drag onto a LAN to attach`, '', 'orphan host');
    }
  } else if (kind === 'router') {
    const name = uniqueName('r', state.routers);
    state.routers[name] = { x: def.x, y: def.y, interfaces: {} };
    state.selection = { kind, name };
    recordPatchOp({ op: 'add_router', name, interfaces: [] });
    if (Object.keys(state.networks).length > 0) {
      toast(`Created ${name} — drag onto LANs to add interfaces`, '', 'orphan router');
    }
  }
  markDirty(); bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}
export function worldCenter() {
  const svg = canvasEl();
  const rect = svg.getBoundingClientRect();
  return clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

/* ---------- bus listeners ---------- */
bus.addEventListener('state:topology-changed', () => { renderNav(); renderInspector(); });
bus.addEventListener('state:selection-changed', renderInspector);
bus.addEventListener('sim:status-changed', () => {
  // Only refresh the routing-table section, not the whole panel, so that
  // toggling Sim state doesn't reset focus on inspector inputs.
  if (state.selection && (state.selection.kind === 'host' || state.selection.kind === 'router')) {
    Inspector.refreshRoutes(state.selection.name);
  }
  if (state.selection && state.selection.kind === 'router') {
    Inspector.refreshNAT(state.selection.name);
  }
});
bus.addEventListener('sim:routing-table-changed', (e) => {
  Inspector.onRouteChange({ device: e.detail.device });
});
bus.addEventListener('sim:nat-table-changed', (e) => {
  Inspector.onNATChange({ device: e.detail.device });
});
bus.addEventListener('sim:neighbor-state-changed', (e) => {
  const { device } = e.detail;
  if (!state.selection || state.selection.kind !== 'router' || state.selection.name !== device) return;
  const router = state.routers[device];
  if (!router) return;
  const elI = document.getElementById('inspector');
  const container = elI && elI.querySelector('.insp-neighbors');
  if (!container) return;
  // Re-render only the Neighbors section, preserving open/closed state.
  rememberOpen(elI);
  container.innerHTML = renderNeighborSection(device, router);
  wireSectionToggles(container);
});
bus.addEventListener('sim:interface-state-changed', (e) => {
  const { device } = e.detail;
  if (!state.selection || state.selection.kind !== 'router' || state.selection.name !== device) return;
  // Re-render the whole router panel so the Disable↔Enable buttons flip.
  renderInspector();
});
bus.addEventListener('canvas:contextmenu-requested', (e) => {
  openContextMenu(e.detail.clientX, e.detail.clientY, e.detail.target, e.detail.world);
});
bus.addEventListener('canvas:contextmenu-close-requested', closeContextMenu);

// Dismiss the context menu on outside click or Escape.
document.addEventListener('click', (e) => {
  if (_ctxEl && !e.target.closest('.ctx')) closeContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _ctxEl) closeContextMenu();
});
// Close ctx on resize.
window.addEventListener('resize', closeContextMenu);
