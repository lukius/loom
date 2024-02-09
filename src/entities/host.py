from .device import NetworkDevice
from .interface import Interface


class Host(NetworkDevice):

    def __init__(self, name, net, address, gw_address=None):
        super().__init__(name)

        iface_name = f'iface_{name}'
        self._interface = Interface(iface_name, net, address)
        self.add_interface(self._interface)

        self._gw_address = gw_address

    def network(self):
        return self._interface.network()

    def address(self):
        return self._interface.address()

    def interface(self):
        return self._interface

    def gateway(self):
        return self._gw_address
