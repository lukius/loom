from .base import Entity


class Router(Entity):

    def __init__(self, name):
        super().__init__(name)
        self._interfaces = dict()

    def interfaces(self):
        return self._interfaces

    def add_interface(self, interface):
        self._interfaces[interface.name()] = interface
