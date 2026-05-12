from .base import Entity
from .clock import PauseGate
from .device import NetworkDevice
from .exception import (
    HostNotFoundException,
    NetworkNotFoundException,
    RouterNotFoundException,
)
from .host import Host
from .router import Router


class AS(Entity):

    def __init__(self, name):
        super().__init__(name)
        self._networks = dict()
        self._routers = dict()
        self._hosts = dict()
        self._gate = PauseGate()

    def gate(self) -> PauseGate:
        return self._gate

    def routers(self):
        return self._routers

    def networks(self):
        return self._networks

    def hosts(self):
        return self._hosts

    def network(self, name):
        if name not in self._networks:
            raise NetworkNotFoundException(name)

        return self._networks[name]

    def device(self, name: str) -> NetworkDevice:
        try:
            return self.host(name)
        except HostNotFoundException:
            pass

        return self.router(name)

    def host(self, name: str) -> Host:
        if name not in self._hosts:
            raise HostNotFoundException(name)
        return self._hosts[name]

    def router(self, name: str) -> Router:
        if name not in self._routers:
            raise RouterNotFoundException(name)
        return self._routers[name]

    def add_network(self, network):
        self._networks[network.name()] = network

    def add_router(self, router):
        router._as_gate = self._gate
        self._routers[router.name()] = router

    def add_host(self, host):
        self._hosts[host.name()] = host

    def stop(self):
        self._gate.stop()
        for network in self._networks.values():
            network.stop()
        for router in self._routers.values():
            router.stop()
