// e2e/protocol-config.spec.js
// Verifies the Protocol popover: open on running sim, check defaults,
// change hello, verify derived dead, apply, assert POST /sim/protocol_config.
import { test, expect } from '@playwright/test';

test('protocol config popover sets hello + refresh', async ({ page, request }) => {
  // Force sim back to idle so the toolbar starts from a clean state.
  await request.post('/sim/stop').catch(() => {});

  await page.addInitScript(() => {
    try { localStorage.clear(); } catch (_) {}
    try { sessionStorage.clear(); } catch (_) {}
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('PAGE ERROR:', msg.text());
  });
  page.on('pageerror', (err) => console.error('PAGE EXCEPTION:', err.message));

  await page.goto('/');
  // Wait for canvas to render.
  await page.waitForSelector('#nodes-layer g.node', { timeout: 5000 });

  // Start the simulation so #tb-protocol enables (it stays disabled in idle).
  await page.click('#tb-play');
  await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 8000 });
  // _renderToolbar enables #tb-protocol when state transitions out of idle.
  // Use evaluate to check the DOM property (not the HTML attribute) directly.
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('#tb-protocol');
      return btn !== null && !btn.disabled;
    },
    { timeout: 8000 },
  );

  // Open the popover.
  await page.click('#tb-protocol');
  await expect(page.locator('#protocol-popover')).toBeVisible();

  // Verify defaults: hello=10, refresh=30, dead=30 (3×hello), maxage=60 (2×refresh).
  await expect(page.locator('#proto-hello')).toHaveValue('10');
  await expect(page.locator('#proto-refresh')).toHaveValue('30');
  await expect(page.locator('#proto-dead')).toContainText('30');
  await expect(page.locator('#proto-maxage')).toContainText('60');

  // Change hello to 5 — derived dead should become 15 (3 × 5).
  await page.fill('#proto-hello', '5');
  await page.locator('#proto-hello').dispatchEvent('input');
  await expect(page.locator('#proto-dead')).toContainText('15');

  // Click Apply and intercept the POST /sim/protocol_config response.
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/sim/protocol_config') && r.status() === 200,
    ),
    page.click('#proto-apply'),
  ]);

  const body = await response.json();
  expect(body.hello_interval).toBe(5);
  expect(body.lsa_refresh_interval).toBe(30);

  // Popover should close on success.
  await expect(page.locator('#protocol-popover')).toBeHidden();
});
