// web/packettypes.js
// Routing-protocol message types that appear in the chatter store and
// the Packets panel. Editing this set is the only change needed to
// register a new routing-protocol message kind (e.g. acknowledgement,
// DB-descriptor) — packets.js, packetstore.js, packetspanel.js, and
// styles.css all derive their behaviour from this set.
//
// NOTE: CSS rules in styles.css (.pkt-swatch[data-type=...]) must also be
// added when a new type is registered here, as CSS cannot be driven by a
// JS set at build time.
export const ROUTING_CHATTER_TYPES = Object.freeze(new Set([
    'routing_flood',
    'hello',
]));
