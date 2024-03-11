from .base import Entity
from .exception import EntityNotFoundException


class AS(Entity):

    def __init__(self, name):
        super().__init__(name)
        self._networks = dict()
        self._routers = dict()
        self._hosts = dict()

    def routers(self):
        return self._routers

    def networks(self):
        return self._networks

    def hosts(self):
        return self._hosts

    def network(self, name):
        if name not in self._networks:
            raise EntityNotFoundException(name)

        return self._networks[name]

    def device(self, name):
        if name not in self._hosts and name not in self._routers:
            raise EntityNotFoundException(name)
        if name in self._hosts:
            return self._hosts[name]
        return self._routers[name]

    def add_network(self, network):
        self._networks[network.name()] = network

    def add_router(self, router):
        self._routers[router.name()] = router

    def add_host(self, host):
        self._hosts[host.name()] = host
