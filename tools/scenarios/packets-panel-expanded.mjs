// Scenario: same as packets-panel.mjs plus expand the first in-flight row.
// Used by docs/images/42-packets-panel-expanded.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/42-packets-panel-expanded.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/packets-panel-expanded.mjs \
//       --viewport=1500x900 --selector=body
const { Sim, RuntimeClient } = await import('/sim.js');
const { state } = await import('/state.js');
const { PacketsPanel } = await import('/packetspanel.js');

if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') throw new Error('scenario: failed to start sim');

await new Promise(r => setTimeout(r, 700));

await RuntimeClient.deviceCommand('h1', 'set_gateway 200.100.0.1').catch(() => {});
await RuntimeClient.deviceCommand('h2', 'set_gateway 100.200.0.1').catch(() => {});
await RuntimeClient.deviceCommand('h3', 'set_gateway 150.10.10.1').catch(() => {});

RuntimeClient.deviceCommand('h1', 'ping h3 -W 5').catch(() => {});
RuntimeClient.deviceCommand('h2', 'ping h1 -W 5').catch(() => {});
RuntimeClient.deviceCommand('h3', 'send h2 hi').catch(() => {});

await new Promise(r => setTimeout(r, 800));
await RuntimeClient.pause();
await Sim.refreshState();

if (!state.ui.packetsPanelOpen) PacketsPanel.open();
await new Promise(r => setTimeout(r, 200));

const firstToggle = document.querySelector('#packets-panel .packets-section .pkt-row .pkt-toggle');
if (firstToggle) firstToggle.click();
await new Promise(r => setTimeout(r, 200));
