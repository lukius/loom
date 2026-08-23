import threading

from entities import Address, Interface, Link, Network, NetworkAddress, Router
from routing import LSA, LSDB, InstallResult
from routing.policy import RFC1918_OUTBOUND


class _PermitAll:
    def apply(self, prefix):
        class _D:
            def is_denied(self):
                return False

            def prefix(self):
                return prefix

        return _D()


# Routers advertising the same CIDR are meant to be on the same wire, so the
# Network object is shared across calls. The graph keys fabrics by identity:
# two Network objects are two LANs however alike their prefixes look.
_SHARED_NETS: dict = {}


def _net_for(cidr: str) -> Network:
    if cidr not in _SHARED_NETS:
        _SHARED_NETS[cidr] = Network(f"lan_{cidr}", NetworkAddress(cidr))
    return _SHARED_NETS[cidr]


def _router_with(net_addr_strs, costs, name="rx"):
    r = Router(name)
    for i, (cidr, c) in enumerate(zip(net_addr_strs, costs)):
        n = _net_for(cidr)
        ip = NetworkAddress(cidr).octets()
        ip[-1] = 1
        addr = Address(".".join(str(o) for o in ip))
        r.add_interface(Interface(f"eth{i}", n, addr, cost=c))
    return r


# ---------- InstallResult ----------


def test_install_result_accepted_truthy_and_carries_changed_graph():
    r = InstallResult.accepted(changed_graph=True)
    assert r.is_accepted() is True
    assert r.changed_graph() is True
    r = InstallResult.accepted(changed_graph=False)
    assert r.is_accepted() is True
    assert r.changed_graph() is False


def test_install_result_rejected():
    r = InstallResult.rejected()
    assert r.is_accepted() is False
    assert r.changed_graph() is False


# ---------- LSDB.install ----------


def test_install_new_origin_returns_accepted_changed_graph_true():
    local = Router("local")
    origin = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    lsa = LSA.from_router(origin, seq=1, policy=_PermitAll())
    result = lsdb.install(lsa, now=0.0)
    assert result.is_accepted() and result.changed_graph()
    assert lsdb.lsa_for(origin) is lsa


def test_install_older_seq_returns_rejected():
    local = Router("local")
    origin = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=5, policy=_PermitAll()), now=0.0)
    result = lsdb.install(LSA.from_router(origin, seq=3, policy=_PermitAll()), now=1.0)
    assert result.is_accepted() is False


def test_install_same_seq_returns_rejected():
    local = Router("local")
    origin = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=5, policy=_PermitAll()), now=0.0)
    result = lsdb.install(LSA.from_router(origin, seq=5, policy=_PermitAll()), now=1.0)
    assert result.is_accepted() is False


def test_install_newer_same_links_returns_accepted_changed_graph_false():
    """Refresh: newer seq but identical link content. Re-flood, don't recompute."""
    local = Router("local")
    origin = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=0.0)
    result = lsdb.install(LSA.from_router(origin, seq=2, policy=_PermitAll()), now=1.0)
    assert result.is_accepted() is True
    assert result.changed_graph() is False


def test_install_newer_different_links_returns_accepted_changed_graph_true():
    local = Router("local")
    origin_a = _router_with(["10.0.0.0/24"], [1])
    # Build two LSAs from the same router instance but with different links.
    lsa_a = LSA(origin=origin_a, seq=1)
    lsa_a.add_link(NetworkAddress("10.0.0.0/24"), 1)
    lsa_b = LSA(origin=origin_a, seq=2)
    lsa_b.add_link(NetworkAddress("10.0.0.0/24"), 1)
    lsa_b.add_link(NetworkAddress("10.0.1.0/24"), 1)

    lsdb = LSDB(local)
    lsdb.install(lsa_a, now=0.0)
    result = lsdb.install(lsa_b, now=1.0)
    assert result.is_accepted() and result.changed_graph()


# ---------- LSDB.purge ----------


def test_purge_removes_entry_returns_true():
    local = Router("local")
    origin = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=0.0)
    assert lsdb.purge(origin) is True
    assert lsdb.lsa_for(origin) is None


def test_purge_unknown_origin_returns_false():
    local = Router("local")
    ghost = Router("ghost")
    lsdb = LSDB(local)
    assert lsdb.purge(ghost) is False


# ---------- Withdrawal LSA path ----------


def test_withdrawal_install_purges_origin_and_returns_changed_graph_true():
    local = Router("local")
    origin = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=0.0)
    result = lsdb.install(LSA.withdrawal(origin, seq=2), now=1.0)
    assert result.is_accepted() and result.changed_graph()
    assert lsdb.lsa_for(origin) is None


def test_withdrawal_install_for_unknown_origin_is_accepted_but_no_change():
    local = Router("local")
    ghost = Router("ghost")
    lsdb = LSDB(local)
    result = lsdb.install(LSA.withdrawal(ghost, seq=1), now=0.0)
    assert result.is_accepted() and result.changed_graph() is False


# ---------- LSDB.expired_origins / age_of ----------


def test_age_of_returns_elapsed_since_install():
    local = Router("local")
    origin = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=100.0)
    assert lsdb.age_of(origin, now=100.0) == 0.0
    assert lsdb.age_of(origin, now=110.0) == 10.0


def test_expired_origins_returns_origins_past_max_age():
    local = Router("local")
    origin = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=0.0)
    assert lsdb.expired_origins(max_age=60.0, now=30.0) == []
    assert origin in lsdb.expired_origins(max_age=60.0, now=61.0)


def test_install_refreshes_installed_at():
    local = Router("local")
    origin = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=0.0)
    lsdb.install(LSA.from_router(origin, seq=2, policy=_PermitAll()), now=50.0)
    assert lsdb.age_of(origin, now=50.0) == 0.0


# ---------- LSDB.build_graph ----------


def test_build_graph_with_empty_eligible_set_contains_only_local_router():
    local = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    g = lsdb.build_graph(eligible_origins=set())
    assert local in g
    # Other origins absent.


def test_build_graph_with_eligible_origin_includes_its_links():
    local = _router_with(["10.0.0.0/24"], [1], name="local")
    remote = _router_with(["10.0.1.0/24", "10.0.2.0/24"], [1, 2], name="remote")
    lsdb = LSDB(local)
    # Install local's own LSA — always eligible.
    lsdb.install(LSA.from_router(local, seq=1, policy=_PermitAll()), now=0.0)
    lsdb.install(LSA.from_router(remote, seq=1, policy=_PermitAll()), now=0.0)
    g = lsdb.build_graph(eligible_origins={remote})
    assert remote in g
    assert NetworkAddress("10.0.1.0/24") in g
    assert NetworkAddress("10.0.2.0/24") in g
    # The router's cost lands on its edge into the fabric; the announced
    # prefix hangs off that fabric as a free destination leaf.
    assert g.weight(remote, _net_for("10.0.1.0/24")) == 1
    assert g.weight(remote, _net_for("10.0.2.0/24")) == 2
    assert g.weight(_net_for("10.0.1.0/24"), NetworkAddress("10.0.1.0/24")) == 0


def test_build_graph_uses_pseudonode_model_for_reverse_edges():
    """The reverse edge (subnet → router) must carry weight 0.

    OSPF interface costs are outgoing-only: '10' on iface eth0 means
    'sending a packet out of eth0 onto its subnet costs 10'. There is
    no corresponding incoming cost. OSPF models a multi-access network
    as a pseudonode that advertises zero-cost links back to every
    attached router — once a packet is on the wire, reaching any
    router attached to that wire is free.

    Without this, a single hop ROUTER → SUBNET → ROUTER would be
    double-counted (cost = router's outgoing + router's outgoing), and
    asymmetric link costs would behave incorrectly.
    """
    local = _router_with(["10.0.0.0/24"], [3], name="local")
    remote = _router_with(["10.0.0.0/24", "10.0.1.0/24"], [7, 2], name="remote")
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(local, seq=1, policy=_PermitAll()), now=0.0)
    lsdb.install(LSA.from_router(remote, seq=1, policy=_PermitAll()), now=0.0)
    g = lsdb.build_graph(eligible_origins={remote})

    shared = _net_for("10.0.0.0/24")
    # Outgoing (router → fabric) carries the router's own cost.
    assert g.weight(local, shared) == 3
    assert g.weight(remote, shared) == 7
    # Reverse (fabric → router) is free, regardless of which router's
    # interface cost happened to land there.
    assert g.weight(shared, local) == 0
    assert g.weight(shared, remote) == 0


def test_build_graph_excludes_non_eligible_origin():
    local = _router_with(["10.0.0.0/24"], [1])
    noisy = Router("noisy")
    n_net = Network("lanX", NetworkAddress("192.168.5.0/24"))
    noisy.add_interface(Interface("eth0", n_net, Address("192.168.5.1"), cost=1))
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(local, seq=1, policy=_PermitAll()), now=0.0)
    lsdb.install(LSA.from_router(noisy, seq=1, policy=_PermitAll()), now=0.0)
    g = lsdb.build_graph(eligible_origins=set())  # noisy NOT eligible
    assert noisy not in g
    assert NetworkAddress("192.168.5.0/24") not in g


def test_build_graph_always_includes_local_router():
    local = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(local, seq=1, policy=_PermitAll()), now=0.0)
    g = lsdb.build_graph(eligible_origins=set())
    assert local in g
    assert NetworkAddress("10.0.0.0/24") in g


# ---------- Thread safety smoke test ----------


def test_install_and_build_graph_concurrent_no_torn_reads():
    local = Router("local")
    origin = _router_with(["10.0.0.0/24"], [1])
    lsdb = LSDB(local)

    def installer():
        for i in range(200):
            lsdb.install(LSA.from_router(origin, seq=i, policy=_PermitAll()), now=i)

    def builder():
        for _ in range(200):
            lsdb.build_graph(eligible_origins={origin})

    t1 = threading.Thread(target=installer)
    t2 = threading.Thread(target=builder)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    # No crash, no assertion errors → pass.


# ---------- Multi-origin expiry: originator refresh keeps own LSA below max_age -----


def test_originator_refresh_keeps_local_lsa_below_max_age():
    """Repeated refresh install() resets installed_at so the originator's own LSA
    never reaches max_age regardless of how much wall time has elapsed."""
    max_age = 60.0
    local = _router_with(["10.0.0.0/24"], [1], name="local")
    remote_a = _router_with(["10.0.1.0/24"], [1], name="ra")
    remote_b = _router_with(["10.0.2.0/24"], [1], name="rb")
    lsdb = LSDB(local)

    # Install all three origins at t=0.
    lsdb.install(LSA.from_router(local, seq=1, policy=_PermitAll()), now=0.0)
    lsdb.install(LSA.from_router(remote_a, seq=1, policy=_PermitAll()), now=0.0)
    lsdb.install(LSA.from_router(remote_b, seq=1, policy=_PermitAll()), now=0.0)

    # Simulate periodic originator self-refresh at intervals shorter than max_age.
    refresh_interval = 30.0
    now = 0.0
    for seq in range(2, 6):
        now += refresh_interval
        lsdb.install(LSA.from_router(local, seq=seq, policy=_PermitAll()), now=now)

    # At now=150.0: remotes installed at t=0 are expired (age=150 > 60).
    # Local was last refreshed at now=120.0 (seq=5), so its age is 30.0.
    expired = lsdb.expired_origins(max_age=max_age, now=now)
    assert local not in expired, "originator's own LSA must not expire after refresh"
    assert remote_a in expired, "remote_a (never refreshed) should be expired"
    assert remote_b in expired, "remote_b (never refreshed) should be expired"

    # Age of local LSA must be strictly below max_age.
    assert lsdb.age_of(local, now=now) < max_age


# ---------- point-to-point adjacencies in the graph ----------


def _p2p_pair(link_cidr="10.0.0.0/30", addrs=("10.0.0.1", "10.0.0.2"), costs=(5, 5)):
    """local ── p2p link ── remote, with a LAN hanging off each."""
    link = Link("p2p1", NetworkAddress(link_cidr))

    local = Router("local")
    local_lan = Network("lan_local", NetworkAddress("200.0.1.0/24"))
    local_lan_if = Interface("eth0", local_lan, Address("200.0.1.1"), cost=1)
    local_link_if = Interface("eth1", link, Address(addrs[0]), cost=costs[0])
    local.add_interface(local_lan_if)
    local.add_interface(local_link_if)
    local_lan.add_interface(local_lan_if)
    link.add_interface(local_link_if)

    remote = Router("remote")
    remote_lan = Network("lan_remote", NetworkAddress("200.0.2.0/24"))
    remote_lan_if = Interface("eth0", remote_lan, Address("200.0.2.1"), cost=2)
    remote_link_if = Interface("eth1", link, Address(addrs[1]), cost=costs[1])
    remote.add_interface(remote_lan_if)
    remote.add_interface(remote_link_if)
    remote_lan.add_interface(remote_lan_if)
    link.add_interface(remote_link_if)

    return local, remote


def test_build_graph_joins_both_ends_of_a_point_to_point_link():
    """Both routers attach to the link node, each at its own outgoing cost,
    so a path across the link costs the sender's cost and nothing more."""
    local, remote = _p2p_pair(costs=(5, 9))
    link = local.interface("eth1").network()
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(local, seq=1, policy=RFC1918_OUTBOUND), now=0.0)
    lsdb.install(LSA.from_router(remote, seq=1, policy=RFC1918_OUTBOUND), now=0.0)
    g = lsdb.build_graph(eligible_origins={remote})

    assert g.weight(local, link) == 5
    assert g.weight(remote, link) == 9
    assert g.weight(link, local) == 0
    assert g.weight(link, remote) == 0


def test_build_graph_transits_a_fabric_whose_prefix_is_denied():
    """The private /30 appears as a transit node but never as a destination:
    no prefix leaf, yet paths run straight through it."""
    local, remote = _p2p_pair()
    link = local.interface("eth1").network()
    remote_lan = NetworkAddress("200.0.2.0/24")
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(local, seq=1, policy=RFC1918_OUTBOUND), now=0.0)
    lsdb.install(LSA.from_router(remote, seq=1, policy=RFC1918_OUTBOUND), now=0.0)
    g = lsdb.build_graph(eligible_origins={remote})

    assert NetworkAddress("10.0.0.0/30") not in g  # not a destination
    assert link in g  # but is a path
    paths = g.shortest_paths(local)
    assert paths[remote_lan] == [
        local,
        link,
        remote,
        remote.interface("eth0").network(),
        remote_lan,
    ]


def test_build_graph_ignores_attachments_of_ineligible_origins():
    """An origin we have not verified contributes neither prefixes nor
    attachments."""
    local, remote = _p2p_pair()
    link = local.interface("eth1").network()
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(local, seq=1, policy=RFC1918_OUTBOUND), now=0.0)
    lsdb.install(LSA.from_router(remote, seq=1, policy=RFC1918_OUTBOUND), now=0.0)
    g = lsdb.build_graph(eligible_origins=set())

    # local still attaches to its own side of the link, but the unverified
    # peer contributes nothing — the link leads nowhere.
    assert g.weight(link, remote) is None
    assert NetworkAddress("200.0.2.0/24") not in g


def test_build_graph_does_not_traverse_a_half_open_link():
    """A fabric is only traversable while both ends still advertise it.

    Here the remote end has gone down, so it stops announcing the link
    while the local side still does — routing through it would black-hole.
    Keying transit on the fabric makes this fall out: with no
    fabric → remote edge there is simply no path across.
    """
    local, remote = _p2p_pair()
    remote.interface("eth1").disable()  # the far end of the link goes down
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(local, seq=1, policy=RFC1918_OUTBOUND), now=0.0)
    lsdb.install(LSA.from_router(remote, seq=1, policy=RFC1918_OUTBOUND), now=0.0)
    g = lsdb.build_graph(eligible_origins={remote})

    link = local.interface("eth1").network()
    assert g.weight(link, remote) is None
    # …so the remote LAN is not reachable across the half-open link.
    assert g.shortest_paths(local)[NetworkAddress("200.0.2.0/24")] is None


def test_build_graph_leaves_a_link_dangling_until_the_peer_lsa_arrives():
    """Before the peer's advertisement arrives the link is attached at one
    end only, so nothing routes across it."""
    local, remote = _p2p_pair()
    link = local.interface("eth1").network()
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(local, seq=1, policy=RFC1918_OUTBOUND), now=0.0)
    g = lsdb.build_graph(eligible_origins=set())

    assert g.weight(local, link) == 5
    assert g.weight(link, remote) is None
