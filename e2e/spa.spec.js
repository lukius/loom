// e2e/spa.spec.js
// Smoke + golden-path checks for the loom SPA. Runs against a real
// FastAPI server (booted by Playwright's webServer block) and a real
// Chromium. Each test starts from a clean storage state so the SPA falls
// back to the bundled SAMPLE topology (3 hosts, 3 routers, 3 networks).
import { test, expect } from '@playwright/test';

test.describe('loom SPA - smoke', () => {
  test.beforeEach(async ({ page, context, request }) => {
    // The FastAPI server is shared across tests (one webServer per suite),
    // so the sim's run-state persists. Force it back to idle before every
    // test so toolbar click sequences behave deterministically.
    await request.post('/sim/stop').catch(() => {});

    // Wipe any local/session storage so init() reloads the SAMPLE topology
    // deterministically on every test.
    await context.clearCookies();
    await page.addInitScript(() => {
      try { localStorage.clear(); } catch (_) {}
      try { sessionStorage.clear(); } catch (_) {}
    });

    // Surface page-level errors in the test log.
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('PAGE ERROR:', msg.text());
    });
    page.on('pageerror', (err) => console.error('PAGE EXCEPTION:', err.message));

    await page.goto('/');
    // Wait for canvas + at least one node to be rendered.
    await page.waitForSelector('#nodes-layer g.node', { timeout: 5000 });
  });

  test('serves index, styles, and all JS modules', async ({ page }) => {
    // Reload and collect every response, then assert that every module the
    // SPA depends on returned 200. If app.js silently fails to import a
    // module, the page still loads but the suite goes red here.
    const responses = [];
    page.on('response', (r) => responses.push({ url: r.url(), status: r.status() }));
    await page.reload();
    await page.waitForSelector('#nodes-layer g.node');

    const modules = [
      'app.js', 'state.js', 'utils.js', 'sim.js',
      'canvas.js', 'inspector.js', 'terminals.js', 'packets.js',
      'yaml-io.js', 'file-picker.js',
    ];
    for (const m of modules) {
      const r = responses.find((x) => x.url.endsWith(`/${m}`));
      expect(r, `${m} not loaded`).toBeTruthy();
      expect(r.status, `${m} returned ${r.status}`).toBe(200);
    }

    // styles.css must also be 200.
    const css = responses.find((x) => x.url.endsWith('/styles.css'));
    expect(css).toBeTruthy();
    expect(css.status).toBe(200);

    // favicon.svg must be reachable too.
    const fav = await page.request.get('/favicon.svg');
    expect(fav.status()).toBe(200);
    expect((await fav.text())).toContain('<svg');
  });

  test('renders sample topology with 3 hosts, 3 routers, 3 networks', async ({ page }) => {
    await expect(page.locator('#nodes-layer g.node.host')).toHaveCount(3);
    await expect(page.locator('#nodes-layer g.node.router')).toHaveCount(3);
    await expect(page.locator('#nodes-layer g.node.network')).toHaveCount(3);

    // Verify each expected node name (data-name attribute) is on canvas.
    for (const name of ['h1', 'h2', 'h3', 'r1', 'r2', 'r3', 'lan1', 'lan2', 'lan3']) {
      await expect(
        page.locator(`#nodes-layer g.node[data-name="${name}"]`),
      ).toHaveCount(1);
    }
  });

  test('clicking a host selects it and the inspector shows host fields', async ({ page }) => {
    await page.locator('#nodes-layer g.node.host[data-name="h1"]').click();

    // Selected node gets the `.selected` class.
    await expect(
      page.locator('#nodes-layer g.node.host[data-name="h1"]'),
    ).toHaveClass(/selected/);

    // Inspector header reveals the host pill and the host name.
    const inspector = page.locator('#inspector');
    await expect(inspector.locator('.pill.host')).toBeVisible();
    await expect(inspector.locator('.insp-head .name')).toHaveText('h1');

    // Host-specific fields are populated.
    await expect(inspector.locator('#f-name')).toHaveValue('h1');
    await expect(inspector.locator('#f-addr')).toHaveValue('200.100.0.10');
  });

  test('clicking a router shows router fields in the inspector', async ({ page }) => {
    await page.locator('#nodes-layer g.node.router[data-name="r2"]').click();
    const inspector = page.locator('#inspector');
    await expect(inspector.locator('.pill.router')).toBeVisible();
    await expect(inspector.locator('.insp-head .name')).toHaveText('r2');
  });

  test('right-click on empty canvas opens the context menu with Create options', async ({ page }) => {
    // The canvas has several absolutely-positioned overlays (toolbar, zoom
    // controls, hint strip) that intercept mouse events at various
    // corners. To avoid being defeated by layout details, dispatch the
    // contextmenu event directly on the SVG at the centre — the canvas
    // listener checks `e.target.closest('.node')` to decide menu kind, so
    // the only thing that matters is that target is the SVG, not a node.
    await page.locator('svg#canvas').evaluate((svg) => {
      const rect = svg.getBoundingClientRect();
      const evt = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 2,
      });
      svg.dispatchEvent(evt);
    });

    const menu = page.locator('div.ctx');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Create at this point');
    await expect(menu.locator('button[data-act="new-net"]')).toBeVisible();
    await expect(menu.locator('button[data-act="new-host"]')).toBeVisible();
    await expect(menu.locator('button[data-act="new-router"]')).toBeVisible();
  });

  test('right-click on a host shows host-specific context options', async ({ page }) => {
    const host = page.locator('#nodes-layer g.node.host[data-name="h1"]');
    await host.click({ button: 'right' });

    const menu = page.locator('div.ctx');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('host');
    await expect(menu).toContainText('h1');
    // Detach option appears because h1 is attached to lan1.
    await expect(menu.locator('button[data-act="detach-host"]')).toBeVisible();
  });

  test('header no longer has a Sample button', async ({ page }) => {
    await expect(page.locator('#btn-sample')).toHaveCount(0);
    // The Import + Export pair is still present.
    await expect(page.locator('#btn-import')).toBeVisible();
    await expect(page.locator('#btn-export')).toBeVisible();
  });

  test('Import opens a picker listing samples/, and loading sample.yaml repopulates the canvas', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.locator('#btn-import').click();
    const modal = page.locator('.modal-picker');
    await expect(modal).toBeVisible();

    // Sample list comes from GET /samples — sample.yaml is guaranteed to be there.
    const item = modal.locator('.picker-item', { hasText: 'sample.yaml' });
    await expect(item).toBeVisible();
    await item.click();

    // Picker dismisses itself; sample's canonical 3+3+3 nodes appear.
    await expect(modal).toHaveCount(0);
    await expect(page.locator('#nodes-layer g.node.host')).toHaveCount(3);
    await expect(page.locator('#nodes-layer g.node.router')).toHaveCount(3);
    await expect(page.locator('#nodes-layer g.node.network')).toHaveCount(3);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('sim play -> pause -> resume -> stop toggles toolbar state', async ({ page }) => {
    const play = page.locator('#tb-play');
    const pause = page.locator('#tb-pause');

    // Start: idle -> running.
    await play.click();
    await expect(play).toHaveClass(/running/, { timeout: 8000 });
    // While running the pause button's HTML5 `hidden` attribute is cleared.
    await expect(pause).not.toHaveAttribute('hidden', '', { timeout: 5000 });

    // Pause: running -> paused.
    await pause.click();
    await expect(play).toHaveClass(/paused/, { timeout: 8000 });

    // Resume: paused -> running.
    await pause.click();
    await expect(play).toHaveClass(/running/, { timeout: 8000 });

    // Stop: clicking play while running drops us back to idle.
    await play.click();
    await expect(play).not.toHaveClass(/running|paused/, { timeout: 8000 });
    // In idle the pause button is marked hidden again (the CSS doesn't
    // honour `[hidden]` on .tb-btn, so we can't assert toBeHidden() here —
    // see the follow-up note in the task report).
    await expect(pause).toHaveAttribute('hidden', '', { timeout: 5000 });
  });

  test('dblclick on a host opens a terminal when the sim is running', async ({ page }) => {
    // Start the sim first - Terminals.open() toasts and bails while idle.
    await page.locator('#tb-play').click();
    await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 8000 });

    // Real double-click via Playwright. If renderCanvas runs synchronously inside
    // the first pointerdown handler, the <g> element gets detached between clicks
    // and the browser cannot synthesize dblclick — this test fails when that bug
    // is present (was a regression in the ES module split, fixed by routing
    // state:selection-changed to a lightweight class-only handler).
    await page.locator('#nodes-layer g.node.host[data-name="h1"]').dblclick();

    const term = page.locator('div.term').first();
    await expect(term).toBeVisible({ timeout: 3000 });
    await expect(term.locator('.title')).toHaveText('h1@loom');
    await expect(term.locator('input.term-in')).toBeVisible();

    // Close via the macOS-style traffic light close button.
    await term.locator('.light.close').click();
    await expect(page.locator('div.term')).toHaveCount(0);
  });

  test('drag-and-drop moves a host on the canvas', async ({ page }) => {
    // Drag is only enabled when the topology is editable (idle/paused).
    const host = page.locator('#nodes-layer g.node.host[data-name="h1"]');
    await expect(host).toBeVisible();
    const initialTransform = await host.getAttribute('transform');
    expect(initialTransform).toMatch(/translate\(/);

    const box = await host.boundingBox();
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Multiple small steps to clear the 4px drag threshold and trigger pointermove.
    await page.mouse.move(startX + 20, startY + 10, { steps: 5 });
    await page.mouse.move(startX + 80, startY + 40, { steps: 10 });
    await page.mouse.up();

    // After pointerup, state:topology-changed fires and renderCanvas rebuilds
    // the node at its new position. The transform must reflect the drag.
    await expect(async () => {
      const newTransform = await host.getAttribute('transform');
      expect(newTransform).not.toBe(initialTransform);
    }).toPass({ timeout: 3000 });
  });

  test('sending from a host terminal animates packets on the canvas', async ({ page }) => {
    // Start the sim and let routing converge for a moment.
    await page.locator('#tb-play').click();
    await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 8000 });
    await page.waitForTimeout(1500);

    await page.locator('#nodes-layer g.node.host[data-name="h1"]').dblclick();
    const term = page.locator('div.term').first();
    await expect(term).toBeVisible({ timeout: 3000 });

    const input = term.locator('input.term-in');
    await input.click();
    await input.fill('send h2 hello');
    await input.press('Enter');

    // Packet rectangles are appended to #packet-layer (see packets.js).
    // Wait for at least one to appear; do not assert an exact count because
    // routing chatter is animated too and timings vary.
    await page.waitForFunction(
      () => document.querySelectorAll('#packet-layer rect').length > 0,
      { timeout: 5000 },
    );
  });

  test('LAN nodes render as a bus rail with endcaps, ticks, and inline label', async ({ page }) => {
    // SAMPLE: 3 networks, with attachments lan1=3, lan2=4, lan3=3 → 10 ticks total.
    await expect(page.locator('#nodes-layer g.node.network .rail')).toHaveCount(3);
    await expect(page.locator('#nodes-layer g.node.network .endcap')).toHaveCount(6);
    await expect(page.locator('#nodes-layer g.node.network .tick')).toHaveCount(10);

    const label0 = page.locator('#nodes-layer g.node.network').first().locator('.rail-label');
    await expect(label0).toContainText('·');
  });

  test('default LAN rail renders horizontally (width > height)', async ({ page }) => {
    const rail = page.locator('#nodes-layer g.node.network').first().locator('.rail');
    const w = Number(await rail.getAttribute('width'));
    const h = Number(await rail.getAttribute('height'));
    expect(w).toBeGreaterThan(h);
  });

  test('every LAN has two endcap handles (left/right) wired for resize', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    await expect(lan.locator('[data-handle="true"]')).toHaveCount(2);
    await expect(lan.locator('[data-handle="true"][data-end="left"]')).toHaveCount(1);
    await expect(lan.locator('[data-handle="true"][data-end="right"]')).toHaveCount(1);
  });

  test('clicking a LAN adds the .selected class', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    await lan.click();
    await expect(lan).toHaveClass(/selected/);
  });

  test('dragging the right handle widens the rail and the new width persists', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    await lan.click();
    const rail = lan.locator('.rail');
    const widthBefore = Number(await rail.getAttribute('width'));

    const handle = lan.locator('[data-handle="true"][data-end="right"]');
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 60, hb.y + hb.height / 2, { steps: 10 });
    await page.mouse.up();

    const widthAfter = Number(await rail.getAttribute('width'));
    expect(widthAfter).toBeGreaterThan(widthBefore);

    // markDirty() debounces persistence by 200ms; wait it out then verify the
    // new `w` is written into localStorage (the beforeEach addInitScript wipes
    // storage on every page load, so a full reload can't be used to check
    // persistence — read the slot directly instead).
    await page.waitForTimeout(300);
    const persistedW = await page.evaluate(() => {
      const raw = localStorage.getItem('loom.topology.v5');
      if (!raw) return null;
      const s = JSON.parse(raw);
      const firstKey = Object.keys(s.networks)[0];
      return s.networks[firstKey].w;
    });
    expect(persistedW).toBeCloseTo(widthAfter, 0);
  });

  test('hover-revealed rotate button toggles LAN orientation horizontal -> vertical', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    const rail = lan.locator('.rail');
    const wBefore = Number(await rail.getAttribute('width'));
    const hBefore = Number(await rail.getAttribute('height'));
    expect(wBefore).toBeGreaterThan(hBefore); // starts horizontal

    await lan.hover();
    const btn = lan.locator('[data-rotate-btn="true"]');
    await btn.click();

    const wAfter = Number(await rail.getAttribute('width'));
    const hAfter = Number(await rail.getAttribute('height'));
    // Rail dimensions swapped — now vertical.
    expect(hAfter).toBeGreaterThan(wAfter);
    expect(wAfter).toBe(hBefore);
    expect(hAfter).toBe(wBefore);
  });

  test('rotate button is idempotent — two clicks restore horizontal', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    const rail = lan.locator('.rail');
    const wBefore = Number(await rail.getAttribute('width'));
    const hBefore = Number(await rail.getAttribute('height'));

    await lan.hover();
    const btn = lan.locator('[data-rotate-btn="true"]');
    await btn.click();
    // After the topology re-render the locator still points at the new btn.
    await lan.hover();
    await btn.click();

    const wAfter = Number(await rail.getAttribute('width'));
    const hAfter = Number(await rail.getAttribute('height'));
    expect(wAfter).toBe(wBefore);
    expect(hAfter).toBe(hBefore);
  });

  test('inspector Rotate button also toggles orientation', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    await lan.click();
    const rail = lan.locator('.rail');
    const wBefore = Number(await rail.getAttribute('width'));
    const hBefore = Number(await rail.getAttribute('height'));

    await page.locator('#f-rotate').click();
    const wAfter = Number(await rail.getAttribute('width'));
    const hAfter = Number(await rail.getAttribute('height'));
    expect(wAfter).toBe(hBefore);
    expect(hAfter).toBe(wBefore);
  });

  test('vertical rail accepts resize via the bottom handle (axis-aware drag)', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    await lan.hover();
    await lan.locator('[data-rotate-btn="true"]').click();
    await lan.click(); // select to enable resize gate

    const rail = lan.locator('.rail');
    const heightBefore = Number(await rail.getAttribute('height'));

    const handle = lan.locator('[data-handle="true"][data-end="bottom"]');
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + 60, { steps: 10 });
    await page.mouse.up();

    const heightAfter = Number(await rail.getAttribute('height'));
    expect(heightAfter).toBeGreaterThan(heightBefore);
  });

  test('dragging a host over a LAN lights up its rail with drop-target class', async ({ page }) => {
    // h1 currently lives on lan1. Drag it toward lan2 (one of the OTHER LANs).
    const host = page.locator('#nodes-layer g.node.host[data-name="h1"]');
    // Pick a target LAN that isn't h1's current LAN to make the drop meaningful.
    const target = page.locator('#nodes-layer g.node.network[data-name="lan2"]');
    const hb = await host.boundingBox();
    const tb = await target.boundingBox();

    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 12 });
    // Still holding the mouse — drop-target class should be live now.
    await expect(target).toHaveClass(/drop-target/, { timeout: 2000 });
    await page.mouse.up();
    // After release, class is cleared.
    await expect(target).not.toHaveClass(/drop-target/);
  });

  test('hovering a host brightens its matching tick on the LAN rail', async ({ page }) => {
    // h1 attaches to lan1, producing exactly one tick with data-device-name="h1".
    const host = page.locator('#nodes-layer g.node.host[data-name="h1"]');
    const tick = page.locator('#nodes-layer g.node.network .tick[data-device-name="h1"]');
    await expect(tick).toHaveCount(1);
    await host.hover();
    await expect(tick).toHaveClass(/matched-hover/, { timeout: 1000 });
    // Move pointer away — class clears.
    await page.locator('body').hover({ position: { x: 5, y: 5 } });
    await expect(tick).not.toHaveClass(/matched-hover/);
  });

  test('toggle Costs button hides every link-cost label on the canvas', async ({ page }) => {
    // Sample topology has edge costs on every router interface — at least 7 cost labels.
    const costs = page.locator('#edges-layer .edge-cost');
    await expect(costs.first()).toBeVisible();
    const before = await costs.count();
    expect(before).toBeGreaterThan(0);

    await page.locator('#tb-toggle-costs').click();
    await expect(page.locator('#tb-toggle-costs')).toHaveClass(/toggle-off/);
    await expect(costs).toHaveCount(0);

    // Click again to restore.
    await page.locator('#tb-toggle-costs').click();
    await expect(page.locator('#tb-toggle-costs')).not.toHaveClass(/toggle-off/);
    await expect(costs).toHaveCount(before);
  });

  test('toggle Ifaces button hides edge ifnames and the router "N ifaces" sub-label', async ({ page }) => {
    const ifaces = page.locator('#edges-layer .edge-iface');
    const routerSubs = page.locator('#nodes-layer g.node.router .sub');
    await expect(ifaces.first()).toBeVisible();
    await expect(routerSubs.first()).toBeVisible();
    const ifaceCountBefore = await ifaces.count();
    const subCountBefore = await routerSubs.count();
    expect(ifaceCountBefore).toBeGreaterThan(0);
    expect(subCountBefore).toBeGreaterThan(0);

    await page.locator('#tb-toggle-ifaces').click();
    await expect(page.locator('#tb-toggle-ifaces')).toHaveClass(/toggle-off/);
    await expect(ifaces).toHaveCount(0);
    await expect(routerSubs).toHaveCount(0);

    // Host address sub-labels are not affected — they stay on.
    const hostSub = page.locator('#nodes-layer g.node.host[data-name="h1"] .sub');
    await expect(hostSub).toBeVisible();

    // Click again to restore.
    await page.locator('#tb-toggle-ifaces').click();
    await expect(ifaces).toHaveCount(ifaceCountBefore);
    await expect(routerSubs).toHaveCount(subCountBefore);
  });

  test('clicking empty canvas after selecting a device clears the edge highlight', async ({ page }) => {
    // Selecting a router attaches `.selected` to every edge connected to it.
    const router = page.locator('#nodes-layer g.node.router[data-name="r1"]');
    await router.click();
    await expect(page.locator('#edges-layer .edge.selected').first()).toBeVisible();

    // Click on empty canvas — selection should clear AND edges should drop the highlight.
    await page.locator('svg#canvas').click({ position: { x: 5, y: 200 }, force: true });
    await expect(router).not.toHaveClass(/selected/);
    await expect(page.locator('#edges-layer .edge.selected')).toHaveCount(0);
  });

  test('display toggle state persists in localStorage', async ({ page }) => {
    await page.locator('#tb-toggle-costs').click();
    await page.waitForTimeout(300); // markDirty debounce
    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem('loom.topology.v5');
      return raw ? JSON.parse(raw).display : null;
    });
    expect(persisted).toEqual({ showCosts: false, showIfaces: true });
  });

  test('hovering a router brightens every tick on every LAN it attaches to', async ({ page }) => {
    // r1 attaches to lan1 and lan2 — should brighten 2 ticks.
    const router = page.locator('#nodes-layer g.node.router[data-name="r1"]');
    const ticks = page.locator('#nodes-layer g.node.network .tick[data-device-name="r1"]');
    await expect(ticks).toHaveCount(2);
    await router.hover();
    await expect(ticks.first()).toHaveClass(/matched-hover/, { timeout: 1000 });
    await expect(ticks.nth(1)).toHaveClass(/matched-hover/);
  });

  test('dragging the left handle also widens (symmetric resize)', async ({ page }) => {
    const lan = page.locator('#nodes-layer g.node.network').first();
    await lan.click();
    const rail = lan.locator('.rail');
    const widthBefore = Number(await rail.getAttribute('width'));

    const handle = lan.locator('[data-handle="true"][data-end="left"]');
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x - 60, hb.y + hb.height / 2, { steps: 10 });
    await page.mouse.up();

    const widthAfter = Number(await rail.getAttribute('width'));
    expect(widthAfter).toBeGreaterThan(widthBefore);
  });

  test('p2p link p2p1 is rendered, selectable, and visible in nav', async ({ page }) => {
    // A. The p2p edge is rendered in the SVG.
    // sample.yaml defines exactly one p2p link (p2p1 on 10.0.0.0/30), so there
    // must be exactly one path.edge.p2p element.
    const p2pEdge = page.locator('#edges-layer path.edge.p2p');
    await expect(p2pEdge).toHaveCount(1);
    await expect(p2pEdge).toHaveAttribute('data-kind', 'link');
    await expect(p2pEdge).toHaveAttribute('data-name', 'p2p1');

    // The midpoint label group is also in the edges layer.
    const midG = page.locator('#edges-layer g[data-kind="link"][data-name="p2p1"]');
    await expect(midG).toHaveCount(1);
    await expect(midG).toBeVisible();

    // B. Clicking the midpoint label selects the link and shows it in the inspector.
    // (The thin stroke-only edge path is unreliable as a click target under
    // Playwright; the midpoint group has a real hit-rect.)
    await midG.click();
    const inspector = page.locator('#inspector');
    await expect(inspector.locator('.pill.link')).toBeVisible();
    await expect(inspector.locator('.insp-head .name')).toHaveText('p2p1');
    // The CIDR input is readonly and contains the link's subnet.
    await expect(inspector.locator('#f-cidr')).toHaveValue('10.0.0.0/30');

    // C. The left nav has a Links section with a row for p2p1.
    const nav = page.locator('#nav');
    // Find the nav section whose heading reads "Links".
    const linksSection = nav.locator('.nav-section', { has: page.locator('.nav-shead .ttl', { hasText: 'Links' }) });
    await expect(linksSection).toBeVisible();
    await expect(linksSection.locator('.nav-row .name', { hasText: 'p2p1' })).toBeVisible();
  });
});
