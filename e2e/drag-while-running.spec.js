// e2e/drag-while-running.spec.js
// Verifies that node drag-to-reposition works while the sim is running, and
// that foreign-fabric reassignment is refused (snap-back + warn toast).
//
// The sample topology has 3 hosts (h1/h2/h3) and 3 LANs (lan1/lan2/lan3).
// h1 lives on lan1; lan2 is a foreign fabric for h1.
import { test, expect } from '@playwright/test';

// Shared setup: stop any live sim, clear storage, navigate, wait for canvas.
test.beforeEach(async ({ page, context, request }) => {
  await request.post('/sim/stop').catch(() => {});
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

test('repositions a node while the sim is running', async ({ page }) => {
  // Start the sim.
  await page.locator('#tb-play').click();
  await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 8000 });

  const node = page.locator('#nodes-layer g.node.host[data-name="h1"]');
  await expect(node).toBeVisible();
  const before = await node.getAttribute('transform');
  expect(before).toMatch(/translate\(/);

  const box = await node.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // Move well past the 4px drag threshold.
  await page.mouse.move(cx + 20, cy + 10, { steps: 4 });
  await page.mouse.move(cx + 120, cy + 80, { steps: 8 });
  await page.mouse.up();

  // After drop, renderCanvas rebuilds node at new position.
  await expect(async () => {
    const after = await node.getAttribute('transform');
    expect(after).not.toBe(before);
  }).toPass({ timeout: 3000 });
});

test('refuses foreign-fabric reassignment while running: snaps back + warns', async ({ page }) => {
  // Start the sim.
  await page.locator('#tb-play').click();
  await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 8000 });

  // h1 is on lan1; drag it onto lan2 (a foreign fabric).
  const node = page.locator('#nodes-layer g.node.host[data-name="h1"]');
  const lan2 = page.locator('#nodes-layer g.node.network[data-name="lan2"]');

  await expect(node).toBeVisible();
  await expect(lan2).toBeVisible();

  const before = await node.getAttribute('transform');
  const src = await node.boundingBox();
  const dst = await lan2.boundingBox();

  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 12 });
  await page.mouse.up();

  // Node snaps back to its original position.
  await expect.poll(() => node.getAttribute('transform'), { timeout: 3000 }).toBe(before);

  // Warn toast explaining the restriction is shown.
  await expect(page.locator('#toasts .toast.warn')).toContainText(/stop the sim/i);
});
