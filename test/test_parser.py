import unittest
from parser import Parser, ParsingException

class ParserTest(unittest.TestCase):

    FILE_PATH = 'test/resources'

    def test_simple_network(self):
        system = Parser(f'{self.FILE_PATH}/simple_network.yaml').parse()
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

    def test_two_networks(self):
        system = Parser(f'{self.FILE_PATH}/two_networks.yaml').parse()
        self.assertEqual(system.name(), "test_as")

        # Router assertions
        routers = system.routers()
        self.assertEqual(len(routers), 2)

        router1 = routers['r1']
        self.assertEqual(router1.name(), "r1")

        interfaces = router1.interfaces()
        self.assertEqual(len(interfaces), 1)

        interface = interfaces['eth0']
        self.assertEqual(interface.name(), "eth0")
        self.assertEqual(interface.network().name(), "lan1")
        self.assertEqual(interface.address(), "100.100.100.1")
        self.assertEqual(interface.cost(), 10)

        router2 = routers['r2']
        self.assertEqual(router2.name(), "r2")

        interfaces = router2.interfaces()
        self.assertEqual(len(interfaces), 2)

        interface = interfaces['eth0']
        self.assertEqual(interface.name(), "eth0")
        self.assertEqual(interface.network().name(), "lan2")
        self.assertEqual(interface.address(), "100.100.200.1")
        self.assertEqual(interface.cost(), 5)

        interface = interfaces['eth1']
        self.assertEqual(interface.name(), "eth1")
        self.assertEqual(interface.network().name(), "lan1")
        self.assertEqual(interface.address(), "100.100.100.2")
        self.assertEqual(interface.cost(), 5)

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
        self.assertEqual(len(nets), 2)

        net = nets['lan1']
        self.assertEqual(net.name(), "lan1")
        self.assertEqual(net.address(), "100.100.100.0/24")

        devices = net.devices()
        self.assertEqual(len(devices), 3)
        self.assertIn('h1', devices)
        self.assertEqual(devices['h1'], host)
        self.assertIn('r1', devices)
        self.assertEqual(devices['r1'], router1)
        self.assertIn('r2', devices)
        self.assertEqual(devices['r2'], router2)

        net = nets['lan2']
        self.assertEqual(net.name(), "lan2")
        self.assertEqual(net.address(), "100.100.200.0/22")

        devices = net.devices()
        self.assertEqual(len(devices), 1)
        self.assertIn('r2', devices)
        self.assertEqual(devices['r2'], router2)

    def test_duplicate_network_address(self):
        self._run_parsing_error_test('duplicate_network_address', 'network address already exists')

    def test_duplicate_address(self):
        self._run_parsing_error_test('duplicate_address', 'address already in use')

    def test_invalid_cost(self):
        self._run_parsing_error_test('invalid_cost', 'invalid cost')

    def test_invalid_host_address(self):
        self._run_parsing_error_test('invalid_host_address', 'invalid address')

    def test_invalid_network_address(self):
        self._run_parsing_error_test('invalid_network_address', 'invalid address')

    def test_invalid_router_address(self):
        self._run_parsing_error_test('invalid_router_address', 'invalid address')

    def test_invalid_netmask(self):
        self._run_parsing_error_test('invalid_netmask', 'invalid netmask')

    def test_router_without_interfaces(self):
        self._run_parsing_error_test('router_without_interfaces', 'no interfaces declared')

    def test_missing_network(self):
        self._run_parsing_error_test('missing_network', 'network not found')

    def test_missing_as(self):
        self._run_parsing_error_test('missing_as', 'missing "as" key')

    def test_no_networks(self):
        self._run_parsing_error_test('no_networks', 'no networks')

    def test_missing_netmask(self):
        self._run_parsing_error_test('missing_netmask', 'missing netmask')

    def test_missing_interface_network(self):
        self._run_parsing_error_test('missing_interface_network', 'no network assigned')

    def test_missing_interface_address(self):
        self._run_parsing_error_test('missing_interface_address', 'no address assigned')

    def test_missing_host_network(self):
        self._run_parsing_error_test('missing_host_network', 'no network assigned')

    def test_missing_host_address(self):
        self._run_parsing_error_test('missing_host_address', 'no address assigned')

    def _run_parsing_error_test(self, filename, expected_msg):
        parser = Parser(f'{self.FILE_PATH}/{filename}.yaml')
        with self.assertRaises(ParsingException) as context:
            parser.parse()
        self.assertIn(expected_msg, context.exception.message)
