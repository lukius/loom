"""Integration test: reroute mid-topology after a graceful interface disable.

Topology: triangle of R1, R2, R3.
- R1 and R3 share a direct /30 p2p link (low cost=1) — R1 prefers this path.
- R1 and R2 share a LAN (cost=5 each side).
- R2 and R3 share a LAN (cost=5 each side).
- A destination LAN hangs off R3 (cost=1 on R3's side).

OSPF pseudonode cost model (subnet→router edges are free):
  Direct:   R1→link(1) + link→R3(0) + R3→dst_lan(1) = 2
  Indirect: R1→lan12(5) + lan12→R2(0) + R2→lan23(5) + lan23→R3(0) + R3→dst_lan(1) = 11

After R1 disables its direct-link interface (graceful), it must reconverge
and route to the destination prefix via R2 instead.
"""

import os
import tempfile
import textwrap
import time

from entities import Address, NetworkAddress
from parser import Parser

TRIANGLE_TOPOLOGY = textwrap.dedent("""
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan_r1_r2: "200.0.1.0/24"
        lan_r2_r3: "200.0.2.0/24"
        lan_dst:   "200.0.3.0/24"
      links:
        direct_r1_r3: "200.0.0.0/30"
      routers:
        r1:
          interfaces:
            eth0: {link: direct_r1_r3, address: "200.0.0.1", cost: 1}
            eth1: {network: lan_r1_r2,  address: "200.0.1.1", cost: 5}
        r2:
          interfaces:
            eth0: {network: lan_r1_r2,  address: "200.0.1.2", cost: 5}
            eth1: {network: lan_r2_r3,  address: "200.0.2.1", cost: 5}
        r3:
          interfaces:
            eth0: {link: direct_r1_r3, address: "200.0.0.2", cost: 1}
            eth1: {network: lan_r2_r3,  address: "200.0.2.2", cost: 5}
            eth2: {network: lan_dst,    address: "200.0.3.1", cost: 1}
""")

# A sample host address inside the destination LAN.
_DST_ADDR = "200.0.3.100"

# Prefix strings for convergence checks.
_ALL_PREFIXES = [
    "200.0.0.0/30",
    "200.0.1.0/24",
    "200.0.2.0/24",
    "200.0.3.0/24",
]


def _wait(condition, timeout=5.0, interval=0.02):
    """Poll *condition* until True or *timeout* elapses; return True if met."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(interval)
    return False


def _table_has_prefix(router, prefix_str):
    prefix = NetworkAddress(prefix_str)
    return any(r.prefix() == prefix for r in router.routing_table().rules())


def test_reroute_after_interface_disable():
    """R1 initially routes to the destination LAN via its direct link to R3.
    After gracefully disabling that interface, R1 must reconverge and route
    via R2 instead — the egress interface changes from eth0 to eth1."""
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(TRIANGLE_TOPOLOGY)
        path = f.name

    system = Parser(path).parse(start_routing=False).single_as()
    for r in system.routers().values():
        r.protocol().set_timers(hello_interval=0.2, lsa_refresh_interval=0.6)
        r.start()

    try:
        r1 = system.routers()["r1"]
        r2 = system.routers()["r2"]
        r3 = system.routers()["r3"]

        # Step 1: Wait for full convergence — every router must have every prefix.
        assert _wait(
            lambda: all(
                _table_has_prefix(r, p)
                for r in [r1, r2, r3]
                for p in _ALL_PREFIXES
            ),
            timeout=5.0,
        ), "routers did not converge on all prefixes before disable"

        # Step 2: Record R1's next-hop and egress interface to the destination.
        dst_addr = Address(_DST_ADDR)
        before_result = r1.routing_table().match(dst_addr)
        assert before_result.is_matched(), "r1 has no route to dst before disable"
        before_iface = before_result.interface().name()

        # R1 should prefer the direct link (eth0) — cost 2 vs 11 via R2.
        assert before_iface == "eth0", (
            f"expected r1 to use direct link (eth0) before disable, "
            f"got {before_iface}"
        )

        # Step 3: Gracefully disable R1's direct-link interface.
        r1.disable_interface("eth0", graceful=True)

        # Step 4: Wait for R1 to reconverge with a different egress interface.
        def r1_rerouted():
            result = r1.routing_table().match(dst_addr)
            if not result.is_matched():
                return False
            return result.interface().name() != before_iface

        assert _wait(r1_rerouted, timeout=5.0), (
            "r1 did not reconverge to an alternative path after disable"
        )

        # Step 5: Assert the new route is via eth1 (toward R2).
        after_result = r1.routing_table().match(dst_addr)
        assert after_result.is_matched(), "r1 has no route to dst after disable"
        after_iface = after_result.interface().name()
        assert after_iface == "eth1", (
            f"expected r1 to reroute via eth1 (toward R2), got {after_iface}"
        )

        # The next-hop must also have changed (R1 now routes via R2's address).
        before_nh = str(before_result.next_hop())
        after_nh = str(after_result.next_hop())
        assert after_nh != before_nh, (
            f"next-hop did not change: still {after_nh}"
        )

    finally:
        system.stop()
        os.unlink(path)
