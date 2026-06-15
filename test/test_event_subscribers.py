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
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
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


def test_packet_event_carries_user_message_byte_count():
    import os
    import tempfile
    import textwrap
    import time

    from entities import UserMessage
    from entities.event import EventTracer
    from parser import Parser

    yaml_text = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
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
        msg = UserMessage("hello")
        h1.send_message_to(msg, h2.address())
        time.sleep(0.2)
        pkt_events = [
            e for e in events
            if e.get("kind") == "packet" and e.get("type") == "user_datagram"
        ]
        assert pkt_events, "expected at least one user_datagram packet event"
        assert pkt_events[0]["payload"] == {"bytes": len("hello"), "text": "hello"}
        system.stop()
    finally:
        os.unlink(path)


def test_packet_event_non_string_user_message_omits_text_key():
    import os
    import tempfile
    import textwrap
    import time

    from entities import UserMessage
    from entities.event import EventTracer
    from parser import Parser

    yaml_text = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
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
        payload = b"raw bytes"
        h1.send_message_to(UserMessage(payload), h2.address())
        time.sleep(0.2)
        pkt_events = [
            e for e in events
            if e.get("kind") == "packet" and e.get("type") == "user_datagram"
        ]
        assert pkt_events, "expected at least one user_datagram packet event"
        summary = pkt_events[0]["payload"]
        assert summary == {"bytes": len(payload)}
        assert "text" not in summary
        system.stop()
    finally:
        os.unlink(path)


def test_packet_event_carries_ping_request_seq():
    import os
    import tempfile
    import textwrap
    import time

    from entities.event import EventTracer
    from parser import Parser

    yaml_text = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
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
        h1.ping(h2.address(), timeout=1.0)
        time.sleep(0.1)
        req_events = [
            e for e in events
            if e.get("kind") == "packet" and e.get("type") == "ping_request"
        ]
        assert req_events, "expected at least one ping_request packet event"
        assert isinstance(req_events[0]["payload"]["seq"], int)
        system.stop()
    finally:
        os.unlink(path)


def test_packet_event_carries_ping_reply_seq_and_request_ts():
    import os
    import tempfile
    import textwrap
    import time

    from entities.event import EventTracer
    from parser import Parser

    yaml_text = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
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
        h1.ping(h2.address(), timeout=1.0)
        time.sleep(0.1)
        reply_events = [
            e for e in events
            if e.get("kind") == "packet" and e.get("type") == "ping_reply"
        ]
        assert reply_events, "expected at least one ping_reply packet event"
        payload = reply_events[0]["payload"]
        assert isinstance(payload["seq"], int)
        assert isinstance(payload["request_ts"], float)
        system.stop()
    finally:
        os.unlink(path)


def test_packet_event_for_routing_flood_carries_seq_and_destinations():
    import os
    import tempfile
    import textwrap
    import time

    from entities.event import EventTracer
    from parser import Parser

    # Public addresses are used so the default RFC1918 outbound policy
    # does not filter the prefixes out of the RoutingMessage.
    yaml_text = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "200.100.0.0/24"
            lan2: "200.100.1.0/24"
          routers:
            r1: {interfaces: {eth0: {network: lan1, address: "200.100.0.1", cost: 5},
                              eth1: {network: lan2, address: "200.100.1.1", cost: 5}}}
    """)
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml_text)
        path = f.name
    try:
        events = []
        system = Parser(path).parse().single_as()
        EventTracer.subscribe(events.append)
        system.router("r1").protocol()._run_keepalive_cycle()  # noqa: SLF001
        time.sleep(0.2)
        flood_events = [
            e for e in events
            if e.get("kind") == "packet" and e.get("type") == "routing_flood"
        ]
        assert flood_events, "expected at least one routing_flood packet event"
        payload = flood_events[0]["payload"]
        assert isinstance(payload["seq"], int)
        # `originator` lets downstream subscribers tell an origin emission
        # apart from a re-flood by the same LSA traversing other routers.
        assert payload["originator"] == "r1"
        prefixes = {d["prefix"] for d in payload["destinations"]}
        assert prefixes == {"200.100.0.0/24", "200.100.1.0/24"}
        for dest in payload["destinations"]:
            assert isinstance(dest["cost"], int)
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
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
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
        # First keepalive within ~lsa_refresh_interval; for a test, manually update.
        system.router("r1").update_interface("eth0", 99)
        # nudge protocol to recompute by faking a keepalive call:
        system.router("r1").protocol()._run_keepalive_cycle()  # noqa: SLF001
        kinds = [e.get("kind") for e in events]
        assert "routing_table_changed" in kinds
        system.stop()
    finally:
        os.unlink(path)


def test_neighbor_state_changed_event_payload_shape():
    import os
    import tempfile
    import textwrap
    import time

    from entities.event import EventTracer
    from parser import Parser

    yaml_text = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "200.0.1.0/24"
          links:
            p2p: "200.0.0.0/30"
          routers:
            r1:
              interfaces:
                eth0: {network: lan1, address: "200.0.1.1", cost: 1}
                eth1: {link: p2p, address: "200.0.0.1", cost: 1}
            r2:
              interfaces:
                eth0: {link: p2p, address: "200.0.0.2", cost: 1}
    """)
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml_text)
        path = f.name
    system = Parser(path).parse(start_routing=False).single_as()
    for r in system.routers().values():
        r.protocol().set_timers(hello_interval=0.1, lsa_refresh_interval=0.3)
        r.start()
    try:
        events = []
        EventTracer.subscribe(events.append)

        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            nsc = [e for e in events if e.get("kind") == "neighbor_state_changed"]
            if nsc:
                break
            time.sleep(0.05)

        nsc_events = [e for e in events if e.get("kind") == "neighbor_state_changed"]
        assert nsc_events, "expected at least one neighbor_state_changed event"
        evt = nsc_events[0]
        # Required string fields.
        assert isinstance(evt.get("device"), str), "device must be a str"
        assert isinstance(evt.get("interface"), str), "interface must be a str"
        assert isinstance(evt.get("peer"), str), "peer must be a str"
        assert isinstance(evt.get("state"), str), "state must be a str"
        assert evt["state"] in ("down", "init", "two_way"), (
            f"state must be a valid NeighborState value, got {evt['state']!r}"
        )
        # Timestamp fields: float or None.
        for field in ("last_hello_at", "peer_acked_at"):
            assert field in evt, f"missing field {field!r}"
            val = evt[field]
            assert val is None or isinstance(val, float), (
                f"{field} must be float or None, got {type(val)}"
            )
        system.stop()
    finally:
        os.unlink(path)


def test_event_registry_is_bounded():
    """EventTracer._events must not grow without bound.

    Registering more than _MAX_TRACKED_EVENTS messages must cap the registry
    at that size.  A freshly-registered event (registered last, after the cap
    is exceeded) must still fire its on_forwarded callback.
    """
    from entities.event import (
        _MAX_TRACKED_EVENTS,  # noqa: PLC0415 — module-level line kept clean
    )

    tracer = EventTracer()

    # (a) Register more than the cap — registry size must stay bounded.
    cap = _MAX_TRACKED_EVENTS
    messages = [object() for _ in range(cap + 10)]
    for msg in messages:
        tracer.register_message_event_instance(msg)
    assert len(tracer._events) <= cap, (
        f"_events grew to {len(tracer._events)}, expected <= {cap}"
    )

    # (b) A freshly-registered event (after eviction) must still fire its callbacks.
    fired = []
    fresh_msg = object()

    class _FakeDatagram:
        def payload(self):
            return fresh_msg

    tracer.register_message_event_instance(
        fresh_msg, on_forwarded=lambda *a, **kw: fired.append(True)
    )
    tracer.datagram_forwarded_instance("src", "dst", _FakeDatagram())
    assert fired, "on_forwarded callback for a fresh event was not called after eviction"  # noqa: E501
