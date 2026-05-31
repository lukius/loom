// Scenario: start the sim, let it converge, then gracefully halt r1 so its
// node and links render in the grayed "down" style. Used by
// docs/images/60-router-halted.png.
//
//   npm run screenshot -- docs/images/60-router-halted.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/router-halted.mjs
//
// Runs in the page context (wrapped in an async IIFE by screenshot.mjs).
const { Sim, RuntimeClient } = await import('/sim.js');
await import('/state.js');

if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') {
  throw new Error('router-halted scenario: failed to start sim, state=' + Sim.state);
}

// Converge so the topology is fully drawn before we halt.
await new Promise(r => setTimeout(r, 800));

// Halt r1 gracefully — the device_state_changed / interface_state_changed
// events flow back over the socket and gray r1's node and its links.
await RuntimeClient.deviceCommand('r1', 'halt');
await new Promise(r => setTimeout(r, 600));
