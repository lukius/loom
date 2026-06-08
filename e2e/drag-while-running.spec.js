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

test('an in-flight packet follows a node moved mid-flight', async ({ page }) => {
  // Start the sim and wait for routing to converge.
  await page.locator('#tb-play').click();
  await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 8000 });
  await page.waitForTimeout(2000);

  // Open h2's terminal. h2 is on lan2 (100.200.0.0/24) and already has
  // gateway 100.200.0.2 in the sample topology. Using h2 as sender means
  // _segmentsForNetwork builds srcCenter/srcTap as live thunks keyed on h2's
  // DOM/state position, so the dot geometry is tied to h2's location.
  await page.locator('#nodes-layer g.node.host[data-name="h2"]').dblclick();
  const term = page.locator('div.term').first();
  await expect(term).toBeVisible({ timeout: 3000 });
  const input = term.locator('textarea.term-in');
  await input.click();
  // Set the gateway so h2 can route (the session copy may not carry it).
  await input.fill('set_gateway 100.200.0.2');
  await input.press('Enter');
  await page.waitForTimeout(300);
  // Send a one-way datagram — h1 needs no return route.
  await input.fill('send h1 hello');
  await input.press('Enter');

  // Wait for the user_datagram dot to appear in the canvas — it starts at h2's
  // position (first segment: srcCenter = h2's center → srcTap on lan2).
  // Target by packet type to avoid matching routing-chatter dots.
  const dot = page.locator('#packet-layer rect[data-packet-type="user_datagram"]').first();
  await expect(dot).toBeVisible({ timeout: 10000 });

  // Close the terminal so it doesn't block pointer events on the h2 node below.
  await term.locator('.light.close').click();
  await expect(term).not.toBeVisible({ timeout: 2000 });

  // PAUSE the sim immediately. While paused:
  //   - elapsed is frozen → t is constant → the bezier parameter does NOT advance
  //   - rAF keeps firing, so curveFn()/srcTap()/srcCenter() are re-evaluated
  //     every frame against the current DOM/state positions.
  // On OLD code (fixed p0…p3 captured at animation-start) the dot is pinned
  // regardless of node movement. On NEW code (thunk-based geometry) dragging
  // h2 shifts srcCenter(), re-computing the bezier endpoint each frame, so the
  // dot visibly tracks h2 even while t stays constant.
  await page.locator('#tb-pause').click();
  await expect(page.locator('#tb-play')).toHaveClass(/paused/, { timeout: 5000 });

  // Let one rAF tick settle before reading the baseline position.
  await page.waitForTimeout(50);
  const x0 = await dot.getAttribute('x');

  // Drag h2 a large distance while paused. isTopologyLocked() returns false
  // when paused (only true for 'running'), so canvas.js applies the move
  // without snap-back — it updates state.hosts.h2.x/y and the SVG transform.
  const h2node = page.locator('#nodes-layer g.node.host[data-name="h2"]');
  await expect(h2node).toBeVisible();
  const b = await h2node.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  // Move in many steps; each step lets rAF recalculate the dot position from
  // the updated geometry thunks before the next move arrives.
  await page.mouse.move(b.x + 300, b.y + 200, { steps: 30 });
  await page.mouse.up();

  // The dot must have moved from x0. Use poll so we tolerate any final rAF
  // settling after mouseup. Also assert the dot is still in the DOM
  // (a vanished dot would appear to have "changed" from x0).
  await expect(dot).toBeVisible({ timeout: 2000 });
  await expect.poll(() => dot.getAttribute('x'), { timeout: 3000 }).not.toBe(x0);
});
