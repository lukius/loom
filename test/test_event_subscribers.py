from entities.event import EventTracer


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


def test_egress_broadcast_fires_for_user_datagram():
    import os
    import tempfile
    import textwrap
    import time

    from entities import UserMessage
    from entities.event import EventTracer
    from parser import Parser

    yaml_text = textwrap.dedent("""
    as:
      name: t
      networks:
        lan1: "10.0.0.0/24"
      hosts:
        h1: {network: lan1, address: "10.0.0.1"}
        h2: {network: lan1, address: "10.0.0.2"}
    """)
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml_text)
        path = f.name
    try:
        events = []
        system = Parser(path).parse().single_as()
        EventTracer.subscribe(events.append)
        h1, h2 = system.host("h1"), system.host("h2")
        h1.send_message_to(UserMessage("hi"), h2.address())
        time.sleep(0.2)
        kinds = [(e.get("kind"), e.get("type")) for e in events]
        assert ("packet", "user_datagram") in kinds
        system.stop()
    finally:
        os.unlink(path)


def test_routing_table_changed_event_fires():
    import os
    import tempfile
    import textwrap

    from entities.event import EventTracer
    from parser import Parser

    yaml_text = textwrap.dedent("""
    as:
      name: t
      networks:
        lan1: "10.0.0.0/24"
        lan2: "10.0.1.0/24"
      routers:
        r1: {interfaces: {eth0: {network: lan1, address: "10.0.0.1", cost: 5},
                          eth1: {network: lan2, address: "10.0.1.1", cost: 5}}}
    """)
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml_text)
        path = f.name
    try:
        events = []
        system = Parser(path).parse().single_as()
        EventTracer.subscribe(events.append)
        # First keepalive within ~KEEPALIVE_INTERVAL; for a test, manually update.
        system.router("r1").update_interface("eth0", 99)
        # nudge protocol to recompute by faking a keepalive call:
        system.router("r1").protocol()._handle_update()  # noqa: SLF001
        kinds = [e.get("kind") for e in events]
        assert "routing_table_changed" in kinds
        system.stop()
    finally:
        os.unlink(path)
