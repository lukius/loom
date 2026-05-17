// Scenario: render the multi_tenant_nat topology with iface + cost labels
// off so the muted private-LAN tone reads cleanly. Used by
// docs/images/50-private-lan-tone.png.
//
// Invoke via:
//   npm run screenshot -- docs/images/50-private-lan-tone.png \
//       --load-yaml=samples/multi_tenant_nat.yaml \
//       --exec-file=tools/scenarios/private-lan-tone.mjs \
//       --selector=#canvas
//
// Runs in the page context (wrapped in an async IIFE by screenshot.mjs).
const { state, bus } = await import('/state.js');

// Hide iface/cost labels — they're useful for editing but add clutter
// when the screenshot is about the LAN color convention itself.
state.display.showIfaces = false;
state.display.showCosts = false;
bus.dispatchEvent(new CustomEvent('state:topology-changed'));

// Let renderAll() run with the new display toggles.
await new Promise(r => setTimeout(r, 200));
