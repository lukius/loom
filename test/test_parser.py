import unittest

from parser import Parser, ParsingException


class ParserTest(unittest.TestCase):

    FILE_PATH = 'test/resources'

    def test_simple_network(self):
        system = Parser(f'{self.FILE_PATH}/simple_network.yaml').parse().single_as()
        self.assertEqual(system.name(), 'main')

        # Router assertions
        routers = system.routers()
        self.assertEqual(len(routers), 1)

        router = routers['r1']
        self.assertEqual(router.name(), 'r1')

        interfaces = router.interfaces()
        self.assertEqual(len(interfaces), 1)

        interface = interfaces['eth0']
        self.assertEqual(interface.name(), 'eth0')
        self.assertEqual(interface.network().name(), 'lan1')
        self.assertEqual(interface.address(), '100.100.100.1')
        self.assertEqual(interface.cost(), 10)

        # Host assertions
        hosts = system.hosts()
        self.assertEqual(len(hosts), 1)

        host = hosts['h1']
        self.assertEqual(host.name(), 'h1')

        host_net = host.network()
        self.assertEqual(host_net.name(), 'lan1')
        self.assertEqual(host.address(), '100.100.100.10')

        gw_address = host.gateway()
        self.assertIsNone(gw_address)

        # Network assertions
        nets = system.networks()
        self.assertEqual(len(nets), 1)

        net = nets['lan1']
        self.assertEqual(net.name(), 'lan1')
        self.assertEqual(net.address(), '100.100.100.0/24')

        devices = net.devices()
        self.assertEqual(len(devices), 2)
        self.assertIn('h1', devices)
        self.assertEqual(devices['h1'], host)
        self.assertIn('r1', devices)
        self.assertEqual(devices['r1'], router)

    def test_two_networks(self):
        system = Parser(f'{self.FILE_PATH}/two_networks.yaml').parse().single_as()
        self.assertEqual(system.name(), 'main')

        # Router assertions
        routers = system.routers()
        self.assertEqual(len(routers), 2)

        router1 = routers['r1']
        self.assertEqual(router1.name(), 'r1')

        interfaces = router1.interfaces()
        self.assertEqual(len(interfaces), 1)

        interface = interfaces['eth0']
        self.assertEqual(interface.name(), 'eth0')
        self.assertEqual(interface.network().name(), 'lan1')
        self.assertEqual(interface.address(), '100.100.100.1')
        self.assertEqual(interface.cost(), 10)

        router2 = routers['r2']
        self.assertEqual(router2.name(), 'r2')

        interfaces = router2.interfaces()
        self.assertEqual(len(interfaces), 2)

        interface = interfaces['eth0']
        self.assertEqual(interface.name(), 'eth0')
        self.assertEqual(interface.network().name(), 'lan2')
        self.assertEqual(interface.address(), '100.100.200.1')
        self.assertEqual(interface.cost(), 5)

        interface = interfaces['eth1']
        self.assertEqual(interface.name(), 'eth1')
        self.assertEqual(interface.network().name(), 'lan1')
        self.assertEqual(interface.address(), '100.100.100.2')
        self.assertEqual(interface.cost(), 5)

        # Host assertions
        hosts = system.hosts()
        self.assertEqual(len(hosts), 1)

        host = hosts['h1']
        self.assertEqual(host.name(), 'h1')

        host_net = host.network()
        self.assertEqual(host_net.name(), 'lan1')
        self.assertEqual(host.address(), '100.100.100.10')

        gw_address = host.gateway()
        self.assertEqual(gw_address, '100.100.100.2')

        # Network assertions
        nets = system.networks()
        self.assertEqual(len(nets), 2)

        net = nets['lan1']
        self.assertEqual(net.name(), 'lan1')
        self.assertEqual(net.address(), '100.100.100.0/24')

        devices = net.devices()
        self.assertEqual(len(devices), 3)
        self.assertIn('h1', devices)
        self.assertEqual(devices['h1'], host)
        self.assertIn('r1', devices)
        self.assertEqual(devices['r1'], router1)
        self.assertIn('r2', devices)
        self.assertEqual(devices['r2'], router2)

        net = nets['lan2']
        self.assertEqual(net.name(), 'lan2')
        self.assertEqual(net.address(), '100.100.200.0/22')

        devices = net.devices()
        self.assertEqual(len(devices), 1)
        self.assertIn('r2', devices)
        self.assertEqual(devices['r2'], router2)

    def test_duplicate_private_network_allowed(self):
        # RFC 1918 prefixes may legally repeat — downstream NAT handles them.
        system = Parser(
            f'{self.FILE_PATH}/duplicate_private_network.yaml'
        ).parse().single_as()
        nets = system.networks()
        self.assertIn('lan_a', nets)
        self.assertIn('lan_b', nets)
        self.assertEqual(nets['lan_a'].address(), nets['lan_b'].address())

    def test_duplicate_network_address(self):
        self._run_parsing_error_test(
            'duplicate_network_address', 'network address already exists'
        )

    def test_duplicate_address(self):
        self._run_parsing_error_test('duplicate_address', 'address already in use')

    def test_invalid_cost(self):
        self._run_parsing_error_test('invalid_cost', 'invalid cost')

    def test_negative_cost(self):
        self._run_parsing_error_test('cost_negative', 'invalid cost')

    def test_zero_cost(self):
        self._run_parsing_error_test('cost_zero', 'invalid cost')

    def test_boolean_cost(self):
        self._run_parsing_error_test('cost_boolean', 'invalid cost')

    def test_routers_as_list(self):
        self._run_parsing_error_test('routers_as_list', 'must be a mapping')

    def test_network_as_int(self):
        self._run_parsing_error_test('network_as_int', 'must be a string')

    def test_empty_as_block(self):
        self._run_parsing_error_test('empty_as_block', 'must be a mapping')

    def test_empty_interface(self):
        self._run_parsing_error_test('empty_interface', 'must be a mapping')

    def test_invalid_host_address(self):
        self._run_parsing_error_test('invalid_host_address', 'invalid address')

    def test_invalid_network_address(self):
        self._run_parsing_error_test('invalid_network_address', 'invalid address')

    def test_invalid_router_address(self):
        self._run_parsing_error_test('invalid_router_address', 'invalid address')

    def test_invalid_netmask(self):
        self._run_parsing_error_test('invalid_netmask', 'invalid netmask')

    def test_router_without_interfaces(self):
        self._run_parsing_error_test(
            'router_without_interfaces', 'no interfaces declared'
        )

    def test_missing_network(self):
        self._run_parsing_error_test('missing_network', 'network not found')

    def test_missing_as(self):
        self._run_parsing_error_test(
            'missing_as', 'missing "internet" key at YAML root'
        )

    def test_no_networks(self):
        self._run_parsing_error_test('no_networks', 'no networks')

    def test_missing_netmask(self):
        self._run_parsing_error_test('missing_netmask', 'missing netmask')

    def test_missing_interface_network(self):
        self._run_parsing_error_test(
            'missing_interface_network', 'no network or link assigned'
        )

    def test_missing_interface_address(self):
        self._run_parsing_error_test('missing_interface_address', 'no address assigned')

    def test_missing_host_network(self):
        self._run_parsing_error_test(
            'missing_host_network', 'no network or link assigned'
        )

    def test_missing_host_address(self):
        self._run_parsing_error_test('missing_host_address', 'no address assigned')

    def test_invalid_host_gateway(self):
        self._run_parsing_error_test(
            'invalid_gateway', 'gateway address not in host network'
        )

    # ------------------------------------------------------------------ links --

    def test_two_routers_one_link(self):
        system = Parser(
            f'{self.FILE_PATH}/two_routers_one_link.yaml'
        ).parse().single_as()

        links = system.links()
        self.assertEqual(len(links), 1)
        self.assertIn('p2p1', links)

        from entities import NetworkAddress
        self.assertEqual(links['p2p1'].address(), NetworkAddress('10.0.0.0/30'))

        link = links['p2p1']
        self.assertEqual(link.endpoint_count(), 2)

        r1 = system.routers()['r1']
        r2 = system.routers()['r2']

        r1_eth1 = r1.interfaces()['eth1']
        self.assertEqual(r1_eth1.address(), '10.0.0.1')
        self.assertEqual(r1_eth1.cost(), 5)
        self.assertEqual(r1_eth1.network().name(), 'p2p1')

        r2_eth0 = r2.interfaces()['eth0']
        self.assertEqual(r2_eth0.address(), '10.0.0.2')
        self.assertEqual(r2_eth0.cost(), 5)
        self.assertEqual(r2_eth0.network().name(), 'p2p1')

        self.assertEqual(len(r1.interfaces()), 2)
        r1_eth0 = r1.interfaces()['eth0']
        self.assertEqual(r1_eth0.network().name(), 'lan1')

    def test_host_on_link(self):
        system = Parser(f'{self.FILE_PATH}/host_on_link.yaml').parse().single_as()

        hosts = system.hosts()
        h3 = hosts['h3']
        self.assertEqual(h3.network().name(), 'h3link')

        from entities import Address
        self.assertEqual(h3.gateway(), Address('10.0.1.1'))

    def test_host_to_host_link(self):
        system = Parser(f'{self.FILE_PATH}/host_to_host_link.yaml').parse().single_as()

        from entities import Address
        h1 = system.hosts()['h1']
        h2 = system.hosts()['h2']

        self.assertEqual(h1.gateway(), Address('10.0.2.1'))
        self.assertEqual(h2.gateway(), Address('10.0.2.0'))

    def test_host_on_link_explicit_correct_gateway(self):
        system = Parser(
            f'{self.FILE_PATH}/host_on_link_explicit_correct_gateway.yaml'
        ).parse().single_as()

        from entities import Address
        h3 = system.hosts()['h3']
        self.assertEqual(h3.gateway(), Address('10.0.1.1'))

    def test_link_too_wide(self):
        self._run_parsing_error_test('link_too_wide', '/28')

    def test_link_three_endpoints(self):
        self._run_parsing_error_test('link_three_endpoints', 'two endpoints')

    def test_link_one_endpoint(self):
        self._run_parsing_error_test('link_one_endpoint', 'two endpoints')

    def test_link_no_endpoints(self):
        self._run_parsing_error_test('link_no_endpoints', 'two endpoints')

    def test_link_iface_both_keys(self):
        self._run_parsing_error_test('link_iface_both_keys', 'network and link')

    def test_link_iface_neither_key(self):
        self._run_parsing_error_test(
            'link_iface_neither_key', 'no network or link assigned'
        )

    def test_link_addr_outside_cidr(self):
        self._run_parsing_error_test(
            'link_addr_outside_cidr', 'invalid address for network'
        )

    def test_link_addr_is_network_or_broadcast(self):
        self._run_parsing_error_test(
            'link_addr_is_network_or_broadcast', 'invalid address for network'
        )

    def test_link_host_wrong_gateway(self):
        self._run_parsing_error_test('link_host_wrong_gateway', 'gateway mismatch')

    def test_link_name_collides_with_network(self):
        self._run_parsing_error_test(
            'link_name_collides_with_network', 'already exists as a network'
        )

    def test_link_not_found(self):
        self._run_parsing_error_test('link_not_found', 'link not found')

    def test_link_host_iface_both_keys(self):
        self._run_parsing_error_test('link_host_iface_both_keys', 'network and link')

    def test_link_host_iface_neither_key(self):
        self._run_parsing_error_test(
            'link_host_iface_neither_key', 'no network or link assigned'
        )

    def test_link_host_addr_outside_cidr(self):
        self._run_parsing_error_test(
            'link_host_addr_outside_cidr', 'address not in link'
        )

    def test_link_host_addr_is_network_or_broadcast(self):
        self._run_parsing_error_test(
            'link_host_addr_is_network_or_broadcast', 'invalid address for link'
        )

    def test_network_interface_on_network_address(self):
        self._run_parsing_error_test(
            'interface_on_network_address', 'invalid address for network'
        )

    def test_network_interface_on_broadcast_address(self):
        self._run_parsing_error_test(
            'interface_on_broadcast_address', 'invalid address for network'
        )

    def test_host_on_full_link(self):
        self._run_parsing_error_test('host_on_full_link', 'two endpoints')

    def test_parses_top_level_config_as_opaque_dict(self):
        internet = Parser(f'{self.FILE_PATH}/config_roundtrip.yaml').parse(
            start_routing=False
        )
        self.assertEqual(
            internet.config(),
            {'packet_duration_ms': 2400, 'theme': 'dark'},
        )

    def test_rejects_non_mapping_internet_config(self):
        with self.assertRaises(ParsingException):
            Parser(
                f'{self.FILE_PATH}/invalid_internet_config_not_mapping.yaml'
            ).parse(start_routing=False)

    def test_parses_and_applies_protocol_config(self):
        internet = Parser(f'{self.FILE_PATH}/config_roundtrip.yaml').parse(
            start_routing=False
        )
        system = internet.single_as()
        self.assertEqual(
            system.protocol_config(),
            {'hello_interval': 5.0, 'lsa_refresh_interval': 15.0},
        )
        proto = system.routers()['r1'].protocol()
        self.assertEqual(proto.hello_interval(), 5.0)
        self.assertEqual(proto.lsa_refresh_interval(), 15.0)

    def test_rejects_non_positive_protocol_timer(self):
        with self.assertRaises(ParsingException):
            Parser(
                f'{self.FILE_PATH}/invalid_protocol_timer_non_positive.yaml'
            ).parse(start_routing=False)

    def test_rejects_partial_protocol_config(self):
        with self.assertRaises(ParsingException):
            Parser(
                f'{self.FILE_PATH}/invalid_protocol_config_partial.yaml'
            ).parse(start_routing=False)

    def test_parses_asn_from_as_block(self):
        internet = Parser(f'{self.FILE_PATH}/config_roundtrip.yaml').parse(
            start_routing=False
        )
        # config_roundtrip.yaml declares asn: 65000
        self.assertEqual(internet.single_as().asn(), 65000)

    def test_asn_defaults_when_absent(self):
        internet = Parser(f'{self.FILE_PATH}/no_asn.yaml').parse(
            start_routing=False
        )
        self.assertEqual(internet.single_as().asn(), 65000)

    def test_parses_custom_asn(self):
        internet = Parser(f'{self.FILE_PATH}/custom_asn.yaml').parse(
            start_routing=False
        )
        self.assertEqual(internet.single_as().asn(), 64500)

    # --------------------------------------------------------- H1 hardening --

    def test_duplicate_device_name(self):
        self._run_parsing_error_test(
            'duplicate_device_name', 'duplicate device name'
        )

    def test_address_leading_zero(self):
        self._run_parsing_error_test(
            'address_leading_zero', 'invalid address'
        )

    def test_network_with_host_bits(self):
        self._run_parsing_error_test(
            'network_with_host_bits', 'host bits set'
        )

    # ----------------------------------------------------------------- helpers

    def _run_parsing_error_test(self, filename, expected_msg):
        parser = Parser(f'{self.FILE_PATH}/{filename}.yaml')
        with self.assertRaises(ParsingException) as context:
            parser.parse()
        self.assertIn(expected_msg, context.exception.message)
