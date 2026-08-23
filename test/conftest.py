import queue

import pytest

from entities import Address, Network, NetworkAddress, Router
from entities.event import EventTracer
from entities.host import Host
from entities.interface import Interface


@pytest.fixture(autouse=True)
def fresh_event_tracer():
    EventTracer.set_current(EventTracer())
    yield
    EventTracer.set_current(None)  # next test re-initialises lazily via current()


@pytest.fixture
def router_with_iface():
    r = Router("r1")
    net = Network("lan", NetworkAddress("10.0.0.0/24"))
    iface = Interface("eth0", net, Address("10.0.0.1"), cost=1)
    iface._set_out_queue(queue.Queue())
    r.add_interface(iface)
    net.add_interface(iface)
    return r


@pytest.fixture
def ping_host():
    net = Network("lan", NetworkAddress("10.0.0.0/24"))
    return Host("h1", net, Address("10.0.0.1"))
