from entities.address import NetworkAddress
from entities.packet import Message, Packet  # noqa: F401

_DEFAULT_TTL = 64


class Datagram(Packet):

    def __init__(self, src_addr, dst_addr, payload, ttl=_DEFAULT_TTL):
        super().__init__(src_addr, dst_addr, payload)
        self._ttl = ttl

    def ttl(self):
        return self._ttl

    def decrement_ttl(self):
        self._ttl -= 1


class RoutingMessage(Message):

    def __init__(self, src, seq: int):
        super().__init__()
        self._src = src
        self._seq = seq
        self._dests = dict()

    def seq(self):
        return self._seq

    def src_address(self):
        return self._src.address()

    def src_router(self):
        return self._src.device()

    def destinations(self):
        return self._dests

    def add_destination(self, prefix: NetworkAddress, cost: int):
        self._dests[prefix] = cost
