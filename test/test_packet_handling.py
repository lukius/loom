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
    Router,
    RoutingMessage,
    UserMessage,
)


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
