// e2e/nat.spec.js
// Visual smoke for the NAT pipeline: loads the multi_tenant_nat topology,
// fires a user datagram from a private host to a public destination, then
// asserts both the packet tooltip and the router inspector panel surface
// the NAT translation. The afterEach hook restores samples/sample.yaml so
// other specs in the suite (which assume the bundled SAMPLE topology) keep
// passing — the Playwright server is shared (reuseExistingServer + workers:1).
import fs from 'fs';
import { test, expect } from '@playwright/test';

test.describe('loom NAT - visual smoke', () => {
  test.beforeEach(async ({ page, context, request }) => {
    // Server state persists across tests; force idle before swapping topology.
    await request.post('/sim/stop').catch(() => {});

    // Mirror the server's topology on disk too (so any GET /topology and the
    // post-test reset behave). The SPA itself is local-first — it doesn't
    // fetch the topology from the server on init — so we also have to push
    // the YAML into the SPA via the bus once the page boots (see below).
    const yamlText = fs.readFileSync('samples/multi_tenant_nat.yaml', 'utf-8');
    const res = await request.post('/topology', { data: { yaml: yamlText } });
    expect(res.ok()).toBeTruthy();

    // Wipe storage so the SPA doesn't restore a stale local topology.
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

    // Inject the multi-tenant NAT topology into the SPA. app.js registers a
    // 'sim:topology-import-requested' bus listener that calls importYaml(),
    // which mutates state and re-renders the canvas. We grab the bus via a
    // dynamic import of /state.js (same module-record the SPA loaded, since
    // ES modules are singletons per URL).
    await page.evaluate(async (yaml) => {
      const stateMod = await import('/state.js');
      stateMod.bus.dispatchEvent(new CustomEvent('sim:topology-import-requested', { detail: { yaml } }));
    }, yamlText);

    // Sanity: the NAT topology has 3 hosts + 3 routers; wait until those
    // render before driving the UI. h_a is named explicitly so we can also
    // catch any name mismatch early.
    await expect(page.locator('#nodes-layer g.node.host')).toHaveCount(3, { timeout: 5000 });
    await expect(page.locator('#nodes-layer g.node.router')).toHaveCount(3);
    await expect(page.locator('#nodes-layer g.node.host[data-name="h_a"]')).toHaveCount(1);
  });

  test.afterEach(async ({ request }) => {
    // Make sure the sim is idle before the topology swap.
    await request.post('/sim/stop').catch(() => {});
    const yamlText = fs.readFileSync('samples/sample.yaml', 'utf-8');
    await request.post('/topology', { data: { yaml: yamlText } }).catch(() => {});
  });

  test('private host -> public destination surfaces NAT translation in tooltip and inspector', async ({ page }) => {
    // Start the sim and give the link-state protocol a beat to converge.
    await page.locator('#tb-play').click();
    await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 8000 });
    await page.waitForTimeout(2000);

    // Open a terminal on h_a (the private tenant host) and send to h_public.
    await page.locator('#nodes-layer g.node.host[data-name="h_a"]').dblclick();
    const term = page.locator('div.term').first();
    await expect(term).toBeVisible({ timeout: 3000 });
    const input = term.locator('textarea.term-in');
    await input.click();
    await input.fill('send 200.100.0.10 hello');
    await input.press('Enter');

    // Wait for a user-datagram packet rect to appear on the canvas. Routing
    // chatter is grey (#94a3b8); user datagrams are green (#22c55e). Match by
    // fill so we ignore the unrelated keepalive animations.
    const pktSel = '#packet-layer rect[fill="#22c55e"]';
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length > 0,
      pktSel,
      { timeout: 8000 },
    );

    // Pause so the packet freezes in flight and we can hover it.
    await page.locator('#tb-pause').click();
    await expect(page.locator('#tb-play')).toHaveClass(/paused/, { timeout: 5000 });

    // Hover the frozen user-datagram packet — Sim.state === 'paused' freezes
    // the tween, so the rect stays put while showPacketTooltip runs. Use
    // dispatchEvent rather than mouse hover because the rect is inside an
    // SVG layer that sits underneath the toolbar/zoom overlays in some
    // viewport sizes; the rect's own mouseenter listener is the only thing
    // the tooltip flow actually requires.
    const pkt = page.locator(pktSel).first();
    await pkt.dispatchEvent('mouseenter');

    const tt = page.locator('#packet-tooltip');
    await expect(tt).toBeVisible({ timeout: 3000 });
    // The tooltip headline ("user_datagram: 192.168.1.10 → 200.100.0.10") and
    // the NAT line ("NAT @ r_a: 192.168.1.10 → 198.51.100.1") both reference
    // the original private address; assert that plus the NAT marker.
    await expect(tt).toContainText('NAT');
    await expect(tt).toContainText('r_a');
    await expect(tt).toContainText('192.168.1.10');
    await expect(tt).toContainText('198.51.100.1');

    // Resume so any queued packets drain cleanly before the inspector check.
    await page.locator('#tb-pause').click();
    await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 5000 });

    // Select r_a and assert the NAT table panel surfaces the binding.
    await page.locator('#nodes-layer g.node.router[data-name="r_a"]').click();
    const natPanel = page.locator('#insp-nat');
    await expect(natPanel).toBeVisible({ timeout: 5000 });
    await expect(natPanel).toContainText('192.168.1.10');   // original src
    await expect(natPanel).toContainText('198.51.100.1');   // rewritten src
    await expect(natPanel).toContainText('200.100.0.10');   // destination
  });
});
