import sys
from threading import Lock
from typing import List, Optional

from routing import NoNATEgressException, NoRouteToHostException

from .address import Address, NetworkAddress, NullAddress
from .device import NetworkDevice
from .event import EventTracer
from .interface import Interface
from .nat import NATTable, flow_id
from .packet import Datagram, PingReply, PingRequest, RoutingMessage


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

    def next_hop(self) -> Optional[NetworkAddress]:
        return self._next_hop

    def interface(self) -> Optional[Interface]:
        return self._interface


class RoutingTable:

    _rules: List[RoutingRule]

    def __init__(self):
        self._rules = list()
        self._lock = Lock()

    def rules(self):
        with self._lock:
            return list(self._rules)

    def add_rule(self, prefix, next_hop, interface):
        new_rule = RoutingRule(prefix, next_hop, interface)
        with self._lock:
            for i, rule in enumerate(self._rules):
                if prefix == rule.prefix():
                    self._rules[i] = new_rule
                    return
            self._rules.append(new_rule)

    def clear(self):
        with self._lock:
            self._rules = list()

    def remove_rule(self, prefix):
        with self._lock:
            for i, rule in enumerate(self._rules):
                if prefix == rule.prefix():
                    del self._rules[i]
                    break

    def match(self, address: Address) -> MatchingResult:
        with self._lock:
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


class Router(NetworkDevice):

    def __init__(self, name):
        super().__init__(name)
        self._routing_table = RoutingTable()
        self._nat_table = NATTable()
        # BGP-FOLLOWUP: this deferred import + the paired __getattr__ in
        # entities/__init__.py exist solely to break the entities ↔ routing
        # cycle. When BGP lands, externalize protocol construction (have
        # the parser inject protocols into Router via add_protocol() rather
        # than Router.__init__ constructing LinkStateProtocol itself). At
        # that point the cycle disappears and both the noqa here and the
        # __getattr__ hook can go.
        # Deferred import: entities ↔ routing cycle. entities/__init__.py loads
        # this module before routing/__init__.py finishes binding LinkStateProtocol.
        # Importing at call time ensures both packages are fully loaded.
        from routing import LinkStateProtocol  # noqa: PLC0415
        # BGP-FOLLOWUP: today LinkStateProtocol writes rules directly into
        # self._routing_table via _recompute_routing_table. When BGP becomes the
        # second protocol, introduce a RIB-level merge that walks
        # `self.protocols()`, collects each protocol's `installed_rules()`,
        # and applies administrative-distance ordering before writing to the
        # routing table. Today's accessor returns the table's rules as a
        # passthrough; tomorrow it should be the protocol's own contribution.
        self._protocols: list = [LinkStateProtocol(self)]
        self._as_gate = None  # set by AS.add_router

    def gate(self):
        return self._as_gate

    def protocols(self):
        """Routing protocols active on this router.

        Today this is ``[LinkStateProtocol(self)]``. When a second protocol
        is added (e.g. BGP at AS edges), it goes here; per-protocol
        lifecycle calls (start/stop) and the routing-message dispatch
        walk this list.
        """
        return list(self._protocols)

    # BGP-FOLLOWUP: remove this single-protocol accessor once a second
    # protocol exists. Migrate the ~16 callers (tests, shell, server commands)
    # to either `protocols()` for multi-protocol operations or named accessors
    # (`link_state()`, `bgp()`) for protocol-specific queries.
    def protocol(self):
        """Back-compat: return the (single) link-state protocol.

        Transitional accessor for code that still wants the single
        protocol object; new code should iterate ``protocols()``. Will be
        removed once all consumers are migrated.
        """
        return self._protocols[0]

    def routing_table(self):
        return self._routing_table

    def nat_table(self):
        return self._nat_table

    def start(self):
        for proto in self._protocols:
            proto.start()

    def stop(self):
        for proto in self._protocols:
            proto.stop()

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
        if isinstance(msg, RoutingMessage):
            self._handle_routing_message(msg, interface)
            return
        if isinstance(msg, PingRequest):
            self._reply_to_ping(msg, interface, packet)
            return
        # PingReply silently dropped — routers don't initiate pings.

    def _reply_to_ping(self, msg: PingRequest, interface: Interface, packet: Datagram):
        """Answer an ICMP echo request addressed to one of our interfaces.

        Mirrors a real router's behavior. Important when interface IPs
        coincide with addresses on other subnets (e.g. two /30 links that
        accidentally share a CIDR): the router answers, the sender sees a
        successful ping that didn't actually reach the intended host. A
        `router_intercept` event is emitted so the SPA can flag the reply.
        """
        originator = packet.source()
        result = self._routing_table.match(originator)
        if not result.is_matched():
            return  # No route back — quietly drop, same as a real router would.
        out_iface = result.interface()
        next_hop = result.next_hop()
        if next_hop == NullAddress:
            next_hop = originator
        reply = PingReply(
            seq=msg.seq, request_ts=msg.sent_at, request_id=msg.id(),
        )
        # Source address of the reply is the IP the sender pinged — the
        # interface whose address matched, not the receiving interface.
        reply_dgram = Datagram(
            src_addr=packet.destination(), dst_addr=originator, payload=reply,
        )
        # Identify which of our interfaces owned the address that was pinged
        # — usually NOT the one the packet came in on (that's the whole reason
        # this branch fires through the cross-interface "for me" check).
        owning_iface = next(
            (n for n, iff in self._interfaces.items()
             if iff.address() == packet.destination()),
            None,
        )
        EventTracer._broadcast({
            'kind': 'router_intercept',
            'router': self.name(),
            'originator': str(originator),
            'pinged_address': str(packet.destination()),
            'received_on': interface.name(),
            'owning_iface': owning_iface,
            'payload_id': str(reply.id()),
        })
        out_iface.send_to(reply_dgram, dst_addr=next_hop)

    def _handle_routing_message(self, msg: RoutingMessage, interface: Interface):
        for proto in self._protocols:
            proto.handle_incoming_message(msg, interface)
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
                raise NoNATEgressException(
                    f'router {self.name()} has no public interface '
                    f'for private source {packet.source()}'
                )
            raise NoRouteToHostException(f'no route to host {dest}')

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
