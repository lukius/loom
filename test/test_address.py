import unittest

from entities import Address, NetworkAddress


class AddressTest(unittest.TestCase):

    def test_eq_hash_contract_same_subnet(self):
        a = NetworkAddress('192.168.1.0/24')
        b = NetworkAddress('192.168.1.50/24')
        self.assertEqual(a, b)  # both canonicalize to 192.168.1.0/24
        self.assertEqual(hash(a), hash(b))

    def test_eq_structural_different_subnets(self):
        a = NetworkAddress('192.168.1.0/24')
        b = NetworkAddress('192.168.2.0/24')
        self.assertNotEqual(a, b)

    def test_host_bits_canonicalized(self):
        canonical = NetworkAddress('192.168.1.0/24')
        with_host_bits = NetworkAddress('192.168.1.50/24')
        self.assertEqual(canonical, with_host_bits)
        self.assertEqual(hash(canonical), hash(with_host_bits))

    def test_contains_subnet_membership(self):
        net_addr = NetworkAddress('192.168.1.0/24')
        self.assertTrue(net_addr.contains(Address('192.168.1.1')))
        self.assertTrue(net_addr.contains(Address('192.168.1.254')))
        self.assertFalse(net_addr.contains(Address('192.168.2.1')))

    def test_str_uses_canonical_prefix(self):
        addr = NetworkAddress('192.168.1.50/24')
        self.assertEqual(str(addr), '192.168.1.0/24')

    def test_basic_address_matching(self):
        net_addr = NetworkAddress('100.100.100.0/24')

        host_addrs = [
            Address('100.100.100.1'),
            Address('100.100.100.2'),
            Address('100.100.100.254'),
            Address('100.100.100.15')
        ]

        for addr in host_addrs:
            self.assertTrue(net_addr.matches(addr))

    def test_address_matching_changing_masks(self):
        net_addr1 = NetworkAddress('100.100.196.100/18')
        net_addr2 = NetworkAddress('100.100.248.0/21')

        host_addrs = [
            Address('100.100.192.1'),
            Address('100.100.211.254'),
            Address('100.100.200.10'),
            Address('100.100.193.100'),
            Address('100.100.247.200')
        ]

        for addr in host_addrs:
            self.assertTrue(net_addr1.matches(addr))
            self.assertFalse(net_addr2.matches(addr))

    def test_addresses_not_matching(self):
        net_addr = NetworkAddress('100.100.100.0/24')

        host_addrs = [
            Address('100.100.0.1'),
            Address('200.100.100.2'),
            Address('100.100.99.254'),
            Address('100.1.100.15')
        ]

        for addr in host_addrs:
            self.assertFalse(net_addr.matches(addr))

    def test_broadcast_address(self):
        net_addr = NetworkAddress('100.100.100.0/24')
        self.assertEqual(net_addr.broadcast(), '100.100.100.255')

        net_addr = NetworkAddress('100.100.96.0/21')
        self.assertEqual(net_addr.broadcast(), '100.100.103.255')

    def test_broadcast_address_slash32(self):
        net_addr = NetworkAddress('1.2.3.4/32')
        self.assertEqual(net_addr.broadcast(), '1.2.3.4')

    def test_broadcast_address_slash0(self):
        net_addr = NetworkAddress('0.0.0.0/0')
        self.assertEqual(net_addr.broadcast(), '255.255.255.255')
