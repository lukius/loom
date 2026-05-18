import yaml

from entities import (
    AS,
    Address,
    Host,
    Interface,
    Internet,
    Link,
    LinkNotFoundException,
    Network,
    NetworkAddress,
    NetworkNotFoundException,
    Router,
)
from entities.exception import TooManyEndpointsException

from .exception import ParsingException
from .validator import SystemValidator


class Parser:

    def __init__(self, filename: any):
        self.filename = filename

    def parse(self, start_routing: bool = True) -> Internet:
        with open(self.filename, 'r') as f:
            content = yaml.safe_load(f)

        return self._parse(content, start_routing=start_routing)

    def _parse(self, content: dict, start_routing: bool = True):
        if 'internet' not in content:
            self._fail('missing "internet" key at YAML root')

        internet_dict = content['internet']
        internet_name = internet_dict.get('name', 'loom')
        internet = Internet(name=internet_name)

        if 'autonomous_systems' not in internet_dict:
            self._fail('missing "autonomous_systems" in internet block')
        ases_dict = internet_dict['autonomous_systems']
        if not ases_dict:
            self._fail('"autonomous_systems" must contain at least one AS')

        for as_short_name, as_block in ases_dict.items():
            self._parse_single_as(as_short_name, as_block, internet)

        # BGP-FOLLOWUP: inter-AS wiring pass — when BGP lands, the YAML grows
        # an `external_links:` block under `internet:` that names router/iface
        # endpoints across ASes. Parse and wire those links here, after every
        # AS has been built. The current single-AS topologies have no external
        # links so this pass is a no-op today.

        if start_routing:
            for system in internet.ases().values():
                for router in system.routers().values():
                    router.start()

        return internet

    def _parse_single_as(self, short_name, system_dict, internet):
        system = AS(short_name, gate=internet.gate())
        internet.add_as(system)
        validator = SystemValidator(system)

        if 'networks' not in system_dict:
            self._fail(f'{short_name}: no networks in AS')
        self._parse_networks(system, validator, system_dict['networks'])

        if 'links' in system_dict:
            self._parse_links(system, validator, system_dict['links'])

        hosts_on_links = []

        if 'routers' in system_dict:
            self._parse_routers(system, validator, system_dict['routers'])

        if 'hosts' in system_dict:
            self._parse_hosts(system, validator, system_dict['hosts'], hosts_on_links)

        self._post_pass_links(system, hosts_on_links)
        return system

    def _parse_networks(self, system, validator, network_dict):
        for name, addr in network_dict.items():
            address = self._parse_net_address(name, addr, validator)

            net = Network(name, address, gate=system.gate())
            result = validator.validate_network(net)
            if not result.ok():
                self._fail(f'{name}: {result.reason()}')

            system.add_network(net)

    def _parse_links(self, system, validator, link_dict):
        for name, addr in link_dict.items():
            address = self._parse_net_address(name, addr, validator)

            try:
                lnk = Link(name, address, gate=system.gate())
            except ValueError as e:
                self._fail(f'{name}: {e}')

            result = validator.validate_link(lnk)
            if not result.ok():
                self._fail(f'{name}: {result.reason()}')

            system.add_link(lnk)

    def _parse_routers(self, system, validator, router_dict):
        for name, obj in router_dict.items():
            if obj is None or 'interfaces' not in obj:
                self._fail(f'{name}: no interfaces declared')

            router = Router(name)

            for iface_name, iface in obj['interfaces'].items():
                has_network = 'network' in iface
                has_link = 'link' in iface

                if has_network and has_link:
                    self._fail(f'{name}: {iface_name}: declares both network and link')
                if not has_network and not has_link:
                    self._fail(f'{name}: {iface_name}: no network or link assigned')

                if has_network:
                    fabric = self._resolve_network(
                        system, name, iface_name, iface['network']
                    )
                else:
                    fabric = self._resolve_link(
                        system, name, iface_name, iface['link']
                    )

                if 'address' not in iface:
                    self._fail(f'{name}: {iface_name}: no address assigned')
                addr_str = iface['address']
                result = validator.validate_address(addr_str)
                if not result.ok():
                    self._fail(f'{name}: {iface_name}: {result.reason()}')
                address = Address(addr_str)

                cost = 1
                if 'cost' in iface:
                    cost = iface['cost']
                try:
                    cost = int(cost)
                except ValueError:
                    self._fail(f'{name}: {iface_name}: invalid cost')

                iface_obj = Interface(
                    iface_name, fabric, address, cost, gate=system.gate()
                )
                try:
                    fabric.add_interface(iface_obj)
                except TooManyEndpointsException as e:
                    self._fail(f'{name}: {iface_name}: {e}')
                router.add_interface(iface_obj)

            result = validator.validate_router(router)
            if not result.ok():
                self._fail(f'{name}: {result.reason()}')

            system.add_router(router)

    def _parse_hosts(self, system, validator, host_dict, hosts_on_links):
        for name, obj in host_dict.items():
            has_network = obj is not None and 'network' in obj
            has_link = obj is not None and 'link' in obj

            if has_network and has_link:
                self._fail(f'{name}: declares both network and link')
            if not has_network and not has_link:
                self._fail(f'{name}: no network or link assigned')

            if has_network:
                fabric = self._resolve_network(system, name, None, obj['network'])
            else:
                fabric = self._resolve_link(system, name, None, obj['link'])

            if 'address' not in obj:
                self._fail(f'{name}: no address assigned')
            addr_str = obj['address']
            result = validator.validate_address(addr_str)
            if not result.ok():
                self._fail(f'{name}: {result.reason()}')
            address = Address(addr_str)

            gw_address = None
            explicit_gw_str = None
            if 'gateway' in obj:
                gw_str = obj['gateway']
                result = validator.validate_address(gw_str)
                if not result.ok():
                    self._fail(f'{name}: {result.reason()}')
                explicit_gw_str = gw_str
                # For hosts on a network, apply the gateway immediately.
                # For hosts on a link, gateway is validated in the post-pass.
                if has_network:
                    gw_address = Address(gw_str)

            if has_link:
                fabric_addr = Address(addr_str)
                if not fabric.contains_address(fabric_addr):
                    self._fail(f'{name}: address not in link {fabric.name()}')
                if not fabric.is_valid_host_address(fabric_addr):
                    self._fail(f'{name}: invalid address for link {fabric.name()}')

            host = Host(name, fabric, address, gw_address, gate=system.gate())

            if has_network:
                result = validator.validate_host(host)
                if not result.ok():
                    self._fail(f'{name}: {result.reason()}')

            fabric.add_interface(host.interface())
            system.add_host(host)

            if has_link:
                hosts_on_links.append((host, explicit_gw_str))

    def _post_pass_links(self, system, hosts_on_links):
        for name, link in system.links().items():
            endpoint_count = link.endpoint_count()
            if endpoint_count != 2:
                self._fail(
                    f'{name}: link must have exactly two endpoints'
                    f' (got {endpoint_count})'
                )

        for host, explicit_gw_str in hosts_on_links:
            link = host.network()
            peer_iface = link.peer_of(host.interface())
            peer_addr = peer_iface.address()
            if explicit_gw_str is not None:
                if Address(explicit_gw_str) != peer_addr:
                    self._fail(
                        f'{host.name()}: gateway mismatch: expected {peer_addr},'
                        f' got {explicit_gw_str}'
                    )
            host.set_gateway(peer_addr)

    def _resolve_network(self, system, dev_name, iface_name, net_name):
        try:
            return system.network(net_name)
        except NetworkNotFoundException:
            if iface_name is not None:
                self._fail(f'{dev_name}: {iface_name}: network not found')
            else:
                self._fail(f'{dev_name}: network not found')

    def _resolve_link(self, system, dev_name, iface_name, link_name):
        try:
            return system.link(link_name)
        except LinkNotFoundException:
            if iface_name is not None:
                self._fail(f'{dev_name}: {iface_name}: link not found')
            else:
                self._fail(f'{dev_name}: link not found')

    def _parse_net_address(self, name, addr, validator):
        if '/' not in addr:
            self._fail(f'{name}: missing netmask')

        address, mask = addr.split('/')
        try:
            mask = int(mask)
            if mask < 0 or mask > 32:
                raise ValueError
        except ValueError:
            self._fail(f'{name}: invalid netmask {mask}')

        result = validator.validate_address(address)
        if not result.ok():
            self._fail(f'{name}: {result.reason()}')

        return NetworkAddress(addr)

    def _fail(self, msg):
        raise ParsingException(msg)
