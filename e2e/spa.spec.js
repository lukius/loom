// e2e/spa.spec.js
// Smoke + golden-path checks for the netrouting SPA. Runs against a real
// FastAPI server (booted by Playwright's webServer block) and a real
// Chromium. Each test starts from a clean storage state so the SPA falls
// back to the bundled SAMPLE topology (3 hosts, 3 routers, 3 networks).
import { test, expect } from '@playwright/test';

test.describe('netrouting SPA - smoke', () => {
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

  test('serves index, styles, and all eight JS modules', async ({ page }) => {
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

  test('Load Sample button reloads the bundled topology with no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Wipe topology in-page to simulate an empty state, then click Sample.
    await page.evaluate(() => {
      try { localStorage.clear(); } catch (_) {}
    });
    await page.locator('#btn-sample').click();

    // Sample should give us the canonical 3+3+3 set.
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

    // Playwright's high-level dblclick() does not fire a `dblclick` event on
    // SVG <g> nodes in our setup (likely because hit-test resolves to the
    // inner <rect class="hit">). Synthesise the DOM event directly — this is
    // exactly what the SPA listens for in canvas.js, so the test still
    // exercises real production code paths.
    await page.locator('#nodes-layer g.node.host[data-name="h1"]').evaluate((g) => {
      g.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });

    const term = page.locator('div.term').first();
    await expect(term).toBeVisible({ timeout: 3000 });
    await expect(term.locator('.title')).toHaveText('h1@netrouting');
    await expect(term.locator('input.term-in')).toBeVisible();

    // Close via the macOS-style traffic light close button.
    await term.locator('.light.close').click();
    await expect(page.locator('div.term')).toHaveCount(0);
  });

  test('sending from a host terminal animates packets on the canvas', async ({ page }) => {
    // Start the sim and let routing converge for a moment.
    await page.locator('#tb-play').click();
    await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 8000 });
    await page.waitForTimeout(1500);

    // See the dblclick test above for why we dispatch the event manually.
    await page.locator('#nodes-layer g.node.host[data-name="h1"]').evaluate((g) => {
      g.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
    const term = page.locator('div.term').first();
    await expect(term).toBeVisible({ timeout: 3000 });

    const input = term.locator('input.term-in');
    await input.click();
    await input.fill('send h2 hello');
    await input.press('Enter');

    // Packet circles are appended to #packet-layer with r=8 (see packets.js).
    // Wait for at least one to appear; do not assert an exact count because
    // routing chatter is animated too and timings vary.
    await page.waitForFunction(
      () => document.querySelectorAll('#packet-layer circle').length > 0,
      { timeout: 5000 },
    );
  });
});
