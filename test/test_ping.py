import os
import tempfile
import textwrap
import threading
import time

import pytest

from entities import Address, NetworkAddress
from entities.event import EventTracer
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
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan1: "10.0.0.0/24"
      hosts:
        h1: {network: lan1, address: "10.0.0.1"}
        h2: {network: lan1, address: "10.0.0.2"}
""")


def test_ping_happy_path():
    path = _make_topology(TWO_HOSTS)
    system = Parser(path).parse().single_as()
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
    system = Parser(path).parse().single_as()
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
    system = Parser(path).parse().single_as()
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
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
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
    system = Parser(path).parse().single_as()
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
    system = Parser(path).parse().single_as()
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
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
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
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
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
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
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
    system = Parser(path).parse().single_as()
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
    system = Parser(path).parse().single_as()
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
    system = Parser(path).parse().single_as()
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


# ---------------------------------------------------------------------------
# Multi-tenant NAT end-to-end test
# ---------------------------------------------------------------------------

MULTI_TENANT_NAT = textwrap.dedent("""
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan_a: "192.168.1.0/24"
        lan_b: "192.168.1.0/24"
        lan_isp: "200.100.0.0/24"
      links:
        p2p_a: "198.51.100.0/30"
        p2p_b: "198.51.100.4/30"
      hosts:
        h_a:
          network: lan_a
          address: "192.168.1.10"
          gateway: "192.168.1.1"
        h_b:
          network: lan_b
          address: "192.168.1.20"
          gateway: "192.168.1.1"
        h_pub:
          network: lan_isp
          address: "200.100.0.10"
          gateway: "200.100.0.1"
      routers:
        r_a:
          interfaces:
            eth0: {network: lan_a, address: "192.168.1.1", cost: 1}
            eth1: {link: p2p_a, address: "198.51.100.1", cost: 1}
        r_b:
          interfaces:
            eth0: {network: lan_b, address: "192.168.1.1", cost: 1}
            eth1: {link: p2p_b, address: "198.51.100.5", cost: 1}
        r_core:
          interfaces:
            eth0: {link: p2p_a, address: "198.51.100.2", cost: 1}
            eth1: {link: p2p_b, address: "198.51.100.6", cost: 1}
            eth2: {network: lan_isp, address: "200.100.0.1", cost: 1}
""")


def test_multi_tenant_nat_e2e():
    """Two tenants share 192.168.1.0/24 behind their own routers. Both
    reach a shared public destination through r_core; each tenant's NAT
    rewrites its source on the way out. Tenants cannot reach each other."""
    path = _make_topology(MULTI_TENANT_NAT)
    system = Parser(path).parse().single_as()
    try:
        h_a = system.host("h_a")
        h_b = system.host("h_b")
        h_pub = system.host("h_pub")

        # Wait for routing convergence: r_a and r_b should learn the public
        # LAN through r_core. (Public p2p links and lan_isp are advertised;
        # private LANs are not.)
        r_a = system.routers()["r_a"]
        r_b = system.routers()["r_b"]
        assert _wait(lambda: _table_has_prefix(r_a, "200.100.0.0/24"), timeout=5.0), \
            "r_a did not converge on public LAN"
        assert _wait(lambda: _table_has_prefix(r_b, "200.100.0.0/24"), timeout=5.0), \
            "r_b did not converge on public LAN"

        # Tenant A reaches the public host (NAT'd by r_a).
        rtt_a = h_a.ping(h_pub.address(), timeout=2.0)
        assert rtt_a is not None, "h_a -> h_pub ping failed (should be NAT'd via r_a)"
        assert rtt_a < 1.0

        # Tenant B reaches the public host (NAT'd by r_b).
        rtt_b = h_b.ping(h_pub.address(), timeout=2.0)
        assert rtt_b is not None, "h_b -> h_pub ping failed (should be NAT'd via r_b)"
        assert rtt_b < 1.0

        # Cross-tenant: h_a cannot reach h_b. h_a sends to 192.168.1.20
        # which it sees as same-LAN delivery (lan_a doesn't have 192.168.1.20).
        # The reply never arrives.
        rtt_cross = h_a.ping(h_b.address(), timeout=0.3)
        assert rtt_cross is None, "h_a should NOT reach h_b's address (CIDRs overlap)"
    finally:
        system.stop()
        os.unlink(path)


def test_nat_ping_packet_events_share_one_flow():
    """All packet events for one ping across NAT must share one flow key.

    `flow` identifies the end-to-end conversation. A single ping — request
    and reply, on both sides of a NAT boundary — is one conversation, so
    every emitted `packet` event must carry the same `flow` even when NAT
    rewrites the visible src/dst mid-path.
    """
    path = _make_topology(MULTI_TENANT_NAT)
    events = []
    system = Parser(path).parse().single_as()
    EventTracer.subscribe(events.append)
    try:
        h_a = system.host("h_a")
        h_pub = system.host("h_pub")
        r_a = system.routers()["r_a"]
        r_b = system.routers()["r_b"]
        assert _wait(lambda: _table_has_prefix(r_a, "200.100.0.0/24"), timeout=5.0)
        assert _wait(lambda: _table_has_prefix(r_b, "200.100.0.0/24"), timeout=5.0)

        # Clear out the routing-convergence chatter; we only want this ping's events.
        events.clear()
        rtt = h_a.ping(h_pub.address(), timeout=2.0)
        assert rtt is not None, "h_a -> h_pub ping failed (NAT path)"

        ping_kinds = ("ping_request", "ping_reply")
        ping_packet_events = [
            e for e in events
            if e.get("kind") == "packet" and e.get("type") in ping_kinds
        ]
        assert len(ping_packet_events) >= 6, (
            f"expected at least 6 hops (3 request + 3 reply), "
            f"got {len(ping_packet_events)}: {ping_packet_events}"
        )
        flows = {e.get("flow") for e in ping_packet_events}
        assert len(flows) == 1, (
            f"all hops of one ping should share a flow; "
            f"got {len(flows)} flows: {flows}"
        )
    finally:
        system.stop()
        os.unlink(path)


def test_two_private_hosts_keep_distinct_nat_entries_for_same_destination():
    """Two hosts on the same private LAN pinging the same public destination
    must each occupy their own NAT entry on the gateway router. The two
    `PingRequest`s collide on `seq` (both start at 0 for fresh hosts), so
    the NAT flow_id cannot be derived from `seq` alone — that would let the
    second registration overwrite the first and the first host would lose
    its reverse mapping.
    """
    topology = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan_priv: "192.168.1.0/24"
            lan_pub: "200.100.0.0/24"
          links:
            uplink: "198.51.100.0/30"
          hosts:
            h_x: {network: lan_priv, address: "192.168.1.10", gateway: "192.168.1.1"}
            h_y: {network: lan_priv, address: "192.168.1.20", gateway: "192.168.1.1"}
            h_pub: {network: lan_pub, address: "200.100.0.10", gateway: "200.100.0.1"}
          routers:
            r_nat:
              interfaces:
                eth0: {network: lan_priv, address: "192.168.1.1", cost: 1}
                eth1: {link: uplink, address: "198.51.100.1", cost: 1}
            r_pub:
              interfaces:
                eth0: {link: uplink, address: "198.51.100.2", cost: 1}
                eth1: {network: lan_pub, address: "200.100.0.1", cost: 1}
    """)
    path = _make_topology(topology)
    system = Parser(path).parse().single_as()
    try:
        h_x = system.host("h_x")
        h_y = system.host("h_y")
        h_pub = system.host("h_pub")
        r_nat = system.routers()["r_nat"]
        assert _wait(lambda: _table_has_prefix(r_nat, "200.100.0.0/24"), timeout=5.0)
        rtt_x = h_x.ping(h_pub.address(), timeout=2.0)
        rtt_y = h_y.ping(h_pub.address(), timeout=2.0)
        assert rtt_x is not None, "h_x → h_pub ping failed"
        assert rtt_y is not None, "h_y → h_pub ping failed"
        snap = r_nat.nat_table().snapshot()
        original_srcs = {e['original_src'] for e in snap}
        assert original_srcs == {'192.168.1.10', '192.168.1.20'}, (
            f"NAT table should hold one entry per private host; got: {snap}"
        )
    finally:
        system.stop()
        os.unlink(path)


_TWO_HOPS_TO_R1 = textwrap.dedent("""
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan1: "10.0.0.0/24"
        lan2: "192.168.0.0/24"
      hosts:
        h1: {network: lan1, address: "10.0.0.10", gateway: "10.0.0.1"}
      routers:
        r1:
          interfaces:
            eth0: {network: lan1, address: "10.0.0.1", cost: 1}
            eth1: {network: lan2, address: "192.168.0.1", cost: 1}
""")


def test_ping_router_on_its_inbound_interface():
    """Pinging the IP of the router's own LAN-facing interface succeeds.

    This worked before: dst matches the receiving interface's address, so
    Device.handle_packet routed the packet into _handle_message — and the
    router used to silently drop it. After the fix, the router replies.
    """
    path = _make_topology(_TWO_HOPS_TO_R1)
    system = Parser(path).parse().single_as()
    try:
        h1 = system.host("h1")
        rtt = h1.ping(Address("10.0.0.1"), timeout=2.0)
        assert rtt is not None, "router did not reply to ping on its inbound interface"
    finally:
        system.stop()
        os.unlink(path)


def test_ping_router_on_its_far_side_interface():
    """Pinging an IP that lives on the router's *other* interface succeeds.

    Regression: r1.eth0 receives a packet whose dst is r1.eth1's address.
    Before the fix, Device.handle_packet only compared dst with the
    receiving iface; dst didn't match, so the packet was forwarded into
    the routing table — back out the same path it came in, eventually
    looping until TTL expired and the ping timed out.
    """
    path = _make_topology(_TWO_HOPS_TO_R1)
    system = Parser(path).parse().single_as()
    try:
        h1 = system.host("h1")
        r1 = system.router("r1")
        far_addr = r1.interfaces()["eth1"].address()
        rtt = h1.ping(far_addr, timeout=2.0)
        assert rtt is not None, (
            "router did not reply to a ping for its far-side interface "
            "(forwarded instead of intercepted)"
        )
    finally:
        system.stop()
        os.unlink(path)


def test_router_ping_intercept_emits_event():
    """A router answering an ICMP echo on its own address fires a
    `router_intercept` tracer event so subscribers (the SPA, observers,
    tests) can annotate the duplicate-IP-aware behaviour."""
    intercepts = []

    def on_evt(evt):
        if evt.get("kind") == "router_intercept":
            intercepts.append(evt)

    path = _make_topology(_TWO_HOPS_TO_R1)
    system = Parser(path).parse().single_as()
    unsub = EventTracer.subscribe(on_evt)
    try:
        h1 = system.host("h1")
        rtt = h1.ping(Address("192.168.0.1"), timeout=2.0)
        assert rtt is not None
        # The intercept event should carry the router name + the source host
        # so the SPA tooltip can render "Replied by router r1".
        assert intercepts, "no router_intercept event was emitted"
        evt = intercepts[-1]
        assert evt.get("router") == "r1"
        assert evt.get("originator") == "10.0.0.10"  # h1
    finally:
        unsub()
        system.stop()
        os.unlink(path)
