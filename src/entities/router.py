from typing import List

from .device import NetworkDevice
from .address import NetworkAddress, Address
from .interface import Interface

class RoutingRule(object):

    _address: NetworkAddress
    _next_hop: Address
    _interface: Interface

    def __init__(self, address, next_hop, interface):
        self._address = address
        self._next_hop = next_hop
        self._interface = interface

    def matches(self, address):
        return self._address.matches(address)

    def prefix(self) -> NetworkAddress:
        return self._address

    def next_hop(self):
        return self._next_hop

    def interface(self):
        return self._interface


class MatchingResult(object):

    def succeeded(self) -> bool:
        raise NotImplementedError


class MatchingFailure(MatchingResult):

    def succeeded(self) -> bool:
        return False


class MatchingSuccess(MatchingResult):

    def __init__(self, next_hop, interface):
        self._next_hop = next_hop
        self._interface = interface

    def succeeded(self) -> bool:
        return True

    def next_hop(self) -> NetworkAddress:
        return self._next_hop

    def interface(self):
        return self._interface


class RoutingTable(object):

    _rules: List[RoutingRule]

    def __init__(self):
        self._rules = list()

    def add_rule(self, prefix, next_hop, interface):
        new_rule = RoutingRule(prefix, next_hop, interface)

        for i, rule in enumerate(self._rules):
            if prefix == rule.prefix():
                self._rules[i] = new_rule
                return

        self._rules.append(new_rule)

    def remove_rule(self, prefix):
        for i, rule in enumerate(self._rules):
            if prefix == rule.prefix():
                del self._rules[i]
                break

    def match(self, address: Address) -> MatchingResult:
        longest_prefix = -1
        longest_prefix_idx = -1

        for i, rule in enumerate(self._rules):
            if not rule.matches(address):
                continue

            prefix_length = rule.prefix().mask()
            if prefix_length > longest_prefix:
                longest_prefix = prefix_length
                longest_prefix_idx = i

        if longest_prefix_idx < 0:
            return MatchingFailure()

        rule = self._rules[longest_prefix_idx]
        return MatchingSuccess(rule.next_hop(), rule.interface())



class Router(NetworkDevice):

    def __init__(self, name):
        super().__init__(name)
        self._routing_table = RoutingTable()
