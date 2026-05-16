from ._fabric import _FabricBase
from .address import Address
from .device import NetworkDevice


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

    def devices(self) -> dict:
        return {
            interface.device().name(): interface.device()
            for interface in self._interfaces.values()
        }

    def has_device(self, device: NetworkDevice) -> bool:
        for iface in self._interfaces.values():
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
        for dst_iface in self._interfaces.values():
            dst_iface.receive(packet)

    def _interface_with_address(self, address):
        iface = self._interfaces.get(address)
        if iface is None:
            raise Exception(f'{address} not in {self._name}')
        return iface
