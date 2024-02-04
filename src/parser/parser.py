import yaml

from .exception import ParsingException
from entities import AS, Network, Router, Host, Interface, NetworkAddress, Address, EntityNotFoundException
from .validator import SystemValidator


class Parser(object):

    def __init__(self, filename: any):
        self.filename = filename
        self._unnamed_count = 0

    def parse(self) -> AS:
        with open(self.filename, 'r') as f:
            content = yaml.safe_load(f)

        return self._parse(content)

    def _parse(self, content: dict):
        if 'as' not in content:
            self._fail('missing "as" key')

        system_dict = content['as']
        name = self._get_name(system_dict)
        system = AS(name)
        validator = SystemValidator(system)

        if 'networks' not in system_dict:
            self._fail('no networks in AS')
        self._parse_networks(system, validator, system_dict['networks'])

        if 'routers' in system_dict:
            self._parse_routers(system, validator, system_dict['routers'])

        if 'hosts' in system_dict:
            self._parse_hosts(system, validator, system_dict['hosts'])

        return system

    def _parse_networks(self, system: AS, validator: SystemValidator, network_dict: dict):
        for name, addr in network_dict.items():
            address = self._parse_net_address(name, addr, validator)

            net = Network(name, address)
            result = validator.validate_network(net)
            if not result.ok():
                self._fail(f'{name}: {result.reason()}')

            system.add_network(net)

    def _parse_routers(self, system: AS, validator: SystemValidator, router_dict: dict):
        for name, obj in router_dict.items():
            if 'interfaces' not in obj:
                self._fail(f'{name}: no interfaces declared')

            router = Router(name)

            for iface_name, iface in obj['interfaces'].items():
                if 'network' not in iface:
                    self._fail(f'{name}: {iface_name}: no network assigned')
                net_name = iface['network']
                try:
                    net = system.get_network(net_name)
                except EntityNotFoundException:
                    self._fail(f'{name}: {iface_name}: network not found')

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

                iface = Interface(iface_name, net, address, cost)
                net.add_interface(iface)
                router.add_interface(iface)

            result = validator.validate_router(router)
            if not result.ok():
                self._fail(f'{name}: {result.reason()}')

            system.add_router(router)

    def _parse_hosts(self, system: AS, validator: SystemValidator, host_dict: dict):
        for name, obj in host_dict.items():
            if 'network' not in obj:
                self._fail(f'{name}: no network assigned')
            net_name = obj['network']
            try:
                net = system.get_network(net_name)
            except EntityNotFoundException:
                self._fail(f'{name}: network not found')

            if 'address' not in obj:
                self._fail(f'{name}: no address assigned')
            addr_str = obj['address']
            result = validator.validate_address(addr_str)
            if not result.ok():
                self._fail(f'{name}: {result.reason()}')
            address = Address(addr_str)

            host = Host(name, net, address)

            result = validator.validate_host(host)
            if not result.ok():
                self._fail(f'{name}: {result.reason()}')

            net.add_interface(host.interface())
            system.add_host(host)

    def _parse_net_address(self, name: str, addr: str, validator: SystemValidator) -> NetworkAddress:
        if '/' not in addr:
            self._fail(f'{name}: missing netmask')

        address, mask = addr.split('/')
        try:
            mask = int(mask)
        except ValueError:
            self._fail(f'{name}: invalid netmask {mask}')

        result = validator.validate_address(address)
        if not result.ok():
            self._fail(f'{name}: {result.reason()}')

        return NetworkAddress(addr)

    def _get_name(self, obj: dict) -> str:
        if 'name' in obj:
            return obj['name']

        idx = self._unnamed_count
        self._unnamed_count += 1
        return f'unnamed_entity_{idx}'

    def _fail(self, msg):
        raise ParsingException(msg)
