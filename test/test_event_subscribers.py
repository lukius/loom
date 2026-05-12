from entities.event import EventTracer


def setup_function():
    # reset between tests
    EventTracer._subscribers = []


def test_subscribe_returns_unsubscribe():
    events = []
    unsub = EventTracer.subscribe(events.append)
    EventTracer._broadcast({"kind": "x"})
    assert events == [{"kind": "x"}]
    unsub()
    EventTracer._broadcast({"kind": "y"})
    assert events == [{"kind": "x"}]


def test_multiple_subscribers_receive_in_order():
    a, b = [], []
    EventTracer.subscribe(a.append)
    EventTracer.subscribe(b.append)
    EventTracer._broadcast({"kind": "e1"})
    EventTracer._broadcast({"kind": "e2"})
    assert a == b == [{"kind": "e1"}, {"kind": "e2"}]


def test_subscriber_exception_does_not_break_others():
    a, b = [], []

    def boom(_evt):
        raise RuntimeError("oops")

    EventTracer.subscribe(boom)
    EventTracer.subscribe(a.append)
    EventTracer.subscribe(b.append)
    EventTracer._broadcast({"kind": "e1"})
    assert a == b == [{"kind": "e1"}]


def test_unsubscribe_during_broadcast_is_safe():
    log = []
    handles = []

    def killer(evt):
        log.append("k")
        handles[0]()  # unsubscribe the next subscriber mid-broadcast

    def follower(evt):
        log.append("f")

    EventTracer.subscribe(killer)
    handles.append(EventTracer.subscribe(follower))
    EventTracer._broadcast({"kind": "e1"})
    # snapshot iteration: follower still fires this round
    assert log == ["k", "f"]
    # but is gone next round
    log.clear()
    EventTracer._broadcast({"kind": "e2"})
    assert log == ["k"]
