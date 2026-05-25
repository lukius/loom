"""Wire-format messages for the routing layer.

Datagram lives here. The protocol-message family (RoutingMessage
abstract base + LSA + Hello) lives in their own modules under
routing/. Routers and tests should import from ``routing`` (the
package __init__ re-exports everything).
"""
from entities.packet import Packet

_DEFAULT_TTL = 64


class Datagram(Packet):

    def __init__(self, src_addr, dst_addr, payload, ttl=_DEFAULT_TTL):
        super().__init__(src_addr, dst_addr, payload)
        self._ttl = ttl

    def ttl(self):
        return self._ttl

    def decrement_ttl(self):
        self._ttl -= 1
