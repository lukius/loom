from typing import NamedTuple, Optional

from entities.address import NetworkAddress
from entities.packet import Message


class RoutingMessage(Message):
    """Abstract base for link-state-protocol wire messages."""


class Attachment(NamedTuple):
    """One fabric a router is attached to, as advertised in an LSA.

    `cost` is the router's outgoing interface cost onto that fabric.
    `prefix` is the fabric's range when the advertisement policy permits
    announcing it, and None when it does not — a withheld prefix hides the
    fabric as a *destination* while leaving it usable as a *path*.
    """

    cost: int
    prefix: Optional[NetworkAddress]


class LSA(RoutingMessage):
    """A link-state advertisement: one router's view of its own links.

    Origin-tagged, not interface-tagged. The same LSA instance is
    re-used across every interface emission and every re-flood hop.

    Each entry names the **fabric** the router is attached to, keyed by the
    fabric itself rather than by its prefix. Identity matters because two
    different LANs may legally carry the same private CIDR inside one AS;
    keying by prefix would fuse them into a single node and invent paths
    between routers that share nothing.
    """

    @classmethod
    def from_router(cls, router, seq: int, policy) -> "LSA":
        lsa = cls(origin=router, seq=seq)
        for _, iface in router.interfaces().items():
            if not iface.is_up():
                continue
            fabric = iface.network()
            decision = policy.apply(fabric.address())
            prefix = None if decision.is_denied() else decision.prefix()
            lsa.add_attachment(fabric, iface.cost(), prefix=prefix)
        return lsa

    @classmethod
    def withdrawal(cls, router, seq: int) -> "LSA":
        return cls(origin=router, seq=seq, is_withdrawal=True)

    def __init__(self, origin, seq: int, is_withdrawal: bool = False):
        super().__init__()
        self._origin = origin
        self._seq = seq
        self._is_withdrawal = is_withdrawal
        self._attachments: dict = {}

    def origin(self):
        return self._origin

    def seq(self) -> int:
        return self._seq

    def is_withdrawal(self) -> bool:
        return self._is_withdrawal

    def add_attachment(self, fabric, cost: int, prefix: NetworkAddress = None):
        """Advertise an attachment to `fabric`, optionally announcing `prefix`."""
        self._attachments[fabric] = Attachment(cost=cost, prefix=prefix)

    def attachments(self) -> dict:
        """Fabric → Attachment for every fabric this router advertises."""
        return dict(self._attachments)

    def add_link(self, prefix: NetworkAddress, cost: int):
        """Advertise `prefix` as reachable at `cost`.

        Convenience over `add_attachment` for callers that think in prefixes.
        The fabric carrying the prefix is resolved from the origin router so
        the entry keys on the same node as a policy-built advertisement would;
        if the origin has no interface on it, the prefix keys itself.
        """
        self.add_attachment(self._fabric_for(prefix) or prefix, cost, prefix=prefix)

    def links(self) -> dict:
        """Prefix → cost for the destinations this LSA announces.

        Attachments whose prefix was withheld by policy are absent: they are
        topology, not reachability.
        """
        return {
            att.prefix: att.cost
            for att in self._attachments.values()
            if att.prefix is not None
        }

    def is_newer_than(self, other: "LSA") -> bool:
        return self._seq > other.seq()

    def has_same_links_as(self, other: "LSA") -> bool:
        """Whether this LSA describes the same graph contribution as `other`.

        Compares attachments, so a fabric appearing or going away counts as a
        change even when no announced prefix moved — the case for a private
        link or LAN, which contributes topology and no destination at all.
        """
        return self._attachments == other._attachments

    def _fabric_for(self, prefix: NetworkAddress):
        """The origin's fabric carrying `prefix`, or None if it has none."""
        if self._origin is None:
            return None
        for _, iface in self._origin.interfaces().items():
            if iface.network().address() == prefix:
                return iface.network()
        return None
