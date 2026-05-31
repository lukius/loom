// Scenario: start the sim, disable one of r1's interfaces, and select r1 so
// the inspector shows the per-interface Disable / Fail / Enable controls
// (the disabled interface shows Enable). Used by
// docs/images/61-interface-controls.png.
//
//   npm run screenshot -- docs/images/61-interface-controls.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/interface-controls.mjs \
//       --selector=#inspector --viewport=1400x900
//
// Runs in the page context (wrapped in an async IIFE by screenshot.mjs).
const { Sim, RuntimeClient } = await import('/sim.js');
const { state, bus } = await import('/state.js');

if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') {
  throw new Error('interface-controls scenario: failed to start sim, state=' + Sim.state);
}

await new Promise(r => setTimeout(r, 800));

// Disable one interface so the inspector row flips to "Enable" and the
// canvas link grays — showing both states side by side.
await RuntimeClient.deviceCommand('r1', 'ifconfig eth0 down');
await new Promise(r => setTimeout(r, 400));

// Select r1 so the router inspector (with the per-interface controls) renders.
state.selection = { kind: 'router', name: 'r1' };
bus.dispatchEvent(new CustomEvent('state:selection-changed'));
await new Promise(r => setTimeout(r, 400));

// The per-interface Disable / Fail / Enable controls live inside each
// interface's expandable row — open them all so the controls are visible
// (the disabled eth0 row shows Enable; the others show Disable / Fail).
document.querySelectorAll('#inspector details').forEach((d) => { d.open = true; });
await new Promise(r => setTimeout(r, 300));
