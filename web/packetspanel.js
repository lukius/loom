// web/packetspanel.js
// Panel listing in-flight packets and the last 10 delivered.
// Wires the tb-packets toolbar button, mounts the panel inside the
// #inspector slot (hiding the inspector's normal content while open),
// subscribes to packets:list-changed, and renders.
import { state, bus, markDirty } from './state.js';

import { escapeHtml, cssEscape } from './utils.js';
import { PacketStore } from './packetstore.js';

// Friendly labels for chatter rows, so the panel shows "Hello" / "LSA"
// instead of the raw wire-type strings.
const FRIENDLY_CHATTER_LABELS = {
  hello: 'Hello',
  routing_flood: 'LSA',
};
function _friendlyTypeLabel(type) {
  return FRIENDLY_CHATTER_LABELS[type] || type || '';
}

export const PacketsPanel = {
  _wired: false,
  _panel: null,
  _expanded: new Set(),
  _chatterExpanded: false,

  _reset() {
    const host = document.getElementById('inspector');
    if (host) delete host.dataset.packetsOpen;
    this._wired = false;
    if (this._panel && this._panel.parentNode) this._panel.parentNode.removeChild(this._panel);
    this._panel = null;
    this._expanded.clear();
    this._chatterExpanded = false;
    delete document.body.dataset.chatterBadges;
  },

  wire() {
    if (this._wired) return;
    const btn = document.getElementById('tb-packets');
    if (!btn) return;
    btn.addEventListener('click', () => this.toggle());
    this._wired = true;
  },

  init() {
    if (state.ui && state.ui.packetsPanelOpen) this.open();
    this._syncButton();
  },

  toggle() {
    if (state.ui.packetsPanelOpen) this.close();
    else this.open();
  },

  open() {
    state.ui.packetsPanelOpen = true;
    const host = document.getElementById('inspector');
    if (!host) return;
    if (!this._panel) {
      this._panel = document.createElement('div');
      this._panel.id = 'packets-panel';
      this._panel.className = 'packets-panel';
      host.appendChild(this._panel);
    } else if (this._panel.parentNode !== host) {
      host.appendChild(this._panel);
    }
    host.dataset.packetsOpen = '1';
    this._panel.hidden = false;
    this.render();
    this._syncButton();
    markDirty();
  },

  close() {
    state.ui.packetsPanelOpen = false;
    if (this._panel) this._panel.hidden = true;
    const host = document.getElementById('inspector');
    if (host) delete host.dataset.packetsOpen;
    this._syncButton();
    markDirty();
  },

  _natFormat(natList) {
    if (!natList || natList.length === 0) return '';
    return natList.map(n => {
      if (n.direction === 'outbound') {
        return `<div class="pkt-nat">NAT @ ${escapeHtml(n.router)}: ${escapeHtml(n.original_src)} → ${escapeHtml(n.rewritten_src)}</div>`;
      }
      return `<div class="pkt-nat">NAT @ ${escapeHtml(n.router)}: ${escapeHtml(n.rewritten_dst)} → ${escapeHtml(n.original_dst)}</div>`;
    }).join('');
  },

  _userRowHtml(row) {
    const isOpen = this._expanded.has(row.payloadId);
    const totalRegistered = row.hops.length;
    const currentHop = row.status === 'delivered' ? totalRegistered : Math.min((row._arrivedCount || 0) + 1, totalRegistered);
    const hopBadge = totalRegistered > 1 ? `<span class="pkt-hopct">[hop ${currentHop}]</span>` : '';
    const swatch = `<span class="pkt-swatch" data-type="${escapeHtml(row.type)}"></span>`;
    const detail = isOpen ? `
      <div class="pkt-detail">
        <div class="pkt-payload">payload: ${escapeHtml(row.payloadSrc)} → ${escapeHtml(row.payloadDst)}</div>
        <div class="pkt-hops">hops:</div>
        <ol>
          ${row.hops.map((h, i) => `
            <li><span class="pkt-hop">${escapeHtml(h.srcDev || '?')} → ${escapeHtml(h.dstDev || '?')}</span>
                <span class="pkt-hop-net">(${escapeHtml(h.network || '')})</span>
                ${i === row.hops.length - 1 && row.status !== 'delivered' ? '<span class="pkt-hop-flag">◀ in flight</span>' : ''}
            </li>`).join('')}
        </ol>
        ${this._payloadHtml(row.payload)}
        ${this._natFormat(PacketStore.natFor(row.payloadId))}
      </div>` : '';
    return `
      <div class="pkt-row" data-payload-id="${escapeHtml(row.payloadId)}">
        <button class="pkt-toggle" aria-expanded="${isOpen}">${isOpen ? '▾' : '▸'}</button>
        ${swatch}
        <span class="pkt-id">#${row.id}</span>
        <span class="pkt-type">${escapeHtml(row.type)}</span>
        <span class="pkt-route">${escapeHtml(row.srcLabel)} → ${escapeHtml(row.dstLabel)}</span>
        ${hopBadge}
        ${detail}
      </div>`;
  },

  _payloadHtml(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const entries = Object.entries(payload);
    if (entries.length === 0) return '';
    const rows = entries.map(([k, v]) => {
      if (Array.isArray(v)) {
        const items = v.length === 0
          ? '<li class="pkt-payload-empty">(empty)</li>'
          : v.map(item => `<li>${this._renderPayloadScalar(item)}</li>`).join('');
        return `
        <div class="pkt-payload-block">
          <div class="pkt-payload-key">${escapeHtml(k)}</div>
          <ul class="pkt-payload-list">${items}</ul>
        </div>`;
      }
      return `
      <div class="pkt-payload-row">
        <span class="pkt-payload-key">${escapeHtml(k)}</span>
        <span class="pkt-payload-val" title="${escapeHtml(String(v))}">${escapeHtml(this._formatScalar(v))}</span>
      </div>`;
    }).join('');
    return `<div class="pkt-payload-section">
      <div class="pkt-payload-title">payload</div>
      ${rows}
    </div>`;
  },

  _renderPayloadScalar(item) {
    if (item == null) return '';
    if (typeof item === 'object' && !Array.isArray(item)) {
      return Object.entries(item)
        .map(([k, v]) => `<span class="pkt-payload-kv"><span class="pkt-payload-kv-k">${escapeHtml(k)}</span>=<span class="pkt-payload-kv-v">${escapeHtml(this._formatScalar(v))}</span></span>`)
        .join(' ');
    }
    return escapeHtml(this._formatScalar(item));
  },

  _formatScalar(v) {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (_) { return String(v); }
    }
    return String(v);
  },

  _setChatterExpanded(on) {
    this._chatterExpanded = on;
    if (on) document.body.dataset.chatterBadges = 'on';
    else delete document.body.dataset.chatterBadges;
    bus.dispatchEvent(new CustomEvent('packets:chatter-badges-changed'));
  },

  _chatterGroupRowHtml(group) {
    const isOpen = this._expanded.has(group.payloadId);
    const detail = isOpen ? `
      <div class="pkt-detail">
        ${this._payloadHtml(group.payload)}
        <div class="pkt-emissions">${group.emissionKeys.length} emission${group.emissionKeys.length === 1 ? '' : 's'} in flight</div>
      </div>` : '';
    const typeLabel = _friendlyTypeLabel(group.type);
    return `
      <div class="pkt-row pkt-chatter-row" data-payload-id="${escapeHtml(group.payloadId)}" data-emission-keys="${escapeHtml(group.emissionKeys.join(' '))}">
        <button class="pkt-toggle" aria-expanded="${isOpen}">${isOpen ? '▾' : '▸'}</button>
        <span class="pkt-swatch" data-type="${escapeHtml(group.type)}"></span>
        <span class="pkt-id">#R${group.id}</span>
        <span class="pkt-type">${escapeHtml(typeLabel)}</span>
        <span class="pkt-route">${escapeHtml(group.srcDev || '?')} → ${escapeHtml(group.network || '?')}</span>
        ${group.iface ? `<span class="pkt-hop-net">(${escapeHtml(group.iface)})</span>` : ''}
        <span class="pkt-emission-count">×${group.emissionKeys.length}</span>
        ${detail}
      </div>`;
  },

  _totalEmissions(groups) {
    return groups.reduce((sum, g) => sum + g.emissionKeys.length, 0);
  },

  _chatterSectionHtml() {
    if (!state.ui.showChatter) return '';
    const groups = PacketStore.visibleChatterGroups();
    if (groups.length === 0) return '';
    const open = this._chatterExpanded;
    const list = open
      ? groups.map(g => this._chatterGroupRowHtml(g)).join('')
      : '';
    return `
      <section class="packets-section">
        <h3>In flight — routing chatter</h3>
        <div class="pkt-chatter-summary">
          <button class="pkt-toggle" aria-expanded="${open}">${open ? '▾' : '▸'}</button>
          <span class="pkt-swatch" data-type="routing_flood"></span>
          <span>Routing chatter · ${groups.length} message${groups.length === 1 ? '' : 's'} (${this._totalEmissions(groups)} emissions)</span>
        </div>
        ${list}
      </section>`;
  },

  render() {
    if (!this._panel) return;
    // Row DOM is rebuilt on every render, which detaches the mouseleave
    // handlers responsible for clearing canvas halos. Clear any stale halos
    // up front so hovers don't accumulate across re-renders.
    const layer = document.getElementById('packet-layer');
    if (layer) layer.querySelectorAll('rect.halo').forEach(d => d.classList.remove('halo'));
    const inFlight = PacketStore.visibleInFlight();
    const chatterGroups = state.ui.showChatter ? PacketStore.visibleChatterGroups() : [];
    const total = inFlight.length + chatterGroups.length;
    const empty = total === 0 && PacketStore.recent.length === 0;

    this._panel.innerHTML = `
      <header class="packets-header">
        <span>Packets (${total})</span>
        <div class="packets-header-actions">
          <button class="packets-chatter-toggle" aria-pressed="${state.ui.showChatter ? 'true' : 'false'}" title="Show/hide routing chatter section">
            <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
              <circle cx="4" cy="8" r="1.5" fill="currentColor"/>
              <circle cx="8" cy="8" r="1.5" fill="currentColor"/>
              <circle cx="12" cy="8" r="1.5" fill="currentColor"/>
            </svg>
          </button>
          <button class="packets-close" aria-label="Close">×</button>
        </div>
      </header>
      <div class="packets-body">
        ${empty ? '<div class="packets-empty">No packets yet — start the simulation to see traffic.</div>' : ''}
        ${inFlight.length > 0 ? `
          <section class="packets-section">
            <h3>In flight — user traffic</h3>
            ${inFlight.map(r => this._userRowHtml(r)).join('')}
          </section>` : ''}
        ${this._chatterSectionHtml()}
        ${PacketStore.recent.length > 0 ? `
          <section class="packets-section packets-recent">
            <h3>Recent</h3>
            ${PacketStore.recent.map(r => this._userRowHtml(r)).join('')}
          </section>` : ''}
      </div>
    `;

    const close = this._panel.querySelector('.packets-close');
    if (close) close.addEventListener('click', () => this.close());
    const chatterToggleBtn = this._panel.querySelector('.packets-chatter-toggle');
    if (chatterToggleBtn) {
      chatterToggleBtn.addEventListener('click', () => {
        state.ui.showChatter = !state.ui.showChatter;
        markDirty();
        this.render();
      });
    }
    this._panel.querySelectorAll('.pkt-row').forEach(rowEl => {
      const tog = rowEl.querySelector('.pkt-toggle');
      if (tog) {
        tog.addEventListener('click', () => {
          const pid = rowEl.dataset.payloadId;
          if (this._expanded.has(pid)) this._expanded.delete(pid);
          else this._expanded.add(pid);
          this.render();
        });
      }
      const emissionKeys = rowEl.dataset.emissionKeys;
      const pid = rowEl.dataset.payloadId;
      rowEl.addEventListener('mouseenter', () => {
        if (emissionKeys) {
          // Chatter group: halo every emission's dot.
          const keys = emissionKeys.split(' ');
          keys.forEach(k => {
            const dot = document.querySelector(`#packet-layer rect[data-payload-id="${cssEscape(k)}"]`);
            if (dot) dot.classList.add('halo');
          });
        } else {
          const dot = document.querySelector(`#packet-layer rect[data-payload-id="${cssEscape(pid)}"]`);
          if (dot) dot.classList.add('halo');
        }
      });
      rowEl.addEventListener('mouseleave', () => {
        if (emissionKeys) {
          emissionKeys.split(' ').forEach(k => {
            const dot = document.querySelector(`#packet-layer rect[data-payload-id="${cssEscape(k)}"]`);
            if (dot) dot.classList.remove('halo');
          });
        } else {
          const dot = document.querySelector(`#packet-layer rect[data-payload-id="${cssEscape(pid)}"]`);
          if (dot) dot.classList.remove('halo');
        }
      });
    });

    const chatterToggle = this._panel.querySelector('.pkt-chatter-summary .pkt-toggle');
    if (chatterToggle) {
      chatterToggle.addEventListener('click', () => {
        this._setChatterExpanded(!this._chatterExpanded);
        this.render();
      });
    }
  },

  _syncButton() {
    const btn = document.getElementById('tb-packets');
    if (btn) btn.classList.toggle('toggle-on', !!(state.ui && state.ui.packetsPanelOpen));
  },
};

bus.addEventListener('packets:list-changed', () => PacketsPanel.render());

// The inspector re-renders (via innerHTML=) on selection and topology changes,
// which destroys the #packets-panel child. Re-attach it when the panel is open.
function _reattachIfOpen() {
  if (!state.ui || !state.ui.packetsPanelOpen || !PacketsPanel._panel) return;
  const host = document.getElementById('inspector');
  if (!host) return;
  if (PacketsPanel._panel.parentNode !== host) host.appendChild(PacketsPanel._panel);
  host.dataset.packetsOpen = '1';
  PacketsPanel._panel.hidden = false;
}
bus.addEventListener('state:selection-changed', _reattachIfOpen);
bus.addEventListener('state:topology-changed', _reattachIfOpen);
