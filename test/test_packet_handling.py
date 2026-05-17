import io
import sys
import unittest

from entities import (
    Address,
    Datagram,
    EventTracer,
    Host,
    Interface,
    Network,
    NetworkAddress,
    NullAddress,
    Router,
    RoutingMessage,
    UserMessage,
)
from entities.packet import Frame


class PacketHandlingTest(unittest.TestCase):

    def setUp(self):
        net1 = Network('lan1', NetworkAddress('200.200.10.0/24'))
        net2 = Network('lan2', NetworkAddress('100.100.0.0/24'))

        self.iface1 = Interface('eth0', net1, Address('200.200.10.1'))
        self.iface2 = Interface('eth1', net2, Address('100.100.0.254'))
        self.iface3 = Interface('eth2', net2, Address('100.100.0.250'))

        net1.add_interface(self.iface1)
        net2.add_interface(self.iface2)
        net2.add_interface(self.iface3)

        self.router = Router('r1')
        self.router.add_interface(self.iface1)
        self.router.add_interface(self.iface2)
        self.router.add_interface(self.iface3)

        self.host = Host(
            'h1', net1, Address('200.200.10.10'), gw_address=self.iface1.address()
        )

    def test_msg_host_unicast(self):
        datagram = self._user_msg_datagram(
            'test msg',
            src=Address('100.100.10.15'),
            dst=self.host.address()
        )

        self.received = False

        def on_received(*args, **kwargs):
            self.received = True

        _ = EventTracer.register_message_event(
            datagram.payload(),
            on_sent=lambda *args, **kwargs: self.fail(),
            on_forwarded=lambda *args, **kwargs: self.fail(),
            on_received=on_received
        )

        self.host.handle_packet(datagram, self.host.interface())
        self.assertTrue(self.received)

    def test_msg_host_broadcast(self):
        datagram = self._user_msg_datagram(
            'test msg',
            src=Address('100.100.10.15'),
            dst=Address('200.200.10.255')
        )

        self.received = False

        def on_received(*args, **kwargs):
            self.received = True

        _ = EventTracer.register_message_event(
            datagram.payload(),
            on_sent=lambda *args, **kwargs: self.fail(),
            on_forwarded=lambda *args, **kwargs: self.fail(),
            on_received=on_received
        )

        self.host.handle_packet(datagram, self.host.interface())
        self.assertTrue(self.received)

    def test_routing_msg_ignored_by_hosts(self):
        datagram = self._routing_msg_datagram(
            self.router.interfaces()['eth0'],
            src=Address('200.200.100.1'),
            dst=Address('200.200.10.255')
        )

        _ = EventTracer.register_message_event(
            datagram.payload(),
            on_sent=lambda *args, **kwargs: self.fail(),
            on_forwarded=lambda *args, **kwargs: self.fail(),
            on_received=lambda *args, **kwargs: self.fail()
        )

        self.host.handle_packet(datagram, self.host.interface())

    def test_host_cannot_forward(self):
        datagram = self._user_msg_datagram(
            'test msg',
            src=Address('100.100.10.15'),
            dst=Address('200.100.10.50')
        )

        _ = EventTracer.register_message_event(
            datagram.payload(),
            on_sent=lambda *args, **kwargs: self.fail(),
            on_forwarded=lambda *args, **kwargs: self.fail(),
            on_received=lambda *args, **kwargs: self.fail()
        )

        with self.assertRaises(Exception) as context:
            self.host.handle_packet(datagram, self.host.interface())
        self.assertIn('cannot forward datagrams', str(context.exception))

    def test_routing_msg_router(self):
        datagram = self._routing_msg_datagram(
            self.iface3,
            src=self.iface3.address(),
            dst=Address('200.200.10.255')
        )

        self.received = False

        def on_received(*args, **kwargs):
            self.received = True

        _ = EventTracer.register_message_event(
            datagram.payload(),
            on_sent=lambda *args, **kwargs: self.fail(),
            on_forwarded=lambda *args, **kwargs: self.fail(),
            on_received=on_received
        )

        self.router.handle_packet(datagram, self.iface1)
        self.assertTrue(self.received)

    def test_forwarding_failure(self):
        datagram = self._user_msg_datagram(
            'test msg',
            src=Address('100.100.10.15'),
            dst=Address('200.100.10.50')
        )

        self.forwarded = False

        def on_forwarded(*args, **kwargs):
            self.forwarded = True

        _ = EventTracer.register_message_event(
            datagram.payload(),
            on_sent=lambda *args, **kwargs: self.fail(),
            on_forwarded=on_forwarded,
            on_received=lambda *args, **kwargs: self.fail()
        )

        with self.assertRaises(Exception) as context:
            self.router.handle_packet(datagram, self.iface1)
        self.assertIn('no route to host', str(context.exception))

    def test_user_msg_ignored_by_routers(self):
        datagram = self._user_msg_datagram(
            'test msg',
            src=Address('100.100.10.15'),
            dst=self.iface1.address()
        )

        _ = EventTracer.register_message_event(
            datagram.payload(),
            on_sent=lambda *args, **kwargs: self.fail(),
            on_forwarded=lambda *args, **kwargs: self.fail(),
            on_received=lambda *args, **kwargs: self.fail()
        )

        self.router.handle_packet(datagram, self.iface1)

    def test_datagram_default_ttl(self):
        datagram = self._user_msg_datagram(
            'test msg',
            src=Address('100.100.10.15'),
            dst=Address('200.200.10.10')
        )
        self.assertEqual(datagram.ttl(), 64)

    def test_forwarding_decrements_ttl(self):
        self.router.routing_table().add_rule(
            prefix=self.iface2.network().address(),
            next_hop=self.iface2.address(),
            interface=self.iface2
        )
        datagram = self._user_msg_datagram(
            'test msg',
            src=Address('100.100.10.15'),
            dst=Address('100.100.0.5')
        )
        initial_ttl = datagram.ttl()
        self.router._handle_forwarding(datagram)
        self.assertEqual(datagram.ttl(), initial_ttl - 1)

    def test_ttl_zero_drops_packet(self):
        self.router.routing_table().add_rule(
            prefix=self.iface2.network().address(),
            next_hop=self.iface2.address(),
            interface=self.iface2
        )
        datagram = self._user_msg_datagram_with_ttl(
            'test msg',
            src=Address('100.100.10.15'),
            dst=Address('100.100.0.5'),
            ttl=1
        )

        forwarded = False

        def on_forwarded(*args, **kwargs):
            nonlocal forwarded
            forwarded = True

        _ = EventTracer.register_message_event(
            datagram.payload(),
            on_sent=lambda *args, **kwargs: None,
            on_forwarded=on_forwarded,
            on_received=lambda *args, **kwargs: None
        )

        captured = io.StringIO()
        sys.stderr = captured
        try:
            self.router._handle_forwarding(datagram)
        finally:
            sys.stderr = sys.__stderr__

        self.assertFalse(forwarded)
        self.assertIn('TTL', captured.getvalue())

    def _user_msg_datagram(self, payload, src, dst):
        msg = UserMessage(payload)
        return Datagram(src, dst, msg)

    def _user_msg_datagram_with_ttl(self, payload, src, dst, ttl):
        msg = UserMessage(payload)
        return Datagram(src, dst, msg, ttl=ttl)

    def _routing_msg_datagram(self, interface, src, dst):
        msg = RoutingMessage(interface, 1)
        return Datagram(src, dst, msg)


class NetworkBroadcastTest(unittest.TestCase):
    """A multi-access Network must not echo a broadcast back to its sender.

    Real NICs filter out frames whose source MAC matches their own; modelling
    that here keeps the routing protocol from treating its own LSP as an
    incoming external message and re-flooding it (which amplifies LSP
    traffic on every shared LAN — once outbound, once "received from self"
    and re-flooded out the other interfaces).
    """

    def test_broadcast_is_not_delivered_back_to_the_sending_interface(self):
        net = Network('lan', NetworkAddress('10.0.0.0/24'))
        sender = Interface('eth0', net, Address('10.0.0.1'))
        peer_a = Interface('eth_a', net, Address('10.0.0.2'))
        peer_b = Interface('eth_b', net, Address('10.0.0.3'))
        net.add_interface(sender)
        net.add_interface(peer_a)
        net.add_interface(peer_b)

        received_on = []
        sender.receive = lambda pkt: received_on.append('sender')
        peer_a.receive = lambda pkt: received_on.append('peer_a')
        peer_b.receive = lambda pkt: received_on.append('peer_b')

        frame = Frame(
            src_addr=sender.address(),
            dst_addr=net.broadcast_address(),
            payload=UserMessage('hello LAN'),
        )
        net._dispatch_broadcast(frame)

        self.assertNotIn('sender', received_on)
        self.assertEqual(sorted(received_on), ['peer_a', 'peer_b'])


class PacketRewriteTest(unittest.TestCase):

    def test_rewrite_source_changes_source_only(self):
        d = Datagram(Address('192.168.1.10'), Address('8.8.8.8'), payload='x')
        d.rewrite_source(Address('200.100.0.1'))
        self.assertEqual(d.source(), Address('200.100.0.1'))
        self.assertEqual(d.destination(), Address('8.8.8.8'))

    def test_rewrite_destination_changes_destination_only(self):
        d = Datagram(Address('192.168.1.10'), Address('200.100.0.1'), payload='x')
        d.rewrite_destination(Address('192.168.1.10'))
        self.assertEqual(d.destination(), Address('192.168.1.10'))
        self.assertEqual(d.source(), Address('192.168.1.10'))

    def test_rewrite_preserves_payload_identity(self):
        payload = object()
        d = Datagram(Address('192.168.1.10'), Address('8.8.8.8'), payload)
        d.rewrite_source(Address('200.100.0.1'))
        self.assertIs(d.payload(), payload)


class InboundNATTest(unittest.TestCase):

    def _build_two_iface_router(self, priv, priv_net, pub, pub_net):
        """Build a router with one private and one public interface.

        Returns the router. The router has eth_priv on priv_net at priv,
        and eth_pub on pub_net at pub. Both networks have add_interface
        called. interface.send_to is replaced with a no-op stub that
        records into router._sent_list.
        """
        net_priv = Network('lan_priv', NetworkAddress(priv_net))
        net_pub = Network('lan_pub', NetworkAddress(pub_net))
        router = Router('r')
        iface_priv = Interface('eth_priv', net_priv, Address(priv))
        iface_pub = Interface('eth_pub', net_pub, Address(pub))
        router.add_interface(iface_priv)
        router.add_interface(iface_pub)
        net_priv.add_interface(iface_priv)
        net_pub.add_interface(iface_pub)

        table = router.routing_table()
        table.add_rule(
            prefix=net_priv.address(), next_hop=NullAddress, interface=iface_priv,
        )
        table.add_rule(
            prefix=net_pub.address(), next_hop=NullAddress, interface=iface_pub,
        )

        router._sent_list = []
        def capturing_send(pkt, dst_addr):
            router._sent_list.append((pkt, dst_addr))
        iface_priv.send_to = capturing_send
        iface_pub.send_to = capturing_send
        return router

    def test_inbound_reply_rewrites_destination_to_original_private(self):
        router = self._build_two_iface_router(
            priv='192.168.1.1', priv_net='192.168.1.0/24',
            pub='200.100.0.1', pub_net='200.100.0.0/24',
        )
        # Register what a prior outbound NAT would have left in the table.
        router.nat_table().register(
            rewritten_src=Address('200.100.0.1'),
            original_dst=Address('200.100.0.5'),
            flow_id=None,
            original_src=Address('192.168.1.10'),
        )
        reply = Datagram(
            src_addr=Address('200.100.0.5'),
            dst_addr=Address('200.100.0.1'),
            payload=UserMessage('hi'),
        )
        router.handle_packet(reply, router.interface('eth_pub'))

        # After reverse-translation + re-entry into _handle_forwarding,
        # the packet should leave on eth_priv addressed to the original host.
        self.assertTrue(len(router._sent_list) >= 1)
        out_pkt, out_dst = router._sent_list[-1]
        self.assertEqual(out_pkt.destination(), Address('192.168.1.10'))

    def test_inbound_to_router_with_no_nat_entry_falls_through(self):
        # No NAT entry registered. Packet addressed to router's public IP
        # must reach _handle_message (we capture by replacing it).
        router = self._build_two_iface_router(
            priv='192.168.1.1', priv_net='192.168.1.0/24',
            pub='200.100.0.1', pub_net='200.100.0.0/24',
        )
        msg_calls = []
        def stub_handle_message(msg, iface, packet):
            msg_calls.append((msg, iface, packet))
        router._handle_message = stub_handle_message

        pkt = Datagram(
            src_addr=Address('200.100.0.99'),
            dst_addr=Address('200.100.0.1'),
            payload=UserMessage('hello'),
        )
        router.handle_packet(pkt, router.interface('eth_pub'))
        self.assertEqual(len(msg_calls), 1)

    def test_inbound_on_private_interface_does_not_trigger_nat(self):
        # Even if a (rewritten_src, original_dst, flow_id) tuple happens
        # to match an entry, arrival on a private interface must skip
        # the NAT lookup entirely.
        router = self._build_two_iface_router(
            priv='192.168.1.1', priv_net='192.168.1.0/24',
            pub='200.100.0.1', pub_net='200.100.0.0/24',
        )
        router.nat_table().register(
            rewritten_src=Address('192.168.1.1'),
            original_dst=Address('192.168.1.50'),
            flow_id=None,
            original_src=Address('10.0.0.1'),
        )

        msg_calls = []
        def stub_handle_message(msg, iface, packet):
            msg_calls.append((msg, iface, packet))
        router._handle_message = stub_handle_message

        pkt = Datagram(
            src_addr=Address('192.168.1.50'),
            dst_addr=Address('192.168.1.1'),
            payload=UserMessage('internal'),
        )
        router.handle_packet(pkt, router.interface('eth_priv'))

        # Must NOT have been rewritten. Should have reached _handle_message.
        self.assertEqual(len(msg_calls), 1)
        self.assertEqual(pkt.destination(), Address('192.168.1.1'))


class InboundNATEventTest(unittest.TestCase):

    def setUp(self):
        self.events = []
        self._handler = lambda ev: self.events.append(ev)
        self._unsub = EventTracer.subscribe(self._handler)

    def tearDown(self):
        if callable(self._unsub):
            self._unsub()

    def test_inbound_nat_emits_nat_event(self):
        # Mirror InboundNATTest's _build_two_iface_router shape.
        net_priv = Network('lan_priv', NetworkAddress('192.168.1.0/24'))
        net_pub = Network('lan_pub', NetworkAddress('200.100.0.0/24'))
        router = Router('r')
        iface_priv = Interface('eth_priv', net_priv, Address('192.168.1.1'))
        iface_pub = Interface('eth_pub', net_pub, Address('200.100.0.1'))
        router.add_interface(iface_priv)
        router.add_interface(iface_pub)
        net_priv.add_interface(iface_priv)
        net_pub.add_interface(iface_pub)
        router.routing_table().add_rule(
            prefix=net_priv.address(), next_hop=NullAddress, interface=iface_priv,
        )
        router.routing_table().add_rule(
            prefix=net_pub.address(), next_hop=NullAddress, interface=iface_pub,
        )
        iface_priv.send_to = lambda pkt, dst_addr: None
        iface_pub.send_to = lambda pkt, dst_addr: None

        router.nat_table().register(
            rewritten_src=Address('200.100.0.1'),
            original_dst=Address('200.100.0.5'),
            flow_id=None,
            original_src=Address('192.168.1.10'),
        )

        reply = Datagram(
            src_addr=Address('200.100.0.5'),
            dst_addr=Address('200.100.0.1'),
            payload=UserMessage('hi'),
        )
        router.handle_packet(reply, router.interface('eth_pub'))

        inbound = [e for e in self.events
                   if e.get('kind') == 'nat' and e.get('direction') == 'inbound']
        self.assertEqual(len(inbound), 1)
        ev = inbound[0]
        self.assertEqual(ev['rewritten_dst'], '200.100.0.1')
        self.assertEqual(ev['original_dst'], '192.168.1.10')
        self.assertEqual(ev['src'], '200.100.0.5')
        self.assertEqual(ev['router'], router.name())
        self.assertIsNone(ev['flow_id'])
        self.assertIsInstance(ev['payload_id'], str)
        self.assertTrue(ev['payload_id'])
