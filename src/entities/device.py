from .base import Entity


class NetworkDevice(Entity):

    def __init__(self, name):
        super().__init__(name)
        self._interfaces = dict()

    def interfaces(self):
        return self._interfaces

    def interface(self, name):
        return self._interfaces.get(name, None)

    def add_interface(self, interface):
        self._interfaces[interface.name()] = interface
        interface._set_device(self)

    def handle_packet(self, packet, interface):
        dst = packet.destination()
        net_broadcast_addr = interface.network().broadcast_address()
        if dst == interface.address() or dst == net_broadcast_addr:
            self._handle_message(packet.payload(), interface)
        else:
            self._handle_forwarding(packet)

    def _handle_message(self, msg, interface):
        raise NotImplementedError

    def _handle_forwarding(self, packet):
        raise NotImplementedError

    def __eq__(self, other):
        return (self.__class__ == other.__class__ and
                self.name() == other.name())

    def __hash__(self):
        return hash(self.name()) ^ hash(self.__class__)

    def __str__(self):
        return f'{self.__class__.__name__} {self.name()}'

    def __repr__(self):
        return str(self)
