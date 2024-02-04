from .device import NetworkDevice
from .interface import Interface


class Host(NetworkDevice):

    def __init__(self, name, net, address):
        super().__init__(name)

        iface_name = f'iface_{name}'
        self._interface = Interface(iface_name, net, address)
        self.add_interface(self._interface)

    def network(self):
        return self._interface.network()

    def address(self):
        return self._interface.address()

    def interface(self):
        return self._interface
