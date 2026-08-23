// e2e/connection.spec.js
// The connection-lost banner was the one item on the retired manual smoke
// checklist that no automated test covered.
//
// The FastAPI server is shared by the whole suite (one webServer per run), so
// stopping it here would break every later spec. Instead the /ws/events socket
// is proxied through Playwright and then closed from the Node side, which
// drops the page's connection for real: the SPA sees a genuine ws.onclose,
// paints #conn-banner, and re-dials on its own backoff. What this does not
// cover is server-side restart recovery (RuntimeClient.refreshState on
// reconnect); only the banner lifecycle is asserted.
import { test, expect } from '@playwright/test';

test.describe('loom SPA - connection banner', () => {
  test.beforeEach(async ({ page, context, request }) => {
    await request.post('/sim/stop').catch(() => {});
    await context.clearCookies();
    await page.addInitScript(() => {
      try { localStorage.clear(); } catch (_) {}
      try { sessionStorage.clear(); } catch (_) {}
    });
    page.on('pageerror', (err) => console.error('PAGE EXCEPTION:', err.message));
  });

  test('banner appears when the event socket drops, and clears on reconnect', async ({
    page,
  }) => {
    // Proxy every /ws/events dial to the real server, keeping the most recent
    // route handle so the test can sever it on demand. Must be registered
    // before the first navigation.
    let live = null;
    await page.routeWebSocket('**/ws/events', (ws) => {
      ws.connectToServer();
      live = ws;
    });

    await page.goto('/');
    await page.waitForSelector('#nodes-layer g.node', { timeout: 5000 });

    const banner = page.locator('#conn-banner');
    // While connected the banner is absent or hidden; both satisfy toBeHidden.
    await expect(banner).toBeHidden();
    expect(live, 'SPA should have opened /ws/events').not.toBeNull();

    live.close();
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toHaveText(/connection lost/i);

    // _openWs re-dials on a backoff that doubles from 500ms to a max of 8s;
    // the retry is proxied by the same handler and reaches the live server.
    await expect(banner).toBeHidden({ timeout: 20_000 });
  });
});
