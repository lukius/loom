import queue

from .base import Entity
from .device import NetworkDevice
from .address import Address


class Network(Entity):

    def __init__(self, name, address):
        super().__init__(name)
        self._address = address
        self._interfaces = dict()
        self._in_queue = queue.Queue()

    def address(self):
        return self._address

    def add_interface(self, interface):
        self._interfaces[interface.name()] = interface
        interface._set_out_queue(self._in_queue)

    def devices(self) -> dict:
        return {
            interface.device().name(): interface.device()
            for _, interface in self._interfaces.items()
        }

    def has_device(self, device: NetworkDevice) -> bool:
        for _, iface in device.interfaces().items():
            net_iface = self._interfaces.get(iface.name())
            if net_iface is not None and net_iface.device() == device:
                return True
        return False

    def contains_address(self, address: Address) -> bool:
        return self._address.matches(address)
