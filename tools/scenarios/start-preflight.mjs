// Scenario: press Start on an incomplete topology so the pre-Start check
// fires, naming the problem and selecting the offending LAN.
// Used by docs/images/07-start-preflight.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/07-start-preflight.png \
//       --exec-file=tools/scenarios/start-preflight.mjs \
//       --selector=body --viewport=1400x900
const { state, bus, clearTopology } = await import('/state.js');
const { Sim } = await import('/sim.js');
const { fitView } = await import('/canvas.js');

// Start from a clean canvas, then add a LAN (no range yet) with a host on it.
clearTopology();
state.networks = { lan1: { cidr: '', x: 700, y: 320 } };
state.hosts = { h1: { network: 'lan1', address: '', x: 700, y: 480 } };
state.selection = null;
bus.dispatchEvent(new CustomEvent('state:topology-changed'));
// Centre the pair: without this they sit wherever the hard-coded coordinates
// land, half-hidden behind the inspector.
await new Promise(r => setTimeout(r, 200));
fitView();

// Let the "new topology" toast fade so only the Start message shows.
await new Promise(r => setTimeout(r, 3500));
await Sim.onPrimary();
// Capture while the message is still on screen (toasts live ~2.4 s, and the
// screenshot tool waits its own --delay on top of this).
await new Promise(r => setTimeout(r, 200));
