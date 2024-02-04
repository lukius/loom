import unittest
from parser import Parser

class ParserTest(unittest.TestCase):

    def test_simple_network(self):
        system = Parser('test/resources/simple_network.yaml').parse()
        self.assertEquals(system.name(), "test_as")

        # Router assertions
        routers = system.routers()
        self.assertEquals(len(routers), 1)

        router = routers['r1']
        self.assertEquals(router.name(), "r1")

        interfaces = router.interfaces()
        self.assertEquals(len(interfaces), 1)

        interface = interfaces['eth0']
        self.assertEquals(interface.name(), "eth0")
        self.assertEquals(interface.network().name(), "lan1")
        self.assertEquals(interface.address(), "100.100.100.1")
        self.assertEquals(interface.cost(), 10)

        # Host assertions
        hosts = system.hosts()
        self.assertEquals(len(hosts), 1)

        host = hosts['h1']
        self.assertEquals(host.name(), "h1")

        host_net = host.network()
        self.assertEquals(host_net.name(), "lan1")
        self.assertEquals(host.address(), "100.100.100.10")

        # Network assertions
        nets = system.networks()
        self.assertEquals(len(nets), 1)

        net = nets['lan1']
        self.assertEquals(net.name(), "lan1")
        self.assertEquals(net.address(), "100.100.100.0/24")

        devices = net.devices()
        self.assertEquals(len(devices), 2)
        self.assertIn('h1', devices)
        self.assertEquals(devices['h1'], host)
        self.assertIn('r1', devices)
        self.assertEquals(devices['r1'], router)