import os
import tempfile
import textwrap
import threading
import time

from parser import Parser


def _make_topology(yaml_text):
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(yaml_text)
        return f.name


TWO_HOSTS = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.0.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.0.1"}
    h2: {network: lan1, address: "10.0.0.2"}
""")


def test_ping_happy_path():
    path = _make_topology(TWO_HOSTS)
    system = Parser(path).parse()
    try:
        h1, h2 = system.host("h1"), system.host("h2")
        rtt = h1.ping(h2.address(), timeout=1.0)
        assert rtt is not None
        assert rtt < 0.5
    finally:
        system.stop()
        os.unlink(path)


def test_ping_unreachable_returns_none():
    path = _make_topology(TWO_HOSTS)
    system = Parser(path).parse()
    try:
        from entities import Address

        h1 = system.host("h1")
        bogus = Address("192.168.99.99")
        t0 = time.monotonic()
        rtt = h1.ping(bogus, timeout=0.3)
        elapsed = time.monotonic() - t0
        assert rtt is None
        assert 0.3 <= elapsed < 0.7
    finally:
        system.stop()
        os.unlink(path)


def test_concurrent_pings_independent():
    path = _make_topology(TWO_HOSTS)
    system = Parser(path).parse()
    try:
        h1, h2 = system.host("h1"), system.host("h2")
        results = [None] * 5
        threads = []

        def go(i):
            results[i] = h1.ping(h2.address(), timeout=1.0)

        for i in range(5):
            t = threading.Thread(target=go, args=(i,), daemon=True)
            threads.append(t)
            t.start()
        for t in threads:
            t.join(timeout=2.0)
        assert all(r is not None for r in results)
    finally:
        system.stop()
        os.unlink(path)


def test_no_thread_leak_after_pings():
    path = _make_topology(TWO_HOSTS)
    before = {t.ident for t in threading.enumerate()}
    system = Parser(path).parse()
    try:
        h1, h2 = system.host("h1"), system.host("h2")
        for _ in range(10):
            h1.ping(h2.address(), timeout=0.5)
    finally:
        system.stop()
        os.unlink(path)
    time.sleep(0.2)
    after = {t.ident for t in threading.enumerate()}
    # only daemon threads from parser may remain; ping itself must not leak threads
    assert len(after - before) <= 0, f"thread leak: {after - before}"
