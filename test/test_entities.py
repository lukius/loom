import unittest

from entities import *

class EntitiesTest(unittest.TestCase):

    def setUp(self):
        self._network1 = Network('lan1', NetworkAddress('192.168.1.0/24'))
        self._addr1_net1 = Address('192.168.1.15')
        self._addr2_net1 = Address('192.168.1.100')

        self._network2 = Network('lan2', NetworkAddress('192.168.10.0/24'))
        self._addr1_net2 = Address('192.168.10.25')

    def test_host(self):
        host = Host('host', self._network1, self._addr1_net1, self._addr2_net1)
        self.assertEqual(host.name(), 'host')
        self.assertEqual(host.address(), '192.168.1.15')
        self.assertEqual(host.network().name(), 'lan1')
        self.assertEqual(len(host.interfaces()), 1)
        self.assertEqual(host.interface().address(), '192.168.1.15')
        self.assertEqual(host.gateway(), '192.168.1.100')

    def test_interface(self):
        iface = Interface('iface', self._network1, self._addr1_net1)
        self.assertEqual(iface.name(), 'iface')
        self.assertEqual(iface.address(), '192.168.1.15')
        self.assertEqual(iface.network().name(), 'lan1')
        self.assertEqual(iface.cost(), 0)
        self.assertIsNone(iface.device())

    def test_router(self):
        router = Router('router')
        self.assertEqual(router.name(), 'router')

        iface1 = Interface('iface1', self._network1, self._addr1_net1)
        iface2 = Interface('iface2', self._network2, self._addr1_net2)
        router.add_interface(iface1)
        router.add_interface(iface2)

        self.assertEqual(len(router.interfaces()), 2)
        self.assertIn('iface1', router.interfaces())
        self.assertIn('iface2', router.interfaces())

        self.assertEqual(iface1.device(), router)
        self.assertEqual(iface2.device(), router)

    def test_network(self):
        self.assertEqual(len(self._network1.devices()), 0)
        self.assertEqual(len(self._network2.devices()), 0)

        self.assertTrue(self._network1.contains_address(self._addr1_net1))
        self.assertTrue(self._network1.contains_address(self._addr2_net1))
        self.assertFalse(self._network1.contains_address(self._addr1_net2))
        self.assertFalse(self._network2.contains_address(self._addr1_net1))
        self.assertFalse(self._network2.contains_address(self._addr2_net1))
        self.assertTrue(self._network2.contains_address(self._addr1_net2))

        host1 = Host('host1', self._network1, self._addr1_net1)
        host2 = Host('host2', self._network1, self._addr2_net1)
        self._network1.add_interface(host1.interface())
        self._network1.add_interface(host2.interface())

        self.assertTrue(self._network1.has_device(host1))
        self.assertTrue(self._network1.has_device(host2))
        self.assertFalse(self._network2.has_device(host1))
        self.assertFalse(self._network2.has_device(host2))

        self.assertEqual(len(self._network1.devices()), 2)
        self.assertEqual(len(self._network2.devices()), 0)

        self.assertIn('host1', self._network1.devices())
        self.assertIn('host2', self._network1.devices())