from entities import Address, Interface, Network, NetworkAddress, Router
from routing import LSA
from routing.policy import PERMIT_ALL


def _make_router_with_two_ifaces():
    net1 = Network('lan1', NetworkAddress('200.0.1.0/24'))
    net2 = Network('lan2', NetworkAddress('200.0.2.0/24'))
    r = Router('r1')
    i1 = Interface('eth0', net1, Address('200.0.1.1'), cost=1)
    i2 = Interface('eth1', net2, Address('200.0.2.1'), cost=5)
    r.add_interface(i1)
    r.add_interface(i2)
    return r


class _PermitAll:
    def apply(self, prefix):
        class _D:
            def is_denied(self): return False
            def prefix(self): return prefix
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
    assert links[NetworkAddress('200.0.1.0/24')] == 1
    assert links[NetworkAddress('200.0.2.0/24')] == 5


def test_lsa_omits_denied_prefixes():
    class _DenyAll:
        def apply(self, prefix):
            class _D:
                def is_denied(self): return True
                def prefix(self): return prefix
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
    snapshot[NetworkAddress('9.9.9.0/24')] = 99
    assert NetworkAddress('9.9.9.0/24') not in lsa.links()


def _router_two_ifaces():
    r = Router("r1")
    for nm, cidr, addr in (("eth0", "10.0.0.0/24", "10.0.0.1"),
                           ("eth1", "10.0.1.0/24", "10.0.1.1")):
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
