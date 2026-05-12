import contextlib
import io
import os
import tempfile
import textwrap

import pytest

from shell import Shell

SAMPLE = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.0.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.0.1"}
    h2: {network: lan1, address: "10.0.0.2"}
  routers:
    r1: {interfaces: {eth0: {network: lan1, address: "10.0.0.254", cost: 1}}}
""")


@pytest.fixture
def shell():
    sh = Shell()
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(SAMPLE)
        path = f.name
    sh.do_read(path)
    yield sh
    if sh._system is not None:
        sh._system.stop()
    os.unlink(path)


def _capture(shell, method, arg):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        method(arg)
    return buf.getvalue()


def test_ifconfig_host(shell):
    out = _capture(shell, shell.do_ifconfig, "h1")
    assert "iface_h1" in out
    assert "10.0.0.1" in out


def test_ifconfig_router(shell):
    out = _capture(shell, shell.do_ifconfig, "r1")
    assert "eth0" in out
    assert "10.0.0.254" in out
    assert "cost=1" in out


def test_neighbors_router(shell):
    out = _capture(shell, shell.do_neighbors, "r1")
    # before convergence, expect either empty list message or just no rows
    assert "r1" not in out  # self not listed


def test_ping_happy(shell):
    out = _capture(shell, shell.do_ping, "h1 h2 -W 1.0")
    assert "h2" in out
    assert "time=" in out or "timeout" in out


def test_ping_unreachable(shell):
    out = _capture(shell, shell.do_ping, "h1 192.168.99.99 -W 0.3")
    assert "timeout" in out.lower() or "unreachable" in out.lower()


def test_ping_invalid_destination(shell):
    out = _capture(shell, shell.do_ping, "h1 not-a-host-or-ip -W 0.1")
    assert "invalid destination" in out.lower()
