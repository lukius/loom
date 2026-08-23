from entities import Address, Host, Interface, Link, Network, NetworkAddress, Router
from routing import LSA
from routing.lsa import Attachment
from routing.policy import PERMIT_ALL, RFC1918_OUTBOUND


def _make_router_with_two_ifaces():
    net1 = Network("lan1", NetworkAddress("200.0.1.0/24"))
    net2 = Network("lan2", NetworkAddress("200.0.2.0/24"))
    r = Router("r1")
    i1 = Interface("eth0", net1, Address("200.0.1.1"), cost=1)
    i2 = Interface("eth1", net2, Address("200.0.2.1"), cost=5)
    r.add_interface(i1)
    r.add_interface(i2)
    return r


class _PermitAll:
    def apply(self, prefix):
        class _D:
            def is_denied(self):
                return False

            def prefix(self):
                return prefix

        return _D()


def test_lsa_carries_origin_and_seq():
    r = _make_router_with_two_ifaces()
    lsa = LSA.from_router(r, seq=7, policy=_PermitAll())
    assert lsa.origin() is r
    assert lsa.seq() == 7
    assert lsa.is_withdrawal() is False


def test_lsa_snapshots_all_local_links():
    r = _make_router_with_two_ifaces()
    lsa = LSA.from_router(r, seq=1, policy=_PermitAll())
    links = lsa.links()
    assert links[NetworkAddress("200.0.1.0/24")] == 1
    assert links[NetworkAddress("200.0.2.0/24")] == 5


def test_lsa_omits_denied_prefixes():
    class _DenyAll:
        def apply(self, prefix):
            class _D:
                def is_denied(self):
                    return True

                def prefix(self):
                    return prefix

            return _D()

    r = _make_router_with_two_ifaces()
    lsa = LSA.from_router(r, seq=1, policy=_DenyAll())
    assert lsa.links() == {}


def test_lsa_is_newer_than_compares_seq():
    r = _make_router_with_two_ifaces()
    a = LSA.from_router(r, seq=3, policy=_PermitAll())
    b = LSA.from_router(r, seq=5, policy=_PermitAll())
    assert b.is_newer_than(a) is True
    assert a.is_newer_than(b) is False


def test_lsa_has_same_links_as_compares_link_dict():
    r = _make_router_with_two_ifaces()
    a = LSA.from_router(r, seq=1, policy=_PermitAll())
    b = LSA.from_router(r, seq=2, policy=_PermitAll())
    assert a.has_same_links_as(b)


def test_lsa_withdrawal_factory_sets_flag_and_no_links():
    r = _make_router_with_two_ifaces()
    w = LSA.withdrawal(r, seq=99)
    assert w.origin() is r
    assert w.seq() == 99
    assert w.is_withdrawal() is True
    assert w.links() == {}


def test_lsa_add_link_mutates_dict_copy_not_returned_dict():
    r = _make_router_with_two_ifaces()
    lsa = LSA.from_router(r, seq=1, policy=_PermitAll())
    snapshot = lsa.links()
    snapshot[NetworkAddress("9.9.9.0/24")] = 99
    assert NetworkAddress("9.9.9.0/24") not in lsa.links()


def _router_two_ifaces():
    r = Router("r1")
    for nm, cidr, addr in (
        ("eth0", "10.0.0.0/24", "10.0.0.1"),
        ("eth1", "10.0.1.0/24", "10.0.1.1"),
    ):
        net = Network(nm + "net", NetworkAddress(cidr))
        iface = Interface(nm, net, Address(addr), cost=1)
        r.add_interface(iface)
        net.add_interface(iface)
    return r


def test_lsa_excludes_down_interface_link():
    r = _router_two_ifaces()
    r.interface("eth1").disable()
    lsa = LSA.from_router(r, seq=1, policy=PERMIT_ALL)
    prefixes = {str(p) for p in lsa.links()}
    assert "10.0.0.0/24" in prefixes
    assert "10.0.1.0/24" not in prefixes


def _linked_router_pair(
    link_cidr="10.0.0.0/30", link_addrs=("10.0.0.1", "10.0.0.2"), cost_r1=5, cost_r2=7
):
    """Two routers joined by a point-to-point link, plus a LAN on r1."""
    lan = Network("lan1", NetworkAddress("200.0.1.0/24"))
    link = Link("p2p1", NetworkAddress(link_cidr))

    r1 = Router("r1")
    r1_lan = Interface("eth0", lan, Address("200.0.1.1"), cost=1)
    r1_link = Interface("eth1", link, Address(link_addrs[0]), cost=cost_r1)
    r1.add_interface(r1_lan)
    r1.add_interface(r1_link)
    lan.add_interface(r1_lan)
    link.add_interface(r1_link)

    r2 = Router("r2")
    r2_link = Interface("eth0", link, Address(link_addrs[1]), cost=cost_r2)
    r2.add_interface(r2_link)
    link.add_interface(r2_link)

    return r1, r2, link


def test_lsa_advertises_every_attached_fabric_with_its_interface_cost():
    """An LSA names the fabrics the router is attached to. That attachment
    is what lets peers compute paths *through* each one."""
    r1, _, link = _linked_router_pair()
    lsa = LSA.from_router(r1, seq=1, policy=PERMIT_ALL)
    assert lsa.attachments()[link].cost == 5


def test_lsa_advertises_attachment_even_when_the_prefix_is_denied():
    """RFC 1918 policy withholds the fabric's *prefix* (nobody should install
    a route to a private range) but must not hide the attachment itself —
    otherwise the fabric can never carry transit traffic."""
    r1, _, link = _linked_router_pair()
    lsa = LSA.from_router(r1, seq=1, policy=RFC1918_OUTBOUND)
    assert NetworkAddress("10.0.0.0/30") not in lsa.links()
    assert lsa.attachments()[link] == Attachment(cost=5, prefix=None)


def test_lsa_announces_a_permitted_prefix_alongside_its_attachment():
    """A public fabric keeps being advertised as a reachable destination —
    the prefix rides along with the attachment rather than replacing it."""
    r1, _, link = _linked_router_pair(
        link_cidr="203.0.113.0/30",
        link_addrs=("203.0.113.1", "203.0.113.2"),
    )
    lsa = LSA.from_router(r1, seq=1, policy=RFC1918_OUTBOUND)
    assert lsa.links()[NetworkAddress("203.0.113.0/30")] == 5
    assert lsa.attachments()[link] == Attachment(
        cost=5,
        prefix=NetworkAddress("203.0.113.0/30"),
    )


def test_lsa_advertises_lans_and_links_the_same_way():
    """A LAN is a fabric like any other: same attachment shape, so a private
    LAN carries transit exactly as a private link does."""
    r = _make_router_with_two_ifaces()
    lsa = LSA.from_router(r, seq=1, policy=PERMIT_ALL)
    fabrics = {f.name(): a.cost for f, a in lsa.attachments().items()}
    assert fabrics == {"lan1": 1, "lan2": 5}


def test_lsa_omits_attachment_on_a_down_interface():
    r1, _, link = _linked_router_pair()
    r1.interface("eth1").disable()
    lsa = LSA.from_router(r1, seq=1, policy=PERMIT_ALL)
    assert link not in lsa.attachments()


def test_lsa_has_same_links_as_detects_a_changed_attachment_set():
    """Attachment changes must count as graph changes, or SPF never reruns
    when a private fabric appears or goes away. Under RFC 1918 policy that
    fabric announces no prefix, so the attachment set is the *only* thing
    that differs between these two LSAs."""
    r1, _, _ = _linked_router_pair()
    a = LSA.from_router(r1, seq=1, policy=RFC1918_OUTBOUND)
    r1.interface("eth1").disable()
    b = LSA.from_router(r1, seq=2, policy=RFC1918_OUTBOUND)
    assert a.links() == b.links()
    assert not a.has_same_links_as(b)


def test_lsa_withdrawal_carries_no_attachments():
    r1, _, _ = _linked_router_pair()
    w = LSA.withdrawal(r1, seq=9)
    assert w.attachments() == {}


def test_a_link_to_a_host_is_a_dead_end_not_a_path():
    """A host is a stub: it originates no advertisement, so the link it sits
    on is attached at one end only and nothing can route across it."""
    link = Link("p2p1", NetworkAddress("203.0.113.0/30"))
    r = Router("r1")
    r_link = Interface("eth0", link, Address("203.0.113.1"), cost=5)
    r.add_interface(r_link)
    link.add_interface(r_link)

    h = Host("h1", link, Address("203.0.113.2"))
    link.add_interface(h.interface())

    lsa = LSA.from_router(r, seq=1, policy=PERMIT_ALL)
    # The router advertises the link; the host advertises nothing, so the
    # fabric node has a single attached router and leads nowhere.
    assert lsa.attachments()[link] == Attachment(
        cost=5,
        prefix=NetworkAddress("203.0.113.0/30"),
    )
    assert lsa.links()[NetworkAddress("203.0.113.0/30")] == 5
