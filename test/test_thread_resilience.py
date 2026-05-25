import threading
import time
import unittest

from entities import (
    Address,
    Datagram,
    Interface,
    Network,
    NetworkAddress,
    Router,
    UserMessage,
)


def _wait(condition, timeout=2.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(interval)
    return False


class InterfaceThreadResilienceTest(unittest.TestCase):
    """Interface._pkt_loop must survive exceptions during handle_packet."""

    def setUp(self):
        self._net = Network("lan", NetworkAddress("10.0.0.0/24"))
        self._iface = Interface("eth0", self._net, Address("10.0.0.1"))
        self._net.add_interface(self._iface)

    def tearDown(self):
        self._net.stop()

    def test_thread_survives_handle_packet_exception(self):
        call_count = 0
        processed = threading.Event()

        class FaultyDevice:
            def handle_packet(self, packet, iface):
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    raise Exception("simulated crash")
                processed.set()

            def __eq__(self, other):
                return self is other

            def __hash__(self):
                return id(self)

        device = FaultyDevice()
        self._iface._set_device(device)

        src = Address("10.0.0.2")
        dst = Address("10.0.0.1")
        bad_frame = _make_frame(src, dst)
        good_frame = _make_frame(src, dst)

        self._iface._in_queue.put(bad_frame)
        self._iface._in_queue.put(good_frame)

        self.assertTrue(
            processed.wait(timeout=2.0), "thread died after first exception"
        )
        self.assertEqual(call_count, 2)


class NetworkThreadResilienceTest(unittest.TestCase):
    """Network._pkt_loop must survive exceptions during _dispatch_packet."""

    def setUp(self):
        self._net = Network("lan", NetworkAddress("10.0.0.0/24"))

    def tearDown(self):
        self._net.stop()

    def test_thread_survives_dispatch_exception(self):
        received = threading.Event()

        iface = Interface("eth0", self._net, Address("10.0.0.1"))
        self._net.add_interface(iface)

        class SimpleDevice:
            def handle_packet(self, packet, i):
                received.set()

            def __eq__(self, other):
                return self is other

            def __hash__(self):
                return id(self)

        device = SimpleDevice()
        iface._set_device(device)

        src = Address("10.0.0.99")

        bad_dst = Address("10.0.0.250")
        bad_frame = _make_frame(src, bad_dst)

        good_dst = Address("10.0.0.1")
        good_datagram = Datagram(
            src_addr=src, dst_addr=good_dst, payload=UserMessage("hi")
        )

        self._net._in_queue.put(bad_frame)
        self._net._in_queue.put(good_datagram)

        self.assertTrue(
            received.wait(timeout=2.0), "thread died after dispatch exception"
        )


class RoutingProtocolThreadResilienceTest(unittest.TestCase):
    """RoutingProtocol._protocol_loop must survive exceptions from dispatched actions.
    """

    def setUp(self):
        self._net = Network("lan", NetworkAddress("10.0.0.0/24"))
        self._iface = Interface("eth0", self._net, Address("10.0.0.1"))
        self._net.add_interface(self._iface)
        self._router = Router("r1")
        self._router.add_interface(self._iface)

    def tearDown(self):
        self._router.stop()
        self._net.stop()

    def test_thread_survives_dispatch_exception(self):
        from routing import Scheduler  # noqa: PLC0415  # test-only local import
        protocol = self._router.protocol()
        call_count = 0
        completed = threading.Event()

        original_emit_hello = protocol._emit_hello_on_all_interfaces

        def patched_emit_hello(now):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise Exception("simulated dispatch crash")
            original_emit_hello(now)
            completed.set()

        protocol._emit_hello_on_all_interfaces = patched_emit_hello
        # Use no-jitter scheduler with zero-interval to fire immediately.
        protocol._scheduler = Scheduler(jitter_range=(0.0, 0.0))
        protocol.set_timers(hello_interval=0.01, lsa_refresh_interval=0.05)
        protocol._protocol_thread = threading.Thread(
            target=protocol._protocol_loop, daemon=True
        )
        protocol._protocol_thread.start()

        self.assertTrue(
            completed.wait(timeout=2.0),
            "protocol thread died after exception",
        )
        self.assertGreaterEqual(call_count, 2)


def _make_frame(src, dst):
    from entities.packet import Datagram, Frame, UserMessage

    datagram = Datagram(src_addr=src, dst_addr=dst, payload=UserMessage("test"))
    return Frame(src_addr=src, dst_addr=dst, payload=datagram)
