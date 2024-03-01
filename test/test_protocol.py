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
        net1 = Network('lan1', NetworkAddress('200.200.10.0/24'))
        net2 = Network('lan2', NetworkAddress('100.100.0.0/24'))
        net3 = Network('lan3', NetworkAddress('10.10.10.0/24'))

        r1 = Router('r1')
        iface1 = Interface('eth0', net1, Address('200.200.10.1'), cost=10)
        iface2 = Interface('eth1', net2, Address('100.100.0.254'), cost=20)
        iface3 = Interface('eth2', net3, Address('10.10.10.2'), cost=1)
        r1.add_interface(iface1)
        r1.add_interface(iface2)
        r1.add_interface(iface3)

        r2 = Router('r2')
        iface4 = Interface('eth0', net2, Address('100.100.0.1'), cost=15)
        iface5 = Interface('eth1', net3, Address('10.10.10.1'), cost=5)
        r2.add_interface(iface4)
        r2.add_interface(iface5)

        msg = RoutingMessage(src=iface4, seq=1)
        msg.add_destination(prefix=net2.address(), cost=iface4.cost())
        msg.add_destination(prefix=net3.address(), cost=iface5.cost())

        proto = RoutingProtocol(r1)
        proto.handle_incoming_message(msg, iface2)

        datagram1, dst_addr1 = self._queue.get(timeout=0.1)
        self.assertIn(dst_addr1, [net1.broadcast_address(), net3.broadcast_address()])
        payload1 = datagram1.payload()
        self.assertEqual(payload1.src_address(), iface4.address())
        self.assertEqual(payload1.src_router(), r2)
        self.assertEqual(payload1.seq(), 1)
        dests1 = payload1.destinations()
        self.assertEqual(len(dests1), 2)
        self.assertEqual(dests1.get(net2.address(), 0), iface4.cost())
        self.assertEqual(dests1.get(net3.address(), 0), iface5.cost())

        datagram2, dst_addr2 = self._queue.get(timeout=0.1)
        self.assertIn(dst_addr2, [net1.broadcast_address(), net3.broadcast_address()])
        self.assertNotEqual(dst_addr1, dst_addr2)
        payload2 = datagram2.payload()
        self.assertEqual(payload2.src_address(), iface4.address())
        self.assertEqual(payload2.src_router(), r2)
        self.assertEqual(payload2.seq(), 1)
        self.assertEqual(len(payload2.destinations()), 2)
        dests2 = payload2.destinations()
        self.assertEqual(len(dests2), 2)
        self.assertEqual(dests2.get(net2.address(), 0), iface4.cost())
        self.assertEqual(dests2.get(net3.address(), 0), iface5.cost())

        with self.assertRaises(queue.Empty):
            self._queue.get(timeout=0.1)