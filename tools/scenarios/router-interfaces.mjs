// Scenario: select r2 (which has three interfaces) so the inspector lists all
// three. Used by docs/images/12-router-interfaces.png.
//
// We wait ≥3.5 s after --load-yaml so the "Topology imported" toast fades.
// The Routing table section is collapsed so the "(loading…)" placeholder is
// not visible — the focus of this screenshot is the 3 interfaces.
//
// Invoke via:
//   npm run screenshot -- docs/images/12-router-interfaces.png \
//       --load-yaml=samples/sample.yaml \
//       --exec-file=tools/scenarios/router-interfaces.mjs \
//       --selector=body --viewport=1440x860
const { state, bus } = await import('/state.js');

// Wait for the "Topology imported" toast to fade fully.
await new Promise(r => setTimeout(r, 3500));

// Select r2 which has three interfaces (eth0/eth1/eth2).
state.selection = { kind: 'router', name: 'r2' };
bus.dispatchEvent(new CustomEvent('state:selection-changed'));
bus.dispatchEvent(new CustomEvent('state:topology-changed'));

await new Promise(r => setTimeout(r, 400));

// Collapse the Routing table section so the "(loading…)" placeholder is not
// shown — this screenshot focuses on the 3 interfaces, not the routing table.
const routingSection = document.querySelector('#inspector details.insp-section[data-section="routing"]');
if (routingSection) routingSection.open = false;

await new Promise(r => setTimeout(r, 200));
