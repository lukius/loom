import unittest
import threading
import queue

from entities import Interface, RoutingProtocol, Router, Network, NetworkAddress, Address, RoutingMessage


class MockThread(object):

    def start(self, *args, **kwargs):
        pass


class ProtocolTest(unittest.TestCase):

    def setUp(self):
        self._queue = queue.Queue()

        self._thread_class = threading.Thread
        threading.Thread = lambda *args, **kwargs: MockThread()

        self._interface_send_to = Interface.send_to
        Interface.send_to = lambda _self, pkt, dst_addr: self._queue.put((pkt, dst_addr))

    def tearDown(self):
        threading.Thread = self._thread_class
        Interface.send_to = self._interface_send_to

    def test_message_update(self):
        net1 = Network('lan1', NetworkAddress('200.200.10.0/24'))
        net2 = Network('lan2', NetworkAddress('100.100.0.0/24'))

        router = Router('r1')
        iface1 = Interface('eth0', net1, Address('200.200.10.1'), cost=10)
        iface2 = Interface('eth1', net2, Address('100.100.0.254'), cost=20)
        router.add_interface(iface1)
        router.add_interface(iface2)

        proto = RoutingProtocol(router)

        proto._handle_update(iface1)

        result = self._queue.get(timeout=0.1)
        self.assertIsNotNone(result)

        datagram, dst_addr = result
        self.assertEqual(dst_addr, '200.200.10.255')
        self.assertEqual(datagram.source(), '200.200.10.1')
        self.assertEqual(datagram.destination(), '200.200.10.255')

        msg = datagram.payload()
        self.assertEqual(RoutingMessage, msg.type())
        self.assertEqual(msg.seq(), 1)
        self.assertEqual(len(msg.destinations()), 1)
        self.assertEqual(msg.src_address(), '200.200.10.1')
        self.assertEqual(msg.src_router(), router)

        cost = msg.destinations().get(net2.address())
        self.assertIsNotNone(cost)
        self.assertEqual(cost, 20)

    def test_flooding_on_incoming_message(self):
        pass
