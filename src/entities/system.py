from .base import Entity
from .clock import PauseGate
from .device import NetworkDevice
from .event import EventTracer
from .exception import (
    ASNotFoundException,
    HostNotFoundException,
    LinkNotFoundException,
    NetworkNotFoundException,
    RouterNotFoundException,
)
from .host import Host
from .router import Router


class AS(Entity):

    def __init__(self, name, gate=None):
        super().__init__(name)
        self._networks = dict()
        self._links = dict()
        self._routers = dict()
        self._hosts = dict()
        self._gate = gate if gate is not None else PauseGate()

    def gate(self) -> PauseGate:
        return self._gate

    def routers(self):
        return self._routers

    def networks(self):
        return self._networks

    def links(self):
        return self._links

    def hosts(self):
        return self._hosts

    def network(self, name):
        if name not in self._networks:
            raise NetworkNotFoundException(name)

        return self._networks[name]

    def link(self, name):
        if name not in self._links:
            raise LinkNotFoundException(name)

        return self._links[name]

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

    def add_link(self, link):
        self._links[link.name()] = link

    def add_router(self, router):
        router._as_gate = self._gate
        self._routers[router.name()] = router

    def add_host(self, host):
        self._hosts[host.name()] = host

    def stop(self):
        self._gate.stop()
        for network in self._networks.values():
            network.stop()
        for link in self._links.values():
            link.stop()
        for router in self._routers.values():
            router.stop()


class Internet(Entity):
    """Top-level container for an entire `loom` simulation.

    Holds one or more `AS` instances and owns the shared `PauseGate`
    (and, after D.2.c, the shared `EventTracer`). Today every
    simulation has exactly one `AS`, so single-AS files are wrapped
    in an `Internet` with that one member. When external routing
    lands, `Internet` will also own the inter-AS link registry.
    """

    def __init__(self, name='loom'):
        super().__init__(name)
        self._ases = dict()
        self._gate = PauseGate()
        self._event_tracer = EventTracer()
        EventTracer.set_current(self._event_tracer)

    def gate(self) -> PauseGate:
        return self._gate

    def event_tracer(self) -> EventTracer:
        return self._event_tracer

    # BGP-FOLLOWUP: rename to `autonomous_systems()` to match the YAML key
    # `autonomous_systems:` introduced in D.2.d. Deferred to BGP work because
    # the BGP agent will be touching all `ases()` call sites anyway when
    # migrating from `single_as()` (see marker above) — one sweep instead of
    # two.
    def ases(self) -> dict:
        return self._ases

    def autonomous_system(self, name: str) -> 'AS':
        if name not in self._ases:
            raise ASNotFoundException(name)
        return self._ases[name]

    def add_as(self, as_) -> None:
        as_._gate = self._gate     # AS shares the Internet's gate
        self._ases[as_.name()] = as_

    # BGP-FOLLOWUP: remove this single-AS unwrap once the codebase supports
    # multi-AS topologies. 34 call sites today (tests, shell, server/state.py)
    # all assume one AS; migrate each to either iterate `autonomous_systems()`
    # (after the rename below) or look up by name via
    # `internet.autonomous_system(name)`.
    def single_as(self):
        """Return the only AS in this Internet. Raises if there are
        zero or multiple ASes. Used by single-AS consumers (the SPA's
        server, the legacy shell) during the multi-AS transition.
        """
        ases = list(self._ases.values())
        if len(ases) != 1:
            raise ValueError(
                f'single_as() requires exactly one AS, found {len(ases)}'
            )
        return ases[0]

    def stop(self):
        self._gate.stop()
        for as_ in self._ases.values():
            as_.stop()
