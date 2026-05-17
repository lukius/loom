// web/inspector.test.js
// Tests for inspector.js: nav links section, link editor, CRUD ops,
// fabric-type dropdowns, and context menu for p2p links.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state, bus } from './state.js';
import {
  renderNav,
  renderInspector,
  renderLinkInsp,
  renderHostInsp,
  renderRouterInsp,
  renameLink,
  duplicateLink,
  duplicateHost,
  duplicateNetwork,
  duplicateRouter,
  deleteSelected,
  openContextMenu,
  closeContextMenu,
  Inspector,
} from './inspector.js';
import { Sim } from './sim.js';

// ---------------------------------------------------------------------------
// Minimal DOM environment — mirrors the subset that inspector.js touches.
// ---------------------------------------------------------------------------
function setupDOM() {
  document.body.innerHTML = `
    <div id="nav"></div>
    <div id="inspector"></div>
    <div id="toasts"></div>
    <div id="save-state"><span class="dot"></span> autosaved</div>
    <input id="proj-name" value="test_as" />
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

function resetState() {
  state.links     = {};
  state.networks  = {};
  state.hosts     = {};
  state.routers   = {};
  state.natTables = {};
  state.selection = null;
  state.view      = { x: 0, y: 0, k: 1 };
  state.display   = { showCosts: true, showIfaces: true };
}

beforeEach(() => {
  setupDOM();
  resetState();
  closeContextMenu();
});

// ---------------------------------------------------------------------------
// 1. renderNav includes a Links section
// ---------------------------------------------------------------------------
describe('renderNav — Links section', () => {
  it('renders a "Links" section title', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    renderNav();
    const nav = document.getElementById('nav');
    expect(nav.textContent).toContain('Links');
  });

  it('renders one row for p2p1', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    renderNav();
    const nav = document.getElementById('nav');
    const rows = nav.querySelectorAll('.nav-row');
    // At least one row with the name p2p1
    const names = Array.from(rows).map(r => r.querySelector('.name')?.textContent);
    expect(names).toContain('p2p1');
  });

  it('shows "No links yet" placeholder when links is empty', () => {
    state.links = {};
    renderNav();
    const nav = document.getElementById('nav');
    expect(nav.textContent).toContain('No links yet');
  });

  it('shows the CIDR as meta text in the nav row', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    renderNav();
    const nav = document.getElementById('nav');
    expect(nav.textContent).toContain('10.0.0.0/30');
  });

  it('shows "—" as meta when cidr is absent', () => {
    state.links = { p2p1: { x: 0, y: 0 } };
    renderNav();
    const nav = document.getElementById('nav');
    // Find the link row's meta span
    const rows = Array.from(nav.querySelectorAll('.nav-row'));
    const linkRow = rows.find(r => r.querySelector('.name')?.textContent === 'p2p1');
    expect(linkRow).not.toBeNull();
    expect(linkRow.querySelector('.meta')?.textContent).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// 2. Clicking a link row sets selection
// ---------------------------------------------------------------------------
describe('renderNav — clicking a link row', () => {
  it('sets state.selection.kind === "link" and name matches', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    renderNav();
    const nav = document.getElementById('nav');
    const rows = Array.from(nav.querySelectorAll('.nav-row'));
    const linkRow = rows.find(r => r.querySelector('.name')?.textContent === 'p2p1');
    expect(linkRow).not.toBeNull();
    linkRow.click();
    expect(state.selection).not.toBeNull();
    expect(state.selection.kind).toBe('link');
    expect(state.selection.name).toBe('p2p1');
  });

  it('dispatches state:selection-changed on click', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    renderNav();
    const nav = document.getElementById('nav');
    const rows = Array.from(nav.querySelectorAll('.nav-row'));
    const linkRow = rows.find(r => r.querySelector('.name')?.textContent === 'p2p1');
    let fired = false;
    bus.addEventListener('state:selection-changed', () => { fired = true; }, { once: true });
    linkRow.click();
    expect(fired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. renderLinkInsp — editor structure
// ---------------------------------------------------------------------------
describe('renderLinkInsp — editor structure', () => {
  function setupLink() {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 100, y: 100, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
      r2: { x: 200, y: 100, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.2', cost: 5 } } },
    };
    state.selection = { kind: 'link', name: 'p2p1' };
  }

  it('renders the inspector when selection.kind is "link"', () => {
    setupLink();
    renderInspector();
    const elI = document.getElementById('inspector');
    expect(elI.innerHTML).toContain('p2p1');
  });

  it('has an input for the link name', () => {
    setupLink();
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    expect(elI.querySelector('#f-name')).not.toBeNull();
    expect(elI.querySelector('#f-name').value).toBe('p2p1');
  });

  it('shows the CIDR in an editable input', () => {
    setupLink();
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const cidrInput = elI.querySelector('#f-cidr');
    expect(cidrInput).not.toBeNull();
    expect(cidrInput.value).toBe('10.0.0.0/30');
    expect(cidrInput.hasAttribute('readonly')).toBe(false);
  });

  it('typing in the CIDR field writes to state.links[name].cidr', () => {
    setupLink();
    state.links.p2p1.cidr = '';
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const cidrInput = elI.querySelector('#f-cidr');
    cidrInput.value = '10.0.0.0/30';
    cidrInput.dispatchEvent(new Event('input'));
    expect(state.links.p2p1.cidr).toBe('10.0.0.0/30');
  });

  it('renders endpoint list with both attached routers', () => {
    setupLink();
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const epList = elI.querySelector('.ep-list');
    expect(epList).not.toBeNull();
    expect(epList.textContent).toContain('r1');
    expect(epList.textContent).toContain('r2');
  });

  it('shows "no endpoints" hint when no devices attached', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    expect(elI.textContent).toContain('no endpoints');
  });

  it('has duplicate and delete buttons', () => {
    setupLink();
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    expect(elI.querySelector('#f-dup')).not.toBeNull();
    expect(elI.querySelector('#f-del')).not.toBeNull();
  });

  it('shows a "link" pill with class "link"', () => {
    setupLink();
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const pill = elI.querySelector('.pill.link');
    expect(pill).not.toBeNull();
  });

  it('resets selection and re-renders if link is missing', () => {
    state.links = {};
    state.selection = { kind: 'link', name: 'ghost' };
    renderInspector();
    // Should fall back to "Nothing selected"
    const elI = document.getElementById('inspector');
    expect(elI.textContent).toContain('Nothing selected');
    expect(state.selection).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. renameLink — rewrites references
// ---------------------------------------------------------------------------
describe('renameLink', () => {
  it('renames the link in state.links', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    renameLink('p2p1', 'wan');
    expect(state.links.wan).toBeDefined();
    expect(state.links.p2p1).toBeUndefined();
  });

  it('updates router interface references', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
    };
    renameLink('p2p1', 'wan');
    expect(state.routers.r1.interfaces.eth0.link).toBe('wan');
  });

  it('updates host link references', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.hosts = { h1: { link: 'p2p1', address: '10.0.0.1', x: 0, y: 0 } };
    renameLink('p2p1', 'wan');
    expect(state.hosts.h1.link).toBe('wan');
  });

  it('updates selection to the new name', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    renameLink('p2p1', 'wan');
    expect(state.selection).toEqual({ kind: 'link', name: 'wan' });
  });
});

// ---------------------------------------------------------------------------
// 6. renameLink — rejects duplicate names
// ---------------------------------------------------------------------------
describe('renameLink — uniqueness check', () => {
  it('does not rename when new name already exists', () => {
    state.links = {
      p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 },
      p2p2: { cidr: '10.0.0.4/30', x: 0, y: 0 },
    };
    renameLink('p2p1', 'p2p2');
    // Both still exist, neither removed
    expect(state.links.p2p1).toBeDefined();
    expect(state.links.p2p2.cidr).toBe('10.0.0.4/30');
  });

  it('is a no-op when oldName === newName', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    renameLink('p2p1', 'p2p1');
    expect(state.links.p2p1).toBeDefined();
  });

  it('is a no-op when newName is empty string', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    renameLink('p2p1', '');
    expect(state.links.p2p1).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. deleteSelected for a link
// ---------------------------------------------------------------------------
describe('deleteSelected — link kind', () => {
  it('removes state.links[name]', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.selection = { kind: 'link', name: 'p2p1' };
    // No attached devices, so no confirm() needed
    deleteSelected();
    expect(state.links.p2p1).toBeUndefined();
  });

  it('clears router interface link refs (sets network="")', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
      r2: { x: 0, y: 0, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.2', cost: 5 } } },
    };
    state.selection = { kind: 'link', name: 'p2p1' };
    // Stub confirm to return true
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    deleteSelected();
    expect(state.links.p2p1).toBeUndefined();
    expect(state.routers.r1.interfaces.eth0.link).toBeUndefined();
    expect(state.routers.r1.interfaces.eth0.network).toBe('');
    expect(state.routers.r2.interfaces.eth0.link).toBeUndefined();
    expect(state.routers.r2.interfaces.eth0.network).toBe('');
  });

  it('clears host link refs (sets network="", removes link)', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.hosts = {
      h1: { link: 'p2p1', address: '10.0.0.1', x: 0, y: 0 },
    };
    state.routers = {};
    state.selection = { kind: 'link', name: 'p2p1' };
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    deleteSelected();
    expect(state.links.p2p1).toBeUndefined();
    expect(state.hosts.h1.link).toBeUndefined();
    expect(state.hosts.h1.network).toBe('');
  });

  it('clears selection after delete', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.selection = { kind: 'link', name: 'p2p1' };
    deleteSelected();
    expect(state.selection).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Fabric-type dropdown — switching router interface from Network to Link
// ---------------------------------------------------------------------------
describe('renderRouterInsp — fabric-type dropdown', () => {
  it('renders a fabric-type select for each interface', () => {
    state.networks = { lan1: { cidr: '10.1.0.0/24', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.1.0.1', cost: 5 } } },
    };
    state.selection = { kind: 'router', name: 'r1' };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const typeSelect = elI.querySelector('[data-iface-fabric-type="eth0"]');
    expect(typeSelect).not.toBeNull();
    expect(typeSelect.value).toBe('network');
  });

  it('shows Link option selected when iface has link field', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
    };
    state.selection = { kind: 'router', name: 'r1' };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const typeSelect = elI.querySelector('[data-iface-fabric-type="eth0"]');
    expect(typeSelect.value).toBe('link');
  });

  it('switching fabric-type to Link sets iff.link and deletes iff.network', () => {
    state.networks = { lan1: { cidr: '10.1.0.0/24', x: 0, y: 0 } };
    state.links    = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers  = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.1.0.1', cost: 5 } } },
    };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const typeSelect = elI.querySelector('[data-iface-fabric-type="eth0"]');
    typeSelect.value = 'link';
    typeSelect.dispatchEvent(new Event('change'));
    expect(state.routers.r1.interfaces.eth0.link).toBeDefined();
    expect(state.routers.r1.interfaces.eth0.network).toBeUndefined();
  });

  it('switching iface fabric-type to Link defaults to unattached, not the first existing link', () => {
    state.networks = { lan1: { cidr: '10.1.0.0/24', x: 0, y: 0 } };
    state.links    = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers  = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.1.0.1', cost: 5 } } },
    };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const typeSelect = elI.querySelector('[data-iface-fabric-type="eth0"]');
    typeSelect.value = 'link';
    typeSelect.dispatchEvent(new Event('change'));
    // Must NOT auto-attach to p2p1 — that would silently overflow a /30.
    expect(state.routers.r1.interfaces.eth0.link).toBe('');
  });

  it('router iface "+ New link" creates a fresh link and attaches this iface to it', () => {
    state.routers = {
      r1: { x: 100, y: 100, interfaces: { eth0: { link: '', address: '', cost: 0 } } },
    };
    state.links = {};
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const btn = elI.querySelector('[data-iface-new-link="eth0"]');
    expect(btn).not.toBeNull();
    btn.click();
    const created = Object.keys(state.links);
    expect(created.length).toBe(1);
    expect(state.routers.r1.interfaces.eth0.link).toBe(created[0]);
    expect(state.routers.r1.interfaces.eth0.network).toBeUndefined();
  });

  it('switching fabric-type back to Network sets iff.network and deletes iff.link', () => {
    state.networks = { lan1: { cidr: '10.1.0.0/24', x: 0, y: 0 } };
    state.links    = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers  = {
      r1: { x: 0, y: 0, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
    };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const typeSelect = elI.querySelector('[data-iface-fabric-type="eth0"]');
    typeSelect.value = 'network';
    typeSelect.dispatchEvent(new Event('change'));
    expect(state.routers.r1.interfaces.eth0.network).toBeDefined();
    expect(state.routers.r1.interfaces.eth0.link).toBeUndefined();
  });

  it('iface summary shows "link p2p1" when link is set', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
    };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const summary = elI.querySelector('.iface-summary');
    expect(summary).not.toBeNull();
    expect(summary.textContent).toContain('link p2p1');
  });
});

// ---------------------------------------------------------------------------
// 9. Same fabric-type dropdown on host editor
// ---------------------------------------------------------------------------
describe('renderHostInsp — fabric-type dropdown', () => {
  it('renders a fabric-type select for the host', () => {
    state.networks = { lan1: { cidr: '10.1.0.0/24', x: 0, y: 0 } };
    state.hosts = { h1: { network: 'lan1', address: '10.1.0.10', x: 0, y: 0 } };
    state.selection = { kind: 'host', name: 'h1' };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const typeSelect = elI.querySelector('#f-fabric-type');
    expect(typeSelect).not.toBeNull();
    expect(typeSelect.value).toBe('network');
  });

  it('shows Link selected when host has link field', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.hosts = { h1: { link: 'p2p1', address: '10.0.0.1', x: 0, y: 0 } };
    state.selection = { kind: 'host', name: 'h1' };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const typeSelect = elI.querySelector('#f-fabric-type');
    expect(typeSelect.value).toBe('link');
  });

  it('switching to Link sets h.link and deletes h.network', () => {
    state.networks = { lan1: { cidr: '10.1.0.0/24', x: 0, y: 0 } };
    state.links    = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.hosts    = { h1: { network: 'lan1', address: '10.1.0.10', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const typeSelect = elI.querySelector('#f-fabric-type');
    typeSelect.value = 'link';
    typeSelect.dispatchEvent(new Event('change'));
    expect(state.hosts.h1.link).toBeDefined();
    expect(state.hosts.h1.network).toBeUndefined();
  });

  it('switching host fabric-type to Link defaults to unattached, not the first existing link', () => {
    state.networks = { lan1: { cidr: '10.1.0.0/24', x: 0, y: 0 } };
    state.links    = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.hosts    = { h1: { network: 'lan1', address: '10.1.0.10', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const typeSelect = elI.querySelector('#f-fabric-type');
    typeSelect.value = 'link';
    typeSelect.dispatchEvent(new Event('change'));
    expect(state.hosts.h1.link).toBe('');
  });

  it('host editor "+ New link" creates a fresh link and attaches this host to it', () => {
    state.hosts = { h1: { link: '', address: '', x: 100, y: 100 } };
    state.links = {};
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const btn = elI.querySelector('#f-new-link');
    expect(btn).not.toBeNull();
    btn.click();
    const created = Object.keys(state.links);
    expect(created.length).toBe(1);
    expect(state.hosts.h1.link).toBe(created[0]);
    expect(state.hosts.h1.network).toBeUndefined();
  });

  it('host editor "+ New link" button only appears when fabric type is Link', () => {
    state.networks = { lan1: { cidr: '10.1.0.0/24', x: 0, y: 0 } };
    state.hosts = { h1: { network: 'lan1', address: '10.1.0.10', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    expect(elI.querySelector('#f-new-link')).toBeNull();
  });

  it('switching back to Network sets h.network and deletes h.link', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.hosts = { h1: { link: 'p2p1', address: '10.0.0.1', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const typeSelect = elI.querySelector('#f-fabric-type');
    typeSelect.value = 'network';
    typeSelect.dispatchEvent(new Event('change'));
    expect(state.hosts.h1.network).toBeDefined();
    expect(state.hosts.h1.link).toBeUndefined();
  });

  it('hides the gateway field when fabric type is Link', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.hosts = { h1: { link: 'p2p1', address: '10.0.0.1', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const gwField = elI.querySelector('#f-gw-field');
    expect(gwField).not.toBeNull();
    expect(gwField.hidden).toBe(true);
  });

  it('shows the gateway field when fabric type is Network', () => {
    state.networks = { lan1: { cidr: '10.1.0.0/24', x: 0, y: 0 } };
    state.hosts = { h1: { network: 'lan1', address: '10.1.0.10', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const gwField = elI.querySelector('#f-gw-field');
    expect(gwField).not.toBeNull();
    expect(gwField.hidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. duplicateLink — clones the link but not its endpoints
// ---------------------------------------------------------------------------
describe('duplicateLink', () => {
  it('creates a new link entry with a unique name', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    duplicateLink('p2p1');
    // uniqueName('p2p1_', state.links) → 'p2p1_1'
    expect(state.links['p2p1_1']).toBeDefined();
  });

  it('preserves the CIDR of the original', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    duplicateLink('p2p1');
    expect(state.links['p2p1_1'].cidr).toBe('10.0.0.0/30');
  });

  it('does NOT copy endpoints — no router or host references to the new link', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
      r2: { x: 0, y: 0, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.2', cost: 5 } } },
    };
    duplicateLink('p2p1');
    const newName = 'p2p1_1';
    // Original r1 and r2 still reference p2p1, not the clone
    expect(state.routers.r1.interfaces.eth0.link).toBe('p2p1');
    expect(state.routers.r2.interfaces.eth0.link).toBe('p2p1');
    // No router has an interface referencing the new link
    const allLinks = [];
    Object.values(state.routers).forEach(r =>
      Object.values(r.interfaces || {}).forEach(iff => { if (iff.link) allLinks.push(iff.link); })
    );
    expect(allLinks).not.toContain(newName);
  });

  it('sets selection to the new link name', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    duplicateLink('p2p1');
    expect(state.selection).toEqual({ kind: 'link', name: 'p2p1_1' });
  });
});

// ---------------------------------------------------------------------------
// 10b. duplicate-* must work while the sim is paused
//
// Regression: a stale `Sim.state === 'paused'` guard caused all four
// duplicate-* fns to silently no-op in paused mode, even though the context
// menu rendered the item as enabled (locked-check is `running`-only).
// Mirrors addNew, which already records an `add_*` patch op for reconcile.
// ---------------------------------------------------------------------------
describe('duplicate-* in paused sim', () => {
  beforeEach(() => {
    Sim.state = 'paused';
    Sim.patch = [];
  });
  afterEach(() => {
    Sim.state = 'idle';
    Sim.patch = [];
  });

  it('duplicateHost clones the host and records add_host', () => {
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    duplicateHost('h1');
    expect(state.hosts['h1_1']).toBeDefined();
    expect(Sim.patch.some(o => o.op === 'add_host' && o.name === 'h1_1')).toBe(true);
  });

  it('duplicateRouter clones the router and records add_router', () => {
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.0.0.1', cost: 5 } } },
    };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    duplicateRouter('r1');
    expect(state.routers['r1_1']).toBeDefined();
    expect(Sim.patch.some(o => o.op === 'add_router' && o.name === 'r1_1')).toBe(true);
  });

  it('duplicateNetwork clones the LAN and records add_network', () => {
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    duplicateNetwork('lan1');
    expect(state.networks['lan1_1']).toBeDefined();
    expect(Sim.patch.some(o => o.op === 'add_network' && o.name === 'lan1_1')).toBe(true);
  });

  it('duplicateLink clones the link (no patch op — add_link is unsupported)', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    duplicateLink('p2p1');
    expect(state.links['p2p1_1']).toBeDefined();
    // Mirrors addNew: link creation isn't a patch op (server has no add_link).
    expect(Sim.patch.some(o => o.op && o.op.startsWith('add_link'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. Context menu opens for a link target
// ---------------------------------------------------------------------------
describe('openContextMenu — link target', () => {
  it('renders the context menu with the link header', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    openContextMenu(100, 100, { kind: 'link', name: 'p2p1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    expect(ctx).not.toBeNull();
    const head = ctx.querySelector('.ctx-head');
    expect(head.textContent).toContain('link');
    expect(head.textContent).toContain('p2p1');
  });

  it('has an Edit button', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    openContextMenu(100, 100, { kind: 'link', name: 'p2p1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    const items = Array.from(ctx.querySelectorAll('.ctx-item'));
    expect(items.some(b => b.textContent.includes('Edit'))).toBe(true);
  });

  it('has a Duplicate button', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    openContextMenu(100, 100, { kind: 'link', name: 'p2p1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    const items = Array.from(ctx.querySelectorAll('.ctx-item'));
    expect(items.some(b => b.textContent.includes('Duplicate'))).toBe(true);
  });

  it('has a Delete button', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    openContextMenu(100, 100, { kind: 'link', name: 'p2p1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    const items = Array.from(ctx.querySelectorAll('.ctx-item'));
    expect(items.some(b => b.textContent.includes('Delete'))).toBe(true);
  });

  it('does NOT have an "Add endpoint" button (schema requires exactly 2)', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    openContextMenu(100, 100, { kind: 'link', name: 'p2p1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    expect(ctx.textContent).not.toContain('Add endpoint');
  });

  it('clicking Edit sets selection to the link', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    openContextMenu(100, 100, { kind: 'link', name: 'p2p1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    const editBtn = Array.from(ctx.querySelectorAll('.ctx-item'))
      .find(b => b.getAttribute('data-act') === 'edit');
    expect(editBtn).not.toBeNull();
    editBtn.click();
    expect(state.selection).toEqual({ kind: 'link', name: 'p2p1' });
  });

  it('clicking Duplicate creates a new link', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    openContextMenu(100, 100, { kind: 'link', name: 'p2p1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    const dupBtn = Array.from(ctx.querySelectorAll('.ctx-item'))
      .find(b => b.getAttribute('data-act') === 'duplicate');
    expect(dupBtn).not.toBeNull();
    dupBtn.click();
    expect(state.links['p2p1_1']).toBeDefined();
  });

  it('clicking Delete removes the link from state', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    openContextMenu(100, 100, { kind: 'link', name: 'p2p1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    const delBtn = Array.from(ctx.querySelectorAll('.ctx-item'))
      .find(b => b.getAttribute('data-act') === 'delete');
    expect(delBtn).not.toBeNull();
    delBtn.click();
    expect(state.links.p2p1).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. Inline validation — link CIDR field
// ---------------------------------------------------------------------------
describe('renderLinkInsp — inline CIDR validation', () => {
  function setupLink(cidr = '') {
    state.links = { p2p1: { cidr, x: 0, y: 0 } };
    state.routers = {};
  }

  it('renders a .field-error element sibling to #f-cidr', () => {
    setupLink();
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    expect(elI.querySelector('#f-cidr-err')).not.toBeNull();
  });

  it('no validation feedback for empty CIDR', () => {
    setupLink('');
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const input = elI.querySelector('#f-cidr');
    const err = elI.querySelector('#f-cidr-err');
    expect(input.classList.contains('invalid')).toBe(false);
    expect(err.classList.contains('show')).toBe(false);
  });

  it('shows error immediately on render when stored CIDR is invalid (wrong mask)', () => {
    setupLink('10.0.0.0/24');
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const input = elI.querySelector('#f-cidr');
    const err = elI.querySelector('#f-cidr-err');
    expect(input.classList.contains('invalid')).toBe(true);
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toBe('CIDR must be /30 or /31');
  });

  it('shows "not a network address" for host-bit-set /30', () => {
    setupLink('10.0.0.1/30');
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const err = elI.querySelector('#f-cidr-err');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toContain('not a network address');
  });

  it('clears error when user types a valid /30', () => {
    setupLink('10.0.0.1/30'); // start invalid
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const input = elI.querySelector('#f-cidr');
    const err = elI.querySelector('#f-cidr-err');
    input.value = '10.0.0.0/30';
    input.dispatchEvent(new Event('input'));
    expect(input.classList.contains('invalid')).toBe(false);
    expect(err.classList.contains('show')).toBe(false);
  });

  it('shows no error for a valid /31', () => {
    setupLink('10.0.0.4/31');
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const input = elI.querySelector('#f-cidr');
    expect(input.classList.contains('invalid')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. Inline validation — network CIDR field
// ---------------------------------------------------------------------------
describe('renderNetworkInsp — inline CIDR validation', () => {
  it('shows error for a host-bits-set network CIDR', async () => {
    state.networks = { lan1: { cidr: '192.168.0.5/24', x: 0, y: 0 } };
    state.selection = { kind: 'network', name: 'lan1' };
    const { renderNetworkInsp } = await import('./inspector.js');
    const elI = document.getElementById('inspector');
    renderNetworkInsp('lan1', elI);
    const err = elI.querySelector('#f-cidr-err');
    expect(err).not.toBeNull();
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toContain('not a network address');
  });

  it('shows "malformed CIDR" for a bare IP without slash', async () => {
    state.networks = { lan1: { cidr: '192.168.0.0', x: 0, y: 0 } };
    state.selection = { kind: 'network', name: 'lan1' };
    const { renderNetworkInsp } = await import('./inspector.js');
    const elI = document.getElementById('inspector');
    renderNetworkInsp('lan1', elI);
    const err = elI.querySelector('#f-cidr-err');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toBe('malformed CIDR');
  });

  it('shows no error for empty CIDR', async () => {
    state.networks = { lan1: { cidr: '', x: 0, y: 0 } };
    const { renderNetworkInsp } = await import('./inspector.js');
    const elI = document.getElementById('inspector');
    renderNetworkInsp('lan1', elI);
    const err = elI.querySelector('#f-cidr-err');
    expect(err.classList.contains('show')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14. Inline validation — host IP address and gateway fields
// ---------------------------------------------------------------------------
describe('renderHostInsp — inline IP validation', () => {
  it('shows error for invalid IP in #f-addr on render', () => {
    state.hosts = { h1: { network: 'lan1', address: 'bad', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const err = elI.querySelector('#f-addr-err');
    expect(err).not.toBeNull();
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toBe('not a valid IPv4 address');
  });

  it('shows no error for empty #f-addr', () => {
    state.hosts = { h1: { network: 'lan1', address: '', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const err = elI.querySelector('#f-addr-err');
    expect(err.classList.contains('show')).toBe(false);
  });

  it('shows no error for a valid IP in #f-addr', () => {
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const err = elI.querySelector('#f-addr-err');
    expect(err.classList.contains('show')).toBe(false);
  });

  it('clears error when user types a valid IP in #f-addr', () => {
    state.hosts = { h1: { network: 'lan1', address: 'bad', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const input = elI.querySelector('#f-addr');
    const err = elI.querySelector('#f-addr-err');
    input.value = '10.0.0.5';
    input.dispatchEvent(new Event('input'));
    expect(err.classList.contains('show')).toBe(false);
  });

  it('shows error for invalid gateway in #f-gw', () => {
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', gateway: 'notanip', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const err = elI.querySelector('#f-gw-err');
    expect(err).not.toBeNull();
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toBe('not a valid IPv4 address');
  });

  it('shows no error for empty #f-gw', () => {
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const err = elI.querySelector('#f-gw-err');
    expect(err.classList.contains('show')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. Inline validation — router interface address fields
// ---------------------------------------------------------------------------
describe('renderRouterInsp — inline IP validation for iface address', () => {
  it('shows error for invalid IP in iface addr on render', () => {
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: 'notanip', cost: 5 } } },
    };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const err = elI.querySelector('[data-iface-addr-err="eth0"]');
    expect(err).not.toBeNull();
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toBe('not a valid IPv4 address');
  });

  it('shows no error for valid IP in iface addr', () => {
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.0.0.1', cost: 5 } } },
    };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const err = elI.querySelector('[data-iface-addr-err="eth0"]');
    expect(err.classList.contains('show')).toBe(false);
  });

  it('shows no error for empty iface address', () => {
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '', cost: 5 } } },
    };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const err = elI.querySelector('[data-iface-addr-err="eth0"]');
    expect(err.classList.contains('show')).toBe(false);
  });

  it('clears error when user types a valid IP in iface addr input', () => {
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: 'bad', cost: 5 } } },
    };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const input = elI.querySelector('[data-iface-addr="eth0"]');
    const err = elI.querySelector('[data-iface-addr-err="eth0"]');
    input.value = '10.0.0.1';
    input.dispatchEvent(new Event('input'));
    expect(err.classList.contains('show')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 16. Context menu — "New p2p link…" item for host and router targets
// ---------------------------------------------------------------------------
describe('openContextMenu — "New p2p link…" on host and router', () => {
  it('shows "New p2p link…" for a host target', () => {
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    openContextMenu(100, 100, { kind: 'host', name: 'h1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    expect(ctx.textContent).toContain('New p2p link');
    closeContextMenu();
  });

  it('shows "New p2p link…" for a router target', () => {
    state.routers = { r1: { x: 100, y: 100, interfaces: {} } };
    openContextMenu(100, 100, { kind: 'router', name: 'r1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    expect(ctx.textContent).toContain('New p2p link');
    closeContextMenu();
  });

  it('does NOT show "New p2p link…" for a network target', () => {
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    openContextMenu(100, 100, { kind: 'network', name: 'lan1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    // There should be no "New p2p link…" button on network context menus
    const items = Array.from(ctx.querySelectorAll('.ctx-item'));
    expect(items.some(b => b.getAttribute('data-act') === 'new-p2p-link')).toBe(false);
    closeContextMenu();
  });

  it('"New p2p link…" button has data-act="new-p2p-link"', () => {
    state.routers = { r1: { x: 100, y: 100, interfaces: {} } };
    openContextMenu(100, 100, { kind: 'router', name: 'r1' }, { x: 0, y: 0 });
    const ctx = document.querySelector('.ctx');
    const btn = Array.from(ctx.querySelectorAll('.ctx-item'))
      .find(b => b.getAttribute('data-act') === 'new-p2p-link');
    expect(btn).not.toBeNull();
    closeContextMenu();
  });
});

// ---------------------------------------------------------------------------
// 17. Router inspector — NAT table panel
// ---------------------------------------------------------------------------
describe('renderRouterInsp — NAT table panel', () => {
  it('injects an #insp-nat div alongside #insp-routes', () => {
    state.routers = { r1: { x: 0, y: 0, interfaces: {} } };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    expect(elI.querySelector('#insp-nat')).not.toBeNull();
    expect(elI.querySelector('#insp-routes')).not.toBeNull();
  });
});

describe('Inspector.refreshNAT', () => {
  beforeEach(() => {
    document.body.innerHTML += '<div id="insp-nat" hidden></div>';
    Sim.state = 'running';
    state.routers = { r_a: { x: 0, y: 0, interfaces: {} } };
    state.hosts = {};
    state.natTables = {};
  });

  it('hides the panel when there are no entries for the device', () => {
    Inspector.refreshNAT('r_a');
    expect(document.getElementById('insp-nat').hidden).toBe(true);
  });

  it('hides the panel when Sim is idle', () => {
    Sim.state = 'idle';
    state.natTables['r_a'] = [{
      original_src: '192.168.1.10',
      rewritten_src: '200.100.0.1',
      dst: '8.8.8.8',
      flow_id: 7,
    }];
    Inspector.refreshNAT('r_a');
    expect(document.getElementById('insp-nat').hidden).toBe(true);
  });

  it('hides the panel for hosts (no NAT table)', () => {
    state.hosts = { h1: { network: '', address: '', x: 0, y: 0 } };
    state.natTables['h1'] = [{
      original_src: '192.168.1.10',
      rewritten_src: '200.100.0.1',
      dst: '8.8.8.8',
      flow_id: null,
    }];
    Inspector.refreshNAT('h1');
    expect(document.getElementById('insp-nat').hidden).toBe(true);
  });

  it('renders one row per entry with the expected columns', () => {
    state.natTables['r_a'] = [{
      original_src: '192.168.1.10',
      rewritten_src: '200.100.0.1',
      dst: '8.8.8.8',
      flow_id: 7,
    }];
    Inspector.refreshNAT('r_a');
    const sec = document.getElementById('insp-nat');
    expect(sec.hidden).toBe(false);
    expect(sec.innerHTML).toContain('192.168.1.10');
    expect(sec.innerHTML).toContain('200.100.0.1');
    expect(sec.innerHTML).toContain('8.8.8.8');
    expect(sec.innerHTML).toContain('7');
    expect(sec.innerHTML).toContain('NAT table');
    expect(sec.innerHTML).toContain('r_a');
  });

  it('renders an em-dash for entries whose flow_id is null', () => {
    state.natTables['r_a'] = [{
      original_src: '192.168.1.10',
      rewritten_src: '200.100.0.1',
      dst: '8.8.8.8',
      flow_id: null,
    }];
    Inspector.refreshNAT('r_a');
    const sec = document.getElementById('insp-nat');
    expect(sec.innerHTML).toContain('—');
  });

  it('renders multiple entries in the order they appear (oldest first)', () => {
    state.natTables['r_a'] = [
      { original_src: '192.168.1.10', rewritten_src: '200.100.0.1', dst: '1.1.1.1', flow_id: null },
      { original_src: '192.168.1.11', rewritten_src: '200.100.0.1', dst: '2.2.2.2', flow_id: 3 },
    ];
    Inspector.refreshNAT('r_a');
    const sec = document.getElementById('insp-nat');
    const rows = sec.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('1.1.1.1');
    expect(rows[1].textContent).toContain('2.2.2.2');
  });

  it('is a no-op when #insp-nat is missing from the DOM', () => {
    document.getElementById('insp-nat').remove();
    expect(() => Inspector.refreshNAT('r_a')).not.toThrow();
  });
});

describe('Inspector.onNATChange', () => {
  beforeEach(() => {
    document.body.innerHTML += '<div id="insp-nat" hidden></div>';
    Sim.state = 'running';
    state.routers = { r_a: { x: 0, y: 0, interfaces: {} } };
    state.hosts = {};
    state.natTables = {};
  });

  it('re-renders the panel when the changed device matches the current selection', () => {
    state.selection = { kind: 'router', name: 'r_a' };
    state.natTables['r_a'] = [{
      original_src: '192.168.1.10',
      rewritten_src: '200.100.0.1',
      dst: '8.8.8.8',
      flow_id: 1,
    }];
    Inspector.onNATChange({ device: 'r_a' });
    expect(document.getElementById('insp-nat').hidden).toBe(false);
  });

  it('does not re-render when the changed device is not selected', () => {
    state.selection = { kind: 'router', name: 'other' };
    state.natTables['r_a'] = [{
      original_src: '192.168.1.10',
      rewritten_src: '200.100.0.1',
      dst: '8.8.8.8',
      flow_id: 1,
    }];
    Inspector.onNATChange({ device: 'r_a' });
    // Panel stays hidden because refreshNAT was never called for r_a.
    expect(document.getElementById('insp-nat').hidden).toBe(true);
  });
});
