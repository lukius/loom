from entities import Address, Interface, Network, NetworkAddress, Router
from routing import Neighbor, NeighborState, NeighborTable, NeighborTransition


def _iface():
    net = Network("lan", NetworkAddress("10.0.0.0/24"))
    return Interface("eth0", net, Address("10.0.0.1"), cost=1)


def _peer():
    return Router("peer")


def test_neighbor_state_starts_down():
    n = Neighbor(_iface(), _peer())
    assert n.state(dead_interval=30.0, now=0.0) is NeighborState.DOWN


def test_neighbor_state_init_on_first_hello_without_ack():
    n = Neighbor(_iface(), _peer())
    n.heard_hello(peer_listed_us=False, now=10.0)
    assert n.state(dead_interval=30.0, now=10.0) is NeighborState.INIT


def test_neighbor_state_two_way_when_peer_acks():
    n = Neighbor(_iface(), _peer())
    n.heard_hello(peer_listed_us=True, now=10.0)
    assert n.state(dead_interval=30.0, now=10.0) is NeighborState.TWO_WAY


def test_neighbor_state_goes_down_after_dead_interval():
    n = Neighbor(_iface(), _peer())
    n.heard_hello(peer_listed_us=True, now=10.0)
    assert n.state(dead_interval=30.0, now=39.99) is NeighborState.TWO_WAY
    assert n.state(dead_interval=30.0, now=40.01) is NeighborState.DOWN


def test_neighbor_state_two_way_then_unacked_falls_back_to_init():
    """If the peer stops listing us but we still hear their hellos,
    state should fall back to INIT (peer hears us only sporadically)."""
    n = Neighbor(_iface(), _peer())
    n.heard_hello(peer_listed_us=True, now=10.0)
    # Another hello, but peer no longer lists us, much later.
    n.heard_hello(peer_listed_us=False, now=50.0)
    assert n.state(dead_interval=30.0, now=50.0) is NeighborState.INIT


def test_neighbor_last_hello_at_and_peer_acked_at_accessors():
    n = Neighbor(_iface(), _peer())
    assert n.last_hello_at() is None
    assert n.peer_acked_at() is None
    n.heard_hello(peer_listed_us=True, now=42.0)
    assert n.last_hello_at() == 42.0
    assert n.peer_acked_at() == 42.0


def test_neighbor_peer_interface_accessors():
    iface = _iface()
    peer = _peer()
    n = Neighbor(iface, peer)
    assert n.interface() is iface
    assert n.peer() is peer


# ---------- NeighborTransition ----------


def test_transition_carries_before_after_and_neighbor():
    iface = _iface()
    peer = _peer()
    n = Neighbor(iface, peer)
    t = NeighborTransition(n, before=NeighborState.DOWN, after=NeighborState.INIT)
    assert t.neighbor() is n
    assert t.before() is NeighborState.DOWN
    assert t.after() is NeighborState.INIT


def test_transition_went_down_predicate():
    iface = _iface()
    peer = _peer()
    n = Neighbor(iface, peer)
    assert NeighborTransition(n, NeighborState.TWO_WAY, NeighborState.DOWN).went_down()
    assert NeighborTransition(n, NeighborState.INIT, NeighborState.DOWN).went_down()
    t = NeighborTransition(n, NeighborState.INIT, NeighborState.TWO_WAY)
    assert not t.went_down()
    assert not NeighborTransition(n, NeighborState.DOWN, NeighborState.DOWN).went_down()


# ---------- NeighborTable.record_hello ----------


def test_record_hello_creates_neighbor_and_returns_transition_down_to_init():
    tbl = NeighborTable()
    iface = _iface()
    peer = _peer()
    t = tbl.record_hello(iface, peer, peer_listed_us=False, dead_interval=30.0, now=1.0)
    assert t is not None
    assert t.before() is NeighborState.DOWN
    assert t.after() is NeighborState.INIT
    assert t.neighbor().peer() is peer


def test_record_hello_returns_none_when_state_unchanged():
    tbl = NeighborTable()
    iface = _iface()
    peer = _peer()
    tbl.record_hello(iface, peer, peer_listed_us=True, dead_interval=30.0, now=1.0)
    t = tbl.record_hello(iface, peer, peer_listed_us=True, dead_interval=30.0, now=2.0)
    assert t is None


def test_record_hello_init_to_two_way_transition():
    tbl = NeighborTable()
    iface = _iface()
    peer = _peer()
    tbl.record_hello(iface, peer, peer_listed_us=False, dead_interval=30.0, now=1.0)
    t = tbl.record_hello(iface, peer, peer_listed_us=True, dead_interval=30.0, now=2.0)
    assert t is not None
    assert t.before() is NeighborState.INIT
    assert t.after() is NeighborState.TWO_WAY


# ---------- NeighborTable.neighbors_heard_on ----------


def test_neighbors_heard_on_returns_init_and_two_way_excludes_down():
    tbl = NeighborTable()
    iface = _iface()
    p1 = Router("p1")
    p2 = Router("p2")
    p3 = Router("p3")
    tbl.record_hello(iface, p1, peer_listed_us=True, dead_interval=30.0, now=1.0)
    tbl.record_hello(iface, p2, peer_listed_us=False, dead_interval=30.0, now=1.0)
    # p3: heard at the same time as p1/p2 — all expire at now=100
    tbl.record_hello(iface, p3, peer_listed_us=True, dead_interval=30.0, now=1.0)
    heard = tbl.neighbors_heard_on(iface, dead_interval=30.0, now=100.0)
    assert p1 not in heard and p2 not in heard and p3 not in heard
    heard_at_2 = tbl.neighbors_heard_on(iface, dead_interval=30.0, now=2.0)
    assert p1 in heard_at_2 and p2 in heard_at_2 and p3 in heard_at_2


# ---------- NeighborTable.bidirectional_peers ----------


def test_bidirectional_peers_returns_only_two_way_across_any_iface():
    tbl = NeighborTable()
    iface1 = _iface()
    net2 = Network("lan2", NetworkAddress("10.0.1.0/24"))
    iface2 = Interface("eth1", net2, Address("10.0.1.1"), cost=1)
    p1 = Router("p1")
    p2 = Router("p2")
    p3 = Router("p3")
    tbl.record_hello(iface1, p1, peer_listed_us=True, dead_interval=30.0, now=1.0)
    tbl.record_hello(iface2, p2, peer_listed_us=False, dead_interval=30.0, now=1.0)
    tbl.record_hello(iface1, p3, peer_listed_us=True, dead_interval=30.0, now=1.0)
    bi = tbl.bidirectional_peers(dead_interval=30.0, now=2.0)
    assert p1 in bi and p3 in bi
    assert p2 not in bi  # only INIT


# ---------- NeighborTable.sweep_transitions ----------


def test_sweep_transitions_reports_dead_interval_expiry():
    tbl = NeighborTable()
    iface = _iface()
    peer = _peer()
    tbl.record_hello(iface, peer, peer_listed_us=True, dead_interval=30.0, now=1.0)
    # Now scoot the clock past dead_interval and sweep.
    transitions = tbl.sweep_transitions(dead_interval=30.0, now=100.0)
    assert len(transitions) == 1
    assert transitions[0].before() is NeighborState.TWO_WAY
    assert transitions[0].after() is NeighborState.DOWN


def test_sweep_transitions_emits_each_transition_only_once():
    tbl = NeighborTable()
    iface = _iface()
    peer = _peer()
    tbl.record_hello(iface, peer, peer_listed_us=True, dead_interval=30.0, now=1.0)
    tbl.sweep_transitions(dead_interval=30.0, now=100.0)
    # Second sweep at the same dead state should yield nothing.
    assert tbl.sweep_transitions(dead_interval=30.0, now=200.0) == []


# ---------- NeighborTable.on_interface / .all ----------


def test_on_interface_lists_all_states_for_that_iface():
    tbl = NeighborTable()
    iface = _iface()
    p1 = Router("p1")
    p2 = Router("p2")
    tbl.record_hello(iface, p1, peer_listed_us=True, dead_interval=30.0, now=1.0)
    tbl.record_hello(iface, p2, peer_listed_us=False, dead_interval=30.0, now=1.0)
    ns = tbl.on_interface(iface)
    assert {n.peer() for n in ns} == {p1, p2}


def test_all_returns_every_neighbor_across_ifaces():
    tbl = NeighborTable()
    iface1 = _iface()
    net2 = Network("lan2", NetworkAddress("10.0.1.0/24"))
    iface2 = Interface("eth1", net2, Address("10.0.1.1"), cost=1)
    p1 = Router("p1")
    p2 = Router("p2")
    tbl.record_hello(iface1, p1, peer_listed_us=True, dead_interval=30.0, now=1.0)
    tbl.record_hello(iface2, p2, peer_listed_us=True, dead_interval=30.0, now=1.0)
    assert len(tbl.all()) == 2


def test_multi_peer_per_iface_each_tracked_independently():
    """A LAN with three peers attached: each becomes its own Neighbor
    under the same interface key; one going DOWN doesn't affect others."""
    tbl = NeighborTable()
    iface = _iface()
    p1 = Router("p1")
    p2 = Router("p2")
    p3 = Router("p3")
    tbl.record_hello(iface, p1, peer_listed_us=True, dead_interval=30.0, now=1.0)
    tbl.record_hello(iface, p2, peer_listed_us=True, dead_interval=30.0, now=1.0)
    tbl.record_hello(iface, p3, peer_listed_us=True, dead_interval=30.0, now=1.0)
    # p2 silenced; re-hear p1+p3 at now=40, then sweep at 60.
    # p1+p3 still TWO_WAY, p2 goes DOWN.
    tbl.record_hello(iface, p1, peer_listed_us=True, dead_interval=30.0, now=40.0)
    tbl.record_hello(iface, p3, peer_listed_us=True, dead_interval=30.0, now=40.0)
    transitions = tbl.sweep_transitions(dead_interval=30.0, now=60.0)
    down = {t.neighbor().peer() for t in transitions if t.after() is NeighborState.DOWN}
    assert down == {p2}
