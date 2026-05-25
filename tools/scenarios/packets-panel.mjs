// Scenario: drive the SPA into a state where the Packets panel shows
// in-flight user traffic, then pause so animations freeze for the capture.
// Used by docs/images/41-packets-panel.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/41-packets-panel.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/packets-panel.mjs \
//       --viewport=1500x900 --selector=body
const { Sim, RuntimeClient } = await import('/sim.js');
const { state, bus } = await import('/state.js');
const { PacketsPanel } = await import('/packetspanel.js');

if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') throw new Error('scenario: failed to start sim');

// Let routing converge so the first ping has a route.
await new Promise(r => setTimeout(r, 700));

// SAMPLE hosts have no gateway baked in. Set them so cross-LAN traffic flows.
// (The simulator's set_gateway command updates the in-sim host without YAML
// patches — fine for a screenshot driver.)
await RuntimeClient.deviceCommand('h1', 'set_gateway 200.100.0.1').catch(() => {});
await RuntimeClient.deviceCommand('h2', 'set_gateway 100.200.0.1').catch(() => {});
await RuntimeClient.deviceCommand('h3', 'set_gateway 150.10.10.1').catch(() => {});

// Fire a couple of pings concurrently and a datagram.
RuntimeClient.deviceCommand('h1', 'ping h3 -W 5').catch(() => {});
RuntimeClient.deviceCommand('h2', 'ping h1 -W 5').catch(() => {});
RuntimeClient.deviceCommand('h3', 'send h2 hi').catch(() => {});

// Wait for packets to be mid-flight, then pause to freeze the animation.
await new Promise(r => setTimeout(r, 800));
await RuntimeClient.pause();
await Sim.refreshState();

// Open the panel.
if (!state.ui.packetsPanelOpen) PacketsPanel.open();
await new Promise(r => setTimeout(r, 300));
