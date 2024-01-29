import unittest
from entities import Address, NetworkAddress


class AddressTest(unittest.TestCase):

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
