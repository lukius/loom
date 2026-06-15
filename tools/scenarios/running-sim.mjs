// Scenario: start the sim and wait for routing-protocol chatter to appear,
// showing the current toolbar (Protocol button, no Keepalive field). Used
// by docs/images/02-running.png.
//
// We wait ≥3.5 s after the YAML import (handled by --load-yaml before this
// script runs) so the "Topology imported" toast fully fades before capture.
// Then we start the sim and wait a further 600 ms for chatter to appear.
//
// Invoke via:
//   npm run screenshot -- docs/images/02-running.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/running-sim.mjs \
//       --selector=body --viewport=1440x860
const { Sim, RuntimeClient } = await import('/sim.js');

if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}

// Wait for the "Topology imported" toast to fade (it appears after --load-yaml).
// Toast auto-dismisses after ~3 s; wait a bit longer to be safe.
await new Promise(r => setTimeout(r, 3500));

await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') {
  throw new Error('running-sim scenario: failed to start sim, state=' + Sim.state);
}

// Wait long enough for chatter to be visibly in-flight.
await new Promise(r => setTimeout(r, 600));
