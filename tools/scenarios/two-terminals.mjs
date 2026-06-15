// Scenario: start the sim, open h1 and h3 terminals simultaneously.
// Used by docs/images/30-two-terminals.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/30-two-terminals.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/two-terminals.mjs \
//       --selector=body --viewport=1440x860
const { Sim, RuntimeClient } = await import('/sim.js');
const { bus } = await import('/state.js');

if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') {
  throw new Error('two-terminals scenario: failed to start sim, state=' + Sim.state);
}

await new Promise(r => setTimeout(r, 700));

// Open h1's terminal.
bus.dispatchEvent(new CustomEvent('canvas:terminal-requested', { detail: { name: 'h1' } }));
await new Promise(r => setTimeout(r, 300));

// Open h3's terminal.
bus.dispatchEvent(new CustomEvent('canvas:terminal-requested', { detail: { name: 'h3' } }));
await new Promise(r => setTimeout(r, 400));
