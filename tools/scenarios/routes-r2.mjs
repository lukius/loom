// Scenario: start the sim, wait for FULL convergence, select r2, and expand
// the routing table section so it is visible. Used by docs/images/04-routes.png
// and docs/images/20-routes.png.
//
// Full convergence = r2's routing table has exactly 4 rules including the
// learned route 10.0.0.0/30 → 200.100.0.1 / eth0. We poll up to 25 s.
//
// Invoke via:
//   npm run screenshot -- docs/images/04-routes.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/routes-r2.mjs \
//       --selector=body --viewport=1440x860
const { Sim, RuntimeClient } = await import('/sim.js');
const { state, bus } = await import('/state.js');

if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') {
  throw new Error('routes-r2 scenario: failed to start sim, state=' + Sim.state);
}

// Select r2 immediately so the inspector is open and starts refreshing.
state.selection = { kind: 'router', name: 'r2' };
bus.dispatchEvent(new CustomEvent('state:selection-changed'));

// Expand the routing table section in the inspector.
await new Promise(r => setTimeout(r, 300));
const routingSection = document.querySelector('#inspector details.insp-section[data-section="routing"]');
if (routingSection) routingSection.open = true;

// Poll until r2's routing table has 4 rows (full convergence), up to 25 s.
const deadline = Date.now() + 25000;
let converged = false;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 1000));
  // Fetch the routing table from the server to check convergence.
  const resp = await fetch('/devices/r2/routes').catch(() => null);
  if (resp && resp.ok) {
    const data = await resp.json().catch(() => null);
    if (data && Array.isArray(data.rules) && data.rules.length >= 4) {
      // Verify the learned route is present (10.0.0.0/30).
      const hasLearned = data.rules.some(r => r.prefix === '10.0.0.0/30');
      if (hasLearned) {
        converged = true;
        break;
      }
    }
  }
}

if (!converged) {
  // Capture what we actually see for debugging — the caller will report it.
  const resp2 = await fetch('/devices/r2/routes').catch(() => null);
  const data2 = resp2 && resp2.ok ? await resp2.json().catch(() => null) : null;
  throw new Error('routes-r2: r2 did not converge in 25 s. Observed: ' + JSON.stringify(data2));
}

// Let the inspector panel refresh with the new table.
await new Promise(r => setTimeout(r, 600));
