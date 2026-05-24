// web/packetspanel.js
// Slide-out panel listing in-flight packets and the last 10 delivered.
// Wires the tb-packets toolbar button, mounts the panel under <body>,
// subscribes to packets:list-changed, and renders.
import { state, bus, markDirty } from './state.js';
import { escapeHtml } from './utils.js';
import { PacketStore } from './packetstore.js';

export const PacketsPanel = {
  _wired: false,
  _panel: null,
  _expanded: new Set(),
  _chatterExpanded: false,

  _reset() {
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
    if (!this._panel) {
      this._panel = document.createElement('aside');
      this._panel.id = 'packets-panel';
      this._panel.className = 'packets-panel';
      document.body.appendChild(this._panel);
    }
    this._panel.hidden = false;
    this.render();
    this._syncButton();
    markDirty();
  },

  close() {
    state.ui.packetsPanelOpen = false;
    if (this._panel) this._panel.hidden = true;
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
    const hopBadge = row.hops.length > 1 ? `<span class="pkt-hopct">[hop ${row.hops.length}]</span>` : '';
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

  _setChatterExpanded(on) {
    this._chatterExpanded = on;
    if (on) document.body.dataset.chatterBadges = 'on';
    else delete document.body.dataset.chatterBadges;
    bus.dispatchEvent(new CustomEvent('packets:chatter-badges-changed'));
  },

  _chatterSectionHtml() {
    const count = PacketStore.chatter.size;
    if (count === 0) return '';
    const open = this._chatterExpanded;
    const list = open
      ? Array.from(PacketStore.chatter.values()).sort((a, b) => a.id - b.id)
          .map(r => `
            <div class="pkt-chatter-row">
              <span class="pkt-swatch" data-type="routing_flood"></span>
              <span class="pkt-id">#R${r.id}</span>
              <span class="pkt-route">${escapeHtml(r.srcDev || '?')} → ${escapeHtml(r.network || '?')}</span>
              ${r.iface ? `<span class="pkt-hop-net">(${escapeHtml(r.iface)})</span>` : ''}
            </div>`).join('')
      : '';
    return `
      <section class="packets-section">
        <h3>In flight — routing chatter</h3>
        <div class="pkt-chatter-summary">
          <button class="pkt-toggle" aria-expanded="${open}">${open ? '▾' : '▸'}</button>
          <span class="pkt-swatch" data-type="routing_flood"></span>
          <span>Routing chatter · ${count} in flight</span>
        </div>
        ${list}
      </section>`;
  },

  render() {
    if (!this._panel) return;
    const inFlight = Array.from(PacketStore.inFlight.values()).sort((a, b) => a.id - b.id);
    const chatterCount = PacketStore.chatter.size;
    const total = inFlight.length + chatterCount;
    const empty = total === 0 && PacketStore.recent.length === 0;

    this._panel.innerHTML = `
      <header class="packets-header">
        <span>Packets (${total})</span>
        <button class="packets-close" aria-label="Close">×</button>
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
      const pid = rowEl.dataset.payloadId;
      rowEl.addEventListener('mouseenter', () => {
        const dot = document.querySelector(`#packet-layer rect[data-payload-id="${CSS.escape(pid)}"]`);
        if (dot) dot.classList.add('halo');
      });
      rowEl.addEventListener('mouseleave', () => {
        const dot = document.querySelector(`#packet-layer rect[data-payload-id="${CSS.escape(pid)}"]`);
        if (dot) dot.classList.remove('halo');
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
