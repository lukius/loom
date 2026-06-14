from ._fabric import _FabricBase
from .address import Address
from .device import NetworkDevice
from .exception import AddressNotInNetworkException


class Network(_FabricBase):

    def __init__(self, name, address, gate=None):
        super().__init__(name=name, gate=gate)
        self._address = address

    def address(self):
        return self._address

    def broadcast_address(self):
        return self._address.broadcast()

    def contains_address(self, address: Address) -> bool:
        return self._address.matches(address)

    def is_valid_host_address(self, address: Address) -> bool:
        """Return True only if address is a usable unicast host address in this network.

        The network address (all-zero host bits) and the broadcast address
        (all-one host bits) are reserved and not usable as interface addresses.

        Comparison is by octets (via Address.__eq__), not raw strings, so
        non-canonical spellings such as '10.0.0.00' are correctly rejected.
        """
        if not self._address.matches(address):
            return False
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

    def _dispatch_packet(self, packet):
        dst = packet.destination()
        if dst == self.broadcast_address():
            self._dispatch_broadcast(packet)
        else:
            self._dispatch_unicast(packet, dst)

    def _dispatch_unicast(self, packet, dst):
        dst_interface = self._interface_with_address(dst)
        dst_interface.receive(packet)

    def _dispatch_broadcast(self, packet):
        # Skip the sending interface: a real NIC filters out frames whose
        # source matches its own address. Without this, a router broadcasting
        # an LSP receives its own broadcast back, treats it as a new external
        # message, and re-floods it out every other interface — amplifying
        # LSP traffic by 2× on every shared LAN.
        src = packet.source()
        for dst_iface in list(self._interfaces.values()):
            if dst_iface.address() == src:
                continue
            dst_iface.receive(packet)

    def _interface_with_address(self, address):
        iface = self._interfaces.get(address)
        if iface is None:
            raise AddressNotInNetworkException(address, self._name)
        return iface
