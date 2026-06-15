// Scenario: start the sim, open h1's terminal, and run ifconfig so the
// popup shows output. Used by docs/images/03-terminal.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/03-terminal.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/terminal-h1.mjs \
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
  throw new Error('terminal-h1 scenario: failed to start sim, state=' + Sim.state);
}

await new Promise(r => setTimeout(r, 700));

// Open h1's terminal popup.
bus.dispatchEvent(new CustomEvent('canvas:terminal-requested', { detail: { name: 'h1' } }));
await new Promise(r => setTimeout(r, 400));

// Type ifconfig and submit it.
const term = document.querySelector('.term');
const inp = term && term.querySelector('.term-in');
if (inp) {
  inp.value = 'ifconfig';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

await new Promise(r => setTimeout(r, 600));
