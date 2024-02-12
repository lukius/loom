import unittest
import threading

from entities import\
    Network, NetworkAddress, Address, Host, Router, \
    UserMessage, Interface, NullAddress, \
    EventTracer


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

        host1 = Host('h1', net=net1, address=Address('200.200.10.10'), gw_address=iface1.address())
        host2 = Host('h2', net=net2, address=Address('100.100.0.10'), gw_address=iface2.address())

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