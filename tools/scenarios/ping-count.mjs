// Scenario: start the sim, open h1's terminal, and run a counted ping so the
// per-reply lines stream into the terminal output. Used by
// docs/images/62-ping-count.png.
//
//   npm run screenshot -- docs/images/62-ping-count.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/ping-count.mjs \
//       --selector=.term --viewport=1400x900 --delay=400
//
// Runs in the page context (wrapped in an async IIFE by screenshot.mjs).
const { Sim, RuntimeClient } = await import('/sim.js');
const { bus } = await import('/state.js');

if (Sim.state !== 'idle') {
  await RuntimeClient.stop().catch(() => {});
  await Sim.refreshState();
}
await Sim.onPrimary();
await Sim.refreshState();
if (Sim.state !== 'running') {
  throw new Error('ping-count scenario: failed to start sim, state=' + Sim.state);
}

await new Promise(r => setTimeout(r, 800));

// Open h1's terminal popup.
bus.dispatchEvent(new CustomEvent('canvas:terminal-requested', { detail: { name: 'h1' } }));
await new Promise(r => setTimeout(r, 300));

// Drive the real terminal flow: type the command and submit it. The terminal
// echoes the command, the per-reply lines stream in live, and the summary
// prints when the command returns.
const term = document.querySelector('.term');
const inp = term.querySelector('.term-in');
inp.value = 'ping h2 -c 4 -W 1.5';
inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

// Wait for the four sequential probes to complete and stream in.
await new Promise(r => setTimeout(r, 5000));
