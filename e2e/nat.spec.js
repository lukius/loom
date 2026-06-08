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

    // --- Capture a NAT'd datagram frozen on the canvas --------------------
    // We need a single green rect that is BOTH still on the canvas AND whose
    // payload has a NAT entry, frozen by a pause so we can hover it. Two facts
    // make this racy if handled naively:
    //   • The store's NAT entry and the on-canvas rect can belong to DIFFERENT
    //     payloads. An earlier NAT'd datagram may finish animating (and be
    //     removed) just as its NAT event lands, while a newer, not-yet-NAT'd
    //     datagram is the rect actually in flight. So "wait for any NAT entry,
    //     then hover any present rect" races — under load the frozen rect can
    //     be one whose NAT hasn't arrived, so no tooltip is ever built.
    //   • Pausing before the packet has traversed r_a can let the PauseGate
    //     block r_a's interface thread before handle_packet runs, so NAT never
    //     fires for that packet.
    // We therefore loop on the real invariant: while RUNNING, send and wait
    // until a CURRENTLY-PRESENT rect is already NAT'd (NAT has fired, rect still
    // animating); then pause to freeze it; then ATOMICALLY re-confirm a present
    // rect is NAT'd and hover it in one evaluate (no gap in which it could be
    // removed). If the freeze lost the rect, resume and retry.
    //
    // Note: an async page.evaluate must be polled manually — it cannot drive
    // waitForFunction (a returned Promise reads as truthy every tick, resolving
    // immediately), so the inner waits are explicit poll loops.
    const pktSel = '#packet-layer rect[fill="#22c55e"]';
    const presentNatd = () => page.evaluate(async (sel) => {
      const { PacketStore } = await import('/packetstore.js');
      return [...document.querySelectorAll(sel)].some(r => {
        let e; try { e = JSON.parse(r.dataset.evt); } catch (_) { return false; }
        return e && e.payload_id && PacketStore.natFor(e.payload_id).length > 0;
      });
    }, pktSel);

    const CAPTURE_OVERALL_MS = 25000;
    const captureDeadline = Date.now() + CAPTURE_OVERALL_MS;
    let hovered = false;
    while (!hovered && Date.now() < captureDeadline) {
      // 1. Ensure the sim is running (clicking #tb-pause toggles run/pause; the
      //    play button's class carries the current state).
      const cls = (await page.locator('#tb-play').getAttribute('class')) || '';
      if (!/running/.test(cls)) {
        await page.locator('#tb-pause').click();
        await expect(page.locator('#tb-play')).toHaveClass(/running/, { timeout: 5000 });
      }

      // 2. Send a datagram (each call allocates a fresh payload_id).
      await input.click();
      await input.fill('send 200.100.0.10 hello');
      await input.press('Enter');

      // 3. While running, wait (≤3 s) until a present rect is NAT'd. This proves
      //    NAT has fired (so the upcoming pause cannot prevent it) and the rect
      //    is still in flight. If nothing shows — packet dropped pre-convergence
      //    or too slow this round — resend.
      let ready = false;
      const readyDeadline = Date.now() + 3000;
      while (!ready && Date.now() < readyDeadline) {
        ready = await presentNatd();
        if (!ready) await page.waitForTimeout(100);
      }
      if (!ready) continue;

      // 4. Pause to freeze whatever is in flight.
      await page.locator('#tb-pause').click();
      await expect(page.locator('#tb-play')).toHaveClass(/paused/, { timeout: 5000 });

      // 5. Atomically re-confirm a frozen rect is NAT'd and hover it. Dispatch
      //    mouseenter directly (the rect sits under toolbar/zoom overlays in
      //    some viewport sizes; its own listener is all the tooltip needs). If
      //    the NAT'd rect vanished in the brief freeze window, return false and
      //    loop — step 1 will resume the sim.
      hovered = await page.evaluate(async (sel) => {
        const { PacketStore } = await import('/packetstore.js');
        for (const rect of document.querySelectorAll(sel)) {
          let evtData;
          try { evtData = JSON.parse(rect.dataset.evt); } catch (_) { continue; }
          if (!evtData || !evtData.payload_id) continue;
          if (PacketStore.natFor(evtData.payload_id).length > 0) {
            rect.dispatchEvent(new MouseEvent('mouseenter'));
            return true;
          }
        }
        return false;
      }, pktSel);
    }
    expect(hovered, 'no NAT-bearing datagram could be frozen on the canvas to hover').toBe(true);

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
