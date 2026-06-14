import queue
import unittest

from entities import Address, Host, Interface, Network, NetworkAddress, Router
from entities.event import EventTracer


class EntitiesTest(unittest.TestCase):

    def setUp(self):
        self._network1 = Network('lan1', NetworkAddress('192.168.1.0/24'))
        self._addr1_net1 = Address('192.168.1.15')
        self._addr2_net1 = Address('192.168.1.100')

        self._network2 = Network('lan2', NetworkAddress('192.168.10.0/24'))
        self._addr1_net2 = Address('192.168.10.25')

    def test_host(self):
        host = Host('host', self._network1, self._addr1_net1, self._addr2_net1)
        self.assertEqual(host.name(), 'host')
        self.assertEqual(host.address(), '192.168.1.15')
        self.assertEqual(host.network().name(), 'lan1')
        self.assertEqual(len(host.interfaces()), 1)
        self.assertEqual(host.interface().address(), '192.168.1.15')
        self.assertEqual(host.gateway(), '192.168.1.100')

    def test_interface(self):
        iface = Interface('iface', self._network1, self._addr1_net1)
        self.assertEqual(iface.name(), 'iface')
        self.assertEqual(iface.address(), '192.168.1.15')
        self.assertEqual(iface.network().name(), 'lan1')
        self.assertEqual(iface.cost(), 0)
        self.assertIsNone(iface.device())

    def test_router(self):
        router = Router('router')
        self.assertEqual(router.name(), 'router')

        iface1 = Interface('iface1', self._network1, self._addr1_net1)
        iface2 = Interface('iface2', self._network2, self._addr1_net2)
        router.add_interface(iface1)
        router.add_interface(iface2)

        self.assertEqual(len(router.interfaces()), 2)
        self.assertIn('iface1', router.interfaces())
        self.assertIn('iface2', router.interfaces())

        self.assertEqual(iface1.device(), router)
        self.assertEqual(iface2.device(), router)

    def test_network(self):
        self.assertEqual(len(self._network1.devices()), 0)
        self.assertEqual(len(self._network2.devices()), 0)

        self.assertTrue(self._network1.contains_address(self._addr1_net1))
        self.assertTrue(self._network1.contains_address(self._addr2_net1))
        self.assertFalse(self._network1.contains_address(self._addr1_net2))
        self.assertFalse(self._network2.contains_address(self._addr1_net1))
        self.assertFalse(self._network2.contains_address(self._addr2_net1))
        self.assertTrue(self._network2.contains_address(self._addr1_net2))

        host1 = Host('host1', self._network1, self._addr1_net1)
        host2 = Host('host2', self._network1, self._addr2_net1)
        self._network1.add_interface(host1.interface())
        self._network1.add_interface(host2.interface())

        self.assertTrue(self._network1.has_device(host1))
        self.assertTrue(self._network1.has_device(host2))
        self.assertFalse(self._network2.has_device(host1))
        self.assertFalse(self._network2.has_device(host2))

        self.assertEqual(len(self._network1.devices()), 2)
        self.assertEqual(len(self._network2.devices()), 0)

        self.assertIn('host1', self._network1.devices())
        self.assertIn('host2', self._network1.devices())


def _make_iface(name="eth0"):
    net = Network("lan", NetworkAddress("10.0.0.0/24"))
    return Interface(name, net, Address("10.0.0.1"))


def test_interface_defaults_to_up():
    iface = _make_iface()
    assert iface.is_up() is True


def test_disable_enable_toggles_is_up():
    iface = _make_iface()
    iface.disable()
    assert iface.is_up() is False
    iface.enable()
    assert iface.is_up() is True


def test_disable_enable_emit_interface_state_changed():
    iface = _make_iface()
    events = []
    unsub = EventTracer.subscribe(events.append)
    try:
        iface.disable()
        iface.enable()
    finally:
        unsub()
    kinds = [
        (e["kind"], e["up"]) for e in events if e["kind"] == "interface_state_changed"
    ]
    assert kinds == [
        ("interface_state_changed", False),
        ("interface_state_changed", True),
    ]
    assert events[0]["interface"] == "eth0"


def _router_one_iface():
    r = Router("r1")
    net = Network("lan", NetworkAddress("10.0.0.0/24"))
    iface = Interface("eth0", net, Address("10.0.0.1"), cost=1)
    iface._set_out_queue(queue.Queue())
    r.add_interface(iface)
    net.add_interface(iface)
    return r


def test_disable_interface_brings_iface_down(monkeypatch):
    r = _router_one_iface()
    calls = []
    monkeypatch.setattr(r.protocol(), "local_links_changed",
                        lambda: calls.append("llc"))
    r.disable_interface("eth0", graceful=True)
    assert r.interface("eth0").is_up() is False
    assert calls == ["llc"]


def test_disable_interface_crash_skips_reflood(monkeypatch):
    r = _router_one_iface()
    calls = []
    monkeypatch.setattr(r.protocol(), "local_links_changed",
                        lambda: calls.append("llc"))
    r.disable_interface("eth0", graceful=False)
    assert r.interface("eth0").is_up() is False
    assert calls == []


def test_enable_interface_brings_iface_up(monkeypatch):
    r = _router_one_iface()
    r.interface("eth0").disable()
    calls = []
    monkeypatch.setattr(r.protocol(), "announce", lambda: calls.append("ann"))
    r.enable_interface("eth0")
    assert r.interface("eth0").is_up() is True
    assert calls == ["ann"]


def test_halt_graceful_withdraws_then_downs_all(monkeypatch):
    r = _router_one_iface()
    order = []
    monkeypatch.setattr(r.protocol(), "withdraw", lambda: order.append("withdraw"))
    orig_disable = r.interface("eth0").disable
    monkeypatch.setattr(r.interface("eth0"), "disable",
                        lambda: (order.append("disable"), orig_disable())[1])
    events = []
    unsub = EventTracer.subscribe(events.append)
    try:
        r.halt(graceful=True)
    finally:
        unsub()
    assert order == ["withdraw", "disable"]   # withdraw BEFORE downing
    assert r.is_halted() is True
    assert r.interface("eth0").is_up() is False
    dev_events = [e for e in events if e["kind"] == "device_state_changed"]
    assert dev_events == [{"kind": "device_state_changed", "device": "r1", "up": False}]


def test_halt_crash_skips_withdraw(monkeypatch):
    r = _router_one_iface()
    calls = []
    monkeypatch.setattr(r.protocol(), "withdraw", lambda: calls.append("w"))
    r.halt(graceful=False)
    assert calls == []
    assert r.is_halted() is True
    assert r.interface("eth0").is_up() is False


def test_resume_enables_all_and_announces(monkeypatch):
    r = _router_one_iface()
    r.halt(graceful=False)
    calls = []
    monkeypatch.setattr(r.protocol(), "announce", lambda: calls.append("ann"))
    events = []
    unsub = EventTracer.subscribe(events.append)
    try:
        r.resume()
    finally:
        unsub()
    assert calls == ["ann"]
    assert r.is_halted() is False
    assert r.interface("eth0").is_up() is True
    assert {"kind": "device_state_changed", "device": "r1", "up": True} in events


def test_fabric_remove_interface():
    net = Network("lan", NetworkAddress("10.0.0.0/24"))
    iface = Interface("eth0", net, Address("10.0.0.1"))
    net.add_interface(iface)
    assert net.endpoint_count() == 1
    net.remove_interface(iface.address())
    assert net.endpoint_count() == 0


def test_fabric_remove_interface_missing_is_noop():
    net = Network("lan", NetworkAddress("10.0.0.0/24"))
    net.remove_interface(Address("10.0.0.9"))  # should not raise
    assert net.endpoint_count() == 0


# ------------------------------------------------------ Network.is_valid_host_address


def test_network_is_valid_host_address_normal_host():
    net = Network("lan", NetworkAddress("192.168.1.0/24"))
    assert net.is_valid_host_address(Address("192.168.1.10")) is True


def test_network_is_valid_host_address_rejects_network_address():
    net = Network("lan", NetworkAddress("192.168.1.0/24"))
    # .0 is the network address — must be rejected
    assert net.is_valid_host_address(Address("192.168.1.0")) is False


def test_network_is_valid_host_address_rejects_broadcast_address():
    net = Network("lan", NetworkAddress("192.168.1.0/24"))
    # .255 is the broadcast address — must be rejected
    assert net.is_valid_host_address(Address("192.168.1.255")) is False


def test_network_is_valid_host_address_rejects_outside_cidr():
    net = Network("lan", NetworkAddress("192.168.1.0/24"))
    assert net.is_valid_host_address(Address("10.0.0.1")) is False


def test_network_is_valid_host_address_slash16():
    net = Network("wan", NetworkAddress("10.10.0.0/16"))
    assert net.is_valid_host_address(Address("10.10.1.1")) is True
    assert net.is_valid_host_address(Address("10.10.0.0")) is False   # network
    assert net.is_valid_host_address(Address("10.10.255.255")) is False  # broadcast


def test_network_is_valid_host_address_noncanonical_network_address():
    # Regression: non-canonical spelling of the network address (leading zero in
    # last octet) must still be rejected.  Address.__str__ returns the raw input
    # string, so a raw-string comparison would see '100.100.100.000' != '100.100.100.0'
    # and wrongly return True.  The fix must compare by octets (Address.__eq__).
    net = Network("lan", NetworkAddress("100.100.100.0/24"))
    assert net.is_valid_host_address(Address("100.100.100.000")) is False


def test_network_is_valid_host_address_noncanonical_broadcast_address():
    # Regression: non-canonical spelling of the broadcast address must also be
    # rejected — same root cause as the network-address case above.
    net = Network("lan", NetworkAddress("100.100.100.0/24"))
    # Canonical broadcast is 100.100.100.255; spell it with a leading zero.
    assert net.is_valid_host_address(Address("100.100.100.0255")) is False
