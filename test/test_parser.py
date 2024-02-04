import unittest
from parser import Parser

class ParserTest(unittest.TestCase):

    def test_simple_network(self):
        system = Parser('test/resources/simple_network.yaml').parse()
        self.assertEqual(system.name(), "test_as")

        # Router assertions
        routers = system.routers()
        self.assertEqual(len(routers), 1)

        router = routers['r1']
        self.assertEqual(router.name(), "r1")

        interfaces = router.interfaces()
        self.assertEqual(len(interfaces), 1)

        interface = interfaces['eth0']
        self.assertEqual(interface.name(), "eth0")
        self.assertEqual(interface.network().name(), "lan1")
        self.assertEqual(interface.address(), "100.100.100.1")
        self.assertEqual(interface.cost(), 10)

        # Host assertions
        hosts = system.hosts()
        self.assertEqual(len(hosts), 1)

        host = hosts['h1']
        self.assertEqual(host.name(), "h1")

        host_net = host.network()
        self.assertEqual(host_net.name(), "lan1")
        self.assertEqual(host.address(), "100.100.100.10")

        # Network assertions
        nets = system.networks()
        self.assertEqual(len(nets), 1)

        net = nets['lan1']
        self.assertEqual(net.name(), "lan1")
        self.assertEqual(net.address(), "100.100.100.0/24")

        devices = net.devices()
        self.assertEqual(len(devices), 2)
        self.assertIn('h1', devices)
        self.assertEqual(devices['h1'], host)
        self.assertIn('r1', devices)
        self.assertEqual(devices['r1'], router)