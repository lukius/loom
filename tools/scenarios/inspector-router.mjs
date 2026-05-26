// Scenario: start the simulation, select r1, and expand the Neighbors
// and Routing table collapsible sections. Used by docs/images/inspector-router.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/inspector-router.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/inspector-router.mjs \
//       --selector=.insp \
//       --viewport=1400x860
const { Sim, RuntimeClient } = await import('/sim.js');
const { state, bus } = await import('/state.js');

// Ensure clean idle state first.
if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') {
  throw new Error('inspector-router scenario: failed to start sim, state=' + Sim.state);
}

// Let routing converge so the routing table is populated.
await new Promise(r => setTimeout(r, 800));

// Select r1 so the router inspector renders.
state.selection = { kind: 'router', name: 'r1' };
bus.dispatchEvent(new CustomEvent('state:selection-changed'));
await new Promise(r => setTimeout(r, 400));

// Open the Neighbors and Routing table collapsible sections.
const neighbSection = document.querySelector('#inspector details.insp-section[data-section="neighbors"]');
if (neighbSection) neighbSection.open = true;
const routingSection = document.querySelector('#inspector details.insp-section[data-section="routing"]');
if (routingSection) routingSection.open = true;

await new Promise(r => setTimeout(r, 300));
