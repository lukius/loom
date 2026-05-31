// Scenario: open the New-topology confirmation dialog over a loaded topology.
// Used by docs/images/06-new-confirm.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/06-new-confirm.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/new-confirm.mjs \
//       --selector=body --viewport=1400x900
const { bus } = await import('/state.js');

bus.dispatchEvent(new CustomEvent('state:topology-changed'));
// Let the "topology imported" toast from --load-yaml fade before capture.
await new Promise(r => setTimeout(r, 3500));
document.getElementById('btn-new').click();
await new Promise(r => setTimeout(r, 150));
