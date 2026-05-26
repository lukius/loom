# Policy framework

loom's route-map / policy mechanism lives in `src/routing/policy.py`. This
document describes what's wired today and what's reserved for the BGP work
that motivated the design.

See also: [routing-protocol.md](routing-protocol.md) (the flood site where
outbound policy is applied), [nat.md](nat.md) (why private-prefix
filtering matters for cross-tenant isolation).

---

## Why a policy framework

The most operationally consequential thing BGP teaches is **policy** —
local-pref, AS-path manipulation, prefix-lists, route-maps, communities.
Path-vector loop prevention is one paragraph; policy is the rest.

Before loom had any policy concept, the link-state protocol's "don't
advertise RFC 1918 prefixes" rule was a hard-coded `continue` in the
flood loop. That worked for the single case but established no shape for
BGP-era policy. The framework introduced here:

1. **Removes the special case.** The RFC 1918 filter is now a route-map
   instance with one rule (`deny` matching the three private prefixes)
   and a `permit` default — observably identical to the previous
   behaviour, structurally one of many policies.
2. **Reserves the BGP shape.** Set clauses, inbound application,
   AS-path matchers, and per-neighbor route-maps are all named in the
   design but unimplemented; the shape they slot into is fixed.

---

## What's wired today

Public types (all from `routing.policy`):

- `PrefixList(prefixes: list[NetworkAddress])`
  - `matches(candidate) -> bool` — true if any entry contains the candidate
- `RouteMapRule(match: PrefixList, action: 'permit' | 'deny')`
  - `evaluate(prefix) -> Optional[PolicyDecision]` — `None` when match fails
- `RouteMap(rules: list[RouteMapRule], default: 'permit' | 'deny')`
  - `apply(prefix) -> PolicyDecision`
- `PolicyDecision`
  - `is_permitted() -> bool`, `is_denied() -> bool`, `prefix()`
  - constructors: `PolicyDecision.permit(prefix)`, `PolicyDecision.deny(prefix)`

`LinkStateProtocol` holds a `RouteMap` as its **outbound** policy, applied
to each prefix the router considers advertising. The default is
`RFC1918_OUTBOUND` — deny the three RFC 1918 ranges, permit everything
else. Construction site: `LinkStateProtocol.__init__(router, outbound_policy=None)`.

Data flow:

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

## What's reserved for the BGP work

Each of these slots into the existing shape without redesigning it:

- **Set clauses.** A future `RouteMapRule.set_clauses` attribute will
  carry mutations to apply when the match clause fires: `set
  local-preference 200`, `set as-path prepend 65001 65001`, `set
  community 65001:1234`. `PolicyDecision.prefix()` already returns a
  routed prefix object so set-clauses have a place to mutate.
- **Inbound application.** `LinkStateProtocol._handle_update` only
  applies the outbound policy today. The receive path
  (`_update_graph`) has the obvious slot for an inbound policy
  attribute; BGP will use it for inbound filtering and attribute
  rewriting on EBGP receive.
- **Communities and AS-path matchers.** `PrefixList` is the only match
  type modelled. `RouteMapRule.match` will become a list of typed match
  clauses (`MatchPrefix`, `MatchCommunity`, `MatchASPath`) when BGP
  introduces non-prefix matches.
- **Per-neighbor route-maps.** Link-state floods to broadcast, so one
  outbound policy per protocol instance is enough. BGP advertises per
  neighbor with potentially distinct route-maps per direction per peer —
  that becomes a `dict[neighbor_id, RouteMap]` attribute on the BGP
  protocol when it lands.
- **YAML configuration.** No YAML syntax for route-maps yet. When BGP
  ships, the YAML grows a `policies:` block at AS scope and per-router
  references to it.

---

## BGP best-path selection

Once BGP is the second protocol, the canonical best-path tiebreaker
order will be:

1. **Highest local-preference** (most administrators' primary lever)
2. **Shortest AS-path** (loop prevention + traffic-engineering)
3. **Lowest origin** (IGP < EGP < incomplete)
4. **Lowest MED**, optionally only among routes with the same first AS in
   the AS-path
5. **Lowest IGP cost to the BGP next-hop**

This logic will live in one function in the future BGP protocol module.
Plain control flow; no need for a class hierarchy.

---

## Honest disclaimers

This is a teaching-grade framework. It deliberately omits production
behaviours that aren't pedagogically load-bearing at loom's scale:

- **No route-map `continue` / numbered sequence semantics.** `RouteMap`
  rules execute in list order with first-match-wins, full stop.
- **No prefix-list `permit` rows.** `PrefixList` is a pure match clause;
  permit/deny lives on the surrounding `RouteMapRule`.
- **No prefix-list `le` / `ge` length constraints.** Only
  exact-or-contained matching.
- **No regex AS-path matchers.**

If a feature gets imported, it'll be because something in BGP's syllabus
needs it, not because Cisco IOS happens to have it.

---

## Where to look in the code

| Concern | File | Symbol |
|---|---|---|
| Policy primitives | `src/routing/policy.py` | `PrefixList`, `RouteMapRule`, `RouteMap`, `PolicyDecision` |
| Default RFC 1918 policy | `src/routing/policy.py` | `RFC1918_OUTBOUND` |
| Outbound policy wiring | `src/routing/protocol.py` | `LinkStateProtocol.__init__` |
| Policy application site | `src/routing/protocol.py` | `LinkStateProtocol._handle_update` |
