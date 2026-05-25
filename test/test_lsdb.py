import threading

from entities import Address, Interface, Network, NetworkAddress, Router
from routing import LSA, LSDB, InstallResult


class _PermitAll:
    def apply(self, prefix):
        class _D:
            def is_denied(self): return False
            def prefix(self): return prefix
        return _D()


def _router_with(net_addr_strs, costs, name='rx'):
    r = Router(name)
    for i, (cidr, c) in enumerate(zip(net_addr_strs, costs)):
        n = Network(f'lan{i}', NetworkAddress(cidr))
        ip = NetworkAddress(cidr).octets()
        ip[-1] = 1
        addr = Address('.'.join(str(o) for o in ip))
        r.add_interface(Interface(f'eth{i}', n, addr, cost=c))
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
    local = Router('local')
    origin = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    lsa = LSA.from_router(origin, seq=1, policy=_PermitAll())
    result = lsdb.install(lsa, now=0.0)
    assert result.is_accepted() and result.changed_graph()
    assert lsdb.lsa_for(origin) is lsa


def test_install_older_seq_returns_rejected():
    local = Router('local')
    origin = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=5, policy=_PermitAll()), now=0.0)
    result = lsdb.install(LSA.from_router(origin, seq=3, policy=_PermitAll()), now=1.0)
    assert result.is_accepted() is False


def test_install_same_seq_returns_rejected():
    local = Router('local')
    origin = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=5, policy=_PermitAll()), now=0.0)
    result = lsdb.install(LSA.from_router(origin, seq=5, policy=_PermitAll()), now=1.0)
    assert result.is_accepted() is False


def test_install_newer_same_links_returns_accepted_changed_graph_false():
    """Refresh: newer seq but identical link content. Re-flood, don't recompute."""
    local = Router('local')
    origin = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=0.0)
    result = lsdb.install(LSA.from_router(origin, seq=2, policy=_PermitAll()), now=1.0)
    assert result.is_accepted() is True
    assert result.changed_graph() is False


def test_install_newer_different_links_returns_accepted_changed_graph_true():
    local = Router('local')
    origin_a = _router_with(['10.0.0.0/24'], [1])
    origin_b = _router_with(['10.0.0.0/24', '10.0.1.0/24'], [1, 1])
    origin_b._name = 'rx'  # share identity
    # Build two LSAs from the same router instance but with different links.
    lsa_a = LSA(origin=origin_a, seq=1)
    lsa_a.add_link(NetworkAddress('10.0.0.0/24'), 1)
    lsa_b = LSA(origin=origin_a, seq=2)
    lsa_b.add_link(NetworkAddress('10.0.0.0/24'), 1)
    lsa_b.add_link(NetworkAddress('10.0.1.0/24'), 1)

    lsdb = LSDB(local)
    lsdb.install(lsa_a, now=0.0)
    result = lsdb.install(lsa_b, now=1.0)
    assert result.is_accepted() and result.changed_graph()


# ---------- LSDB.purge ----------

def test_purge_removes_entry_returns_true():
    local = Router('local')
    origin = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=0.0)
    assert lsdb.purge(origin) is True
    assert lsdb.lsa_for(origin) is None


def test_purge_unknown_origin_returns_false():
    local = Router('local')
    ghost = Router('ghost')
    lsdb = LSDB(local)
    assert lsdb.purge(ghost) is False


# ---------- Withdrawal LSA path ----------

def test_withdrawal_install_purges_origin_and_returns_changed_graph_true():
    local = Router('local')
    origin = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=0.0)
    result = lsdb.install(LSA.withdrawal(origin, seq=2), now=1.0)
    assert result.is_accepted() and result.changed_graph()
    assert lsdb.lsa_for(origin) is None


def test_withdrawal_install_for_unknown_origin_is_accepted_but_no_change():
    local = Router('local')
    ghost = Router('ghost')
    lsdb = LSDB(local)
    result = lsdb.install(LSA.withdrawal(ghost, seq=1), now=0.0)
    assert result.is_accepted() and result.changed_graph() is False


# ---------- LSDB.expired_origins / age_of ----------

def test_age_of_returns_elapsed_since_install():
    local = Router('local')
    origin = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=100.0)
    assert lsdb.age_of(origin, now=100.0) == 0.0
    assert lsdb.age_of(origin, now=110.0) == 10.0


def test_expired_origins_returns_origins_past_max_age():
    local = Router('local')
    origin = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=0.0)
    assert lsdb.expired_origins(max_age=60.0, now=30.0) == []
    assert origin in lsdb.expired_origins(max_age=60.0, now=61.0)


def test_install_refreshes_installed_at():
    local = Router('local')
    origin = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(origin, seq=1, policy=_PermitAll()), now=0.0)
    lsdb.install(LSA.from_router(origin, seq=2, policy=_PermitAll()), now=50.0)
    assert lsdb.age_of(origin, now=50.0) == 0.0


# ---------- LSDB.build_graph ----------

def test_build_graph_with_empty_eligible_set_contains_only_local_router():
    local = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    g = lsdb.build_graph(eligible_origins=set())
    assert local in g
    # Other origins absent.


def test_build_graph_with_eligible_origin_includes_its_links():
    local = _router_with(['10.0.0.0/24'], [1], name='local')
    remote = _router_with(['10.0.1.0/24', '10.0.2.0/24'], [1, 2], name='remote')
    lsdb = LSDB(local)
    # Install local's own LSA — always eligible.
    lsdb.install(LSA.from_router(local, seq=1, policy=_PermitAll()), now=0.0)
    lsdb.install(LSA.from_router(remote, seq=1, policy=_PermitAll()), now=0.0)
    g = lsdb.build_graph(eligible_origins={remote})
    assert remote in g
    assert NetworkAddress('10.0.1.0/24') in g
    assert NetworkAddress('10.0.2.0/24') in g
    assert g.weight(remote, NetworkAddress('10.0.1.0/24')) == 1
    assert g.weight(remote, NetworkAddress('10.0.2.0/24')) == 2


def test_build_graph_excludes_non_eligible_origin():
    local = _router_with(['10.0.0.0/24'], [1])
    noisy = Router('noisy')
    n_net = Network('lanX', NetworkAddress('192.168.5.0/24'))
    noisy.add_interface(Interface('eth0', n_net, Address('192.168.5.1'), cost=1))
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(local, seq=1, policy=_PermitAll()), now=0.0)
    lsdb.install(LSA.from_router(noisy, seq=1, policy=_PermitAll()), now=0.0)
    g = lsdb.build_graph(eligible_origins=set())  # noisy NOT eligible
    assert noisy not in g
    assert NetworkAddress('192.168.5.0/24') not in g


def test_build_graph_always_includes_local_router():
    local = _router_with(['10.0.0.0/24'], [1])
    lsdb = LSDB(local)
    lsdb.install(LSA.from_router(local, seq=1, policy=_PermitAll()), now=0.0)
    g = lsdb.build_graph(eligible_origins=set())
    assert local in g
    assert NetworkAddress('10.0.0.0/24') in g


# ---------- Thread safety smoke test ----------

def test_install_and_build_graph_concurrent_no_torn_reads():
    local = Router('local')
    origin = _router_with(['10.0.0.0/24'], [1])
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
