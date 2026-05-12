import unittest

from entities import Address, Interface, Network, NetworkAddress, RoutingTable


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
