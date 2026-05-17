import os
import tempfile
import textwrap
import threading
import time

import pytest

from entities import NetworkAddress
from parser import Parser


def _make_topology(yaml_text):
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml_text)
        return f.name


def _wait(condition, timeout=3.0, interval=0.02):
    """Poll *condition* until True or *timeout* elapses."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(interval)
    return False


def _table_has_prefix(router, prefix_str):
    """Return True when the router's table has a rule for prefix_str."""
    prefix = NetworkAddress(prefix_str)
    return any(r.prefix() == prefix for r in router.routing_table().rules())


TWO_HOSTS = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.0.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.0.1"}
    h2: {network: lan1, address: "10.0.0.2"}
""")


def test_ping_happy_path():
    path = _make_topology(TWO_HOSTS)
    system = Parser(path).parse()
    try:
        h1, h2 = system.host("h1"), system.host("h2")
        rtt = h1.ping(h2.address(), timeout=1.0)
        assert rtt is not None
        assert rtt < 0.5
    finally:
        system.stop()
        os.unlink(path)


def test_ping_unreachable_returns_none():
    path = _make_topology(TWO_HOSTS)
    system = Parser(path).parse()
    try:
        from entities import Address

        h1 = system.host("h1")
        # In-LAN address that no one answers (h1=10.0.0.1, h2=10.0.0.2).
        bogus = Address("10.0.0.99")
        t0 = time.monotonic()
        rtt = h1.ping(bogus, timeout=0.3)
        elapsed = time.monotonic() - t0
        assert rtt is None
        assert 0.3 <= elapsed < 0.7
    finally:
        system.stop()
        os.unlink(path)


def test_concurrent_pings_independent():
    path = _make_topology(TWO_HOSTS)
    system = Parser(path).parse()
    try:
        h1, h2 = system.host("h1"), system.host("h2")
        results = [None] * 5
        threads = []

        def go(i):
            results[i] = h1.ping(h2.address(), timeout=1.0)

        for i in range(5):
            t = threading.Thread(target=go, args=(i,), daemon=True)
            threads.append(t)
            t.start()
        for t in threads:
            t.join(timeout=2.0)
        assert all(r is not None for r in results)
    finally:
        system.stop()
        os.unlink(path)


TWO_LANS_NO_GATEWAY = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.0.0/24"
    lan2: "10.0.1.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.0.1"}
    h2: {network: lan2, address: "10.0.1.1"}
  routers:
    r1:
      interfaces:
        eth0: {network: lan1, address: "10.0.0.254", cost: 1}
        eth1: {network: lan2, address: "10.0.1.254", cost: 1}
""")


def test_ping_off_lan_with_no_gateway_raises():
    path = _make_topology(TWO_LANS_NO_GATEWAY)
    system = Parser(path).parse()
    try:
        h1 = system.host("h1")
        h2 = system.host("h2")
        with pytest.raises(ValueError, match="no gateway"):
            h1.ping(h2.address(), timeout=0.2)
    finally:
        system.stop()
        os.unlink(path)


def test_no_thread_leak_after_pings():
    path = _make_topology(TWO_HOSTS)
    before = {t.ident for t in threading.enumerate()}
    system = Parser(path).parse()
    try:
        h1, h2 = system.host("h1"), system.host("h2")
        for _ in range(10):
            h1.ping(h2.address(), timeout=0.5)
    finally:
        system.stop()
        os.unlink(path)
    time.sleep(0.2)
    after = {t.ident for t in threading.enumerate()}
    # only daemon threads from parser may remain; ping itself must not leak threads
    assert len(after - before) <= 0, f"thread leak: {after - before}"


# ---------------------------------------------------------------------------
# P2P link ping tests
# ---------------------------------------------------------------------------

H1_SLASH30_LINK = textwrap.dedent("""
as:
  name: t
  networks:
    lan_h1: "200.100.1.0/24"
    lan_h2: "200.100.2.0/24"
  links:
    p2p1: "200.100.0.0/30"
  hosts:
    h1: {network: lan_h1, address: "200.100.1.10", gateway: "200.100.1.1"}
    h2: {network: lan_h2, address: "200.100.2.10", gateway: "200.100.2.1"}
  routers:
    r1:
      interfaces:
        eth0: {network: lan_h1, address: "200.100.1.1", cost: 1}
        eth1: {link: p2p1, address: "200.100.0.1", cost: 1}
    r2:
      interfaces:
        eth0: {link: p2p1, address: "200.100.0.2", cost: 1}
        eth1: {network: lan_h2, address: "200.100.2.1", cost: 1}
""")

H1_SLASH31_LINK = textwrap.dedent("""
as:
  name: t
  networks:
    lan_h1: "200.100.1.0/24"
    lan_h2: "200.100.2.0/24"
  links:
    p2p1: "200.100.0.0/31"
  hosts:
    h1: {network: lan_h1, address: "200.100.1.10", gateway: "200.100.1.1"}
    h2: {network: lan_h2, address: "200.100.2.10", gateway: "200.100.2.1"}
  routers:
    r1:
      interfaces:
        eth0: {network: lan_h1, address: "200.100.1.1", cost: 1}
        eth1: {link: p2p1, address: "200.100.0.0", cost: 1}
    r2:
      interfaces:
        eth0: {link: p2p1, address: "200.100.0.1", cost: 1}
        eth1: {network: lan_h2, address: "200.100.2.1", cost: 1}
""")

HOST_ON_SLASH31_LINK = textwrap.dedent("""
as:
  name: t
  networks:
    lan_h2: "10.0.2.0/24"
  links:
    p2p1: "10.0.0.0/31"
  hosts:
    h1: {link: p2p1, address: "10.0.0.0"}
    h2: {network: lan_h2, address: "10.0.2.10", gateway: "10.0.2.1"}
  routers:
    r1:
      interfaces:
        eth0: {link: p2p1, address: "10.0.0.1", cost: 1}
        eth1: {network: lan_h2, address: "10.0.2.1", cost: 1}
""")


def test_ping_host_behind_p2p_slash30_link():
    """h1 pings h2 across a /30 p2p link; expect non-None RTT."""
    path = _make_topology(H1_SLASH30_LINK)
    system = Parser(path).parse()
    try:
        h1 = system.host("h1")
        h2 = system.host("h2")
        r1 = system.router("r1")
        r2 = system.router("r2")
        # Wait for full routing convergence before pinging.
        assert _wait(lambda: (
            _table_has_prefix(r1, "200.100.2.0/24")
            and _table_has_prefix(r2, "200.100.1.0/24")
        )), "routers did not converge before ping (/30)"
        rtt = h1.ping(h2.address(), timeout=3.0)
        assert rtt is not None, "ping across /30 link returned None (timeout)"
        assert rtt < 1.0
    finally:
        system.stop()
        os.unlink(path)


def test_ping_host_behind_p2p_slash31_link():
    """h1 pings h2 across a /31 p2p link; expect non-None RTT."""
    path = _make_topology(H1_SLASH31_LINK)
    system = Parser(path).parse()
    try:
        h1 = system.host("h1")
        h2 = system.host("h2")
        r1 = system.router("r1")
        r2 = system.router("r2")
        # Wait for full routing convergence before pinging.
        assert _wait(lambda: (
            _table_has_prefix(r1, "200.100.2.0/24")
            and _table_has_prefix(r2, "200.100.1.0/24")
        )), "routers did not converge before ping (/31)"
        rtt = h1.ping(h2.address(), timeout=3.0)
        assert rtt is not None, "ping across /31 link returned None (timeout)"
        assert rtt < 1.0
    finally:
        system.stop()
        os.unlink(path)


def test_ping_host_on_link():
    """h1 lives on a /31 link; h2 is on a LAN attached to r1.

    h1's gateway is auto-filled by the parser (peer = r1's link interface).
    h1 pings h2 (off-link, through the gateway); expect non-None RTT.
    """
    path = _make_topology(HOST_ON_SLASH31_LINK)
    system = Parser(path).parse()
    try:
        h1 = system.host("h1")
        h2 = system.host("h2")
        r1 = system.router("r1")
        # Wait for r1 to have a route to lan_h2 (it's directly connected,
        # so this should be available after the first keepalive tick).
        assert _wait(lambda: _table_has_prefix(r1, "10.0.2.0/24")), (
            "r1 did not populate its table before ping (host-on-link)"
        )
        rtt = h1.ping(h2.address(), timeout=3.0)
        assert rtt is not None, "ping from link-attached host returned None (timeout)"
        assert rtt < 1.0
    finally:
        system.stop()
        os.unlink(path)
