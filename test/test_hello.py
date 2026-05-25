from entities import Router
from routing import Hello, RoutingMessage


def test_hello_is_a_routing_message():
    h = Hello(originator=Router('r1'), neighbours_heard=[])
    assert isinstance(h, RoutingMessage)


def test_hello_carries_originator_and_neighbours_heard_copy():
    r1 = Router('r1')
    r2 = Router('r2')
    r3 = Router('r3')
    h = Hello(originator=r1, neighbours_heard=[r2, r3])
    assert h.originator() is r1
    assert h.neighbours_heard() == [r2, r3]


def test_hello_neighbours_heard_is_defensive_copy():
    r1 = Router('r1')
    r2 = Router('r2')
    seed = [r2]
    h = Hello(originator=r1, neighbours_heard=seed)
    seed.append(Router('intruder'))
    assert h.neighbours_heard() == [r2]


def test_hello_neighbours_heard_returns_defensive_copy_on_read():
    r1 = Router('r1')
    r2 = Router('r2')
    h = Hello(originator=r1, neighbours_heard=[r2])
    got = h.neighbours_heard()
    got.append(Router('intruder'))
    assert h.neighbours_heard() == [r2]
