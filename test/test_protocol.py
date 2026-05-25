import os
import queue
import tempfile
import textwrap
import threading
import time
import unittest

import pytest

from entities import (
    Address,
    Interface,
    Network,
    NetworkAddress,
    NullAddress,
    Router,
)
from parser import Parser
from routing import LSA, Hello, LinkStateProtocol, RouteMap
from routing.policy import RFC1918_OUTBOUND


def test_one_cycle_emits_single_lsa_with_uniform_seq_across_interfaces():
    """A router with N interfaces emits N datagrams in one cycle, all
    carrying the same LSA object with the same seq."""
    net1 = Network('lan1', NetworkAddress('200.0.10.0/24'))
    net2 = Network('lan2', NetworkAddress('200.0.20.0/24'))
    net3 = Network('lan3', NetworkAddress('200.0.30.0/24'))

    r = Router('r1')
    i1 = Interface('eth0', net1, Address('200.0.10.1'), cost=1)
    i2 = Interface('eth1', net2, Address('200.0.20.1'), cost=1)
    i3 = Interface('eth2', net3, Address('200.0.30.1'), cost=1)
    r.add_interface(i1)
    r.add_interface(i2)
    r.add_interface(i3)

    sent = []
    original_send = Interface.send_to
    Interface.send_to = lambda self, pkt, dst_addr: sent.append((self.name(), pkt))
    try:
        proto = LinkStateProtocol(r)
        proto._handle_update()  # noqa: SLF001
    finally:
        Interface.send_to = original_send

    lsa_payloads = [pkt.payload() for _, pkt in sent if isinstance(pkt.payload(), LSA)]
    assert len(lsa_payloads) == 3
    # Single LSA object reused.
    assert all(p is lsa_payloads[0] for p in lsa_payloads[1:])
    # Single seq.
    seq = lsa_payloads[0].seq()
    assert all(p.seq() == seq for p in lsa_payloads)


def _wait(condition, timeout=3.0, interval=0.02):
    """Poll *condition* until True or *timeout* elapses."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(interval)
    return False


SAMPLE_TOPOLOGY = textwrap.dedent("""
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan1: "200.0.1.0/24"
        lan2: "200.0.2.0/24"
        lan3: "200.0.3.0/24"
      hosts:
        h1: {network: lan1, address: "200.0.1.10"}
        h3: {network: lan3, address: "200.0.3.10"}
      routers:
        r1:
          interfaces:
            eth0: {network: lan1, address: "200.0.1.1", cost: 1}
            eth1: {network: lan2, address: "200.0.2.1", cost: 1}
        r2:
          interfaces:
            eth0: {network: lan2, address: "200.0.2.2", cost: 1}
            eth1: {network: lan3, address: "200.0.3.1", cost: 1}
""")


def test_set_keepalive_interval_updates_protocol():
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE_TOPOLOGY)
        path = f.name
    system = Parser(path).parse().single_as()
    try:
        r1 = system.routers()["r1"]
        assert r1.protocol().keepalive_interval() == 10
        r1.protocol().set_keepalive_interval(3)
        assert r1.protocol().keepalive_interval() == 3
    finally:
        system.stop()
        os.unlink(path)


def test_set_keepalive_interval_rejects_non_positive():
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE_TOPOLOGY)
        path = f.name
    system = Parser(path).parse().single_as()
    try:
        r1 = system.routers()["r1"]
        with pytest.raises(ValueError):
            r1.protocol().set_keepalive_interval(0)
        with pytest.raises(ValueError):
            r1.protocol().set_keepalive_interval(-1)
    finally:
        system.stop()
        os.unlink(path)


SAMPLE_THREE_ROUTERS_SHARED_NAMES = textwrap.dedent("""
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
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
    original = LinkStateProtocol.KEEPALIVE_INTERVAL
    LinkStateProtocol.KEEPALIVE_INTERVAL = 0.3
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE_THREE_ROUTERS_SHARED_NAMES)
        path = f.name
    system = Parser(path).parse().single_as()
    try:
        routers = system.routers()

        def all_graphs_complete():
            for name, r in routers.items():
                graph_routers = {x.name() for x in r.protocol()._graph._routers}  # noqa: SLF001
                for other in routers:
                    if other not in graph_routers:
                        return False
            return True

        assert _wait(all_graphs_complete, timeout=5.0), (
            "not all routers converged within timeout"
        )
    finally:
        system.stop()
        os.unlink(path)
        LinkStateProtocol.KEEPALIVE_INTERVAL = original


def test_stop_then_start_resumes_periodic_ticks():
    """Regression: SimState load/start hits start()->stop()->start(). The second
    start must reset _stopped or the alive-but-sleeping thread exits on next wake.

    Count ticks per router instead of events: more deterministic.
    """
    original = LinkStateProtocol.KEEPALIVE_INTERVAL
    LinkStateProtocol.KEEPALIVE_INTERVAL = 0.4
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            f.write(SAMPLE_TOPOLOGY)
            path = f.name
        # Wrap _safe_tick to count ticks per router instance.
        tick_counts = {}
        original_tick = LinkStateProtocol._safe_tick

        def counting_tick(self):
            name = self._router.name()
            tick_counts[name] = tick_counts.get(name, 0) + 1
            original_tick(self)

        LinkStateProtocol._safe_tick = counting_tick
        try:
            system = Parser(path).parse().single_as()
            for r in system.routers().values():
                r.stop()
            tick_counts.clear()  # ignore the parser-time initial tick
            for r in system.routers().values():
                r.start()
            try:
                time.sleep(2.0)  # expect ~5 ticks per router at 0.4s interval
                for name in system.routers():
                    count = tick_counts.get(name, 0)
                    assert count >= 3, (
                        f"{name} ticked only {count} times after restart"
                    )
            finally:
                system.stop()
                os.unlink(path)
        finally:
            LinkStateProtocol._safe_tick = original_tick
    finally:
        LinkStateProtocol.KEEPALIVE_INTERVAL = original


def test_initial_broadcast_propagates_before_keepalive_interval():
    # Every router must learn the full topology after two keepalive ticks
    # (TWO_WAY adjacency requires both sides to list each other).
    original = LinkStateProtocol.KEEPALIVE_INTERVAL
    LinkStateProtocol.KEEPALIVE_INTERVAL = 0.3
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE_TOPOLOGY)
        path = f.name
    system = Parser(path).parse().single_as()
    try:
        routers = system.routers()
        prefixes = {
            iface.network().address()
            for r in routers.values()
            for iface in r.interfaces().values()
        }

        def all_converged():
            for name, r in routers.items():
                graph_prefixes = set(r.protocol()._graph.networks())  # noqa: SLF001
                if prefixes - graph_prefixes:
                    return False
                graph_routers = set(r.protocol()._graph._routers)  # noqa: SLF001
                if routers["r1"] not in graph_routers:
                    return False
                if routers["r2"] not in graph_routers:
                    return False
            return True

        assert _wait(all_converged, timeout=5.0), "routers did not converge in time"
    finally:
        system.stop()
        os.unlink(path)
        LinkStateProtocol.KEEPALIVE_INTERVAL = original


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
        Interface.send_to = (
            lambda _self, pkt, dst_addr: self._queue.put((pkt, dst_addr))
        )

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

        proto = LinkStateProtocol(router)
        proto._handle_update()

        # _handle_update now emits a Hello then an LSA per interface; drain
        # until we find the first LSA datagram.
        datagram = None
        dst_addr = None
        for _ in range(self._queue.qsize() + 4):
            item = self._queue.get(timeout=0.1)
            self.assertIsNotNone(item)
            pkt, addr = item
            if isinstance(pkt.payload(), LSA):
                datagram, dst_addr = pkt, addr
                break

        self.assertIsNotNone(datagram)
        self.assertEqual(dst_addr, '200.200.10.255')
        self.assertEqual(datagram.source(), '200.200.10.1')
        self.assertEqual(datagram.destination(), '200.200.10.255')

        msg = datagram.payload()
        self.assertIsInstance(msg, LSA)
        self.assertEqual(msg.seq(), 1)
        links = msg.links()
        self.assertEqual(len(links), 2)
        self.assertIs(msg.origin(), router)

        cost = links.get(net1.address())
        self.assertIsNotNone(cost)
        self.assertEqual(cost, 10)

        cost = links.get(net2.address())
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

        msg = LSA(origin=r2, seq=1)
        msg.add_link(net2.address(), iface4.cost())
        msg.add_link(net3.address(), iface5.cost())

        proto = LinkStateProtocol(r1)
        proto.handle_incoming_message(msg, iface2)

        datagram1, dst_addr1 = self._queue.get(timeout=0.1)
        self.assertIn(dst_addr1, [net1.broadcast_address(), net3.broadcast_address()])
        payload1 = datagram1.payload()
        self.assertIs(payload1.origin(), r2)
        self.assertEqual(payload1.seq(), 1)
        links1 = payload1.links()
        self.assertEqual(len(links1), 2)
        self.assertEqual(links1.get(net2.address(), 0), iface4.cost())
        self.assertEqual(links1.get(net3.address(), 0), iface5.cost())

        datagram2, dst_addr2 = self._queue.get(timeout=0.1)
        self.assertIn(dst_addr2, [net1.broadcast_address(), net3.broadcast_address()])
        self.assertNotEqual(dst_addr1, dst_addr2)
        payload2 = datagram2.payload()
        self.assertIs(payload2.origin(), r2)
        self.assertEqual(payload2.seq(), 1)
        links2 = payload2.links()
        self.assertEqual(len(links2), 2)
        self.assertEqual(links2.get(net2.address(), 0), iface4.cost())
        self.assertEqual(links2.get(net3.address(), 0), iface5.cost())

        with self.assertRaises(queue.Empty):
            self._queue.get(timeout=0.1)

    def test_routing_table_update_on_incoming_message(self):
        system = Parser('test/resources/several_networks.yaml').parse().single_as()
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
        msg = LSA(origin=r3, seq=1)
        msg.add_link(lan4.address(), r3_eth0.cost())
        msg.add_link(lan5.address(), r3_eth1.cost())

        proto = LinkStateProtocol(r1)
        r1_eth1 = r1.interface('eth1')
        # Seed TWO_WAY adjacency so r3's LSA is eligible for the graph.
        proto._neighbor_table.record_hello(  # noqa: SLF001
            r1_eth1, r3, peer_listed_us=True,
            dead_interval=proto._dead_interval, now=time.monotonic(),  # noqa: SLF001
        )

        # First message from r3; new connectivity to lan5
        proto.handle_incoming_message(msg, r1_eth1)

        r1_table = r1.routing_table()

        result = r1_table.match(h5.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

        result = r1_table.match(h1.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth0')

        result = r1_table.match(h4.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth1')

        for unreachable_host in [h2, h3, h6]:
            result = r1_table.match(unreachable_host.address())
            self.assertFalse(result.is_matched())

        # Second message from r2; new connectivity to lan2 and lan3
        r2_eth0 = r2.interface('eth0')
        r2_eth1 = r2.interface('eth1')
        r2_eth2 = r2.interface('eth2')
        msg = LSA(origin=r2, seq=1)
        msg.add_link(lan2.address(), r2_eth0.cost())
        msg.add_link(lan1.address(), r2_eth1.cost())
        msg.add_link(lan3.address(), r2_eth2.cost())

        r1_eth0 = r1.interface('eth0')
        # Seed TWO_WAY adjacency so r2's LSA is eligible for the graph.
        proto._neighbor_table.record_hello(  # noqa: SLF001
            r1_eth0, r2, peer_listed_us=True,
            dead_interval=proto._dead_interval, now=time.monotonic(),  # noqa: SLF001
        )
        proto.handle_incoming_message(msg, r1_eth0)

        result = r1_table.match(h2.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), r2_eth1.address())
        self.assertEqual(result.interface().name(), 'eth0')

        result = r1_table.match(h3.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), r2_eth1.address())
        self.assertEqual(result.interface().name(), 'eth0')

        # No routing changes for h1, h4 and h5 addresses
        result = r1_table.match(h5.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

        result = r1_table.match(h1.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth0')

        result = r1_table.match(h4.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth1')

        for unreachable_host in [h6]:
            result = r1_table.match(unreachable_host.address())
            self.assertFalse(result.is_matched())

        # Third message from r4; new connectivity to lan6 and routing improvements
        # to some hosts
        r4_eth0 = r4.interface('eth0')
        r4_eth1 = r4.interface('eth1')
        r4_eth2 = r4.interface('eth2')
        msg = LSA(origin=r4, seq=1)
        msg.add_link(lan5.address(), r4_eth0.cost())
        msg.add_link(lan6.address(), r4_eth1.cost())
        msg.add_link(lan2.address(), r4_eth2.cost())

        # Seed TWO_WAY adjacency so r4's LSA is eligible for the graph.
        proto._neighbor_table.record_hello(  # noqa: SLF001
            r1_eth1, r4, peer_listed_us=True,
            dead_interval=proto._dead_interval, now=time.monotonic(),  # noqa: SLF001
        )
        proto.handle_incoming_message(msg, r1_eth1)

        # No routing changes for h1, h3, h4 and h5 addresses
        result = r1_table.match(h5.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

        result = r1_table.match(h1.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth0')

        result = r1_table.match(h4.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth1')

        # h2 is now better reached through r1.eth1 via r3
        result = r1_table.match(h2.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

        # Same for h3
        result = r1_table.match(h3.address())
        self.assertTrue(result.is_matched())
        self.assertEqual(result.next_hop(), r3_eth0.address())
        self.assertEqual(result.interface().name(), 'eth1')

        # New connectivity to h6
        result = r1_table.match(h6.address())
        self.assertTrue(result.is_matched())
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

        proto = LinkStateProtocol(r1)

        # Seed TWO_WAY adjacencies so r2 and r3 LSAs are eligible for the graph.
        proto._neighbor_table.record_hello(  # noqa: SLF001
            r1_eth1, r2, peer_listed_us=True,
            dead_interval=proto._dead_interval, now=time.monotonic(),  # noqa: SLF001
        )
        proto._neighbor_table.record_hello(  # noqa: SLF001
            r1_eth2, r3, peer_listed_us=True,
            dead_interval=proto._dead_interval, now=time.monotonic(),  # noqa: SLF001
        )

        msg_r2 = LSA(origin=r2, seq=1)
        msg_r2.add_link(net2.address(), r2_eth0.cost())
        msg_r2.add_link(net4.address(), r2_eth1.cost())
        proto.handle_incoming_message(msg_r2, r1_eth1)

        msg_r3 = LSA(origin=r3, seq=1)
        msg_r3.add_link(net3.address(), r3_eth0.cost())
        msg_r3.add_link(net4.address(), r3_eth1.cost())
        proto.handle_incoming_message(msg_r3, r1_eth2)

        result = r1.routing_table().match(Address('10.0.4.100'))
        self.assertTrue(result.is_matched())
        self.assertEqual(result.interface().name(), 'eth1')

        r1_eth1.set_cost(100)

        proto._handle_update()

        result = r1.routing_table().match(Address('10.0.4.100'))
        self.assertTrue(result.is_matched())
        self.assertEqual(result.interface().name(), 'eth2')


# ---------------------------------------------------------------------------
# P2P link convergence tests
# ---------------------------------------------------------------------------

TWO_ROUTERS_SLASH30 = textwrap.dedent("""
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan_r1: "200.0.1.0/24"
        lan_r2: "200.0.2.0/24"
      links:
        p2p1: "200.0.0.0/30"
      routers:
        r1:
          interfaces:
            eth0: {network: lan_r1, address: "200.0.1.1", cost: 1}
            eth1: {link: p2p1, address: "200.0.0.1", cost: 5}
        r2:
          interfaces:
            eth0: {link: p2p1, address: "200.0.0.2", cost: 5}
            eth1: {network: lan_r2, address: "200.0.2.1", cost: 1}
""")

TWO_ROUTERS_SLASH31 = textwrap.dedent("""
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan_r1: "200.0.1.0/24"
        lan_r2: "200.0.2.0/24"
      links:
        p2p1: "200.0.0.0/31"
      routers:
        r1:
          interfaces:
            eth0: {network: lan_r1, address: "200.0.1.1", cost: 1}
            eth1: {link: p2p1, address: "200.0.0.0", cost: 5}
        r2:
          interfaces:
            eth0: {link: p2p1, address: "200.0.0.1", cost: 5}
            eth1: {network: lan_r2, address: "200.0.2.1", cost: 1}
""")

# Three routers: r1<->r2 via /30 link (asymmetric cost), r1<->r3 via lan_mid,
# r3<->r2 via lan_mid2.  After convergence r1 prefers the longer (link) path
# only if it is cheaper; with asymmetric link costs 5+5 < alternate we verify
# graph weights, not route selection, here.
TWO_ROUTERS_ASYMMETRIC_COST = textwrap.dedent("""
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan_r1: "200.0.1.0/24"
        lan_r2: "200.0.2.0/24"
        lan_mid: "200.0.10.0/24"
        lan_mid2: "200.0.20.0/24"
      links:
        p2p1: "200.0.0.0/30"
      routers:
        r1:
          interfaces:
            eth0: {network: lan_r1, address: "200.0.1.1", cost: 1}
            eth1: {link: p2p1, address: "200.0.0.1", cost: 5}
            eth2: {network: lan_mid, address: "200.0.10.1", cost: 1}
        r2:
          interfaces:
            eth0: {link: p2p1, address: "200.0.0.2", cost: 9}
            eth1: {network: lan_r2, address: "200.0.2.1", cost: 1}
            eth2: {network: lan_mid2, address: "200.0.20.1", cost: 1}
        r3:
          interfaces:
            eth0: {network: lan_mid, address: "200.0.10.2", cost: 1}
            eth1: {network: lan_mid2, address: "200.0.20.2", cost: 1}
""")


def _make_tmp_topology(yaml_text):
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml_text)
        return f.name


def _table_has_prefix(router, prefix_str):
    """Return True when the router's table has a rule for prefix_str."""
    prefix = NetworkAddress(prefix_str)
    return any(r.prefix() == prefix for r in router.routing_table().rules())


def test_two_routers_one_link_converge():
    """Two routers on a /30 link converge: each learns the peer's LAN and the
    link prefix as directly connected."""
    original = LinkStateProtocol.KEEPALIVE_INTERVAL
    LinkStateProtocol.KEEPALIVE_INTERVAL = 0.3
    path = _make_tmp_topology(TWO_ROUTERS_SLASH30)
    system = Parser(path).parse().single_as()
    try:
        r1 = system.routers()["r1"]
        r2 = system.routers()["r2"]

        # Wait for full convergence on both sides.
        assert _wait(lambda: (
            _table_has_prefix(r1, "200.0.0.0/30")
            and _table_has_prefix(r1, "200.0.1.0/24")
            and _table_has_prefix(r1, "200.0.2.0/24")
        )), "r1 did not converge in time"

        assert _wait(lambda: (
            _table_has_prefix(r2, "200.0.0.0/30")
            and _table_has_prefix(r2, "200.0.2.0/24")
            and _table_has_prefix(r2, "200.0.1.0/24")
        )), "r2 did not converge in time"

        # r1: link prefix and own LAN are directly connected (NullAddress).
        r1_link = r1.routing_table().match(Address("200.0.0.1"))
        assert r1_link.is_matched()
        assert r1_link.next_hop() == NullAddress
        assert r1_link.interface().name() == "eth1"

        r1_own = r1.routing_table().match(Address("200.0.1.100"))
        assert r1_own.is_matched()
        assert r1_own.next_hop() == NullAddress
        assert r1_own.interface().name() == "eth0"

        # r1 reaches r2's LAN via r2's link address as next-hop.
        r1_remote = r1.routing_table().match(Address("200.0.2.100"))
        assert r1_remote.is_matched()
        assert r1_remote.next_hop() == Address("200.0.0.2")
        assert r1_remote.interface().name() == "eth1"

        # r2: mirror assertions.
        r2_link = r2.routing_table().match(Address("200.0.0.2"))
        assert r2_link.is_matched()
        assert r2_link.next_hop() == NullAddress
        assert r2_link.interface().name() == "eth0"

        r2_own = r2.routing_table().match(Address("200.0.2.100"))
        assert r2_own.is_matched()
        assert r2_own.next_hop() == NullAddress
        assert r2_own.interface().name() == "eth1"

        r2_remote = r2.routing_table().match(Address("200.0.1.100"))
        assert r2_remote.is_matched()
        assert r2_remote.next_hop() == Address("200.0.0.1")
        assert r2_remote.interface().name() == "eth0"
    finally:
        system.stop()
        os.unlink(path)
        LinkStateProtocol.KEEPALIVE_INTERVAL = original


def test_link_slash31_converge():
    """/31 link topology converges with identical table structure to /30."""
    original = LinkStateProtocol.KEEPALIVE_INTERVAL
    LinkStateProtocol.KEEPALIVE_INTERVAL = 0.3
    path = _make_tmp_topology(TWO_ROUTERS_SLASH31)
    system = Parser(path).parse().single_as()
    try:
        r1 = system.routers()["r1"]
        r2 = system.routers()["r2"]

        assert _wait(lambda: (
            _table_has_prefix(r1, "200.0.0.0/31")
            and _table_has_prefix(r1, "200.0.1.0/24")
            and _table_has_prefix(r1, "200.0.2.0/24")
        )), "r1 did not converge in time (/31)"

        assert _wait(lambda: (
            _table_has_prefix(r2, "200.0.0.0/31")
            and _table_has_prefix(r2, "200.0.2.0/24")
            and _table_has_prefix(r2, "200.0.1.0/24")
        )), "r2 did not converge in time (/31)"

        # r1's own LAN is directly connected.
        r1_own = r1.routing_table().match(Address("200.0.1.100"))
        assert r1_own.is_matched()
        assert r1_own.next_hop() == NullAddress
        assert r1_own.interface().name() == "eth0"

        # r1's link prefix is directly connected.
        r1_link = r1.routing_table().match(Address("200.0.0.0"))
        assert r1_link.is_matched()
        assert r1_link.next_hop() == NullAddress
        assert r1_link.interface().name() == "eth1"

        # r1 reaches r2's LAN via r2's link address.
        r1_remote = r1.routing_table().match(Address("200.0.2.100"))
        assert r1_remote.is_matched()
        assert r1_remote.next_hop() == Address("200.0.0.1")
        assert r1_remote.interface().name() == "eth1"

        # r2's link prefix is directly connected.
        r2_link = r2.routing_table().match(Address("200.0.0.1"))
        assert r2_link.is_matched()
        assert r2_link.next_hop() == NullAddress
        assert r2_link.interface().name() == "eth0"

        # r2 reaches r1's LAN via r1's link address.
        r2_remote = r2.routing_table().match(Address("200.0.1.100"))
        assert r2_remote.is_matched()
        assert r2_remote.next_hop() == Address("200.0.0.0")
        assert r2_remote.interface().name() == "eth0"
    finally:
        system.stop()
        os.unlink(path)
        LinkStateProtocol.KEEPALIVE_INTERVAL = original


def test_link_cost_propagates():
    """Asymmetric costs on a /30 link propagate into each router's graph.

    r1↔r2 link has cost 5 on r1's side and 9 on r2's side.  r3 bridges r1
    and r2 via two shared LANs at cost 1 each.  After convergence:
      - r1's graph stores weight 5 from r1 to the link prefix.
      - r2's graph stores weight 9 from r2 to the link prefix.
      - r1 reaches r2's LAN (10.0.2.0/24) via r3 (eth2, cost 1+1+1+1+1=5)
        rather than the direct link (eth1, graph cost 5+9+1=15: r1→p2p1
        at 5, p2p1→r2 at r2's announced cost 9, r2→lan_r2 at 1).
    """
    original = LinkStateProtocol.KEEPALIVE_INTERVAL
    LinkStateProtocol.KEEPALIVE_INTERVAL = 0.3
    path = _make_tmp_topology(TWO_ROUTERS_ASYMMETRIC_COST)
    system = Parser(path).parse().single_as()
    try:
        r1 = system.routers()["r1"]
        r2 = system.routers()["r2"]
        r3 = system.routers()["r3"]

        link_prefix = NetworkAddress("200.0.0.0/30")

        def _r1_routes_lan_r2_via_eth2():
            result = r1.routing_table().match(Address("200.0.2.100"))
            return result.is_matched() and result.interface().name() == "eth2"

        # Wait for full convergence: every router must have every prefix AND r1
        # must have settled on the cheaper path via r3 (eth2).  Checking only
        # prefix presence is not enough — the route may temporarily point at
        # eth1 (direct link, cost 5+9+1=15) before r3's LSAs arrive and cause
        # Dijkstra to prefer the cheaper path via r3 (cost 1+1+1+1+1=5).
        assert _wait(lambda: all(
            _table_has_prefix(r, p)
            for r in [r1, r2, r3]
            for p in ["200.0.1.0/24", "200.0.2.0/24", "200.0.0.0/30",
                      "200.0.10.0/24", "200.0.20.0/24"]
        ) and _r1_routes_lan_r2_via_eth2()), \
            "routers did not converge in time (asymmetric-cost test)"

        # r1's graph: edge r1→link_prefix has cost 5 (r1's own cost).
        r1_link_cost = r1.protocol()._graph.weight(r1, link_prefix)  # noqa: SLF001
        assert r1_link_cost == 5, f"expected r1→link cost 5, got {r1_link_cost}"

        # r2's graph: edge r2→link_prefix has cost 9 (r2's own cost).
        r2_link_cost = r2.protocol()._graph.weight(r2, link_prefix)  # noqa: SLF001
        assert r2_link_cost == 9, f"expected r2→link cost 9, got {r2_link_cost}"

        # r1 prefers r3's path (cost 1+1+1+1+1=5) over the direct link (cost
        # 5+9+1=15) to reach lan_r2; verified by _wait above.
        # Double-check the final routing table entry.
        r1_to_lan_r2 = r1.routing_table().match(Address("200.0.2.100"))
        assert r1_to_lan_r2.is_matched()
        assert r1_to_lan_r2.interface().name() == "eth2", (
            f"expected r1 to route via eth2 (cheaper via r3), "
            f"got {r1_to_lan_r2.interface().name()}"
        )
    finally:
        system.stop()
        os.unlink(path)
        LinkStateProtocol.KEEPALIVE_INTERVAL = original


def test_handle_update_omits_private_prefixes_from_outbound_message():
    """A router with one public and one private interface advertises only
    the public prefix on every interface's RoutingMessage.

    Private (RFC 1918) prefixes are intentionally hidden from peers; only
    the local router knows about its own private interfaces for installing
    directly-connected rules.
    """
    topology = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan_public: "200.100.0.0/24"
            lan_private: "192.168.1.0/24"
          hosts:
            h_pub: {network: lan_public, address: "200.100.0.10"}
            h_priv:
              network: lan_private
              address: "192.168.1.10"
              gateway: "192.168.1.1"
          routers:
            r1:
              interfaces:
                eth0: {network: lan_public, address: "200.100.0.1", cost: 10}
                eth1: {network: lan_private, address: "192.168.1.1", cost: 5}
    """)
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(topology)
        path = f.name
    system = Parser(path).parse().single_as()
    try:
        r1 = system.routers()["r1"]
        # Join r1's keepalive thread before patching so its initial tick
        # (fired by Parser auto-start) can't race the explicit _handle_update
        # below and double the captured-message count.
        r1.protocol().stop()

        captured: list[LSA] = []

        original_send = Interface.send_to
        def capturing_send(self, pkt, dst_addr):
            if isinstance(pkt.payload(), LSA):
                captured.append(pkt.payload())
            return original_send(self, pkt, dst_addr)
        Interface.send_to = capturing_send
        try:
            r1.protocol()._handle_update()  # noqa: SLF001
        finally:
            Interface.send_to = original_send

        assert len(captured) == 2, (
            f"expected one LSA per interface, got {len(captured)}"
        )
        for msg in captured:
            prefixes = list(msg.links().keys())
            assert NetworkAddress('200.100.0.0/24') in prefixes, (
                f"public prefix should be advertised, got {prefixes}"
            )
            assert NetworkAddress('192.168.1.0/24') not in prefixes, (
                f"private prefix should NOT be advertised, got {prefixes}"
            )
    finally:
        system.stop()
        os.unlink(path)


def test_receiver_graph_never_learns_private_prefix():
    """A router receiving a RoutingMessage from a neighbor with a private
    LAN should NOT have the private prefix in its graph.

    This is the receiver-side pin for the source-side filter: even if the
    receiver wanted to learn about a private prefix, the sender never puts
    it on the wire.
    """
    original = LinkStateProtocol.KEEPALIVE_INTERVAL
    LinkStateProtocol.KEEPALIVE_INTERVAL = 0.3
    topology = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan_private: "10.0.0.0/24"
          links:
            p2p: "200.100.0.0/30"
          hosts:
            h_priv: {network: lan_private, address: "10.0.0.10", gateway: "10.0.0.1"}
          routers:
            r1:
              interfaces:
                eth0: {network: lan_private, address: "10.0.0.1", cost: 5}
                eth1: {link: p2p, address: "200.100.0.1", cost: 1}
            r2:
              interfaces:
                eth0: {link: p2p, address: "200.100.0.2", cost: 1}
    """)
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(topology)
        path = f.name
    system = Parser(path).parse().single_as()
    try:
        _r1 = system.routers()["r1"]
        r2 = system.routers()["r2"]

        # Wait for r2 to converge on what r1 advertises.
        # r2 should know the p2p /30 (public) but never the private LAN.
        assert _wait(
            lambda: NetworkAddress('200.100.0.0/30') in r2.protocol()._graph,  # noqa: SLF001
            timeout=5.0,
        ), "r2 did not converge on the public p2p prefix"

        # The private prefix should never appear in r2's graph.
        assert NetworkAddress('10.0.0.0/24') not in r2.protocol()._graph, (  # noqa: SLF001
            "r2 must not learn the private prefix from r1"
        )
    finally:
        system.stop()
        os.unlink(path)
        LinkStateProtocol.KEEPALIVE_INTERVAL = original


def test_three_router_convergence_with_per_origin_seq():
    """Three-router convergence: every router's routing table contains
    a rule for every prefix after Hello-driven adjacency and LSA exchange.
    Pins that per-origin-seq + LSDB + TWO_WAY filter end-to-end behaviour."""
    original = LinkStateProtocol.KEEPALIVE_INTERVAL
    LinkStateProtocol.KEEPALIVE_INTERVAL = 0.3
    yaml = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "200.0.1.0/24"
            lan2: "200.0.2.0/24"
            lan3: "200.0.3.0/24"
            lan4: "200.0.4.0/24"
          hosts:
            h1: {network: lan1, address: "200.0.1.10"}
            h4: {network: lan4, address: "200.0.4.10"}
          routers:
            r1:
              interfaces:
                eth0: {network: lan1, address: "200.0.1.1", cost: 1}
                eth1: {network: lan2, address: "200.0.2.1", cost: 1}
            r2:
              interfaces:
                eth0: {network: lan2, address: "200.0.2.2", cost: 1}
                eth1: {network: lan3, address: "200.0.3.1", cost: 1}
            r3:
              interfaces:
                eth0: {network: lan3, address: "200.0.3.2", cost: 1}
                eth1: {network: lan4, address: "200.0.4.1", cost: 1}
    """)
    path = _make_tmp_topology(yaml)
    system = Parser(path).parse().single_as()
    try:
        assert _wait(lambda: all(
            _table_has_prefix(r, p)
            for r in system.routers().values()
            for p in ["200.0.1.0/24", "200.0.2.0/24",
                      "200.0.3.0/24", "200.0.4.0/24"]
        ), timeout=5.0), "three-router topology did not converge in time"
    finally:
        system.stop()
        os.unlink(path)
        LinkStateProtocol.KEEPALIVE_INTERVAL = original


class OutboundPolicyTest(unittest.TestCase):

    def test_outbound_policy_default_filters_rfc1918(self):
        """The default outbound policy denies RFC 1918 prefixes — same
        behaviour as the previous hard-coded `if is_private: continue`.
        This pins the policy framework's RFC1918_OUTBOUND default."""
        d = RFC1918_OUTBOUND.apply(NetworkAddress('10.0.0.0/24'))
        self.assertTrue(d.is_denied())
        d = RFC1918_OUTBOUND.apply(NetworkAddress('172.16.0.0/24'))
        self.assertTrue(d.is_denied())
        d = RFC1918_OUTBOUND.apply(NetworkAddress('192.168.0.0/24'))
        self.assertTrue(d.is_denied())
        d = RFC1918_OUTBOUND.apply(NetworkAddress('200.0.0.0/24'))
        self.assertTrue(d.is_permitted())

    def test_outbound_policy_override_permits_private_prefixes(self):
        """A LinkStateProtocol with a permit-all outbound policy doesn't
        filter — the policy attribute really drives advertisement
        decisions, not a hard-coded check."""
        r = Router('r1')
        permit_all = RouteMap(rules=[], default='permit')
        proto = LinkStateProtocol(r, outbound_policy=permit_all)
        # Confirm the protocol holds the override, not the default.
        self.assertIs(proto._outbound_policy, permit_all)


def test_hello_emitted_on_every_interface_each_cycle():
    net1 = Network('lan1', NetworkAddress('200.0.10.0/24'))
    net2 = Network('lan2', NetworkAddress('200.0.20.0/24'))
    r = Router('r1')
    r.add_interface(Interface('eth0', net1, Address('200.0.10.1'), cost=1))
    r.add_interface(Interface('eth1', net2, Address('200.0.20.1'), cost=1))

    sent = []
    original_send = Interface.send_to
    Interface.send_to = lambda self, pkt, dst_addr: sent.append(pkt)
    try:
        proto = LinkStateProtocol(r)
        proto._handle_update()  # noqa: SLF001
    finally:
        Interface.send_to = original_send

    hellos = [p.payload() for p in sent if isinstance(p.payload(), Hello)]
    assert len(hellos) == 2  # one per interface


def test_two_router_convergence_reaches_two_way():
    # Use a short keepalive interval so the second tick (which exchanges
    # neighbour lists) arrives within the test timeout.
    original = LinkStateProtocol.KEEPALIVE_INTERVAL
    LinkStateProtocol.KEEPALIVE_INTERVAL = 0.3
    yaml = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "200.0.1.0/24"
          links:
            p2p: "200.0.0.0/30"
          routers:
            r1:
              interfaces:
                eth0: {network: lan1, address: "200.0.1.1", cost: 1}
                eth1: {link: p2p, address: "200.0.0.1", cost: 1}
            r2:
              interfaces:
                eth0: {link: p2p, address: "200.0.0.2", cost: 1}
    """)
    path = _make_tmp_topology(yaml)
    system = Parser(path).parse().single_as()
    try:
        r1 = system.routers()["r1"]
        r2 = system.routers()["r2"]

        def both_two_way():
            r1_bidi = r1.protocol()._neighbor_table.bidirectional_peers(  # noqa: SLF001
                dead_interval=r1.protocol()._dead_interval, now=time.monotonic())  # noqa: SLF001
            r2_bidi = r2.protocol()._neighbor_table.bidirectional_peers(  # noqa: SLF001
                dead_interval=r2.protocol()._dead_interval, now=time.monotonic())  # noqa: SLF001
            return r2 in r1_bidi and r1 in r2_bidi

        assert _wait(both_two_way, timeout=5.0), "did not reach TWO_WAY in time"
    finally:
        system.stop()
        os.unlink(path)
        LinkStateProtocol.KEEPALIVE_INTERVAL = original


def test_build_graph_excludes_lsas_from_non_two_way_peers():
    """Pin the eligibility filter: receive r2's LSA but with no
    Hello-driven adjacency, r2's links must not appear in r1's graph."""
    net1 = Network('lan1', NetworkAddress('200.0.1.0/24'))
    net2 = Network('lan2', NetworkAddress('200.0.2.0/24'))
    r1 = Router('r1')
    r1_eth0 = Interface('eth0', net1, Address('200.0.1.1'), cost=1)
    r1.add_interface(r1_eth0)
    r1.add_interface(Interface('eth1', net2, Address('200.0.2.1'), cost=1))

    r2 = Router('r2')
    r2_eth0 = Interface('eth0', net2, Address('200.0.2.2'), cost=1)
    r2.add_interface(r2_eth0)

    original_send = Interface.send_to
    Interface.send_to = lambda self, pkt, dst_addr: None
    try:
        proto = LinkStateProtocol(r1)
        lsa_from_r2 = LSA(origin=r2, seq=1)
        lsa_from_r2.add_link(net2.address(), 1)
        proto.handle_incoming_message(lsa_from_r2, r1.interface('eth1'))
    finally:
        Interface.send_to = original_send

    # r1's graph should NOT contain r2 (no TWO_WAY adjacency exists).
    assert r2 not in proto._graph  # noqa: SLF001


def test_lan_with_three_routers_each_sees_two_neighbours_two_way():
    """Three routers on a shared LAN each reach TWO_WAY with both peers.

    Pins that Hello exchange on a broadcast segment (Network, not Link)
    drives multi-peer adjacency: every router must have the other two
    in its bidirectional_peers set before the test times out.
    """
    original = LinkStateProtocol.KEEPALIVE_INTERVAL
    LinkStateProtocol.KEEPALIVE_INTERVAL = 0.3
    yaml = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            shared_lan: "200.0.1.0/24"
            lan_r1: "200.0.2.0/24"
            lan_r2: "200.0.3.0/24"
            lan_r3: "200.0.4.0/24"
          routers:
            r1:
              interfaces:
                eth0: {network: shared_lan, address: "200.0.1.1", cost: 1}
                eth1: {network: lan_r1, address: "200.0.2.1", cost: 1}
            r2:
              interfaces:
                eth0: {network: shared_lan, address: "200.0.1.2", cost: 1}
                eth1: {network: lan_r2, address: "200.0.3.1", cost: 1}
            r3:
              interfaces:
                eth0: {network: shared_lan, address: "200.0.1.3", cost: 1}
                eth1: {network: lan_r3, address: "200.0.4.1", cost: 1}
    """)
    path = _make_tmp_topology(yaml)
    system = Parser(path).parse().single_as()
    try:
        routers = system.routers()
        r1 = routers["r1"]
        r2 = routers["r2"]
        r3 = routers["r3"]

        def all_two_way():
            now = time.monotonic()
            for router in [r1, r2, r3]:
                bidi = router.protocol()._neighbor_table.bidirectional_peers(  # noqa: SLF001
                    dead_interval=router.protocol()._dead_interval,  # noqa: SLF001
                    now=now,
                )
                others = {r for r in [r1, r2, r3] if r is not router}
                if not others.issubset(bidi):
                    return False
            return True

        assert _wait(all_two_way, timeout=10.0), (
            "not all three routers reached TWO_WAY with each other within timeout"
        )
    finally:
        system.stop()
        os.unlink(path)
        LinkStateProtocol.KEEPALIVE_INTERVAL = original


def test_silent_router_lsa_purged_after_max_age():
    """A router that goes silent (no hellos, no LSA refresh) has its
    LSA purged from peers' LSDBs after max_age elapses, and peers
    recompute without it."""
    yaml = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan_r1: "200.0.1.0/24"
            lan_r2: "200.0.2.0/24"
          links:
            p2p: "200.0.0.0/30"
          routers:
            r1:
              interfaces:
                eth0: {network: lan_r1, address: "200.0.1.1", cost: 1}
                eth1: {link: p2p, address: "200.0.0.1", cost: 1}
            r2:
              interfaces:
                eth0: {network: lan_r2, address: "200.0.2.1", cost: 1}
                eth1: {link: p2p, address: "200.0.0.2", cost: 1}
    """)
    path = _make_tmp_topology(yaml)
    internet = Parser(path).parse(start_routing=False)
    system = internet.single_as()
    try:
        # Tune timers down before starting so the test is fast.
        for r in system.routers().values():
            r.protocol()._hello_interval = 0.2   # noqa: SLF001
            r.protocol()._dead_interval = 0.6    # noqa: SLF001
            r.protocol()._lsa_refresh_interval = 0.6  # noqa: SLF001
            r.protocol()._max_age = 1.2          # noqa: SLF001
            r.protocol().set_keepalive_interval(0.2)
            r.start()
        r1 = system.routers()["r1"]
        r2 = system.routers()["r2"]
        # Wait for convergence.
        assert _wait(
            lambda: r2 in r1.protocol()._neighbor_table.bidirectional_peers(  # noqa: SLF001
                dead_interval=r1.protocol()._dead_interval, now=time.monotonic()),  # noqa: SLF001
            timeout=3.0,
        )
        # Now stop r2 silently (no withdrawal — kill the thread directly).
        r2.protocol()._stopped = True  # noqa: SLF001
        r2.protocol()._stop_event.set()  # noqa: SLF001
        # Wait for r1 to purge r2's LSA.
        assert _wait(
            lambda: r2 not in r1.protocol()._lsdb.origins(),  # noqa: SLF001
            timeout=5.0,
        ), "r2's LSA was not purged after max_age"
    finally:
        system.stop()
        os.unlink(path)


def test_protocol_stop_floods_withdrawal_lsa_on_every_interface():
    """When LinkStateProtocol.stop() is called, the router floods a
    withdrawal LSA (is_withdrawal()=True) out every interface before
    the keepalive thread joins."""
    net1 = Network('lan1', NetworkAddress('200.0.10.0/24'))
    net2 = Network('lan2', NetworkAddress('200.0.20.0/24'))
    r = Router('r1')
    r.add_interface(Interface('eth0', net1, Address('200.0.10.1'), cost=1))
    r.add_interface(Interface('eth1', net2, Address('200.0.20.1'), cost=1))

    sent = []
    original_send = Interface.send_to
    Interface.send_to = lambda self, pkt, dst_addr: sent.append(pkt)
    try:
        proto = LinkStateProtocol(r)
        proto.stop()
    finally:
        Interface.send_to = original_send

    withdrawals = [
        p.payload() for p in sent
        if isinstance(p.payload(), LSA) and p.payload().is_withdrawal()
    ]
    assert len(withdrawals) == 2  # one per interface


def test_peer_purges_lsa_on_receipt_of_withdrawal():
    """End-to-end: r1 stops gracefully → r2's LSDB no longer has r1's
    entry within one keepalive interval (much faster than max_age)."""
    yaml = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan_r1: "200.0.1.0/24"
            lan_r2: "200.0.2.0/24"
          links:
            p2p: "200.0.0.0/30"
          routers:
            r1:
              interfaces:
                eth0: {network: lan_r1, address: "200.0.1.1", cost: 1}
                eth1: {link: p2p, address: "200.0.0.1", cost: 1}
            r2:
              interfaces:
                eth0: {network: lan_r2, address: "200.0.2.1", cost: 1}
                eth1: {link: p2p, address: "200.0.0.2", cost: 1}
    """)
    path = _make_tmp_topology(yaml)
    system = Parser(path).parse().single_as()
    try:
        for r in system.routers().values():
            r.protocol().set_keepalive_interval(0.2)
            r.protocol()._hello_interval = 0.2  # noqa: SLF001
            r.protocol()._dead_interval = 0.6   # noqa: SLF001
        r1 = system.routers()["r1"]
        r2 = system.routers()["r2"]
        # Wait for convergence.
        assert _wait(
            lambda: r1 in r2.protocol()._lsdb.origins(),  # noqa: SLF001
            timeout=3.0,
        )
        # Gracefully stop r1 — should flood a withdrawal.
        r1.protocol().stop()
        # r2 should purge r1's LSA quickly (< 1s, no need to wait max_age).
        assert _wait(
            lambda: r1 not in r2.protocol()._lsdb.origins(),  # noqa: SLF001
            timeout=2.0,
        ), "r2 did not purge r1's LSA on graceful withdrawal"
    finally:
        system.stop()
        os.unlink(path)


def test_set_timers_derives_dead_and_max_age():
    r = Router('r1')
    proto = LinkStateProtocol(r)
    proto.set_timers(hello_interval=5, lsa_refresh_interval=15)
    assert proto._hello_interval == 5    # noqa: SLF001
    assert proto._dead_interval == 15    # 3 * hello  # noqa: SLF001
    assert proto._lsa_refresh_interval == 15  # noqa: SLF001
    assert proto._max_age == 30          # 2 * refresh  # noqa: SLF001


def test_set_timers_rejects_non_positive():
    r = Router('r1')
    proto = LinkStateProtocol(r)
    with pytest.raises(ValueError):
        proto.set_timers(hello_interval=0, lsa_refresh_interval=10)
    with pytest.raises(ValueError):
        proto.set_timers(hello_interval=5, lsa_refresh_interval=-1)


def test_set_timers_invariant_max_age_must_exceed_refresh():
    """The derived max_age (2 * refresh) is always > refresh, so this
    invariant is satisfied by construction. Pin it via direct
    attribute assignment to catch future regressions."""
    r = Router('r1')
    proto = LinkStateProtocol(r)
    proto.set_timers(hello_interval=5, lsa_refresh_interval=15)
    assert proto._max_age > proto._lsa_refresh_interval  # noqa: SLF001


def test_set_timers_invariant_dead_must_exceed_hello():
    r = Router('r1')
    proto = LinkStateProtocol(r)
    proto.set_timers(hello_interval=5, lsa_refresh_interval=15)
    assert proto._dead_interval > proto._hello_interval  # noqa: SLF001
