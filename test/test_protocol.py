import os
import tempfile
import textwrap
import threading
import queue
import time
import unittest

from parser import Parser
from entities import Interface, RoutingProtocol, Router, Network, NetworkAddress, Address, NullAddress, RoutingMessage


SAMPLE_TOPOLOGY = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.1.0/24"
    lan2: "10.0.2.0/24"
    lan3: "10.0.3.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.1.10"}
    h3: {network: lan3, address: "10.0.3.10"}
  routers:
    r1:
      interfaces:
        eth0: {network: lan1, address: "10.0.1.1", cost: 1}
        eth1: {network: lan2, address: "10.0.2.1", cost: 1}
    r2:
      interfaces:
        eth0: {network: lan2, address: "10.0.2.2", cost: 1}
        eth1: {network: lan3, address: "10.0.3.1", cost: 1}
""")


def test_set_keepalive_interval_updates_protocol():
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE_TOPOLOGY)
        path = f.name
    system = Parser(path).parse()
    try:
        r1 = system.routers()["r1"]
        assert r1._protocol.keepalive_interval() == 10
        r1._protocol.set_keepalive_interval(3)
        assert r1._protocol.keepalive_interval() == 3
    finally:
        system.stop()
        os.unlink(path)


def test_set_keepalive_interval_rejects_non_positive():
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE_TOPOLOGY)
        path = f.name
    system = Parser(path).parse()
    try:
        r1 = system.routers()["r1"]
        import pytest as _pt
        with _pt.raises(ValueError):
            r1._protocol.set_keepalive_interval(0)
        with _pt.raises(ValueError):
            r1._protocol.set_keepalive_interval(-1)
    finally:
        system.stop()
        os.unlink(path)


SAMPLE_THREE_ROUTERS_SHARED_NAMES = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.1.0/24"
    lan2: "10.0.2.0/24"
    lan3: "10.0.3.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.1.10"}
  routers:
    r1:
      interfaces:
        eth0: {network: lan1, address: "10.0.1.1", cost: 1}
        eth1: {network: lan2, address: "10.0.2.1", cost: 1}
    r2:
      interfaces:
        eth0: {network: lan1, address: "10.0.1.2", cost: 1}
        eth1: {network: lan2, address: "10.0.2.2", cost: 1}
        eth2: {network: lan3, address: "10.0.3.1", cost: 1}
    r3:
      interfaces:
        eth0: {network: lan2, address: "10.0.2.3", cost: 1}
        eth1: {network: lan3, address: "10.0.3.2", cost: 1}
""")


def test_routers_with_shared_iface_names_all_receive_lsas():
    """Regression: when two routers share an interface name (eth0/eth1), each
    one must still receive LSAs. Previously Network keyed interfaces by name,
    so later-added routers clobbered earlier ones on the same network."""
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE_THREE_ROUTERS_SHARED_NAMES)
        path = f.name
    system = Parser(path).parse()
    try:
        time.sleep(1.5)
        routers = system.routers()
        # every router's graph should know about every other router
        for name, r in routers.items():
            graph_routers = {x.name() for x in r._protocol._graph._routers}
            for other in routers:
                assert other in graph_routers, (
                    f"{name}'s graph missing {other}; has {graph_routers}"
                )
    finally:
        system.stop()
        os.unlink(path)


def test_initial_broadcast_propagates_before_keepalive_interval():
    # Every router must learn the full topology before the 10s keepalive elapses.
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE_TOPOLOGY)
        path = f.name
    system = Parser(path).parse()
    try:
        time.sleep(1.0)  # well under KEEPALIVE_INTERVAL=10
        routers = system.routers()
        prefixes = {
            iface.network().address()
            for r in routers.values()
            for iface in r.interfaces().values()
        }
        for name, r in routers.items():
            graph_prefixes = set(r._protocol._graph.networks())
            missing = prefixes - graph_prefixes
            assert not missing, (
                f"{name} missing prefixes {missing}; saw {graph_prefixes}"
            )
            graph_routers = set(r._protocol._graph._routers)
            assert routers["r1"] in graph_routers, f"{name} graph missing r1"
            assert routers["r2"] in graph_routers, f"{name} graph missing r2"
    finally:
        system.stop()
        os.unlink(path)


class MockThread(object):

    def start(self, *args, **kwargs):
        pass

    def is_alive(self):
        return False


class ProtocolTest(unittest.TestCase):

    def setUp(self):
        self._queue = queue.Queue()

        self._thread_class = threading.Thread
        threading.Thread = lambda *args, **kwargs: MockThread()

        self._interface_send_to = Interface.send_to
        Interface.send_to = lambda _self, pkt, dst_addr: self._queue.put((pkt, dst_addr))

    def tearDown(self):
        threading.Thread = self._thread_class
        Interface.send_to = self._interface_send_to

    def test_message_update(self):
        net1 = Network('lan1', NetworkAddress('200.200.10.0/24'))
        net2 = Network('lan2', NetworkAddress('100.100.0.0/24'))

        router = Router('r1')
        iface1 = Interface('eth0', net1, Address('200.200.10.1'), cost=10)
        iface2 = Interface('eth1', net2, Address('100.100.0.254'), cost=20)
        router.add_interface(iface1)
        router.add_interface(iface2)

        proto = RoutingProtocol(router)
        proto._handle_update()

        result = self._queue.get(timeout=0.1)
        self.assertIsNotNone(result)

        datagram, dst_addr = result
        self.assertEqual(dst_addr, '200.200.10.255')
        self.assertEqual(datagram.source(), '200.200.10.1')
        self.assertEqual(datagram.destination(), '200.200.10.255')

        msg = datagram.payload()
        self.assertEqual(RoutingMessage, msg.type())
        self.assertEqual(msg.seq(), 1)
        self.assertEqual(len(msg.destinations()), 2)
        self.assertEqual(msg.src_address(), '200.200.10.1')
        self.assertEqual(msg.src_router(), router)

        cost = msg.destinations().get(net1.address())
        self.assertIsNotNone(cost)
        self.assertEqual(cost, 10)

        cost = msg.destinations().get(net2.address())
        self.assertIsNotNone(cost)
        self.assertEqual(cost, 20)

    def test_flooding_on_incoming_message(self):
        net1 = Network('lan1', NetworkAddress('200.200.10.0/24'))
        net2 = Network('lan2', NetworkAddress('100.100.0.0/24'))
        net3 = Network('lan3', NetworkAddress('10.10.10.0/24'))

        r1 = Router('r1')
        iface1 = Interface('eth0', net1, Address('200.200.10.1'), cost=10)
        iface2 = Interface('eth1', net2, Address('100.100.0.254'), cost=20)
        iface3 = Interface('eth2', net3, Address('10.10.10.2'), cost=1)
        r1.add_interface(iface1)
        r1.add_interface(iface2)
        r1.add_interface(iface3)

        r2 = Router('r2')
        iface4 = Interface('eth0', net2, Address('100.100.0.1'), cost=15)
        iface5 = Interface('eth1', net3, Address('10.10.10.1'), cost=5)
        r2.add_interface(iface4)
        r2.add_interface(iface5)

        msg = RoutingMessage(src=iface4, seq=1)
        msg.add_destination(prefix=net2.address(), cost=iface4.cost())
        msg.add_destination(prefix=net3.address(), cost=iface5.cost())

        proto = RoutingProtocol(r1)
        proto.handle_incoming_message(msg, iface2)

        datagram1, dst_addr1 = self._queue.get(timeout=0.1)
        self.assertIn(dst_addr1, [net1.broadcast_address(), net3.broadcast_address()])
        payload1 = datagram1.payload()
        self.assertEqual(payload1.src_address(), iface4.address())
        self.assertEqual(payload1.src_router(), r2)
        self.assertEqual(payload1.seq(), 1)
        dests1 = payload1.destinations()
        self.assertEqual(len(dests1), 2)
        self.assertEqual(dests1.get(net2.address(), 0), iface4.cost())
        self.assertEqual(dests1.get(net3.address(), 0), iface5.cost())

        datagram2, dst_addr2 = self._queue.get(timeout=0.1)
        self.assertIn(dst_addr2, [net1.broadcast_address(), net3.broadcast_address()])
        self.assertNotEqual(dst_addr1, dst_addr2)
        payload2 = datagram2.payload()
        self.assertEqual(payload2.src_address(), iface4.address())
        self.assertEqual(payload2.src_router(), r2)
        self.assertEqual(payload2.seq(), 1)
        self.assertEqual(len(payload2.destinations()), 2)
        dests2 = payload2.destinations()
        self.assertEqual(len(dests2), 2)
        self.assertEqual(dests2.get(net2.address(), 0), iface4.cost())
        self.assertEqual(dests2.get(net3.address(), 0), iface5.cost())

        with self.assertRaises(queue.Empty):
            self._queue.get(timeout=0.1)

    def test_routing_table_update_on_incoming_message(self):
        system = Parser(f'test/resources/several_networks.yaml').parse()
        routers = system.routers()
        r1 = routers['r1']
        r2 = routers['r2']
        r3 = routers['r3']
        r4 = routers['r4']

        networks = system.networks()
        lan1 = networks['lan1']
        lan2 = networks['lan2']
        lan3 = networks['lan3']
        lan4 = networks['lan4']
        lan5 = networks['lan5']
        lan6 = networks['lan6']

        hosts = system.hosts()
        h1 = hosts['h1']
        h2 = hosts['h2']
        h3 = hosts['h3']
        h4 = hosts['h4']
        h5 = hosts['h5']
        h6 = hosts['h6']

        r3_eth0 = r3.interface('eth0')
        r3_eth1 = r3.interface('eth1')
        msg = RoutingMessage(src=r3_eth0, seq=1)
        msg.add_destination(prefix=lan4.address(), cost=r3_eth0.cost())
        msg.add_destination(prefix=lan5.address(), cost=r3_eth1.cost())

        proto = RoutingProtocol(r1)
        r1_eth1 = r1.interface('eth1')

        # First message from r3; new connectivity to lan5
        proto.handle_incoming_message(msg, r1_eth1)

        r1_table = r1.routing_table()

        result = r1_table.match(h5.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

        result = r1_table.match(h1.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth0')

        result = r1_table.match(h4.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth1')

        for unreachable_host in [h2, h3, h6]:
            result = r1_table.match(unreachable_host.address())
            self.assertFalse(result.succeeded())

        # Second message from r2; new connectivity to lan2 and lan3
        r2_eth0 = r2.interface('eth0')
        r2_eth1 = r2.interface('eth1')
        r2_eth2 = r2.interface('eth2')
        msg = RoutingMessage(src=r2_eth1, seq=1)
        msg.add_destination(prefix=lan2.address(), cost=r2_eth0.cost())
        msg.add_destination(prefix=lan1.address(), cost=r2_eth1.cost())
        msg.add_destination(prefix=lan3.address(), cost=r2_eth2.cost())

        r1_eth0 = r1.interface('eth0')
        proto.handle_incoming_message(msg, r1_eth0)

        result = r1_table.match(h2.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), r2_eth1.address())
        self.assertEqual(result.interface().name(), 'eth0')

        result = r1_table.match(h3.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), r2_eth1.address())
        self.assertEqual(result.interface().name(), 'eth0')

        # No routing changes for h1, h4 and h5 addresses
        result = r1_table.match(h5.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

        result = r1_table.match(h1.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth0')

        result = r1_table.match(h4.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth1')

        for unreachable_host in [h6]:
            result = r1_table.match(unreachable_host.address())
            self.assertFalse(result.succeeded())

        # Third message from r4; new connectivity to lan6 and routing improvements to some hosts
        r4_eth0 = r4.interface('eth0')
        r4_eth1 = r4.interface('eth1')
        r4_eth2 = r4.interface('eth2')
        msg = RoutingMessage(src=r4_eth2, seq=1)
        msg.add_destination(prefix=lan5.address(), cost=r4_eth0.cost())
        msg.add_destination(prefix=lan6.address(), cost=r4_eth1.cost())
        msg.add_destination(prefix=lan2.address(), cost=r4_eth2.cost())

        proto.handle_incoming_message(msg, r1_eth1)

        # No routing changes for h1, h3, h4 and h5 addresses
        result = r1_table.match(h5.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

        result = r1_table.match(h1.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth0')

        result = r1_table.match(h4.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth1')

        # h2 is now better reached through r1.eth1 via r3
        result = r1_table.match(h2.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

        # Same for h3
        result = r1_table.match(h3.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

        # New connectivity to h6
        result = r1_table.match(h6.address())
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

    def test_local_cost_change_recomputes_routing_table(self):
        # r1: eth1->net2 (cost 1), eth2->net3 (cost 5).
        # r2: net2<->net4 (costs 1,1); r3: net3<->net4 (costs 5,1).
        # Initially net4 cheapest via eth1->r2 (1+1=2 vs 5+1=6).
        # After eth1 cost rises to 100 the eth2->r3 path wins.
        net2 = Network('lan2', NetworkAddress('10.0.2.0/24'))
        net3 = Network('lan3', NetworkAddress('10.0.3.0/24'))
        net4 = Network('lan4', NetworkAddress('10.0.4.0/24'))

        r1 = Router('r1')
        r1_eth1 = Interface('eth1', net2, Address('10.0.2.1'), cost=1)
        r1_eth2 = Interface('eth2', net3, Address('10.0.3.1'), cost=5)
        r1.add_interface(r1_eth1)
        r1.add_interface(r1_eth2)

        r2 = Router('r2')
        r2_eth0 = Interface('eth0', net2, Address('10.0.2.2'), cost=1)
        r2_eth1 = Interface('eth1', net4, Address('10.0.4.1'), cost=1)
        r2.add_interface(r2_eth0)
        r2.add_interface(r2_eth1)

        r3 = Router('r3')
        r3_eth0 = Interface('eth0', net3, Address('10.0.3.2'), cost=5)
        r3_eth1 = Interface('eth1', net4, Address('10.0.4.2'), cost=1)
        r3.add_interface(r3_eth0)
        r3.add_interface(r3_eth1)

        proto = RoutingProtocol(r1)

        msg_r2 = RoutingMessage(src=r2_eth0, seq=1)
        msg_r2.add_destination(prefix=net2.address(), cost=r2_eth0.cost())
        msg_r2.add_destination(prefix=net4.address(), cost=r2_eth1.cost())
        proto.handle_incoming_message(msg_r2, r1_eth1)

        msg_r3 = RoutingMessage(src=r3_eth0, seq=1)
        msg_r3.add_destination(prefix=net3.address(), cost=r3_eth0.cost())
        msg_r3.add_destination(prefix=net4.address(), cost=r3_eth1.cost())
        proto.handle_incoming_message(msg_r3, r1_eth2)

        result = r1.routing_table().match(Address('10.0.4.100'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.interface().name(), 'eth1')

        r1_eth1.set_cost(100)

        proto._handle_update()

        result = r1.routing_table().match(Address('10.0.4.100'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.interface().name(), 'eth2')
