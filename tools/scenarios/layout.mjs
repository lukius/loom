// Scenario: select r2 so the inspector panel shows a router with three
// interfaces, matching the layout reference shot. Used by
// docs/images/05-layout.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/05-layout.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/layout.mjs \
//       --selector=body --viewport=1440x860
const { state, bus } = await import('/state.js');

state.selection = { kind: 'router', name: 'r2' };
bus.dispatchEvent(new CustomEvent('state:selection-changed'));
bus.dispatchEvent(new CustomEvent('state:topology-changed'));

await new Promise(r => setTimeout(r, 300));
