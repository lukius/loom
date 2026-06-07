import contextlib
import io
import os
import tempfile
import textwrap

import pytest

from shell import Shell

SAMPLE = textwrap.dedent("""
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
    out = _capture(shell, shell.do_ping, "h1 10.0.0.99 -W 0.3")
    assert "timeout" in out.lower() or "unreachable" in out.lower()


def test_ping_off_lan_no_gateway(shell):
    out = _capture(shell, shell.do_ping, "h1 192.168.99.99 -W 0.3")
    assert "no gateway" in out.lower()


def test_ping_invalid_destination(shell):
    out = _capture(shell, shell.do_ping, "h1 not-a-host-or-ip -W 0.1")
    assert "invalid destination" in out.lower()


def test_set_gateway_happy(shell):
    out = _capture(shell, shell.do_set_gateway, "h1 10.0.0.254")
    assert "10.0.0.254" in out
    assert shell._system.host("h1").gateway() is not None


def test_set_gateway_off_network(shell):
    out = _capture(shell, shell.do_set_gateway, "h1 192.168.99.1")
    assert "not in host network" in out.lower()


def test_set_gateway_router_rejects(shell):
    out = _capture(shell, shell.do_set_gateway, "r1 10.0.0.254")
    assert "not a host" in out.lower()


def test_shell_ifconfig_down_up(shell):
    sh = shell
    r_name = next(iter(sh._system.routers()))
    iface = next(iter(sh._system.router(r_name).interfaces()))
    sh.do_ifconfig(f"{r_name} {iface} down")
    assert sh._system.router(r_name).interface(iface).is_up() is False
    sh.do_ifconfig(f"{r_name} {iface} up")
    assert sh._system.router(r_name).interface(iface).is_up() is True


def test_shell_halt_resume(shell):
    sh = shell
    r_name = next(iter(sh._system.routers()))
    sh.do_halt(r_name)
    assert sh._system.router(r_name).is_halted() is True
    sh.do_resume(r_name)
    assert sh._system.router(r_name).is_halted() is False


def test_shell_ping_count(monkeypatch, shell, capsys):
    sh = shell
    h_names = list(sh._system.hosts())
    src, dst = h_names[0], h_names[1]
    calls = []
    monkeypatch.setattr(sh._system.host(src), "ping",
                        lambda addr, timeout: calls.append(addr) or 0.001)
    sleeps = []
    monkeypatch.setattr("time.sleep", lambda s: sleeps.append(s))
    sh.do_ping(f"{src} {dst} -c 3")
    assert len(calls) == 3
    assert sleeps == [1.0, 1.0]   # default 1 s spacing between probes
    assert "3 sent" in capsys.readouterr().out


def test_shell_ping_interval_sleeps_between_probes(monkeypatch, shell, capsys):
    sh = shell
    h_names = list(sh._system.hosts())
    src, dst = h_names[0], h_names[1]
    monkeypatch.setattr(sh._system.host(src), "ping", lambda addr, timeout: 0.001)
    sleeps = []
    monkeypatch.setattr("time.sleep", lambda s: sleeps.append(s))
    sh.do_ping(f"{src} {dst} -c 3 -i 1.5")
    assert sleeps == [1.5, 1.5]
    assert "3 sent" in capsys.readouterr().out


def test_shell_ping_count_capped(monkeypatch, shell, capsys):
    sh = shell
    h_names = list(sh._system.hosts())
    src, dst = h_names[0], h_names[1]
    calls = []
    monkeypatch.setattr(sh._system.host(src), "ping",
                        lambda addr, timeout: calls.append(addr) or 0.001)
    sh.do_ping(f"{src} {dst} -c 101")
    out = capsys.readouterr().out
    # Shell must reject counts above 100; no ping calls should have been made
    assert len(calls) == 0
    assert "100" in out
