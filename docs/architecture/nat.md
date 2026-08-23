# Network Address Translation (NAT)

loom's NAT is a stateful, per-router, source-NAT. Every
router carries its own `NATTable`; the translation kicks in at the
private ↔ public boundary on the forwarding path.

The routing protocol filters RFC 1918 prefixes out of every advertised
LSA, so private LANs are invisible to peer routers. That makes
overlapping private LANs safe across tenants, but it also means
a private host has no globally reachable address. Translation at the
egress router gives those packets a public source the rest of the AS
already knows how to route, and lets the reply come home.

See also: [routing-protocol.md](routing-protocol.md) (private-prefix
advertisement filter) and
[entities.md](entities.md#interface-interfacepy) (the `flow` field on
`packet` events).

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

- `nat` (`direction=outbound`): carries `{router, original_src,
  rewritten_src, dst, flow_id, payload_id}`. Subscribers receive this
  event for each outbound translation.
- `nat_table_changed`: carries `{device, entries}` (the full snapshot
  in LRU order). Subscribers receive this event to update their view
  of the NAT table.

`NoNATEgressException` is raised only when the routing table has no match
at all for the destination, the source is private, and the router
has no public interface. It stands in for the generic "no route to host"
in that one case, so the error names the actual problem. Note what it is
not: it is a diagnostic, not a guard. Nothing inspects the egress
interface before forwarding, and a private source that *does* have a
route out a private interface is forwarded untranslated, which is exactly
how tenant-internal traffic reaches its own LANs. What keeps one tenant's
traffic off another's LAN is the absence of a route in the first place,
courtesy of the RFC 1918 advertisement filter.

### Direction matters: only inside-initiated flows are translated

Source-NAT belongs to conversations the private side opened, so
`_handle_forwarding` branches on which way the packet is crossing the
boundary:

- Public source, private egress. The conversation was opened from
  outside. The router records it with
  `NATTable.note_inbound_flow(flow_id)` and forwards it untranslated.
- Private source, public egress. The ordinary outbound case, handled by
  `_apply_source_nat`, unless `NATTable.is_inbound_flow(flow_id)` reports
  that this flow was opened from outside. In that case the packet is the
  return leg of an inbound conversation and crosses back untouched.

Without that second check, a ping from a public host to a private one on
the same router's other LAN comes back rewritten to the router's own
address. The sender is waiting on a reply from the host it addressed,
discards the one it gets, and reports a timeout, even though the packets
visibly completed the round trip.

The inbound-flow set is bounded and LRU-evicted like the translation
table, and payloads without a `flow_key` (`flow_id=None`) are never
tracked, so they keep the plain address-class behaviour.

Tracking is per-router, so a reply that leaves through a *different* NAT
router than the request entered is translated as a new outbound flow:
the same asymmetric-routing caveat real stateful NAT has.

## Inbound translation (`Router.handle_packet`)

On the reply path the public destination doesn't know the original
private address: it sees and replies to the NAT egress address. When
a packet arrives and its destination equals one of the router's public
interface addresses, the router looks up
`(rewritten_dst, src, flow_id)` in its NAT table. On a hit, it rewrites
the destination back to the original private address and re-enters
forwarding. On a miss, the packet falls through to `_handle_message`
(it's actually addressed to the router itself, e.g. a routing message
broadcast). An `inbound` `nat` event fires on a hit so subscribers can
observe the reverse-translation. There is no second `nat_table_changed`
on the reply: the table state doesn't change on inbound lookup.

## The conversation key (`flow_id`)

Without transport-level ports, the NAT table needs another discriminator
to tell apart two private hosts behind one router talking to the same
public destination. It comes from the payload rather than the addresses.

Every `Message` carries a `flow_key()` returning a stable string id for
the end-to-end conversation that message belongs to. Keying it on the
payload is the whole point: an identifier derived from the packet's
address pair could not survive the src/dst rewriting NAT itself performs
mid-path. The router reaches it through `flow_id(payload)`, a
module-level function in [`nat.py`](../../src/entities/nat.py) that reads
`flow_key` off the payload if there is one. Three cases:

- A plain `Message`, which includes `UserMessage`, returns
  `str(self._id)`: the `uuid.uuid4()` stamped on it at construction. Each
  message object is its own conversation.
- A `PingReply` overrides `flow_key()` to return `str(request_id)`, the
  originating `PingRequest`'s UUID, echoed back by `Host._handle_message`.
  Request and reply therefore share one key, which is what lets the
  reverse lookup find the forward registration.
- A payload that is not a `Message` at all has no `flow_key` attribute,
  and `flow_id` returns `None`. There is no UUID in this case and nothing
  to tell two such payloads apart: they share a single slot per
  `(rewritten_src, original_dst)`. That is enough for fire-and-forget
  traffic, which has no reply to match up in the first place.

This is the same value carried as the `flow` field on `packet` events
(used by subscribers to group hops of one conversation) and as `flow_id`
on `nat` events.

## LRU eviction

`NATTable` is bounded by `max_entries` (default 1024). A `register` that
would exceed the cap evicts the least-recently-used entry; re-registering
an existing key refreshes its position instead of adding a second one.
There is no time-based expiry, and an inbound match does not clear the
entry it matched, so entries persist until they are evicted.

Read together with the conversation key above, that has a consequence
worth spelling out. Because every `Message` carries its own UUID, a run
of user messages between the same two hosts is not one long-lived flow:
it is one fresh entry per message. Ping is the only thing that reuses a
key, and only across a single request/reply pair.

So the table fills steadily for as long as translated traffic flows, and
the cap is the only thing that ever reclaims anything. That is what
bounds memory on a long run, which is the cap's purpose; it also means a
conversation whose entry has been pushed out by 1024 newer ones can no
longer have its reply reverse-translated. Reaching that boundary takes
far more traffic than a teaching session produces, which is why the
simple policy is enough here.

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

`loom`'s NAT models address-translation mechanics: the rewrite, the
flow table, and the public/private boundary detection. It deliberately
omits behaviour whose role is operational rather than conceptual:

- **Time-based ageing.** Real NAT applies per-protocol idle timeouts so
  that abandoned or half-open flows free their table entries on their
  own. `loom`'s `NATTable` evicts only via LRU at the
  `max_entries` boundary. Ageing is omitted here because the simulator's scale
  (handfuls of flows for seconds-to-minutes) makes the cap-based
  policy indistinguishable.
- **Per-protocol awareness.** Real NAT applies different policies to
  TCP, UDP, ICMP, and so on. `loom` keys all flows by their conversation
  UUID regardless of payload type. The same omission
  reason as above: the simulator doesn't model the transport layer at all.
- **NAT-loopback.** Traffic from a private host to its
  own NAT's public address is not specially handled. Not relevant
  for the topologies `loom` targets.

---

## Code references

| Concern | File | Symbol |
|---|---|---|
| Per-flow translation table | [`src/entities/nat.py`](../../src/entities/nat.py) | `NATTable` |
| Register / look up a translation | [`src/entities/nat.py`](../../src/entities/nat.py) | `NATTable.register`, `NATTable.lookup` |
| Inbound-flow bookkeeping | [`src/entities/nat.py`](../../src/entities/nat.py) | `NATTable.note_inbound_flow`, `is_inbound_flow` |
| Table snapshot for subscribers | [`src/entities/nat.py`](../../src/entities/nat.py) | `NATTable.snapshot` |
| Outbound rewrite (egress) | [`src/entities/router.py`](../../src/entities/router.py) | `Router._apply_source_nat` |
| Inbound reverse (ingress) | [`src/entities/router.py`](../../src/entities/router.py) | `Router._reverse_inbound_nat` |
| Table accessor | [`src/entities/router.py`](../../src/entities/router.py) | `Router.nat_table` |
| Flow discriminator | [`src/entities/packet.py`](../../src/entities/packet.py) | `Message.flow_key` |
| Private-range definitions | [`src/routing/policy.py`](../../src/routing/policy.py) | `RFC1918_OUTBOUND` |
| Tests | [`test/test_nat.py`](../../test/test_nat.py) | none |
