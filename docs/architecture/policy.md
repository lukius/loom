# Policy framework

A routing protocol has to decide, for every prefix it could advertise,
whether it actually should. loom expresses that decision with a *route
map*, a construct borrowed from production router configuration and
trimmed here to the part that carries the idea.

A route map is an ordered list of rules. Each rule pairs a match
clause, which says the prefixes the rule applies to, with an action,
either `permit` or `deny`. Applying the map to one candidate prefix walks
the rules from the top and stops at the first one whose match clause
fires; that rule's action is the answer, and no later rule is consulted.
If no rule matches at all, the map's default action decides. The whole
mechanism is therefore a single pass over a list, and "first match wins"
is the only precedence rule there is.

The implementation lives in
[`src/routing/policy.py`](../../src/routing/policy.py).

## Why it exists

Today the framework does exactly one job, and it is the job that
motivated writing it. The link-state protocol must not advertise RFC 1918
prefixes to its peers, because private ranges may legally repeat inside
one AS, and a leaked private route would let one tenant's traffic follow
another tenant's prefix.

Before the framework, that rule was a hard-coded `if prefix.is_private():
continue` at the flood site. It worked, but it was a special case with
nowhere to grow: a second rule would have meant a second `if` in the same
loop, with no way to express ordering or precedence between the two.

Rewriting it as a route map changed no observable behaviour. What it
bought is that the filter became one policy instance among possible
others, and the decision of *what* to filter moved out of the code that
performs the flooding. That separation is the point, and it is what would
let later work reuse the mechanism. External routing between autonomous
systems is the obvious candidate, since deciding what to advertise to a
neighbour, and what to accept from one, is most of what such a protocol
does.

See also: [routing-protocol.md](routing-protocol.md) (the flood site
where outbound policy is applied) and [nat.md](nat.md) (why private
prefixes have to stay out of peers' routing tables).

---

## The primitives

Four public types, all importable from `routing.policy`:

| Type | Constructor | Key method |
|---|---|---|
| `PrefixList` | `PrefixList(prefixes: list[NetworkAddress])` | `matches(candidate) -> bool`: true when *any* entry contains the candidate |
| `RouteMapRule` | `RouteMapRule(match: PrefixList, action)` | `evaluate(prefix) -> PolicyDecision \| None`: `None` when the match clause does not fire |
| `RouteMap` | `RouteMap(rules: list[RouteMapRule], default='permit')` | `apply(prefix) -> PolicyDecision` |
| `PolicyDecision` | `PolicyDecision.permit(prefix)` / `.deny(prefix)` | `is_permitted()`, `is_denied()`, `prefix()` |

A `PrefixList` is the only kind of match clause modelled, so "does this
rule apply?" always means "is this prefix contained in one of these
ranges?".

`RouteMapRule` and `RouteMap` both validate their action string at
construction and raise `ValueError` on anything other than `'permit'` or
`'deny'`. A typo therefore fails when the policy is built, rather than
silently permitting something later.

`PolicyDecision` reports its outcome through predicates rather than by
subclass, and carries the prefix it was asked about. Carrying the prefix
is deliberate: a decision is a natural place for a future rule to hand
back a *modified* prefix instead of a verdict on the original.

Evaluation in full:

```
NetworkAddress (prefix)
        │
        ▼  RouteMap.apply(prefix)
   for each RouteMapRule:                    ← first match wins
       PrefixList.matches(prefix)?
            │  yes → PolicyDecision.permit(prefix) or .deny(prefix)
            │  no  → next rule
        ▼ all rules fall through
   default action → PolicyDecision.permit(prefix) or .deny(prefix)
```

---

## Where it is applied today

Two route maps ship as module-level constants, and `LinkStateProtocol`
uses both. They differ only in which side of the router the advertisement
is headed for:

| Policy | Definition | Used for |
|---|---|---|
| `PERMIT_ALL` | no rules, `default='permit'` | the LSA the router installs in its own LSDB |
| `RFC1918_OUTBOUND` | one `deny` rule matching `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`; `default='permit'` | the LSA the router floods to peers |

`LinkStateProtocol.__init__(router, outbound_policy=None)` takes the
outbound policy as a parameter and falls back to `RFC1918_OUTBOUND`. That
is the only injection point; the local policy is fixed at `PERMIT_ALL`.
Both are consumed in `LSA.from_router`, which calls
`policy.apply(fabric.address())` once per up interface.

The asymmetry is what makes a private LAN usable at all. Under
`PERMIT_ALL` the router's own graph contains every directly-connected
prefix, private ones included, so it can route to its own LANs. Under
`RFC1918_OUTBOUND` the copy that leaves the router omits them, so no peer
installs a route to a range that might belong to somebody else.

---

## Reachability, not topology

The policy decides whether a prefix is *announced*, never whether a
fabric is *advertised*. An LSA carries one attachment per fabric the
router sits on, holding the fabric, the cost, and, only when the policy
permits, that fabric's prefix.

So denying `192.168.0.0/16` means "no peer should install a route to this
private range". It does not mean "this LAN does not exist": the fabric
still appears as a node in every peer's graph, and traffic transits it
normally. See [routing-protocol.md](routing-protocol.md#lsa) for the
field split and what it does to shortest-path computation.

---

## What the shape leaves room for

Nothing in this section is implemented. It is listed because the current
structure was chosen to accommodate it without being redesigned, which
makes some of the existing code read oddly until you know what the seams
are for.

- Inbound application. Policy runs on the send path only. The receive
  path (`_handle_incoming_lsa` into `_rebuild_graph_and_recompute`) has
  the matching slot for an inbound policy attribute, which is where
  filtering what a router is willing to *accept* would go.
- Mutating rules. `PolicyDecision` already carries a prefix rather than a
  bare verdict, so a rule that rewrote some attribute of a route would
  have somewhere to put the result.
- Match clauses other than prefixes. `RouteMapRule.match` is a single
  `PrefixList`. Supporting other criteria means turning it into a list of
  typed match clauses; the first-match-wins loop does not change.
- Per-neighbour policy. Link-state floods identically out of every
  interface, so one outbound policy per protocol instance is enough. A
  protocol that advertised differently to different neighbours would keep
  a mapping from neighbour to route map instead.
- Configuration. Route maps are constructed in Python; there is no YAML
  syntax for them, so a topology cannot yet define its own.

---

## Deliberate omissions

This is a teaching-grade framework, and it leaves out route-map
behaviours whose value is operational rather than conceptual:

- No `continue` or numbered sequence semantics. Rules execute in list
  order, first match wins, and evaluation stops there.
- No `permit` / `deny` rows inside a prefix-list. `PrefixList` is a pure
  match clause; the verdict lives on the enclosing `RouteMapRule`.
- No `le` / `ge` prefix-length constraints. An entry matches by
  containment only.
- No longest-match semantics among entries. `matches()` is a plain "any
  entry contains this", so entry order within a `PrefixList` carries no
  meaning.

If any of these arrives later, it should be because a concrete feature
needs it, not because production routers happen to offer it.

---

## Code references

| Concern | File | Symbol |
|---|---|---|
| Policy primitives | [`src/routing/policy.py`](../../src/routing/policy.py) | `PrefixList`, `RouteMapRule`, `RouteMap`, `PolicyDecision` |
| Shipped policies | [`src/routing/policy.py`](../../src/routing/policy.py) | `PERMIT_ALL`, `RFC1918_OUTBOUND` |
| Policy injection | [`src/routing/protocol.py`](../../src/routing/protocol.py) | `LinkStateProtocol.__init__` |
| Policy application | [`src/routing/lsa.py`](../../src/routing/lsa.py) | `LSA.from_router`, called from `_emit_lsa_on_up_interfaces` |
| Receive path (no policy today) | [`src/routing/protocol.py`](../../src/routing/protocol.py) | `_handle_incoming_lsa`, `_rebuild_graph_and_recompute` |
| Tests | [`test/test_policy.py`](../../test/test_policy.py) | none |
