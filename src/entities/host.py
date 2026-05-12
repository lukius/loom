from .address import Address
from .device import NetworkDevice
from .event import EventTracer
from .interface import Interface
from .packet import Datagram, UserMessage


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

    def send_message_to(self, msg: UserMessage, addr: Address):
        src = self.address()
        datagram = Datagram(src_addr=src, dst_addr=addr, payload=msg)
        if self._interface.network().contains_address(addr):
            dst_addr = addr
        else:
            dst_addr = self._gw_address
        if dst_addr is None:
            raise ValueError("no route to host: no gateway configured")
        self._interface.send_to(datagram, dst_addr=dst_addr)

        return EventTracer.message_sent(src=src, dst=addr, msg=msg)

    def _handle_message(self, msg, interface):
        if msg.type() == UserMessage:
            return EventTracer.message_received(src=self.address(), msg=msg)

    def _handle_forwarding(self, packet):
        # TODO
        raise Exception(f'{self._name}: cannot forward datagrams')
