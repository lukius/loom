from .base import Entity


class Network(Entity):

    def __init__(self, name, address, mask):
        super().__init__(name)
        self._address = address
        self._mask = mask

    def address(self):
        return self._address

    def mask(self):
        return self._mask

    def contains(self, address):
        return True
