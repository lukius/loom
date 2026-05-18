"""Routing-layer exceptions.

Separate from `entities.exception` so the routing package can grow its
own failure modes (no route, graph inconsistency, future BGP cases)
without entangling with entity-layer concerns.
"""


class NoRouteToHostException(Exception):
    """Raised when packet forwarding finds no matching route in the RIB."""


class NoNATEgressException(Exception):
    """Raised when a router with no public interface cannot egress NAT
    for a packet from a private source."""


class GraphConsistencyException(Exception):
    """Raised when a graph operation references nodes that don't exist
    (add_edge with a missing endpoint, shortest_paths from a missing src)."""
