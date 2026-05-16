// web/inspector.test.js
// Tests for inspector.js: nav links section, link editor, CRUD ops,
// fabric-type dropdowns, and context menu for p2p links.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state, bus } from './state.js';
import {
  renderNav,
  renderInspector,
  renderLinkInsp,
  renderHostInsp,
  renderRouterInsp,
  renameLink,
  duplicateLink,
  deleteSelected,
  openContextMenu,
  closeContextMenu,
} from './inspector.js';

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

  it('shows the CIDR in a readonly input', () => {
    setupLink();
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const cidrInput = elI.querySelector('#f-cidr');
    expect(cidrInput).not.toBeNull();
    expect(cidrInput.value).toBe('10.0.0.0/30');
  });

  it('CIDR field has readonly attribute', () => {
    setupLink();
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    const cidrInput = elI.querySelector('#f-cidr');
    expect(cidrInput.hasAttribute('readonly')).toBe(true);
  });

  it('shows a hint about immutability on the CIDR field', () => {
    setupLink();
    const elI = document.getElementById('inspector');
    renderLinkInsp('p2p1', elI);
    expect(elI.textContent).toContain('Immutable');
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
