from .base import Entity


class AS(Entity):

    def __init__(self, name):
        super().__init__(name)
        self._networks = list()
        self._routers = list()
        self._hosts = list()

    def routers(self):
        return self._routers

    def networks(self):
        return self._networks

    def hosts(self):
        return self._hosts

    def add_network(self, network):
        self._networks.append(network)