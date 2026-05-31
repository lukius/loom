"""Routing policy primitives — a minimal route-map framework.

The framework expresses outbound filtering today (used by
LinkStateProtocol to drop RFC 1918 prefixes from advertisements) and
reserves the shape for the inbound application points, set clauses,
and AS-path matchers that simplified BGP will introduce.

See docs/architecture/policy.md for the design rationale and the
deferred-slot summary.
"""

from enum import Enum
from typing import List, Optional

from entities.address import NetworkAddress


class _Action(Enum):
    PERMIT = 'permit'
    DENY = 'deny'


class PrefixList:
    """Ordered list of network prefixes used as a route-map match clause.

    A prefix-list matches a candidate prefix if *any* of its entries
    contains the candidate. (BGP's longest-match-of-named-prefix
    semantics are out of scope here.)
    """

    def __init__(self, prefixes: List[NetworkAddress]):
        self._prefixes = list(prefixes)

    def matches(self, prefix: NetworkAddress) -> bool:
        return any(p.contains(prefix) for p in self._prefixes)


class PolicyDecision:
    """Outcome of applying a route-map to a candidate prefix.

    Constructed via `PolicyDecision.permit(prefix)` or
    `PolicyDecision.deny(prefix)`. The decision exposes predicate methods
    (`is_permitted()`, `is_denied()`) rather than discriminating on
    subclass; downstream set-clauses will mutate the carried prefix.
    """

    @classmethod
    def permit(cls, prefix) -> 'PolicyDecision':
        return cls(_Action.PERMIT, prefix)

    @classmethod
    def deny(cls, prefix) -> 'PolicyDecision':
        return cls(_Action.DENY, prefix)

    def __init__(self, action: _Action, prefix):
        self._action = action
        self._prefix = prefix

    def is_permitted(self) -> bool:
        return self._action is _Action.PERMIT

    def is_denied(self) -> bool:
        return self._action is _Action.DENY

    def prefix(self):
        return self._prefix


class RouteMapRule:
    """One numbered rule in a route-map: a match clause + an action.

    Set clauses (e.g. `set local-pref 200`) are reserved for the BGP
    work and not modelled here — when they arrive, this class grows a
    `set_clauses` attribute and the `evaluate()` return value carries
    the mutated prefix.
    """

    def __init__(self, match: PrefixList, action: str):
        if action not in ('permit', 'deny'):
            raise ValueError(f"action must be 'permit' or 'deny', got {action!r}")
        self._match = match
        self._action = _Action(action)

    def evaluate(self, prefix) -> Optional[PolicyDecision]:
        if not self._match.matches(prefix):
            return None
        return (
            PolicyDecision.permit(prefix)
            if self._action is _Action.PERMIT
            else PolicyDecision.deny(prefix)
        )


class RouteMap:
    """Ordered sequence of RouteMapRules with a terminal default action.

    `apply(prefix)` walks the rules; the first to match wins. If none
    matches, the `default` action determines the outcome (`permit` or
    `deny`).
    """

    def __init__(self, rules: List[RouteMapRule], default: str = 'permit'):
        if default not in ('permit', 'deny'):
            raise ValueError(f"default must be 'permit' or 'deny', got {default!r}")
        self._rules = list(rules)
        self._default = _Action(default)

    def apply(self, prefix) -> PolicyDecision:
        for rule in self._rules:
            decision = rule.evaluate(prefix)
            if decision is not None:
                return decision
        return (
            PolicyDecision.permit(prefix)
            if self._default is _Action.PERMIT
            else PolicyDecision.deny(prefix)
        )


# ---- Default policies ----

PERMIT_ALL = RouteMap(rules=[], default='permit')
"""Permit-all route-map: no match rules, default action is permit.

Used as the local-LSA policy so all directly-connected networks
(including RFC 1918) are reflected in the local graph.
"""

RFC1918_OUTBOUND = RouteMap(
    rules=[RouteMapRule(
        match=PrefixList([
            NetworkAddress('10.0.0.0/8'),
            NetworkAddress('172.16.0.0/12'),
            NetworkAddress('192.168.0.0/16'),
        ]),
        action='deny',
    )],
    default='permit',
)
"""Default outbound route-map for LinkStateProtocol: deny RFC 1918,
permit everything else. Wired in D.3.b — replaces the hard-coded
`if prefix.is_private(): continue` in the flood site."""
