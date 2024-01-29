from .base import Entity


class Interface(Entity):

    def __init__(self, name, network, address, cost=0):
        super().__init__(name)
        self._net = network
        self._address = address
        self._cost = cost

    def network(self):
        return self._net

    def address(self):
        return self._address

    def cost(self):
        return self._cost