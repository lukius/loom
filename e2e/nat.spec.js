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

    // Open a terminal on h_a (the private tenant host).
    await page.locator('#nodes-layer g.node.host[data-name="h_a"]').dblclick();
    const term = page.locator('div.term').first();
    await expect(term).toBeVisible({ timeout: 3000 });
    const input = term.locator('textarea.term-in');

    // Send a datagram and wait for the sim:nat event to arrive in PacketStore.
    // The packet may be silently dropped if the link-state protocol hasn't
    // fully converged yet (no route to host → exception swallowed in
    // Interface._pkt_loop, no NAT event emitted). To avoid a fixed sleep that
    // is long enough for the worst case but slow on the fast path, we retry:
    // re-send every 1 s until PacketStore registers a NAT translation or the
    // overall deadline expires.
    //
    // We wait for NAT BEFORE pausing for two reasons:
    //   (a) NAT fires inside Interface._pkt_loop → handle_packet. Pausing
    //       first can cause the PauseGate to block r_a's interface thread
    //       before handle_packet runs, so NAT never fires during the pause.
    //   (b) page.evaluate with an async callback cannot be used in
    //       waitForFunction: Playwright evaluates the returned Promise as a
    //       truthy object on every tick and therefore always resolves
    //       immediately — a poll loop with page.evaluate is necessary.
    const pktSel = '#packet-layer rect[fill="#22c55e"]';
    const NAT_OVERALL_MS = 20000;
    const NAT_RETRY_MS  = 1000;
    const natDeadline = Date.now() + NAT_OVERALL_MS;
    let natReady = false;
    while (!natReady && Date.now() < natDeadline) {
      // Re-issue the send command (each call allocates a new payload_id, so
      // multiple in-flight datagrams are harmless).
      await input.click();
      await input.fill('send 200.100.0.10 hello');
      await input.press('Enter');

      // Wait for the green rect to appear and check PacketStore for a NAT entry.
      // If the rect never appears in 3 s the packet was dropped before entering
      // the canvas layer — skip to the next retry without waiting the full budget.
      const rectSeen = await page.waitForFunction(
        (sel) => document.querySelectorAll(sel).length > 0,
        pktSel,
        { timeout: 3000 },
      ).then(() => true).catch(() => false);

      if (rectSeen) {
        // Give the NAT event ~1 s to propagate through the WS pipeline.
        const pollDeadline = Date.now() + NAT_RETRY_MS;
        while (!natReady && Date.now() < pollDeadline) {
          natReady = await page.evaluate(async () => {
            const { PacketStore } = await import('/packetstore.js');
            return PacketStore.natByPayload.size > 0;
          });
          if (!natReady) await page.waitForTimeout(100);
        }
      }
    }
    expect(natReady, 'timed out waiting for sim:nat to populate PacketStore').toBe(true);

    // Pause so the packet freezes in flight and we can hover it. NAT is already
    // in the store, so showPacketTooltip will build the NAT line for the rect
    // whose payload_id has a registered NAT translation.
    await page.locator('#tb-pause').click();
    await expect(page.locator('#tb-play')).toHaveClass(/paused/, { timeout: 5000 });

    // Hover the frozen user-datagram packet — Sim.state === 'paused' freezes
    // the tween, so the rect stays put while showPacketTooltip runs. Use
    // dispatchEvent rather than mouse hover because the rect is inside an
    // SVG layer that sits underneath the toolbar/zoom overlays in some
    // viewport sizes; the rect's own mouseenter listener is the only thing
    // the tooltip flow actually requires.
    //
    // Retry sends may have left multiple green rects in flight simultaneously
    // (one per send). We need to hover the rect whose payload_id is present in
    // PacketStore.natByPayload — not necessarily the first in DOM order.
    await page.evaluate(async (sel) => {
      const { PacketStore } = await import('/packetstore.js');
      const rects = [...document.querySelectorAll(sel)];
      for (const rect of rects) {
        let evtData;
        try { evtData = JSON.parse(rect.dataset.evt); } catch (_) { continue; }
        if (!evtData || !evtData.payload_id) continue;
        if (PacketStore.natFor(evtData.payload_id).length > 0) {
          rect.dispatchEvent(new MouseEvent('mouseenter'));
          return;
        }
      }
    }, pktSel);

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
