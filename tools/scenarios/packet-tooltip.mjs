// Scenario: start the sim, set a slow packet speed, fire a ping, pause the
// sim while a packet is mid-flight, then synthetically trigger the tooltip
// on the first frozen packet dot. Used by docs/images/40-packet-tooltip.png.
//
// This is best-effort: the tooltip requires a mouseenter hover which the
// screenshot tool cannot do natively; we call showPacketTooltip() directly
// on the first available dot and position the tooltip manually.
//
// Invoke via:
//   npm run screenshot -- docs/images/40-packet-tooltip.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/packet-tooltip.mjs \
//       --selector=body --viewport=1440x860
const { Sim, RuntimeClient } = await import('/sim.js');
const { showPacketTooltip } = await import('/packets.js');

if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') {
  throw new Error('packet-tooltip scenario: failed to start sim, state=' + Sim.state);
}

// Wait for convergence.
await new Promise(r => setTimeout(r, 800));

// Set a slow animation speed so packets stay on-screen longer.
const speedInput = document.querySelector('.tb-speed');
if (speedInput) {
  speedInput.value = '4000';
  speedInput.dispatchEvent(new Event('change', { bubbles: true }));
}

// Fire a ping that will animate across multiple hops.
RuntimeClient.deviceCommand('h1', 'ping h3').catch(() => {});

// Wait a bit for the packet to enter the wires, then pause.
await new Promise(r => setTimeout(r, 400));
await RuntimeClient.pause();
await Sim.refreshState();

// Give the paused animation a moment to stabilize.
await new Promise(r => setTimeout(r, 200));

// Find the first user-traffic packet dot on the canvas and show its tooltip.
const layer = document.getElementById('packet-layer');
const dot = layer && layer.querySelector('rect[data-packet-type="ping_request"]');
if (dot) {
  const evtData = dot.dataset.evt;
  if (evtData) {
    const evt = JSON.parse(evtData);
    // Show the tooltip by calling the same handler as mouseenter.
    showPacketTooltip(evt, dot);
  }
}

await new Promise(r => setTimeout(r, 200));
