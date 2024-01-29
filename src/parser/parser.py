import yaml

from .exception import ParsingException
from entities import AS, Network, Router, Host


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

        if 'networks' not in system_dict:
            self._fail('no networks in AS')
        self._parse_networks(system, system_dict['networks'])

        if 'routers' in system_dict:
            self._parse_routers(system, system_dict['routers'])

        if 'hosts' in system_dict:
            self._parse_hosts(system, system_dict['hosts'])

        return system

    def _parse_routers(self, system: AS, router_dict: dict):
        pass

    def _parse_networks(self, system: AS, network_dict: dict):
        for name, addr in network_dict.items():
            address, mask = self._parse_net_address(name, addr)
            net = Network(name, address, mask)
            system.add_network(net)

    def _parse_net_address(self, name: str, addr: str) -> tuple:
        if '/' not in addr:
            self._fail(f'{name}: missing netmask')

        address, mask = addr.split('/')
        try:
            mask = int(mask)
        except ValueError:
            self._fail(f'{name}: invalid netmask {mask}')

        octets = address.split('.')
        msg = f'{name}: invalid address {address}'
        if len(octets) != 4:
            self._fail(msg)

        try:
            octets[0] = int(octets[0])
            octets[1] = int(octets[1])
            octets[2] = int(octets[2])
            octets[3] = int(octets[3])
        except ValueError:
            self._fail(msg)

        for i in range(4):
            if octets[i] < 0 or octets[i] > 255:
                self._fail(f'{name}: invalid address {address}')

        return address, mask

    def _parse_hosts(self, system: AS, host_dict: dict):
        pass

    def _get_name(self, obj: dict) -> str:
        if 'name' in obj:
            return obj['name']

        idx = self._unnamed_count
        self._unnamed_count += 1
        return f'unnamed_entity_{idx}'

    def _fail(self, msg):
        raise ParsingException(msg)
