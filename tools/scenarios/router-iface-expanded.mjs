// Scenario: select r1, expand eth2 (the p2p1-attached interface) so the
// fabric-type / fabric-name / IP / Cost layout under test is visible.
const { state, bus } = await import('/state.js');

state.selection = { kind: 'router', name: 'r1' };
bus.dispatchEvent(new CustomEvent('state:selection-changed'));
bus.dispatchEvent(new CustomEvent('state:topology-changed'));

await new Promise(r => setTimeout(r, 200));
const det = document.querySelector('#inspector details.iface[data-iface="eth2"]');
if (det) det.open = true;
await new Promise(r => setTimeout(r, 200));
