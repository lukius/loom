"""Tests for Link — the point-to-point fabric.

Note: Frame uses .source() / .destination() (inherited from Packet),
not .src_addr().  All dispatch assertions use that API.
"""
import time
import unittest

from entities import (
    Address,
    Interface,
    Link,
    Network,
    NetworkAddress,
    Router,
    TooManyEndpointsException,
)
from entities.packet import Datagram, Frame, UserMessage

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _wait(condition, timeout=2.0, interval=0.01):
    """Poll *condition* until it returns True or *timeout* elapses."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(interval)
    return False


def _make_frame(src_addr, dst_addr):
    """Build a Frame whose payload is a UserMessage."""
    datagram = Datagram(src_addr=src_addr, dst_addr=dst_addr, payload=UserMessage("x"))
    return Frame(src_addr=src_addr, dst_addr=dst_addr, payload=datagram)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

class LinkConstructionTest(unittest.TestCase):
    """Test 1 — basic construction and attribute accessors."""

    def setUp(self):
        self.link = Link("p2p1", NetworkAddress("10.0.0.0/30"))

    def tearDown(self):
        self.link.stop()
        self.link.join()

    def test_name(self):
        self.assertEqual(self.link.name(), "p2p1")

    def test_address(self):
        self.assertEqual(self.link.address(), NetworkAddress("10.0.0.0/30"))

    def test_broadcast_address(self):
        self.assertEqual(self.link.broadcast_address(), Address("10.0.0.3"))

    def test_contains_address_inside(self):
        self.assertTrue(self.link.contains_address(Address("10.0.0.2")))

    def test_contains_address_outside(self):
        self.assertFalse(self.link.contains_address(Address("10.0.1.1")))


class LinkCidrEnforcementTest(unittest.TestCase):
    """Test 2 — CIDR mask validation."""

    def _try_create(self, cidr):
        link = Link("p", NetworkAddress(cidr))
        link.stop()
        link.join()
        return link

    def test_slash24_raises(self):
        with self.assertRaises(ValueError) as ctx:
            Link("p", NetworkAddress("10.0.0.0/24"))
        self.assertIn("/24", str(ctx.exception))

    def test_slash29_raises(self):
        with self.assertRaises(ValueError) as ctx:
            Link("p", NetworkAddress("10.0.0.0/29"))
        self.assertIn("/29", str(ctx.exception))

    def test_slash30_ok(self):
        link = self._try_create("10.0.0.0/30")
        self.assertIsNotNone(link)

    def test_slash31_ok(self):
        link = self._try_create("10.0.1.0/31")
        self.assertIsNotNone(link)


class LinkAddInterfaceCapTest(unittest.TestCase):
    """Test 3 — add_interface caps at MAX_ENDPOINTS=2."""

    def setUp(self):
        self.link = Link("p2p1", NetworkAddress("10.0.0.0/30"))
        self.net = Network("dummy", NetworkAddress("10.0.0.0/30"))

        self.iface_a = Interface("eth0", self.net, Address("10.0.0.1"))
        self.iface_b = Interface("eth1", self.net, Address("10.0.0.2"))
        self.iface_c = Interface("eth2", self.net, Address("10.0.0.3"))

    def tearDown(self):
        self.link.stop()
        self.link.join()
        self.net.stop()

    def test_first_two_succeed(self):
        self.link.add_interface(self.iface_a)
        self.link.add_interface(self.iface_b)
        devices_ifaces = list(self.link._interfaces.values())
        self.assertIn(self.iface_a, devices_ifaces)
        self.assertIn(self.iface_b, devices_ifaces)

    def test_third_raises_too_many_endpoints(self):
        self.link.add_interface(self.iface_a)
        self.link.add_interface(self.iface_b)
        with self.assertRaises(TooManyEndpointsException) as ctx:
            self.link.add_interface(self.iface_c)
        msg = str(ctx.exception)
        self.assertIn("p2p1", msg)
        self.assertIn("eth2", msg)


class LinkPeerOfTest(unittest.TestCase):
    """Test 4 — peer_of lookup."""

    def setUp(self):
        self.link = Link("p2p1", NetworkAddress("10.0.0.0/30"))
        self.net = Network("dummy", NetworkAddress("10.0.0.0/30"))
        self.iface_a = Interface("eth0", self.net, Address("10.0.0.1"))
        self.iface_b = Interface("eth1", self.net, Address("10.0.0.2"))

    def tearDown(self):
        self.link.stop()
        self.link.join()
        self.net.stop()

    def test_peer_of_a_is_b(self):
        self.link.add_interface(self.iface_a)
        self.link.add_interface(self.iface_b)
        self.assertIs(self.link.peer_of(self.iface_a), self.iface_b)

    def test_peer_of_b_is_a(self):
        self.link.add_interface(self.iface_a)
        self.link.add_interface(self.iface_b)
        self.assertIs(self.link.peer_of(self.iface_b), self.iface_a)

    def test_peer_of_with_one_endpoint_returns_none(self):
        self.link.add_interface(self.iface_a)
        self.assertIsNone(self.link.peer_of(self.iface_a))

    def test_peer_of_with_zero_endpoints_returns_none(self):
        # iface not attached at all — should return None, not raise
        self.assertIsNone(self.link.peer_of(self.iface_a))


def _track_receive(iface):
    """Patch iface.receive() to record deliveries; return the list."""
    delivered = []
    original = iface.receive

    def tracked(frame):
        delivered.append(frame)
        original(frame)

    iface.receive = tracked
    return delivered


class LinkDispatch30Test(unittest.TestCase):
    """Test 5 — dispatch on /30 link (broadcast dst = .3)."""

    def setUp(self):
        self.link = Link("p2p1", NetworkAddress("10.0.0.0/30"))
        self.r1 = Router("r1")
        self.r2 = Router("r2")

        self.iface_a = Interface("eth0", self.link, Address("10.0.0.1"))
        self.iface_b = Interface("eth1", self.link, Address("10.0.0.2"))

        self.link.add_interface(self.iface_a)
        self.link.add_interface(self.iface_b)

        self.r1.add_interface(self.iface_a)
        self.r2.add_interface(self.iface_b)

    def tearDown(self):
        self.link.stop()
        self.link.join()

    def test_frame_from_a_to_broadcast_reaches_b_only(self):
        a_delivered = _track_receive(self.iface_a)
        b_delivered = _track_receive(self.iface_b)

        src = Address("10.0.0.1")
        dst = Address("10.0.0.3")  # /30 broadcast
        frame = _make_frame(src, dst)

        self.link._in_queue.put(frame)

        self.assertTrue(
            _wait(lambda: len(b_delivered) > 0),
            "iface_b never received the frame",
        )
        self.assertEqual(len(a_delivered), 0, "iface_a should NOT echo")


class LinkDispatch31Test(unittest.TestCase):
    """Test 6 — dispatch on /31 link (dst = peer IP)."""

    def setUp(self):
        self.link = Link("p2p2", NetworkAddress("10.0.1.0/31"))
        self.r1 = Router("r1")
        self.r2 = Router("r2")

        self.iface_a = Interface("eth0", self.link, Address("10.0.1.0"))
        self.iface_b = Interface("eth1", self.link, Address("10.0.1.1"))

        self.link.add_interface(self.iface_a)
        self.link.add_interface(self.iface_b)

        self.r1.add_interface(self.iface_a)
        self.r2.add_interface(self.iface_b)

    def tearDown(self):
        self.link.stop()
        self.link.join()

    def test_frame_from_a_to_b_reaches_b_only(self):
        a_delivered = _track_receive(self.iface_a)
        b_delivered = _track_receive(self.iface_b)

        src = Address("10.0.1.0")
        dst = Address("10.0.1.1")  # peer IP (also /31 "broadcast")
        frame = _make_frame(src, dst)

        self.link._in_queue.put(frame)

        self.assertTrue(
            _wait(lambda: len(b_delivered) > 0),
            "iface_b never received the frame",
        )
        self.assertEqual(len(a_delivered), 0, "iface_a should NOT echo")


class LinkDispatchUnicastTest(unittest.TestCase):
    """Test 7 — unicast dispatch: frame from B to A reaches A only."""

    def setUp(self):
        self.link = Link("p2p1", NetworkAddress("10.0.0.0/30"))
        self.r1 = Router("r1")
        self.r2 = Router("r2")

        self.iface_a = Interface("eth0", self.link, Address("10.0.0.1"))
        self.iface_b = Interface("eth1", self.link, Address("10.0.0.2"))

        self.link.add_interface(self.iface_a)
        self.link.add_interface(self.iface_b)

        self.r1.add_interface(self.iface_a)
        self.r2.add_interface(self.iface_b)

    def tearDown(self):
        self.link.stop()
        self.link.join()

    def test_frame_from_b_to_a_reaches_a_only(self):
        a_delivered = _track_receive(self.iface_a)
        b_delivered = _track_receive(self.iface_b)

        src = Address("10.0.0.2")
        dst = Address("10.0.0.1")
        frame = _make_frame(src, dst)

        self.link._in_queue.put(frame)

        self.assertTrue(
            _wait(lambda: len(a_delivered) > 0),
            "iface_a never received the frame",
        )
        self.assertEqual(len(b_delivered), 0, "iface_b should NOT receive")


class LinkStopJoinTest(unittest.TestCase):
    """Test 8 — stop/join lifecycle."""

    def test_stop_and_join(self):
        link = Link("p2p1", NetworkAddress("10.0.0.0/30"))
        self.assertTrue(link._pkt_thread.is_alive())
        link.stop()
        link.join()
        self.assertFalse(link._pkt_thread.is_alive())


class LinkHasDeviceTest(unittest.TestCase):
    """Test 9 — has_device / devices with two distinct devices."""

    def setUp(self):
        self.link = Link("p2p1", NetworkAddress("10.0.0.0/30"))
        self.r1 = Router("r1")
        self.r2 = Router("r2")
        self.r_other = Router("r_other")

        self.iface_a = Interface("eth0", self.link, Address("10.0.0.1"))
        self.iface_b = Interface("eth1", self.link, Address("10.0.0.2"))

        self.link.add_interface(self.iface_a)
        self.link.add_interface(self.iface_b)

        self.r1.add_interface(self.iface_a)
        self.r2.add_interface(self.iface_b)

    def tearDown(self):
        self.link.stop()
        self.link.join()

    def test_devices_keyed_by_name(self):
        devices = self.link.devices()
        self.assertIn("r1", devices)
        self.assertIn("r2", devices)

    def test_has_device_true_for_attached(self):
        self.assertTrue(self.link.has_device(self.r1))
        self.assertTrue(self.link.has_device(self.r2))

    def test_has_device_false_for_unattached(self):
        self.assertFalse(self.link.has_device(self.r_other))


class LinkSelfDispatchGuardTest(unittest.TestCase):
    """Test 10 — frame is dropped (not echoed) when only one endpoint exists."""

    def setUp(self):
        self.link = Link("p2p1", NetworkAddress("10.0.0.0/30"))
        self.r1 = Router("r1")

        self.iface_a = Interface("eth0", self.link, Address("10.0.0.1"))
        self.link.add_interface(self.iface_a)
        self.r1.add_interface(self.iface_a)

    def tearDown(self):
        self.link.stop()
        self.link.join()

    def test_lone_endpoint_frame_dropped_not_echoed(self):
        a_delivered = _track_receive(self.iface_a)

        src = Address("10.0.0.1")
        dst = Address("10.0.0.3")
        frame = _make_frame(src, dst)

        self.link._in_queue.put(frame)

        # Give dispatch thread time to process; iface_a must NOT receive the frame.
        self.assertFalse(
            _wait(lambda: len(a_delivered) > 0, timeout=0.5),
            "iface_a should NOT receive the frame (no echo to sender)",
        )


class NetworkUnlimitedEndpointsTest(unittest.TestCase):
    """Test 11 — Network.MAX_ENDPOINTS is None (inherited from _FabricBase), so
    more than two interfaces can be added without error."""

    def setUp(self):
        self.net = Network("lan", NetworkAddress("10.0.0.0/24"))

    def tearDown(self):
        self.net.stop()

    def test_network_admits_more_than_two_endpoints(self):
        """MAX_ENDPOINTS=None on Network means no cap — regression for the
        asymmetry once present between Link and Network capacity rules."""
        for i in range(5):
            iface = Interface(f"eth{i}", self.net, Address(f"10.0.0.{i + 1}"))
            self.net.add_interface(iface)
        self.assertEqual(len(self.net._interfaces), 5)
