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
  handleCtxAction,
  Inspector,
} from './inspector.js';
import { Sim, RuntimeClient } from './sim.js';

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

  it('iface summary lists the fabric name and address, but not the cost or a fabric-kind prefix', () => {
    // Collapsed-row summary is "<fabric> · <address>" — short. Kind is
    // implicit from context (and explicit once the iface is expanded);
    // cost is editable inline once expanded so it's not worth a glance.
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.1', cost: 5 } } },
    };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const summary = elI.querySelector('.iface-summary');
    expect(summary).not.toBeNull();
    expect(summary.textContent.trim()).toBe('p2p1 · 10.0.0.1');
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

  it('omits the gateway field from the DOM when fabric type is Link', () => {
    // Hosts on a p2p link have no gateway choice — the peer's IP plays
    // that role and the parser fills it in. Remove the field entirely
    // rather than ship a no-op control.
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.hosts = { h1: { link: 'p2p1', address: '10.0.0.1', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    expect(elI.querySelector('#f-gw-field')).toBeNull();
  });

  it('shows the gateway field when fabric type is Network', () => {
    state.networks = { lan1: { cidr: '10.1.0.0/24', x: 0, y: 0 } };
    state.hosts = { h1: { network: 'lan1', address: '10.1.0.10', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    expect(elI.querySelector('#f-gw-field')).not.toBeNull();
    expect(elI.querySelector('#f-gw')).not.toBeNull();
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
// Right-click "Add host / router here" on a LAN must queue a patch op while
// paused, mirroring the toolbar's addNew() — otherwise the new device exists
// only in the SPA and Resume sees nothing to ship to the server.
// ---------------------------------------------------------------------------
describe('add-host-here / add-router-here in paused sim', () => {
  beforeEach(() => {
    Sim.state = 'paused';
    Sim.patch = [];
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
  });
  afterEach(() => {
    Sim.state = 'idle';
    Sim.patch = [];
  });

  it('add-host-here on lan1 records an add_host op attached to lan1', () => {
    handleCtxAction('add-host-here', { kind: 'network', name: 'lan1' }, { x: 0, y: 0 });
    const newName = Object.keys(state.hosts)[0];
    expect(newName).toBeDefined();
    expect(state.hosts[newName].network).toBe('lan1');
    const op = Sim.patch.find(o => o.op === 'add_host' && o.name === newName);
    expect(op).toBeDefined();
    expect(op.network).toBe('lan1');
  });

  it('add-router-here on lan1 records an add_router op', () => {
    handleCtxAction('add-router-here', { kind: 'network', name: 'lan1' }, { x: 0, y: 0 });
    const newName = Object.keys(state.routers)[0];
    expect(newName).toBeDefined();
    const op = Sim.patch.find(o => o.op === 'add_router' && o.name === newName);
    expect(op).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Editing the gateway of a host that was added during the current pause
// window (i.e. has a pending add_host in Sim.patch) must NOT hit the server
// via deviceCommand — the host doesn't exist there yet. The gateway must
// land in local state and be carried by reconcilePatch on Resume.
// ---------------------------------------------------------------------------
// Same shape as the gateway-on-pending-host bug: editing the cost of an
// interface on a freshly-added router used to queue an `update_cost` op
// that referenced a router the server didn't know about yet, so Resume
// raised "interface_not_found" during patch validation.
describe('cost edit while router has a pending add_router', () => {
  beforeEach(() => {
    Sim.state = 'paused';
    Sim.patch = [];
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
  });
  afterEach(() => {
    Sim.state = 'idle';
    Sim.patch = [];
  });

  it('does not queue update_cost; cost still lands in local state for reconcilePatch', () => {
    handleCtxAction('add-router-here', { kind: 'network', name: 'lan1' }, { x: 0, y: 0 });
    const name = Object.keys(state.routers)[0];
    state.selection = { kind: 'router', name };

    renderRouterInsp(name, document.getElementById('inspector'));
    const costInp = document.querySelector('[data-iface-cost="eth0"]');
    costInp.value = '25';
    costInp.dispatchEvent(new Event('input'));

    // Update_cost MUST NOT have been queued — the server can't apply it
    // until the add_router op has run, and they're validated together.
    expect(Sim.patch.some(o => o.op === 'update_cost' && o.router === name)).toBe(false);
    // Local state still reflects the new cost; reconcilePatch will fold it
    // into the rebuilt add_router op on Resume.
    expect(state.routers[name].interfaces.eth0.cost).toBe(25);
  });
});

describe('host gateway edit while host has a pending add_host', () => {
  beforeEach(() => {
    Sim.state = 'paused';
    Sim.patch = [];
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
  });
  afterEach(() => {
    Sim.state = 'idle';
    Sim.patch = [];
    vi.restoreAllMocks();
  });

  it('skips RuntimeClient.deviceCommand and updates state locally', async () => {
    // Need a peer router on lan1 so the gateway dropdown includes 10.0.0.1
    // as a selectable option.
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.0.0.1', cost: 5 } } },
    };
    // Drop in a host the way the right-click context menu would.
    handleCtxAction('add-host-here', { kind: 'network', name: 'lan1' }, { x: 0, y: 0 });
    const name = Object.keys(state.hosts)[0];
    state.hosts[name].address = '10.0.0.5';
    state.selection = { kind: 'host', name };
    const spy = vi.spyOn(RuntimeClient, 'deviceCommand').mockResolvedValue({ ok: true, output: '' });

    renderHostInsp(name, document.getElementById('inspector'));
    const gw = document.getElementById('f-gw');
    gw.value = '10.0.0.1';
    gw.dispatchEvent(new Event('change'));
    // The handler is async — drain microtasks before checking.
    await Promise.resolve();
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
    expect(state.hosts[name].gateway).toBe('10.0.0.1');
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

  it('renders #f-gw as a SELECT, not a free-text input', () => {
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const gw = elI.querySelector('#f-gw');
    expect(gw).not.toBeNull();
    expect(gw.tagName).toBe('SELECT');
  });

  it('populates #f-gw with router interface IPs on the same fabric', () => {
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 }, lan2: { cidr: '20.0.0.0/24', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.0.0.1', cost: 5 } } },
      r2: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.0.0.254', cost: 5 } } },
      // r3 is on lan2 — must NOT appear in lan1-host's gateway dropdown.
      r3: { x: 0, y: 0, interfaces: { eth0: { network: 'lan2', address: '20.0.0.1', cost: 5 } } },
    };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const gw = elI.querySelector('#f-gw');
    const values = Array.from(gw.options).map(o => o.value);
    expect(values).toContain('10.0.0.1');
    expect(values).toContain('10.0.0.254');
    expect(values).not.toContain('20.0.0.1');
    // Empty value lets the user clear the gateway.
    expect(values).toContain('');
  });

  it('omits the gateway field entirely for a link-attached host', () => {
    // Hosts on a p2p link have no meaningful default-gateway choice — the
    // peer's IP plays that role and the parser fills it in automatically.
    // The field is removed from the DOM (not just hidden) when fabric=link.
    state.hosts = { h1: { link: 'p2p1', address: '192.168.0.1', x: 0, y: 0 } };
    state.links = { p2p1: { cidr: '192.168.0.0/30', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    expect(elI.querySelector('#f-gw')).toBeNull();
    expect(elI.querySelector('#f-gw-field')).toBeNull();
  });

  it('renders the gateway field again after switching fabric type from link back to network', () => {
    state.hosts = { h1: { link: 'p2p1', address: '192.168.0.1', x: 0, y: 0 } };
    state.links = { p2p1: { cidr: '192.168.0.0/30', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    state.selection = { kind: 'host', name: 'h1' };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    expect(elI.querySelector('#f-gw')).toBeNull();
    // User flips to network — the gateway field comes back.
    const typeSel = elI.querySelector('#f-fabric-type');
    typeSel.value = 'network';
    typeSel.dispatchEvent(new Event('change'));
    expect(elI.querySelector('#f-gw')).not.toBeNull();
  });

  it('clears any stored gateway when the host is moved to a link', () => {
    // A gateway carried over from a previous network attachment can't match
    // a p2p peer, so it would just become stale data. Drop it on switch.
    state.hosts = { h1: {
      network: 'lan1', address: '10.0.0.5', gateway: '10.0.0.1', x: 0, y: 0,
    } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    state.links = { p2p1: { cidr: '192.168.0.0/30', x: 0, y: 0 } };
    state.selection = { kind: 'host', name: 'h1' };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const typeSel = elI.querySelector('#f-fabric-type');
    typeSel.value = 'link';
    typeSel.dispatchEvent(new Event('change'));
    expect(state.hosts.h1.gateway).toBeUndefined();
  });

  it('preserves a host gateway that has no matching peer as a stale option', () => {
    // Host carries a gateway from a router that's been removed; the dropdown
    // must keep the value selectable so the user can see and replace it.
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', gateway: '10.0.0.99', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    state.routers = {};
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const gw = elI.querySelector('#f-gw');
    const values = Array.from(gw.options).map(o => o.value);
    expect(values).toContain('10.0.0.99');
    expect(gw.value).toBe('10.0.0.99');
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

  it('flags an iface address that falls outside the network CIDR', () => {
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.50.50.1', cost: 5 } } },
    };
    state.networks = { lan1: { cidr: '200.100.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const err = elI.querySelector('[data-iface-addr-err="eth0"]');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toMatch(/lan1|200\.100\.0\.0/);
  });
});

describe('renderHostInsp — host address must fall inside network CIDR', () => {
  it('flags a host address outside the network CIDR', () => {
    state.hosts = { h1: { network: 'lan1', address: '10.50.50.5', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '200.100.0.0/24', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const err = elI.querySelector('#f-addr-err');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toMatch(/lan1|200\.100\.0\.0/);
  });

  it('flags a link-attached host address outside the link CIDR', () => {
    state.hosts = { h1: { link: 'p2p1', address: '10.0.0.5', x: 0, y: 0 } };
    state.links = { p2p1: { cidr: '192.168.0.0/30', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const err = elI.querySelector('#f-addr-err');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toMatch(/p2p1|192\.168\.0\.0/);
  });
});

describe('renderRouterInsp — iface on link address must fall inside link CIDR', () => {
  it('flags a router-iface address outside the link CIDR', () => {
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { link: 'p2p1', address: '10.0.0.5', cost: 5 } } },
    };
    state.links = { p2p1: { cidr: '192.168.0.0/30', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const err = elI.querySelector('[data-iface-addr-err="eth0"]');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toMatch(/p2p1|192\.168\.0\.0/);
  });
});

// ---------------------------------------------------------------------------
// Changing a host or router-iface's fabric (e.g. moving it from one link to
// another) must re-validate the address against the *new* fabric's CIDR.
// Without a re-wire of the field validator, a previously-valid address can
// silently fall out of the new CIDR.
// ---------------------------------------------------------------------------
describe('host address is flagged when its fabric has no CIDR yet', () => {
  it('flags a host address when the link CIDR is empty (cannot reach the address otherwise)', () => {
    // The user's case: new link starts with cidr=''. Setting an address on a
    // host attached to that link should fail validation immediately so the
    // user sees the problem before hitting Resume.
    state.hosts = { h1: { link: 'p2p1', address: '10.0.0.31', x: 0, y: 0 } };
    state.links = { p2p1: { cidr: '', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const err = elI.querySelector('#f-addr-err');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toMatch(/p2p1/);
  });

  it('flags a host address when the network CIDR is empty', () => {
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    state.networks = { lan1: { cidr: '', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const err = elI.querySelector('#f-addr-err');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toMatch(/lan1/);
  });

  it('stays silent when the host has no fabric set at all (unattached)', () => {
    state.hosts = { h1: { network: '', address: '10.0.0.5', x: 0, y: 0 } };
    state.networks = {};
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    const err = elI.querySelector('#f-addr-err');
    expect(err.classList.contains('show')).toBe(false);
  });
});

describe('switching a host between fabrics rechecks the address CIDR', () => {
  it('flags the host address after the link selection changes to one with a different CIDR', () => {
    state.hosts = { h1: { link: 'p2p1', address: '192.168.0.1', x: 0, y: 0 } };
    state.links = {
      p2p1: { cidr: '192.168.0.0/30', x: 0, y: 0 },
      p2p2: { cidr: '10.0.0.0/30', x: 0, y: 0 },
    };
    // The fabric-name change handler re-renders via renderInspector, which
    // routes off state.selection — set it so the re-render hits the host
    // path and produces the #f-addr-err span we want to inspect.
    state.selection = { kind: 'host', name: 'h1' };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    // Initially valid for p2p1.
    expect(elI.querySelector('#f-addr-err').classList.contains('show')).toBe(false);
    // User picks p2p2 from the link dropdown — same address now falls outside.
    const sel = elI.querySelector('#f-fabric-name');
    sel.value = 'p2p2';
    sel.dispatchEvent(new Event('change'));
    expect(elI.querySelector('#f-addr-err').classList.contains('show')).toBe(true);
    expect(elI.querySelector('#f-addr-err').textContent).toMatch(/p2p2|10\.0\.0\.0/);
  });
});

describe('renderRouterInsp — interface details stay open across a fabric change', () => {
  // The fabric-type / fabric-name selects live inside an <details> block.
  // Their change handlers call renderInspector(), which rewrites the
  // whole panel; without preserving the open state, the user loses the
  // edit context mid-edit.
  beforeEach(() => {
    state.networks = {
      lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 },
      lan2: { cidr: '10.0.1.0/24', x: 0, y: 0 },
    };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: {
        eth0: { network: 'lan1', address: '10.0.0.1', cost: 5 },
        eth1: { network: 'lan2', address: '10.0.1.1', cost: 5 },
      } },
    };
    state.selection = { kind: 'router', name: 'r1' };
  });

  it('keeps eth0 expanded after the user picks a different network', () => {
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const details = elI.querySelector('details.iface[data-iface="eth0"]');
    details.open = true;
    const sel = elI.querySelector('[data-iface-fabric-name="eth0"]');
    sel.value = 'lan2';
    sel.dispatchEvent(new Event('change'));
    // After re-render, the same iface must still be expanded.
    expect(
      elI.querySelector('details.iface[data-iface="eth0"]').open,
    ).toBe(true);
    // Sibling iface that was closed should remain closed.
    expect(
      elI.querySelector('details.iface[data-iface="eth1"]').open,
    ).toBe(false);
  });

  it('keeps the expanded iface open after the fabric-type change', () => {
    state.links = { p2p1: { cidr: '192.168.0.0/30', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const details = elI.querySelector('details.iface[data-iface="eth0"]');
    details.open = true;
    const sel = elI.querySelector('[data-iface-fabric-type="eth0"]');
    sel.value = 'link';
    sel.dispatchEvent(new Event('change'));
    expect(
      elI.querySelector('details.iface[data-iface="eth0"]').open,
    ).toBe(true);
  });
});

describe('switching a router interface between fabrics rechecks the address CIDR', () => {
  it('flags the iface address after the fabric-name selection changes', () => {
    state.routers = {
      r1: { x: 0, y: 0, interfaces: {
        eth0: { link: 'p2p1', address: '192.168.0.1', cost: 5 },
      } },
    };
    state.links = {
      p2p1: { cidr: '192.168.0.0/30', x: 0, y: 0 },
      p2p2: { cidr: '10.0.0.0/30', x: 0, y: 0 },
    };
    state.selection = { kind: 'router', name: 'r1' };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    expect(elI.querySelector('[data-iface-addr-err="eth0"]').classList.contains('show')).toBe(false);
    const sel = elI.querySelector('[data-iface-fabric-name="eth0"]');
    sel.value = 'p2p2';
    sel.dispatchEvent(new Event('change'));
    expect(elI.querySelector('[data-iface-addr-err="eth0"]').classList.contains('show')).toBe(true);
    expect(elI.querySelector('[data-iface-addr-err="eth0"]').textContent).toMatch(/p2p2|10\.0\.0\.0/);
  });
});

// ---------------------------------------------------------------------------
// 15b. Address-uniqueness — host + router interface inspectors flag a
// duplicate address on the same fabric (network or link). Mirrors the
// server-side `address_in_use` patch-validator check so the user catches
// the collision before Resume rejects it.
// ---------------------------------------------------------------------------
describe('renderHostInsp — duplicate-address inline check', () => {
  it('flags a host address already used by another host on the same LAN', () => {
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    state.hosts = {
      h1:   { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 },
      h1_1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 },
    };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1_1', elI);
    const err = elI.querySelector('#f-addr-err');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toContain('already used by h1');
  });

  it('does NOT flag when the colliding host is on a different LAN', () => {
    state.networks = {
      lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 },
      lan2: { cidr: '10.0.0.0/24', x: 0, y: 0 },
    };
    state.hosts = {
      h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 },
      h2: { network: 'lan2', address: '10.0.0.5', x: 0, y: 0 },
    };
    const elI = document.getElementById('inspector');
    renderHostInsp('h2', elI);
    expect(elI.querySelector('#f-addr-err').classList.contains('show')).toBe(false);
  });

  it('does NOT flag the host editing its own address (self-exclusion)', () => {
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    const elI = document.getElementById('inspector');
    renderHostInsp('h1', elI);
    expect(elI.querySelector('#f-addr-err').classList.contains('show')).toBe(false);
  });

  it('flags a host whose link-fabric address collides with another host on the same link', () => {
    state.links = { p2p1: { cidr: '10.0.0.0/30', x: 0, y: 0 } };
    state.hosts = {
      h1: { link: 'p2p1', address: '10.0.0.1', x: 0, y: 0 },
      h2: { link: 'p2p1', address: '10.0.0.1', x: 0, y: 0 },
    };
    const elI = document.getElementById('inspector');
    renderHostInsp('h2', elI);
    const err = elI.querySelector('#f-addr-err');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toContain('already used by h1');
  });
});

describe('renderRouterInsp — duplicate-address inline check', () => {
  it("flags a router interface using an address that's already on a host on the same LAN", () => {
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    state.hosts = { h1: { network: 'lan1', address: '10.0.0.5', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: { eth0: { network: 'lan1', address: '10.0.0.5', cost: 5 } } },
    };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const err = elI.querySelector('[data-iface-addr-err="eth0"]');
    expect(err.classList.contains('show')).toBe(true);
    expect(err.textContent).toContain('already used by h1');
  });

  it('flags intra-router collisions (two interfaces sharing an address on the same LAN)', () => {
    // The first iface holds the address freely; the second is the collision.
    // (Iteration order in JS objects is insertion order, so eth1 sees eth0 already there.)
    state.networks = { lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 } };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: {
        eth0: { network: 'lan1', address: '10.0.0.5', cost: 5 },
        eth1: { network: 'lan1', address: '10.0.0.5', cost: 5 },
      } },
    };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    const eth1Err = elI.querySelector('[data-iface-addr-err="eth1"]');
    expect(eth1Err.classList.contains('show')).toBe(true);
    expect(eth1Err.textContent).toContain('already used by r1/eth0');
  });

  it('does NOT flag a router interface whose siblings sit on different LANs', () => {
    // Both LAN CIDRs cover 10.0.0.5 so that the only effect under test is the
    // cross-LAN duplicate-address check, not the in-CIDR containment check.
    state.networks = {
      lan1: { cidr: '10.0.0.0/24', x: 0, y: 0 },
      lan2: { cidr: '10.0.0.0/16', x: 0, y: 0 },
    };
    state.routers = {
      r1: { x: 0, y: 0, interfaces: {
        eth0: { network: 'lan1', address: '10.0.0.5', cost: 5 },
        eth1: { network: 'lan2', address: '10.0.0.5', cost: 5 },
      } },
    };
    const elI = document.getElementById('inspector');
    renderRouterInsp('r1', elI);
    expect(elI.querySelector('[data-iface-addr-err="eth0"]').classList.contains('show')).toBe(false);
    expect(elI.querySelector('[data-iface-addr-err="eth1"]').classList.contains('show')).toBe(false);
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

  it('hides the panel when there are no entries for the device', async () => {
    // Server returns an empty table for r_a — panel stays hidden.
    RuntimeClient._json = vi.fn(async () => ({ entries: [] }));
    await Inspector.refreshNAT('r_a');
    expect(document.getElementById('insp-nat').hidden).toBe(true);
  });

  it('primes state.natTables from GET /devices/<n>/nat-table on first call, then renders', async () => {
    // Simulates a page reload: the SPA bootstrap left state.natTables
    // empty (no events fired since reload). Inspector must fetch the
    // current snapshot so the panel doesn't stay empty until the next
    // translation happens.
    expect(state.natTables['r_a']).toBeUndefined();
    RuntimeClient._json = vi.fn(async (method, path) => {
      if (method === 'GET' && path === '/devices/r_a/nat-table') {
        return { entries: [{
          original_src: '192.168.1.10',
          rewritten_src: '200.100.0.1',
          dst: '8.8.8.8',
          flow_id: 'abc-uuid-string',
        }] };
      }
      return {};
    });
    await Inspector.refreshNAT('r_a');
    expect(state.natTables['r_a']).toBeDefined();
    expect(state.natTables['r_a'].length).toBe(1);
    const sec = document.getElementById('insp-nat');
    expect(sec.hidden).toBe(false);
    expect(sec.innerHTML).toContain('192.168.1.10');
  });

  it('does NOT re-fetch when state.natTables already has the device cached', async () => {
    // Avoids a race where an in-flight fetch overwrites a newer event-driven
    // update. Events are the steady-state source of truth; the fetch is just
    // a prime on cold start.
    state.natTables['r_a'] = [{
      original_src: '10.0.0.1', rewritten_src: '1.1.1.1', dst: '8.8.8.8', flow_id: null,
    }];
    const spy = vi.fn(async () => ({ entries: [] }));
    RuntimeClient._json = spy;
    await Inspector.refreshNAT('r_a');
    expect(spy).not.toHaveBeenCalled();
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

  it('truncates long string flow_ids (UUIDs) to a short prefix, full value in title', () => {
    // Flow_ids are now conversation UUIDs (~36 chars). Rendering them in
    // full would overflow the NAT column we tuned to fit on one line.
    const fullUuid = '0123456789abcdef-0123-4567-89ab-cdef01234567';
    state.natTables['r_a'] = [{
      original_src: '192.168.1.10',
      rewritten_src: '200.100.0.1',
      dst: '8.8.8.8',
      flow_id: fullUuid,
    }];
    Inspector.refreshNAT('r_a');
    const cell = document.querySelector('#insp-nat tbody tr td:nth-child(4)');
    expect(cell.textContent.length).toBeLessThan(fullUuid.length);
    // The full id should still be accessible via the title (hover tooltip).
    expect(cell.getAttribute('title')).toBe(fullUuid);
  });

  it('renders short flow_ids verbatim (no truncation)', () => {
    state.natTables['r_a'] = [{
      original_src: '192.168.1.10',
      rewritten_src: '200.100.0.1',
      dst: '8.8.8.8',
      flow_id: 7,
    }];
    Inspector.refreshNAT('r_a');
    const cell = document.querySelector('#insp-nat tbody tr td:nth-child(4)');
    expect(cell.textContent).toBe('7');
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
