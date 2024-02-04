from .base import Entity


class NetworkDevice(Entity):

    def __init__(self, name):
        super().__init__(name)
        self._interfaces = dict()

    def interfaces(self):
        return self._interfaces

    def add_interface(self, interface):
        self._interfaces[interface.name()] = interface
        interface._set_device(self)

    def __eq__(self, other):
        return (self.__class__ == other.__class__ and
                self.name() == other.name())

    def __hash__(self):
        return hash(self.name()) ^ hash(self.__class__)
