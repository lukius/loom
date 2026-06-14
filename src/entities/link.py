from ._fabric import _FabricBase
from .address import Address, NetworkAddress
from .device import NetworkDevice


class Link(_FabricBase):
    """Point-to-point link: a fabric with exactly two endpoints.

    Unlike a multi-access Network, a Link has no broadcast domain. Any
    frame entering one end is delivered to the other endpoint (the one
    whose address does not match frame.source()). Capped at two
    interfaces — add_interface raises after the second.
    """

    MAX_ENDPOINTS = 2

    def __init__(self, name, address: NetworkAddress, gate=None):
        mask = address.mask()
        if mask not in (30, 31):
            raise ValueError(f"Link requires /30 or /31 CIDR, got /{mask}")
        super().__init__(name=name, gate=gate)
        self._address = address

    def address(self) -> NetworkAddress:
        return self._address

    def broadcast_address(self) -> Address:
        return self._address.broadcast()

    def contains_address(self, address: Address) -> bool:
        return self._address.matches(address)

    def is_valid_host_address(self, address: Address) -> bool:
        """Return True only if address is a usable host address in this link.

        For /30 links, the network (.0) and broadcast (.3) addresses are
        reserved and not usable.  For /31 links (RFC 3021) both addresses
        are valid host addresses.

        Comparison is by octets (via Address.__eq__), not raw strings, so
        non-canonical spellings such as '10.0.0.00' are correctly rejected.
        """
        if not self._address.matches(address):
            return False
        if self._address.mask() == 30:
            network_addr = Address(str(self._address).split('/')[0])
            if address == network_addr or address == self._address.broadcast():
                return False
        return True

    def devices(self) -> dict:
        return {
            interface.device().name(): interface.device()
            for interface in list(self._interfaces.values())
        }

    def has_device(self, device: NetworkDevice) -> bool:
        for iface in list(self._interfaces.values()):
            if iface.device() == device:
                return True
        return False

    def peer_of(self, interface):
        """Return the other endpoint Interface, or None if it hasn't joined yet."""
        for iface in list(self._interfaces.values()):
            if iface is not interface:
                return iface
        return None

    def _dispatch_packet(self, frame):
        """Deliver frame to the endpoint whose address does not match frame.source().

        Drops the frame silently if the peer has not yet been attached (i.e.
        only one endpoint is registered), guarding against construction races.
        """
        src = frame.source()
        target = None
        for iface in list(self._interfaces.values()):
            if iface.address() != src:
                target = iface
                break
        if target is None:
            # No peer attached yet — drop silently.
            return
        target.receive(frame)
