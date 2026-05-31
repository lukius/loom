// Scenario: start the simulation so the Protocol button is enabled, then open
// the Protocol popover. Used by docs/images/protocol-popover.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/protocol-popover.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/protocol-popover.mjs \
//       --selector=body \
//       --viewport=1400x900
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
  throw new Error('protocol-popover scenario: failed to start sim, state=' + Sim.state);
}

// Let routing converge a bit before opening the popover.
await new Promise(r => setTimeout(r, 500));

// Click the Protocol button to open the popover.
const btn = document.getElementById('tb-protocol');
if (btn) btn.click();

// Wait for popover to become visible.
await new Promise(r => setTimeout(r, 300));

const popover = document.getElementById('protocol-popover');
if (!popover || popover.hidden) {
  throw new Error('protocol-popover scenario: popover not visible after clicking Protocol button');
}
