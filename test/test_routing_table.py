import unittest

from entities import (
    Address,
    Interface,
    Link,
    Network,
    NetworkAddress,
    NullAddress,
    RoutingTable,
)


class RoutingTableTest(unittest.TestCase):

    def test_matching_one_rule(self):
        table = RoutingTable()

        net = Network('lan1', NetworkAddress('200.200.10.0/24'))

        table.add_rule(
            prefix=NetworkAddress('100.0.100.0/24'),
            next_hop=Address("200.200.10.35"),
            interface=Interface('eth0', net, Address('200.200.10.1'))
        )

        result = table.match(Address('100.0.100.75'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '200.200.10.35')
        self.assertEqual(result.interface().name(), 'eth0')

        result = table.match(Address('100.0.101.25'))
        self.assertFalse(result.succeeded())

        table.remove_rule(prefix=NetworkAddress('100.0.100.0/24'))

        result = table.match(Address('100.0.100.75'))
        self.assertFalse(result.succeeded())

        result = table.match(Address('100.0.101.25'))
        self.assertFalse(result.succeeded())

    def test_matching_default_rule(self):
        table = RoutingTable()

        net = Network('lan1', NetworkAddress('200.200.10.0/24'))
        net2 = Network('lan2', NetworkAddress('125.101.13.0/24'))

        table.add_rule(
            prefix=NetworkAddress('100.0.100.0/24'),
            next_hop=Address("200.200.10.35"),
            interface=Interface('eth0', net, Address('200.200.10.1'))
        )

        table.add_rule(
            prefix=NetworkAddress('0.0.0.0/0'),
            next_hop=Address('125.101.13.10'),
            interface=Interface('eth1', net2, Address('125.101.13.25'))
        )

        result = table.match(Address('100.0.100.75'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '200.200.10.35')
        self.assertEqual(result.interface().name(), 'eth0')

        result = table.match(Address('100.0.101.25'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '125.101.13.10')
        self.assertEqual(result.interface().name(), 'eth1')

        table.remove_rule(prefix=NetworkAddress('100.0.100.0/24'))

        result = table.match(Address('100.0.100.75'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '125.101.13.10')
        self.assertEqual(result.interface().name(), 'eth1')

        result = table.match(Address('100.0.101.25'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '125.101.13.10')
        self.assertEqual(result.interface().name(), 'eth1')

    def test_matching_longest_prefix(self):
        table = RoutingTable()

        net = Network('lan1', NetworkAddress('200.200.10.0/24'))
        net2 = Network('lan2', NetworkAddress('125.101.13.0/24'))
        net3 = Network('lan3', NetworkAddress('125.101.12.0/24'))

        table.add_rule(
            prefix=NetworkAddress('100.0.100.0/22'),
            next_hop=Address('125.101.13.10'),
            interface=Interface('eth0', net2, Address('125.101.13.25'))
        )

        table.add_rule(
            prefix=NetworkAddress("100.0.100.0/24"),
            next_hop=Address("200.200.10.35"),
            interface=Interface('eth1', net, Address('200.200.10.1'))
        )

        table.add_rule(
            prefix=NetworkAddress('0.0.0.0/0'),
            next_hop=Address('125.101.12.2'),
            interface=Interface('eth2', net3, Address('125.101.12.1'))
        )

        result = table.match(Address('100.0.100.75'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '200.200.10.35')
        self.assertEqual(result.interface().name(), 'eth1')

        result = table.match(Address('25.35.101.3'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '125.101.12.2')
        self.assertEqual(result.interface().name(), 'eth2')

        result = table.match(Address('100.0.103.75'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '125.101.13.10')
        self.assertEqual(result.interface().name(), 'eth0')

        table.remove_rule(prefix=NetworkAddress("100.0.100.0/24"))

        result = table.match(Address('100.0.100.75'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '125.101.13.10')
        self.assertEqual(result.interface().name(), 'eth0')

        result = table.match(Address('100.0.103.75'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '125.101.13.10')
        self.assertEqual(result.interface().name(), 'eth0')

        result = table.match(Address('25.35.101.3'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '125.101.12.2')
        self.assertEqual(result.interface().name(), 'eth2')

    def test_add_rule_dedup_with_host_bits(self):
        table = RoutingTable()

        net = Network('lan1', NetworkAddress('10.0.0.0/24'))
        iface1 = Interface('eth0', net, Address('10.0.0.1'))
        iface2 = Interface('eth1', net, Address('10.0.0.2'))

        table.add_rule(
            prefix=NetworkAddress('10.0.0.0/24'),
            next_hop=Address('10.0.0.1'),
            interface=iface1
        )
        table.add_rule(
            prefix=NetworkAddress('10.0.0.50/24'),
            next_hop=Address('10.0.0.2'),
            interface=iface2
        )

        self.assertEqual(len(table.rules()), 1)
        result = table.match(Address('10.0.0.100'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), '10.0.0.2')

    def test_routing_rule_for_directly_connected_link(self):
        """A rule for a /30 link with NullAddress next-hop matches addresses
        inside the link prefix and reports the correct interface."""
        link = Link('p2p1', NetworkAddress('10.0.0.0/30'))
        iface = Interface('eth1', link, Address('10.0.0.1'), cost=5)
        link.add_interface(iface)

        table = RoutingTable()
        table.add_rule(
            prefix=link.address(),
            next_hop=NullAddress,
            interface=iface,
        )

        # An address inside the /30 block matches.
        result = table.match(Address('10.0.0.2'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), NullAddress)
        self.assertEqual(result.interface().name(), 'eth1')

        # An address outside the /30 block does not match.
        result = table.match(Address('10.0.1.1'))
        self.assertFalse(result.succeeded())

        link.stop()

    def test_routing_rule_for_remote_network_via_link(self):
        """A rule for a remote network with a link peer's IP as next-hop resolves
        correctly — the interface returned is the local link interface."""
        link = Link('p2p1', NetworkAddress('10.0.0.0/30'))
        local_iface = Interface('eth1', link, Address('10.0.0.1'), cost=5)
        link.add_interface(local_iface)

        remote_net = Network('lan_r2', NetworkAddress('10.0.2.0/24'))
        peer_iface = Interface('eth0', link, Address('10.0.0.2'), cost=5)
        link.add_interface(peer_iface)

        peer_addr = Address('10.0.0.2')

        table = RoutingTable()
        table.add_rule(
            prefix=remote_net.address(),
            next_hop=peer_addr,
            interface=local_iface,
        )

        result = table.match(Address('10.0.2.100'))
        self.assertTrue(result.succeeded())
        self.assertEqual(result.next_hop(), peer_addr)
        self.assertEqual(result.interface().name(), 'eth1')

        link.stop()
        remote_net.stop()
