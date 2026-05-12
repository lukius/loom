import threading
import time

from entities.clock import PauseGate


def test_gate_starts_running():
    gate = PauseGate()
    running, stopped = gate.wait_or_stop(timeout=0.05)
    assert running is True
    assert stopped is False


def test_pause_blocks_until_resume():
    gate = PauseGate()
    gate.pause()

    result = []
    def worker():
        result.append(gate.wait_or_stop(timeout=1.0))
    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.05)
    assert not result          # still blocked
    gate.resume()
    t.join(timeout=0.5)
    assert result == [(True, False)]


def test_stop_wakes_paused_gate():
    gate = PauseGate()
    gate.pause()

    result = []
    def worker():
        result.append(gate.wait_or_stop())
    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.05)
    gate.stop()
    t.join(timeout=0.2)
    assert result == [(False, True)]


def test_pause_resume_idempotent():
    gate = PauseGate()
    gate.pause()
    gate.pause()
    gate.resume()
    gate.resume()
    running, stopped = gate.wait_or_stop(timeout=0.05)
    assert (running, stopped) == (True, False)


def test_multiple_workers_all_unblock_on_resume():
    gate = PauseGate()
    gate.pause()
    started = threading.Barrier(11)
    results = []
    lock = threading.Lock()

    def worker():
        started.wait()
        r = gate.wait_or_stop(timeout=1.0)
        with lock:
            results.append(r)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(10)]
    for t in threads:
        t.start()
    started.wait()
    time.sleep(0.05)
    assert results == []
    gate.resume()
    for t in threads:
        t.join(timeout=0.5)
    assert len(results) == 10
    assert all(r == (True, False) for r in results)


def test_wait_or_stop_timeout_returns_false_when_paused():
    gate = PauseGate()
    gate.pause()
    running, stopped = gate.wait_or_stop(timeout=0.05)
    assert (running, stopped) == (False, False)


def test_as_owns_a_gate():
    from entities import AS
    system = AS("demo")
    gate = system.gate()
    assert gate.is_running()


def test_as_stop_releases_workers():
    from entities import AS
    system = AS("demo")
    gate = system.gate()
    gate.pause()
    system.stop()
    # workers waiting on the gate should now wake with stopped=True
    running, stopped = gate.wait_or_stop(timeout=0.1)
    assert (running, stopped) == (False, True)


def test_paused_interface_does_not_dispatch():
    import os
    import tempfile
    import textwrap

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
        system = Parser(path).parse()
        system.gate().pause()

        h1 = system.host("h1")
        h2 = system.host("h2")
        from entities import UserMessage

        msg = UserMessage("hi")
        h1.send_message_to(msg, h2.address())

        time.sleep(0.1)
        # The frame is enqueued but the network's _pkt_loop is gated.
        # We expect h2 NOT to have received it yet.
        # Sanity: the network's in_queue should still contain a pending item.
        assert h2.network()._in_queue.qsize() > 0, "expected packet to be queued, not dispatched"  # noqa: E501
    finally:
        system.stop()
        os.unlink(path)


def test_paused_keepalive_does_not_tick():
    from entities import AS, Address, Interface, Network, NetworkAddress, Router

    system = AS("t")
    net = Network("lan1", NetworkAddress("10.0.0.0/24"), gate=system.gate())
    system.add_network(net)
    r1 = Router("r1")
    iface = Interface("eth0", net, Address("10.0.0.1"), cost=1, gate=system.gate())
    net.add_interface(iface)
    r1.add_interface(iface)
    system.add_router(r1)

    # Patch the specific protocol instance: short interval + tick counter.
    # Instance-level patching avoids contaminating other RoutingProtocol objects
    # (e.g., those leaked by test_parser tests that never call system.stop()).
    tick_count = [0]
    proto = r1._protocol
    proto.KEEPALIVE_INTERVAL = 0.05  # instance attribute overrides class attribute

    original_handle_update = proto._handle_update

    def counting_handle_update():
        tick_count[0] += 1
        original_handle_update()

    proto._handle_update = counting_handle_update

    r1.start()

    # Let a few ticks happen to confirm the loop is running.
    time.sleep(0.15)
    assert tick_count[0] >= 1, "expected at least one keepalive tick before pause"

    system.gate().pause()
    # Wait for any in-flight tick to finish, then record the count.
    time.sleep(0.1)
    ticks_at_pause = tick_count[0]

    # Hold the pause for two full intervals; no new ticks should happen.
    time.sleep(0.15)
    assert tick_count[0] == ticks_at_pause, (
        f"keepalive ticked while paused: {tick_count[0] - ticks_at_pause} extra tick(s)"
    )
    system.stop()
    # Join the keepalive thread so it fully exits before the next test,
    # preventing any lingering interface sends from polluting test mocks.
    proto._keepalive_thread.join(timeout=1.0)
