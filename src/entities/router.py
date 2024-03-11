from typing import List
from threading import Lock

from .device import NetworkDevice
from .address import NetworkAddress, Address, NullAddress
from .interface import Interface
from .packet import Datagram, RoutingMessage
from .event import EventTracer

from routing import RoutingProtocol


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
        self._lock = Lock()

    def with_lock(func):
        def func_with_lock(self, *args, **kwargs):
            with self._lock:
                return func(self, *args, **kwargs)

        return func_with_lock

    @with_lock
    def add_rule(self, prefix, next_hop, interface):
        new_rule = RoutingRule(prefix, next_hop, interface)

        for i, rule in enumerate(self._rules):
            if prefix == rule.prefix():
                self._rules[i] = new_rule
                return

        self._rules.append(new_rule)

    @with_lock
    def clear(self):
        self._rules = list()

    @with_lock
    def remove_rule(self, prefix):
        for i, rule in enumerate(self._rules):
            if prefix == rule.prefix():
                del self._rules[i]
                break

    @with_lock
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

    with_lock = staticmethod(with_lock)



class Router(NetworkDevice):

    def __init__(self, name):
        super().__init__(name)
        self._routing_table = RoutingTable()
        self._protocol = RoutingProtocol(self)

    def routing_table(self):
        return self._routing_table

    def _handle_message(self, msg, interface):
        if msg.type() == RoutingMessage:
            self._handle_routing_message(msg, interface)

    def _handle_routing_message(self, msg: RoutingMessage, interface: Interface):
        self._protocol.handle_incoming_message(msg, interface)
        return EventTracer.message_received(src=interface.address(), msg=msg)

    def _handle_forwarding(self, packet: Datagram):
        dest = packet.destination()
        result = self._routing_table.match(dest)
        if not result.succeeded():
            # TODO
            raise Exception(f'no route to host {dest}')

        out_iface = result.interface()
        next_hop = result.next_hop()
        if next_hop == NullAddress:
            next_hop = packet.destination()

        out_iface.send_to(packet, next_hop)

        return EventTracer.datagram_forwarded(src=out_iface.address(), dst=next_hop, datagram=packet)
