from .device import NetworkDevice
from .interface import Interface
from .packet import UserMessage, Datagram


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

    def send_message_to(self, message, addr):
        msg = UserMessage(message)
        src = self.interface().address()
        datagram = Datagram(src_addr=src, dst_addr=addr, payload=msg)
        self._interface.send_to(datagram, dst_addr=self._gw_address)

    def _handle_message(self, msg):
        if msg.type() != UserMessage:
            raise Exception('Unknown message type')
        print(f'{self._name} received {msg.payload()}')
        # TODO: event logging

    def _handle_forwarding(self, packet):
        # TODO
        raise Exception(f'{self._name}: cannot forward datagrams')