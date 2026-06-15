// Scenario: start the sim, wait for FULL convergence, select r2, and expand
// the routing table section so it is visible. Used by docs/images/04-routes.png
// and docs/images/20-routes.png.
//
// Full convergence = r2's routing table has exactly 3 rules:
//   200.100.0.0/24  0.0.0.0        eth0  (directly connected)
//   100.200.0.0/24  0.0.0.0        eth1  (directly connected)
//   150.10.10.0/24  100.200.0.10   eth1  (learned via loom-OSPF)
// We poll up to 25 s and also check that neighbors are all TWO_WAY (no INIT/DOWN).
//
// Invoke via:
//   npm run screenshot -- docs/images/04-routes.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/routes-r2.mjs \
//       --selector=body --viewport=1440x860
const { Sim, RuntimeClient } = await import('/sim.js');
const { state, bus } = await import('/state.js');

// Ensure the sim is fully stopped before starting fresh.
if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}

// Start a fresh sim run.
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') {
  throw new Error('routes-r2 scenario: failed to start sim, state=' + Sim.state);
}

// Wait for the sim's initial routing table (directly-connected only, 2 rules) to
// appear so we can detect when it has been replaced by the converged 3-rule table.
// Without this, a stale 3-rule result from the previously running sim could fool
// the poll below into thinking convergence is already done.
await new Promise(r => setTimeout(r, 2000));

// Select r2 immediately so the inspector is open and starts refreshing.
state.selection = { kind: 'router', name: 'r2' };
bus.dispatchEvent(new CustomEvent('state:selection-changed'));

// Expand the routing table section in the inspector.
await new Promise(r => setTimeout(r, 300));
const routingSection = document.querySelector('#inspector details.insp-section[data-section="routing"]');
if (routingSection) routingSection.open = true;

// Poll until r2's routing table has exactly 3 rows (fully converged), up to 25 s.
// Convergence = 2 directly-connected routes (eth0, eth1) + 1 OSPF-learned route
// (150.10.10.0/24 via 100.200.0.10 / eth1).
const deadline = Date.now() + 25000;
let converged = false;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 1000));
  // Fetch the routing table from the server to check convergence.
  const resp = await fetch('/devices/r2/routes').catch(() => null);
  if (resp && resp.ok) {
    const data = await resp.json().catch(() => null);
    if (data && Array.isArray(data.rules) && data.rules.length === 3) {
      // Verify the OSPF-learned route to 150.10.10.0/24 is present via eth1 (not eth2).
      const hasLearned = data.rules.some(
        r => r.prefix === '150.10.10.0/24' && r.next_hop !== '0.0.0.0',
      );
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

// Poll the in-page neighbor state to confirm all 4 adjacencies are TWO_WAY.
// r2 has: eth0→r1 (lan1), eth1→r1 (lan2), eth1→r3 (lan2), eth2→r3 (lan3) = 4 adjacencies.
// Fully converged = 4 TWO_WAY, 0 INIT, 0 DOWN. We poll up to 20 s.
const neighDeadline = Date.now() + 20000;
while (Date.now() < neighDeadline) {
  const nb = state.neighborsByDevice && state.neighborsByDevice['r2'];
  if (nb) {
    let totalTwoWay = 0;
    let hasInitOrDown = false;
    for (const iface of Object.values(nb)) {
      for (const peer of Object.values(iface)) {
        if (peer.state === 'two_way') {
          totalTwoWay++;
        } else {
          hasInitOrDown = true;
        }
      }
    }
    // All 4 adjacencies must be TWO_WAY for fully-converged Neighbors display.
    if (totalTwoWay >= 4 && !hasInitOrDown) break;
  }
  await new Promise(r => setTimeout(r, 500));
}

// Let the inspector panel re-render with the final converged state.
await new Promise(r => setTimeout(r, 800));

// Wait for any "Topology imported" toast to disappear (auto-dismiss ~3 s).
const toastEl = document.querySelector('.toast');
if (toastEl && toastEl.style.display !== 'none') {
  await new Promise(r => setTimeout(r, 3500));
}
