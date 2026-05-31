// Scenario: load a topology so the toolbar is in its default idle state,
// showing all buttons including the Protocol button. Used by docs/images/toolbar.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/toolbar.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/toolbar.mjs \
//       --selector=.canv-toolbar \
//       --viewport=1400x120
const { state, bus } = await import('/state.js');

// Ensure canvas is rendered with the loaded topology.
bus.dispatchEvent(new CustomEvent('state:topology-changed'));
await new Promise(r => setTimeout(r, 300));
