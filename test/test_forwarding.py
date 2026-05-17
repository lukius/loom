import threading
import unittest

from entities import (
    Address,
    EventTracer,
    Host,
    Interface,
    Link,
    Network,
    NetworkAddress,
    NullAddress,
    Router,
    UserMessage,
)
from entities.packet import Datagram


class ForwardingTest(unittest.TestCase):

    def test_basic_forwarding(self):
        net1 = Network('lan1', NetworkAddress('200.200.10.0/24'))
        net2 = Network('lan2', NetworkAddress('100.100.0.0/24'))

        router = Router('r1')
        iface1 = Interface('eth0', net1, Address('200.200.10.1'))
        iface2 = Interface('eth1', net2, Address('100.100.0.254'))
        router.add_interface(iface1)
        router.add_interface(iface2)

        table = router.routing_table()
        table.add_rule(
            prefix=net1.address(),
            next_hop=NullAddress,
            interface=iface1
        )
        table.add_rule(
            prefix=net2.address(),
            next_hop=NullAddress,
            interface=iface2
        )

        host1 = Host('h1', net=net1, address=Address('200.200.10.10'), gw_address=iface1.address())  # noqa: E501 — long fixture line
        host2 = Host('h2', net=net2, address=Address('100.100.0.10'), gw_address=iface2.address())  # noqa: E501 — long fixture line

        net1.add_interface(iface1)
        net1.add_interface(host1.interface())
        net2.add_interface(iface2)
        net2.add_interface(host2.interface())

        msg_to_send = UserMessage(f'HELO {host2.name()}')

        on_sent_ev = threading.Event()

        def on_sent(src, dst, msg):
            self.assertEqual(src, host1.address())
            self.assertEqual(dst, host2.address())
            self.assertEqual(msg, msg_to_send)
            on_sent_ev.set()

        on_fwd_ev = threading.Event()

        def on_forwarded(src, dst, datagram):
            self.assertEqual(src, iface2.address())
            self.assertEqual(dst, host2.address())
            self.assertEqual(datagram.destination(), host2.address())
            on_fwd_ev.set()

        on_rcvd_ev = threading.Event()

        def on_received(src, msg):
            self.assertEqual(src, host2.address())
            self.assertEqual(msg, msg_to_send)
            on_rcvd_ev.set()

        event = EventTracer.register_message_event(
            msg_to_send,
            on_sent=on_sent,
            on_forwarded=on_forwarded,
            on_received=on_received
        )
        self.assertEqual(event.message(), msg_to_send)

        host1.send_message_to(msg_to_send, addr=host2.address())

        result = on_sent_ev.wait(timeout=0.5)
        self.assertTrue(result)

        result = on_fwd_ev.wait(timeout=0.5)
        self.assertTrue(result)

        result = on_rcvd_ev.wait(timeout=0.5)
        self.assertTrue(result)

    def test_local_peer_send_no_gateway(self):
        net = Network('lan1', NetworkAddress('10.0.0.0/24'))

        host1 = Host('h1', net=net, address=Address('10.0.0.1'))
        host2 = Host('h2', net=net, address=Address('10.0.0.2'))

        net.add_interface(host1.interface())
        net.add_interface(host2.interface())

        msg_to_send = UserMessage('hello')

        on_rcvd_ev = threading.Event()

        def on_received(src, msg):
            self.assertEqual(src, host2.address())
            self.assertEqual(msg, msg_to_send)
            on_rcvd_ev.set()

        EventTracer.register_message_event(
            msg_to_send,
            on_sent=lambda *args, **kwargs: None,
            on_forwarded=lambda *args, **kwargs: self.fail('unexpected forward'),
            on_received=on_received
        )

        host1.send_message_to(msg_to_send, addr=host2.address())

        result = on_rcvd_ev.wait(timeout=0.5)
        self.assertTrue(result)

    def test_off_network_send_no_gateway_raises(self):
        net1 = Network('lan1', NetworkAddress('10.0.0.0/24'))
        net2 = Network('lan2', NetworkAddress('192.168.1.0/24'))

        # host1 has no gateway configured
        host1 = Host('h1', net=net1, address=Address('10.0.0.1'))
        host2 = Host('h2', net=net2, address=Address('192.168.1.5'))

        net1.add_interface(host1.interface())
        net2.add_interface(host2.interface())

        msg_to_send = UserMessage('hello')

        with self.assertRaises(ValueError):
            host1.send_message_to(msg_to_send, addr=host2.address())

    def _build_three_router_chain(self, link_cidr, r1_link_addr, r2_link_addr):
        """Build r1—link—r2—lan_mid—r3 with hosts on r1's and r3's LANs.

        Returns (lan_r1, link, lan_mid, lan_r3, r1, r2, r3, h_src, h_dst).
        Routing tables are pre-filled manually.
        """
        lan_r1 = Network('lan_r1', NetworkAddress('10.0.1.0/24'))
        link = Link('p2p1', NetworkAddress(link_cidr))
        lan_mid = Network('lan_mid', NetworkAddress('10.0.2.0/24'))
        lan_r3 = Network('lan_r3', NetworkAddress('10.0.3.0/24'))

        r1 = Router('r1')
        r1_eth0 = Interface('eth0', lan_r1, Address('10.0.1.1'), cost=1)
        r1_eth1 = Interface('eth1', link, Address(r1_link_addr), cost=1)
        lan_r1.add_interface(r1_eth0)
        link.add_interface(r1_eth1)
        r1.add_interface(r1_eth0)
        r1.add_interface(r1_eth1)

        r2 = Router('r2')
        r2_eth0 = Interface('eth0', link, Address(r2_link_addr), cost=1)
        r2_eth1 = Interface('eth1', lan_mid, Address('10.0.2.1'), cost=1)
        link.add_interface(r2_eth0)
        lan_mid.add_interface(r2_eth1)
        r2.add_interface(r2_eth0)
        r2.add_interface(r2_eth1)

        r3 = Router('r3')
        r3_eth0 = Interface('eth0', lan_mid, Address('10.0.2.2'), cost=1)
        r3_eth1 = Interface('eth1', lan_r3, Address('10.0.3.1'), cost=1)
        lan_mid.add_interface(r3_eth0)
        lan_r3.add_interface(r3_eth1)
        r3.add_interface(r3_eth0)
        r3.add_interface(r3_eth1)

        h_src = Host('h_src', net=lan_r1, address=Address('10.0.1.10'),
                     gw_address=Address('10.0.1.1'))
        h_dst = Host('h_dst', net=lan_r3, address=Address('10.0.3.10'),
                     gw_address=Address('10.0.3.1'))
        lan_r1.add_interface(h_src.interface())
        lan_r3.add_interface(h_dst.interface())

        # Manually populate routing tables (protocol not running).
        link_prefix = NetworkAddress(link_cidr)
        r1_table = r1.routing_table()
        r1_table.add_rule(NetworkAddress('10.0.1.0/24'), NullAddress, r1_eth0)
        r1_table.add_rule(link_prefix, NullAddress, r1_eth1)
        r1_table.add_rule(NetworkAddress('10.0.2.0/24'), Address(r2_link_addr), r1_eth1)
        r1_table.add_rule(NetworkAddress('10.0.3.0/24'), Address(r2_link_addr), r1_eth1)

        r2_table = r2.routing_table()
        r2_table.add_rule(link_prefix, NullAddress, r2_eth0)
        r2_table.add_rule(NetworkAddress('10.0.2.0/24'), NullAddress, r2_eth1)
        r2_table.add_rule(NetworkAddress('10.0.1.0/24'), Address(r1_link_addr), r2_eth0)
        r2_table.add_rule(NetworkAddress('10.0.3.0/24'), Address('10.0.2.2'), r2_eth1)

        r3_table = r3.routing_table()
        r3_table.add_rule(NetworkAddress('10.0.2.0/24'), NullAddress, r3_eth0)
        r3_table.add_rule(NetworkAddress('10.0.3.0/24'), NullAddress, r3_eth1)
        r3_table.add_rule(NetworkAddress('10.0.1.0/24'), Address('10.0.2.1'), r3_eth0)
        r3_table.add_rule(link_prefix, Address('10.0.2.1'), r3_eth0)

        return lan_r1, link, lan_mid, lan_r3, r1, r2, r3, h_src, h_dst

    def _stop_chain(self, lan_r1, link, lan_mid, lan_r3, r1, r2, r3):
        r1.stop()
        r2.stop()
        r3.stop()
        lan_r1.stop()
        link.stop()
        lan_mid.stop()
        lan_r3.stop()

    def test_forward_through_p2p_slash30_link(self):
        """Datagrams forwarded from h_src through a /30 link arrive at h_dst.

        Chain: h_src → lan_r1 → r1 → p2p(/30) → r2 → lan_mid → r3 → lan_r3 → h_dst.
        TTL is decremented once at r1 (lan→link) and once at r2 (link→lan_mid)
        and once at r3 (lan_mid→lan_r3); forwarded datagram carries TTL=61 at r3.
        """
        lan_r1, link, lan_mid, lan_r3, r1, r2, r3, h_src, h_dst = (
            self._build_three_router_chain('10.0.0.0/30', '10.0.0.1', '10.0.0.2')
        )
        try:
            msg = UserMessage('ping_via_slash30')
            fwd_events = []
            on_fwd_ev = threading.Event()
            on_rcvd_ev = threading.Event()

            def on_forwarded(src, dst, datagram):
                fwd_events.append((str(src), str(dst), datagram.ttl()))
                # Signal on the last forward (r3 forwarding to h_dst).
                if str(dst) == str(h_dst.address()):
                    on_fwd_ev.set()

            def on_received(src, msg_rcvd):
                on_rcvd_ev.set()

            EventTracer.register_message_event(
                msg,
                on_sent=lambda *a, **kw: None,
                on_forwarded=on_forwarded,
                on_received=on_received,
            )

            h_src.send_message_to(msg, addr=h_dst.address())

            self.assertTrue(
                on_rcvd_ev.wait(timeout=1.0), "h_dst never received the message"
            )
            self.assertTrue(
                on_fwd_ev.wait(timeout=1.0), "last forward event never fired"
            )

            # Exactly three forward events (r1, r2, r3).
            self.assertEqual(len(fwd_events), 3)

            # TTL decrements: 64→63 at r1, 63→62 at r2, 62→61 at r3.
            ttls = [e[2] for e in fwd_events]
            self.assertEqual(ttls, [63, 62, 61])

            # The packet must ultimately be delivered to h_dst, not to a link
            # endpoint: verifies that the p2p link does not absorb the datagram.
            self.assertEqual(fwd_events[-1][1], str(h_dst.address()))
        finally:
            self._stop_chain(lan_r1, link, lan_mid, lan_r3, r1, r2, r3)

    def test_forward_through_p2p_slash31_link(self):
        """Same chain as the /30 test but using a /31 link (10.0.0.0/31)."""
        lan_r1, link, lan_mid, lan_r3, r1, r2, r3, h_src, h_dst = (
            self._build_three_router_chain('10.0.0.0/31', '10.0.0.0', '10.0.0.1')
        )
        try:
            msg = UserMessage('ping_via_slash31')
            fwd_events = []
            on_fwd_ev = threading.Event()
            on_rcvd_ev = threading.Event()

            def on_forwarded(src, dst, datagram):
                fwd_events.append((str(src), str(dst), datagram.ttl()))
                if str(dst) == str(h_dst.address()):
                    on_fwd_ev.set()

            def on_received(src, msg_rcvd):
                on_rcvd_ev.set()

            EventTracer.register_message_event(
                msg,
                on_sent=lambda *a, **kw: None,
                on_forwarded=on_forwarded,
                on_received=on_received,
            )

            h_src.send_message_to(msg, addr=h_dst.address())

            self.assertTrue(
                on_rcvd_ev.wait(timeout=1.0), "h_dst never received the message (/31)"
            )
            self.assertTrue(
                on_fwd_ev.wait(timeout=1.0), "last forward event never fired (/31)"
            )

            self.assertEqual(len(fwd_events), 3)
            ttls = [e[2] for e in fwd_events]
            self.assertEqual(ttls, [63, 62, 61])
        finally:
            self._stop_chain(lan_r1, link, lan_mid, lan_r3, r1, r2, r3)


def _outbound_setup(host_src, host_net, router_priv, router_pub, router_pub_net, dest):
    """Build a router with two interfaces and a Datagram ready for forwarding.

    Returns (router, public_iface, packet). The router has:
      - eth_in on host_net with address router_priv
      - eth_out on router_pub_net with address router_pub
    A routing-table rule for router_pub_net (directly connected) is installed.
    A packet from host_src to dest is created, ready to forward.

    interface.send_to is replaced with a no-op so the test doesn't enqueue
    onto any fabric. Restore via cleanup if needed.
    """
    net_in = Network('lan_in', NetworkAddress(host_net))
    net_out = Network('lan_out', NetworkAddress(router_pub_net))
    router = Router('r')
    iface_in = Interface('eth_in', net_in, Address(router_priv))
    iface_out = Interface('eth_out', net_out, Address(router_pub))
    router.add_interface(iface_in)
    router.add_interface(iface_out)
    net_in.add_interface(iface_in)
    net_out.add_interface(iface_out)

    table = router.routing_table()
    table.add_rule(prefix=net_in.address(), next_hop=NullAddress, interface=iface_in)
    table.add_rule(prefix=net_out.address(), next_hop=NullAddress, interface=iface_out)

    # No-op send so we don't actually enqueue.
    iface_in.send_to = lambda pkt, dst_addr: None
    iface_out.send_to = lambda pkt, dst_addr: None

    packet = Datagram(
        src_addr=Address(host_src), dst_addr=Address(dest),
        payload=UserMessage('hello'),
    )
    return router, iface_out, packet


class OutboundNATTest(unittest.TestCase):

    def test_private_to_public_rewrites_source(self):
        router, _, packet = _outbound_setup(
            host_src='192.168.1.10', host_net='192.168.1.0/24',
            router_priv='192.168.1.1', router_pub='200.100.0.1',
            router_pub_net='200.100.0.0/24', dest='200.100.0.5',
        )
        router._handle_forwarding(packet)
        self.assertEqual(packet.source(), Address('200.100.0.1'))
        self.assertEqual(
            router.nat_table().lookup(
                Address('200.100.0.1'), Address('200.100.0.5'), flow_id=None,
            ),
            Address('192.168.1.10'),
        )

    def test_private_to_private_does_not_rewrite(self):
        # eth_in 192.168.1.1/24 (private), eth_out 10.0.0.1/24 (also private).
        router, _, packet = _outbound_setup(
            host_src='192.168.1.10', host_net='192.168.1.0/24',
            router_priv='192.168.1.1', router_pub='10.0.0.1',
            router_pub_net='10.0.0.0/24', dest='10.0.0.20',
        )
        router._handle_forwarding(packet)
        self.assertEqual(packet.source(), Address('192.168.1.10'))
        self.assertIsNone(
            router.nat_table().lookup(
                Address('10.0.0.1'), Address('10.0.0.20'), flow_id=None,
            )
        )

    def test_public_source_never_rewritten(self):
        router, _, packet = _outbound_setup(
            host_src='8.8.8.8', host_net='200.100.0.0/24',
            router_priv='200.100.0.1', router_pub='198.51.100.1',
            router_pub_net='198.51.100.0/24', dest='198.51.100.50',
        )
        router._handle_forwarding(packet)
        self.assertEqual(packet.source(), Address('8.8.8.8'))

    def test_no_public_egress_raises_clear_error(self):
        # Router has only private interfaces. Private packet wants to leave.
        # No matching route exists; the error should mention NAT.
        net_in = Network('lan_in', NetworkAddress('192.168.1.0/24'))
        router = Router('r_priv_only')
        iface_in = Interface('eth_in', net_in, Address('192.168.1.1'))
        router.add_interface(iface_in)
        net_in.add_interface(iface_in)
        # Only the directly-connected rule, no public route.
        router.routing_table().add_rule(
            prefix=net_in.address(), next_hop=NullAddress, interface=iface_in,
        )
        iface_in.send_to = lambda pkt, dst_addr: None

        pkt = Datagram(
            src_addr=Address('192.168.1.10'),
            dst_addr=Address('8.8.8.8'),
            payload=UserMessage('hello'),
        )
        with self.assertRaises(Exception) as ctx:
            router._handle_forwarding(pkt)
        self.assertIn('NAT egress', str(ctx.exception))


class OutboundNATEventTest(unittest.TestCase):

    def setUp(self):
        self.events = []
        self._unsubscribe = EventTracer.subscribe(
            lambda ev: self.events.append(ev)
        )

    def tearDown(self):
        self._unsubscribe()

    def test_outbound_nat_emits_nat_event(self):
        router, _, packet = _outbound_setup(
            host_src='192.168.1.10', host_net='192.168.1.0/24',
            router_priv='192.168.1.1', router_pub='200.100.0.1',
            router_pub_net='200.100.0.0/24', dest='200.100.0.5',
        )
        router._handle_forwarding(packet)

        nat_events = [e for e in self.events if e.get('kind') == 'nat']
        self.assertEqual(len(nat_events), 1)
        ev = nat_events[0]
        self.assertEqual(ev['direction'], 'outbound')
        self.assertEqual(ev['original_src'], '192.168.1.10')
        self.assertEqual(ev['rewritten_src'], '200.100.0.1')
        self.assertEqual(ev['dst'], '200.100.0.5')
        self.assertEqual(ev['router'], router.name())
        self.assertIsNone(ev['flow_id'])

    def test_outbound_nat_emits_nat_table_changed_snapshot(self):
        router, _, packet = _outbound_setup(
            host_src='192.168.1.10', host_net='192.168.1.0/24',
            router_priv='192.168.1.1', router_pub='200.100.0.1',
            router_pub_net='200.100.0.0/24', dest='200.100.0.5',
        )
        router._handle_forwarding(packet)

        snaps = [e for e in self.events if e.get('kind') == 'nat_table_changed']
        self.assertEqual(len(snaps), 1)
        snap = snaps[0]
        self.assertEqual(snap['device'], router.name())
        self.assertEqual(snap['entries'], [{
            'rewritten_src': '200.100.0.1',
            'dst': '200.100.0.5',
            'flow_id': None,
            'original_src': '192.168.1.10',
        }])
