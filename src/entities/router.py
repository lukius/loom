import sys
from threading import Lock
from typing import List

from routing import RoutingProtocol

from .address import Address, NetworkAddress, NullAddress
from .device import NetworkDevice
from .event import EventTracer
from .interface import Interface
from .nat import NATTable, flow_id
from .packet import Datagram, RoutingMessage


class RoutingRule:

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


class MatchingResult:
    """Outcome of a longest-prefix lookup on a RoutingTable.

    Constructed via `MatchingResult.matched(next_hop, interface)` for a hit and
    `MatchingResult.not_matched()` for a miss; query via `is_matched()`.
    Accessors (`next_hop()`, `interface()`) return `None` on a miss.
    """

    @classmethod
    def matched(cls, next_hop, interface) -> 'MatchingResult':
        result = cls.__new__(cls)
        result._matched = True
        result._next_hop = next_hop
        result._interface = interface
        return result

    @classmethod
    def not_matched(cls) -> 'MatchingResult':
        result = cls.__new__(cls)
        result._matched = False
        result._next_hop = None
        result._interface = None
        return result

    def is_matched(self) -> bool:
        return self._matched

    def next_hop(self):
        return self._next_hop

    def interface(self):
        return self._interface


class RoutingTable:

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
    def rules(self):
        return self._rules

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
            return MatchingResult.not_matched()

        rule = self._rules[longest_prefix_idx]
        return MatchingResult.matched(rule.next_hop(), rule.interface())

    with_lock = staticmethod(with_lock)


class Router(NetworkDevice):

    def __init__(self, name):
        super().__init__(name)
        self._routing_table = RoutingTable()
        self._nat_table = NATTable()
        self._protocol = RoutingProtocol(self)
        self._as_gate = None  # set by AS.add_router

    def gate(self):
        return self._as_gate

    def routing_table(self):
        return self._routing_table

    def nat_table(self):
        return self._nat_table

    def start(self):
        self._protocol.start()

    def stop(self):
        self._protocol.stop()

    def handle_packet(self, packet, interface):
        dst = packet.destination()
        on_public = not interface.network().address().is_private()
        if dst == interface.address() and on_public:
            fid = flow_id(packet.payload())
            original_dst = self._nat_table.lookup(
                rewritten_src=dst,
                original_dst=packet.source(),
                flow_id=fid,
            )
            if original_dst is not None:
                payload = packet.payload()
                payload_id = str(payload.id()) if hasattr(payload, 'id') else None
                EventTracer._broadcast({
                    'kind': 'nat',
                    'router': self.name(),
                    'direction': 'inbound',
                    'rewritten_dst': str(dst),
                    'original_dst': str(original_dst),
                    'src': str(packet.source()),
                    'flow_id': fid,
                    'payload_id': payload_id,
                })
                packet.rewrite_destination(original_dst)
                self._handle_forwarding(packet)
                return

        super().handle_packet(packet, interface)

    def _handle_message(self, msg, interface, packet):
        if msg.type() == RoutingMessage:
            self._handle_routing_message(msg, interface)
        # PingRequest/PingReply silently dropped

    def _handle_routing_message(self, msg: RoutingMessage, interface: Interface):
        self._protocol.handle_incoming_message(msg, interface)
        return EventTracer.message_received(src=interface.address(), msg=msg)

    def _handle_forwarding(self, packet: Datagram):
        packet.decrement_ttl()
        if packet.ttl() <= 0:
            dst = packet.destination()
            print(f'TTL expired: dropping datagram to {dst}', file=sys.stderr)
            return None

        dest = packet.destination()
        result = self._routing_table.match(dest)
        if not result.is_matched():
            if packet.source().is_private() and not self._has_public_interface():
                raise Exception(
                    f'no NAT egress: router {self.name()} has no public interface '
                    f'for private source {packet.source()}'
                )
            raise Exception(f'no route to host {dest}')

        out_iface = result.interface()
        next_hop = result.next_hop()
        if next_hop == NullAddress:
            next_hop = packet.destination()

        src = packet.source()
        if src.is_private() and not out_iface.network().address().is_private():
            original_src = src
            rewritten_src = out_iface.address()
            fid = flow_id(packet.payload())
            self._nat_table.register(
                rewritten_src, packet.destination(),
                flow_id=fid, original_src=original_src,
            )
            packet.rewrite_source(rewritten_src)
            payload = packet.payload()
            payload_id = str(payload.id()) if hasattr(payload, 'id') else None
            EventTracer._broadcast({
                'kind': 'nat',
                'router': self.name(),
                'direction': 'outbound',
                'original_src': str(original_src),
                'rewritten_src': str(rewritten_src),
                'dst': str(packet.destination()),
                'flow_id': fid,
                'payload_id': payload_id,
            })
            EventTracer._broadcast({
                'kind': 'nat_table_changed',
                'device': self.name(),
                'entries': self._nat_table.snapshot(),
            })

        out_iface.send_to(packet, next_hop)

        return EventTracer.datagram_forwarded(
            src=out_iface.address(), dst=next_hop, datagram=packet
        )

    def _has_public_interface(self):
        return any(
            not iface.network().address().is_private()
            for iface in self._interfaces.values()
        )
