from entities.address import NetworkAddress
from entities.packet import Message


class RoutingMessage(Message):
    """Abstract base for link-state-protocol wire messages."""


class LSA(RoutingMessage):
    """A link-state advertisement: one router's view of its own links.

    Origin-tagged, not interface-tagged. The same LSA instance is
    re-used across every interface emission and every re-flood hop.
    """

    @classmethod
    def from_router(cls, router, seq: int, policy) -> 'LSA':
        lsa = cls(origin=router, seq=seq)
        for _, iface in router.interfaces().items():
            if not iface.is_up():
                continue
            decision = policy.apply(iface.network().address())
            if decision.is_denied():
                continue
            lsa.add_link(decision.prefix(), iface.cost())
        return lsa

    @classmethod
    def withdrawal(cls, router, seq: int) -> 'LSA':
        return cls(origin=router, seq=seq, is_withdrawal=True)

    def __init__(self, origin, seq: int, is_withdrawal: bool = False):
        super().__init__()
        self._origin = origin
        self._seq = seq
        self._is_withdrawal = is_withdrawal
        self._links: dict = {}

    def origin(self):
        return self._origin

    def seq(self) -> int:
        return self._seq

    def is_withdrawal(self) -> bool:
        return self._is_withdrawal

    def add_link(self, prefix: NetworkAddress, cost: int):
        self._links[prefix] = cost

    def links(self) -> dict:
        return dict(self._links)

    def is_newer_than(self, other: 'LSA') -> bool:
        return self._seq > other.seq()

    def has_same_links_as(self, other: 'LSA') -> bool:
        return self._links == other._links
