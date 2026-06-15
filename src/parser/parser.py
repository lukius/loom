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

    def __init__(self, filename: str):
        self.filename = filename
        # Every fabric (_FabricBase) and Interface constructed during the build
        # is appended here so that a partial build can be fully cleaned up on
        # failure — even when add_interface clobbers an earlier entry at the
        # same address key and the clobbered object becomes otherwise unreachable.
        self._tracked: list = []

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

        # Top-level internet.config is an opaque pass-through to Internet; per-AS
        # config.protocol is parsed and applied in _parse_protocol_config.
        config = internet_dict.get('config')
        if config is not None:
            if not isinstance(config, dict):
                self._fail('"internet.config" must be a mapping')
            internet.set_config(config)

        if 'autonomous_systems' not in internet_dict:
            self._fail('missing "autonomous_systems" in internet block')
        ases_dict = internet_dict['autonomous_systems']
        self._require_mapping(ases_dict, '"autonomous_systems"')
        if not ases_dict:
            self._fail('"autonomous_systems" must contain at least one AS')

        try:
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
        except Exception:
            # Stop every constructed fabric and interface, including any whose
            # fabric slot was clobbered by a duplicate-address add_interface
            # call — those become otherwise unreachable.  Guard each stop()
            # individually so a cleanup failure cannot mask the original error.
            for obj in self._tracked:
                try:
                    obj.stop()
                except Exception:
                    pass
            raise

        return internet

    def _parse_single_as(self, short_name, system_dict, internet):
        self._require_mapping(system_dict, f'AS "{short_name}"')
        system = AS(short_name, gate=internet.gate())
        internet.add_as(system)
        validator = SystemValidator(system)

        if 'asn' in system_dict:
            asn = system_dict['asn']
            if isinstance(asn, bool) or not isinstance(asn, int) or asn < 0:
                self._fail(
                    f'{short_name}: invalid asn {asn!r}'
                    ' (must be a non-negative integer)'
                )
            system.set_asn(asn)

        protocol_config = self._parse_protocol_config(short_name, system_dict)
        if protocol_config:
            system.set_protocol_config(protocol_config)

        if 'networks' not in system_dict:
            self._fail(f'{short_name}: no networks in AS')
        self._parse_networks(system, validator, system_dict['networks'])

        if 'links' in system_dict:
            self._parse_links(system, validator, system_dict['links'])

        hosts_on_links = []

        if 'routers' in system_dict:
            self._parse_routers(system, validator, system_dict['routers'])
            if protocol_config:
                for router in system.routers().values():
                    router.protocol().set_timers(**protocol_config)

        if 'hosts' in system_dict:
            self._check_no_duplicate_device_names(
                short_name, system_dict['routers'] if 'routers' in system_dict else {},
                system_dict['hosts'],
            )
            self._parse_hosts(system, validator, system_dict['hosts'], hosts_on_links)

        self._post_pass_links(system, hosts_on_links)
        return system

    def _parse_networks(self, system, validator, network_dict):
        self._require_mapping(network_dict, '"networks"')
        for name, addr in network_dict.items():
            address = self._parse_net_address(name, addr, validator)

            net = Network(name, address, gate=system.gate())
            self._tracked.append(net)
            result = validator.validate_network(net)
            if not result.ok():
                self._fail(f'{name}: {result.reason()}')

            system.add_network(net)

    def _parse_links(self, system, validator, link_dict):
        self._require_mapping(link_dict, '"links"')
        for name, addr in link_dict.items():
            address = self._parse_net_address(name, addr, validator)

            try:
                lnk = Link(name, address, gate=system.gate())
            except ValueError as e:
                self._fail(f'{name}: {e}')

            self._tracked.append(lnk)
            result = validator.validate_link(lnk)
            if not result.ok():
                self._fail(f'{name}: {result.reason()}')

            system.add_link(lnk)

    def _parse_routers(self, system, validator, router_dict):
        self._require_mapping(router_dict, '"routers"')
        for name, obj in router_dict.items():
            if obj is None or 'interfaces' not in obj:
                self._fail(f'{name}: no interfaces declared')

            router = Router(name)

            self._require_mapping(obj['interfaces'], f'{name}: "interfaces"')
            for iface_name, iface in obj['interfaces'].items():
                self._require_mapping(iface, f'{name}: {iface_name}')
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
                    cost = self._positive_int_cost(name, iface_name, iface['cost'])

                iface_obj = Interface(
                    iface_name, fabric, address, cost, gate=system.gate()
                )
                self._tracked.append(iface_obj)
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
        self._require_mapping(host_dict, '"hosts"')
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
            self._tracked.append(host.interface())

            if has_network:
                result = validator.validate_host(host)
                if not result.ok():
                    self._fail(f'{name}: {result.reason()}')

            try:
                fabric.add_interface(host.interface())
            except TooManyEndpointsException as e:
                self._fail(f'{name}: {e}')
            system.add_host(host)

            if has_link:
                hosts_on_links.append((host, explicit_gw_str))

    def _check_no_duplicate_device_names(self, short_name, routers_dict, hosts_dict):
        """Fail if any host name duplicates a router name.

        `AS.device()` resolves hosts first, so a host/router name collision
        makes the router unreachable via the device lookup path.
        """
        router_names = set(routers_dict) if isinstance(routers_dict, dict) else set()
        host_names = set(hosts_dict) if isinstance(hosts_dict, dict) else set()
        duplicates = router_names & host_names
        for name in sorted(duplicates):
            self._fail(
                f'{short_name}: duplicate device name {name!r}'
                f' (used by both a router and a host)'
            )

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
        if not isinstance(addr, str):
            self._fail(f'{name}: address must be a string')
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

        net_addr = NetworkAddress(addr)
        # Reject addresses where the host bits are non-zero (e.g. 10.0.0.5/24).
        # NetworkAddress._canonicalize silently clears host bits; compare the
        # canonical string representation against the raw input to detect this.
        canonical_host = str(net_addr).split('/')[0]
        if canonical_host != address:
            self._fail(
                f'{name}: network address {addr} has host bits set'
                f' (did you mean {net_addr}?)'
            )

        return net_addr

    def _parse_protocol_config(self, short_name, system_dict):
        config = system_dict.get('config')
        if config is None:
            return None
        if not isinstance(config, dict):
            self._fail(f'{short_name}: "config" must be a mapping')
        protocol = config.get('protocol')
        if protocol is None:
            return None
        if not isinstance(protocol, dict):
            self._fail(f'{short_name}: "config.protocol" must be a mapping')
        has_hello = 'hello_interval' in protocol
        has_refresh = 'lsa_refresh_interval' in protocol
        if not has_hello and not has_refresh:
            return None
        if not (has_hello and has_refresh):
            self._fail(
                f'{short_name}: "config.protocol" requires both '
                'hello_interval and lsa_refresh_interval'
            )
        return {
            'hello_interval': self._positive_number(
                short_name, 'hello_interval', protocol['hello_interval']
            ),
            'lsa_refresh_interval': self._positive_number(
                short_name, 'lsa_refresh_interval', protocol['lsa_refresh_interval']
            ),
        }

    def _require_mapping(self, value, label):
        if not isinstance(value, dict):
            self._fail(f'{label} must be a mapping')

    def _positive_number(self, short_name, key, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
            self._fail(
                f'{short_name}: "{key}" must be a positive number (got {value!r})'
            )
        return float(value)

    def _positive_int_cost(self, router_name, iface_name, value):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            self._fail(f'{router_name}: {iface_name}: invalid cost')
        return value

    def _fail(self, msg):
        raise ParsingException(msg)
