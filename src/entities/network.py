from .base import Entity
from .device import NetworkDevice
from .address import Address


class Network(Entity):

    def __init__(self, name, address):
        super().__init__(name)
        self._address = address
        self._interfaces = dict()

    def address(self):
        return self._address

    def add_interface(self, interface):
        self._interfaces[interface.name()] = interface

    def devices(self) -> dict:
        return {
            interface.device().name(): interface.device()
            for _, interface in self._interfaces.items()
        }

    def contains(self, device: NetworkDevice) -> bool:
        for _, iface in device.interfaces().items():
            if self.contains(iface.address()):
                return True
        return False

    def contains(self, address: Address) -> bool:
        return self._address.matches(address)
