import threading
import time
import unittest

from entities import (
    AS,
    Address,
    Datagram,
    Frame,
    Host,
    Interface,
    Link,
    Network,
    NetworkAddress,
    Router,
    UserMessage,
)
from routing import Scheduler


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
        # jitter-audit: exactly 2 frames enqueued; count is deterministic
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
        protocol = self._router.protocol()
        call_count = 0
        completed = threading.Event()

        original_emit_hello = protocol._emit_hello_on_up_interfaces

        def patched_emit_hello(now):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise Exception("simulated dispatch crash")
            original_emit_hello(now)
            completed.set()

        protocol._emit_hello_on_up_interfaces = patched_emit_hello
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
    datagram = Datagram(src_addr=src, dst_addr=dst, payload=UserMessage("test"))
    return Frame(src_addr=src, dst_addr=dst, payload=datagram)


def _collect_as_threads(autonomous_system):
    """Return all worker threads owned by an AS: fabric, interface, and protocol."""
    threads = []
    for fabric in list(autonomous_system.networks().values()) + list(
        autonomous_system.links().values()
    ):
        threads.append(fabric._pkt_thread)
    for device in list(autonomous_system.routers().values()) + list(
        autonomous_system.hosts().values()
    ):
        for iface in device.interfaces().values():
            threads.append(iface._pkt_thread)
        if isinstance(device, Router):
            for proto in device.protocols():
                pt = getattr(proto, '_protocol_thread', None)
                if pt is not None:
                    threads.append(pt)
    return threads


def _build_small_as():
    """Build a minimal AS: one network, one router with one interface, one host.

    Thread inventory created per AS:
      - net._pkt_thread        (Network fabric)
      - link._pkt_thread       (Link fabric)
      - r_iface._pkt_thread    (router eth0 on network)
      - r_link_iface._pkt_thread (router eth1 on link)
      - host.interface()._pkt_thread  (host iface on network)
      - router protocol._protocol_thread
    """
    net = Network("lan", NetworkAddress("10.0.1.0/24"))

    r_iface = Interface("eth0", net, Address("10.0.1.1"))
    net.add_interface(r_iface)
    router = Router("r1")
    router.add_interface(r_iface)

    host = Host("h1", net, Address("10.0.1.10"), gw_address=Address("10.0.1.1"))
    net.add_interface(host.interface())

    link = Link("p2p", NetworkAddress("192.168.0.0/30"))
    r_link_iface = Interface("eth1", link, Address("192.168.0.1"))
    link.add_interface(r_link_iface)
    router.add_interface(r_link_iface)

    as_ = AS("test-as")
    as_.add_network(net)
    as_.add_link(link)
    as_.add_router(router)
    as_.add_host(host)
    router.start()
    return as_


class StopJoinsAllThreadsTest(unittest.TestCase):
    """AS.stop() must fully join every worker thread (fabric, interface, protocol)."""

    def test_all_threads_dead_after_stop(self):
        """Collect all worker threads, call stop(), assert none are alive."""
        as_ = _build_small_as()

        # Allow threads a moment to start.
        time.sleep(0.05)

        threads = _collect_as_threads(as_)
        self.assertTrue(
            all(t.is_alive() for t in threads),
            "pre-condition: all threads should be alive before stop()",
        )

        as_.stop()

        dead = [not t.is_alive() for t in threads]
        self.assertTrue(
            all(dead),
            f"threads still alive after stop(): "
            f"{[t.name for t, d in zip(threads, dead) if not d]}",
        )

    def test_repeated_start_stop_does_not_leak_threads(self):
        """Multiple stop cycles leave no threads alive from previous runs."""
        for cycle in range(3):
            as_ = _build_small_as()
            time.sleep(0.05)
            threads = _collect_as_threads(as_)
            as_.stop()
            still_alive = [t for t in threads if t.is_alive()]
            self.assertEqual(
                still_alive,
                [],
                f"cycle {cycle}: threads still alive: {[t.name for t in still_alive]}",
            )
