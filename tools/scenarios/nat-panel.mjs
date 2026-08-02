// Scenario: drive the SPA into a state where the NAT inspector panel for
// r_a is populated and visible. Used by docs/images/51-nat-panel.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/51-nat-panel.png \
//       --load-yaml=samples/multi_tenant_nat.yaml \
//       --exec-file=tools/scenarios/nat-panel.mjs \
//       --selector=.insp
//
// Runs in the page context (wrapped in an async IIFE by screenshot.mjs).
const { Sim, RuntimeClient } = await import('/sim.js');
const { state, bus } = await import('/state.js');

// Make the starting state deterministic — the running server might be
// mid-sim from a prior session. Stop, sync, then go through the normal
// load+start flow with the SPA's freshly-imported YAML.
if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') {
  throw new Error('scenario: failed to start sim, state=' + Sim.state);
}

// Wait for routing convergence — r_a needs a route to 200.100.0.0/24 before
// the ping can go through and trigger NAT. Poll rather than sleeping a fixed
// amount: with the default 10 s Hello interval an adjacency can sit in INIT
// for a full interval, and a fixed wait then captures an empty NAT table.
const convDeadline = Date.now() + 40000;
let routed = false;
while (Date.now() < convDeadline) {
  const resp = await fetch('/devices/r_a/routes').catch(() => null);
  const data = resp && resp.ok ? await resp.json().catch(() => null) : null;
  if (data && (data.rules || []).some(r => r.prefix === '200.100.0.0/24')) { routed = true; break; }
  await new Promise(r => setTimeout(r, 500));
}
if (!routed) throw new Error('nat-panel: r_a never learned a route to 200.100.0.0/24');

// Ping h_a → h_public. The server's command endpoint blocks until the ping
// completes or times out; on return, r_a's NAT table has an entry.
await RuntimeClient.deviceCommand('h_a', 'ping h_public -W 2.0');

// Reset natTables cache so refreshNAT re-fetches the latest data.
state.natTables = {};

// Select r_a so renderInspector() mounts the NAT panel. Inspector.refreshNAT
// primes state.natTables from GET /devices/r_a/nat-table and renders.
state.selection = { kind: 'router', name: 'r_a' };
bus.dispatchEvent(new CustomEvent('state:selection-changed'));
await new Promise(r => setTimeout(r, 600));

// Make sure the NAT section is expanded.
const natSec = document.querySelector('#insp-nat details.insp-section[data-section="nat"]');
if (natSec) natSec.open = true;
await new Promise(r => setTimeout(r, 200));
