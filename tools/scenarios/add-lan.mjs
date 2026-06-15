// Scenario: idle canvas with sample topology loaded, add a new LAN so it
// appears selected on the canvas with a valid CIDR in a clear empty area.
// Used by docs/images/10-add-lan.png.
//
// The new LAN is placed in the lower-left area of the canvas (away from the
// existing topology) and given a valid CIDR so the rail label renders the
// prefix (not a red "no cidr" placeholder).
//
// Invoke via:
//   npm run screenshot -- docs/images/10-add-lan.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/add-lan.mjs \
//       --selector=body --viewport=1440x860
const { Sim, RuntimeClient } = await import('/sim.js');
const { state, bus } = await import('/state.js');

// Ensure idle state.
if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}

// Wait for the "Topology imported" toast to fade fully before adding the LAN.
await new Promise(r => setTimeout(r, 3500));

// Add the new LAN by clicking the toolbar button.
const lanBtn = document.getElementById('tb-add-net');
if (lanBtn) lanBtn.click();
await new Promise(r => setTimeout(r, 300));

// Find the newly added LAN (it will be the one without a CIDR or the last one).
// Identify it: it's selected right after clicking the toolbar button.
const newLanName = state.selection && state.selection.kind === 'network'
  ? state.selection.name : null;

if (newLanName && state.networks[newLanName] !== undefined) {
  // Place it in the lower-left area, away from the existing topology.
  // The existing topology occupies the center; lower-left is clear space.
  // Use y=660 (not too close to the bottom edge) so the rail is fully visible.
  state.networks[newLanName].x = 430;
  state.networks[newLanName].y = 660;
  // Give it a valid CIDR so the rail shows the prefix, not "no cidr".
  state.networks[newLanName].cidr = '192.168.1.0/24';
  bus.dispatchEvent(new CustomEvent('state:topology-changed'));
}

await new Promise(r => setTimeout(r, 500));
