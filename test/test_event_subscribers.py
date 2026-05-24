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


def test_packet_event_for_routing_flood_has_empty_payload_dict():
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
        system.router("r1").protocol()._handle_update()  # noqa: SLF001
        time.sleep(0.2)
        flood_events = [
            e for e in events
            if e.get("kind") == "packet" and e.get("type") == "routing_flood"
        ]
        assert flood_events, "expected at least one routing_flood packet event"
        assert flood_events[0]["payload"] == {}
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
        # First keepalive within ~KEEPALIVE_INTERVAL; for a test, manually update.
        system.router("r1").update_interface("eth0", 99)
        # nudge protocol to recompute by faking a keepalive call:
        system.router("r1").protocol()._handle_update()  # noqa: SLF001
        kinds = [e.get("kind") for e in events]
        assert "routing_table_changed" in kinds
        system.stop()
    finally:
        os.unlink(path)
