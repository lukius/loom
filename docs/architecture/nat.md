> 🌐 **English** · [Español](../es/architecture/nat.md)

# NAT design

loom's NAT is a stateful, per-router, source-NAT (a.k.a. **NAPT/PAT** in
the real world, minus L4 ports — see "Conversation key" below). Every
router carries its own `NATTable`; the translation kicks in at the
private↔public boundary on the **forwarding path**, not at the receiving
host.

See also: [routing-protocol.md](routing-protocol.md) (private-prefix
advertisement filter), [entities.md](entities.md#interface-interfacepy) (the `flow`
field on `packet` events), [web-spa.md](web-spa.md) (`sim:nat` and
`sim:nat-table-changed` event shapes).

## Why NAT is modeled

The routing protocol filters RFC 1918 prefixes out of every advertised
LSA, so private LANs are invisible to peer routers. That makes
overlapping `192.168.1.0/24` LANs safe across tenants, but it also means
a private host has no globally reachable address. Translation at the
egress router gives those packets a public source the rest of the AS
already knows how to route, and lets the reply come home.

## Outbound translation (`Router._handle_forwarding`)

When a router is about to forward a packet whose source falls in an
RFC 1918 range *and* whose egress interface sits on a non-private
network, it rewrites the source to the egress interface's own address
and registers the translation in the per-router NAT table:

```
key   = (rewritten_src, original_dst, flow_id)
value = original_src
```

Two events fire on the EventTracer bus immediately after the table
mutation:

- `nat` (`direction=outbound`) — carries `{router, original_src,
  rewritten_src, dst, flow_id, payload_id}`. Subscribers receive this
  event for each outbound translation.
- `nat_table_changed` — carries `{device, entries}` (the full snapshot
  in LRU order). Subscribers receive this event to update their view
  of the NAT table.

If the router has no public interface but the source is private,
`_handle_forwarding` raises with a "no NAT egress" error rather than
forwarding privately-sourced traffic out a private interface. That
keeps tenant traffic from leaking onto another tenant's LAN.

### Direction matters: only inside-initiated flows are translated

Source-NAT belongs to conversations the private side opened. When a
router carries a packet the *other* way — public source, private egress
— it records the conversation via `NATTable.note_inbound_flow(flow_id)`,
and `_handle_forwarding` then skips translation for that flow's return
leg (`NATTable.is_inbound_flow`).

Without that distinction, a ping from a public host to a private one on
the same router's other LAN comes back rewritten to the router's own
address. The sender is waiting on a reply from the host it addressed,
discards the one it gets, and reports a timeout — while the packets
visibly completed the round trip. The inbound-flow set is bounded and
LRU-evicted like the translation table, and payloads without a
`flow_key` (`flow_id=None`) are not tracked, so they keep the plain
address-class behavior.

The tracking is per-router, so a reply that leaves through a *different*
NAT router than the request entered is translated as a new outbound
flow — the same asymmetric-routing caveat real stateful NAT has.

## Inbound translation (`Router.handle_packet`)

On the reply path the public destination doesn't know the original
private address — it sees and replies to the NAT egress address. When
a packet arrives whose destination equals one of the router's public
interface addresses, the router looks up
`(rewritten_dst, src, flow_id)` in its NAT table. On a hit, it rewrites
the destination back to the original private address and re-enters
forwarding. On a miss, the packet falls through to `_handle_message`
(it's actually addressed to the router itself, e.g. a routing message
broadcast). An `inbound` `nat` event fires on a hit so subscribers can observe the
reverse-translation. There is no second `nat_table_changed`
on the reply — the table state doesn't change on inbound lookup.

## The conversation key (`flow_id`)

Without L4 ports, the NAT table needs another discriminator so two
private hosts behind one router pinging the same public destination
don't collapse into a single entry. The discriminator is the
**conversation UUID**, computed as:

- For a `Message` with its own `flow_key()` (the default),
  `str(self._id)` — a `uuid.uuid4()` assigned at construction time.
- For a `PingReply`, `str(request_id)` — the originating `PingRequest`'s
  UUID, echoed by `Host._handle_message` so the reverse lookup finds the
  forward registration.
- For arbitrary payloads with no `flow_key`, `None` — a single shared
  slot per `(rewritten_src, original_dst)`, fine for fire-and-forget.

This is the *same value* carried as the `flow` field on `packet` events
(used by subscribers to group hops of one conversation) and as `flow_id`
on `nat` events. Three distinct concerns, one source of truth.

## LRU eviction

`NATTable` is bounded (default 1024 entries). When register would
exceed capacity, the least-recently-used entry is evicted. A
`register` of an existing key refreshes its LRU position. There is
no time-based expiry — entries persist until eviction. Short-lived
flows (ping) and long-lived ones (a UserMessage stream) compete on the
same LRU; long sims don't grow the table unboundedly.

## Concurrency

The table guards all mutations and lookups with a single `threading.Lock`
(see [concurrency.md](concurrency.md)). Forward and reverse traffic
flowing through the same router does not race the table.

## Cross-reference: visual hint

In the SPA, RFC 1918 LANs render in a muted neutral tone, and the
router-side iface label on the private side of the boundary is muted to
match. See [the user-guide page](../user-guide/nat-and-private-lans.md) for
the user-facing description. The detection logic lives in
[`web/utils.js::isPrivateCidr`](../../web/utils.js) and mirrors
[`entities/address.py::is_private`](../../src/entities/address.py).

## Deliberate omissions

`loom`'s NAT models address-translation mechanics — the rewrite, the
flow table, and the public/private boundary detection. It deliberately
omits behaviour whose role is operational rather than conceptual:

- **Time-based ageing.** Real NAT applies per-protocol idle timeouts
  (TCP much longer than UDP — typical defaults are 24h vs 30s) so
  that abandoned or half-open flows free their table entries on their
  own. `loom`'s `NATTable` evicts only via LRU at the
  `max_entries` boundary. Ageing is the most operationally consequential
  part of real NAT behaviour and is what every NAT troubleshooting
  story starts from; it's omitted here because the simulator's scale
  (handfuls of flows for seconds-to-minutes) makes the cap-based
  policy indistinguishable.
- **Per-protocol awareness.** Real NAT applies different policies to
  TCP, UDP, ICMP, and so on. `loom` keys all flows by `flow_id` (a
  conversation UUID) regardless of payload type. The same omission
  reason as above: the simulator doesn't model L4 at all.
- **Hairpinning / NAT-loopback.** Traffic from a private host to its
  own NAT's public address is not specially handled. Not relevant
  for the topologies `loom` targets.

If you need to teach or troubleshoot NAT-ageing behaviour, ns-3 or a
real router are the right tools — see the
[scope statement](../user-guide/getting-started.md#scope).
