from entities import Address, Interface, Network, NetworkAddress, Router
from routing import Neighbor, NeighborState


def _iface():
    net = Network('lan', NetworkAddress('10.0.0.0/24'))
    return Interface('eth0', net, Address('10.0.0.1'), cost=1)


def _peer():
    return Router('peer')


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
