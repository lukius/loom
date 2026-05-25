// e2e/packets-panel.spec.js
// Visual smoke for the Packets panel. Loads the bundled SAMPLE topology,
// starts the sim, sends a datagram from a host terminal, opens the panel,
// and asserts that #1 appears both as a row in the panel and as a badge
// on the in-flight packet dot in the canvas.
import { test, expect } from '@playwright/test';

test.describe('loom Packets panel — visual smoke', () => {
  test.beforeEach(async ({ page, context, request }) => {
    // Shared server state: stop any prior sim and reset the session topology
    // so we always start from the stock SAMPLE (h1/h2/h3 with gateways intact).
    await request.post('/sim/stop').catch(() => {});
    await request.post('/topology/reset').catch(() => {});

    // Wipe storage so init() loads the bundled SAMPLE topology deterministically.
    await context.clearCookies();
    await page.addInitScript(() => {
      try { localStorage.clear(); } catch (_) {}
      try { sessionStorage.clear(); } catch (_) {}
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('PAGE ERROR:', msg.text());
    });
    page.on('pageerror', (err) => console.error('PAGE EXCEPTION:', err.message));

    await page.goto('/');
    await page.waitForSelector('#nodes-layer g.node', { timeout: 5000 });
  });

  test('opens, lists a datagram, and shows #1 badge on the dot', async ({ page }) => {
    // Open the Packets panel before the sim starts to catch the empty state.
    await page.locator('#tb-packets').click();
    await expect(page.locator('#packets-panel')).toBeVisible();

    // Empty state visible before any traffic.
    await expect(page.locator('#packets-panel .packets-empty')).toBeVisible();

    // Start the sim and wait for it to be running. Give routing a moment to converge.
    await page.locator('#tb-play').click();
    await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 8000 });
    await page.waitForTimeout(1500);

    // Fire a datagram from h1 to h2 via the host terminal (double-click pattern).
    // The SAMPLE constant in state.js omits gateways, so the SPA pushes a topology
    // without them at Start time. Configure h1's gateway first so send succeeds.
    await page.locator('#nodes-layer g.node.host[data-name="h1"]').dblclick();
    const term = page.locator('div.term').first();
    await expect(term).toBeVisible({ timeout: 3000 });
    const input = term.locator('textarea.term-in');
    await input.click();
    await input.fill('set_gateway 200.100.0.1');
    await input.press('Enter');
    // Wait briefly for the set_gateway round-trip before sending.
    await page.waitForTimeout(300);
    await input.fill('send h2 hello');
    await input.press('Enter');

    // The row appears in the panel (may be in-flight or recent section).
    await expect(
      page.locator('#packets-panel .pkt-row .pkt-id', { hasText: '#1' }).first(),
    ).toBeVisible({ timeout: 5000 });

    // The badge appears on the canvas dot. May be transient; assert that at
    // least one #1 badge appeared in #packet-layer at some point during the
    // animation window. Use waitForFunction to catch a transient state.
    await page.waitForFunction(
      () => {
        const badges = document.querySelectorAll('#packet-layer text.packet-badge');
        for (const b of badges) if (b.textContent === '#1') return true;
        return false;
      },
      { timeout: 5000 },
    );
  });
});
