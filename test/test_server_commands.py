import textwrap

import pytest
import yaml
from fastapi.testclient import TestClient

from entities import Address, Network, NetworkAddress
from entities.host import Host
from server.app import create_app
from server.command.dispatch import dispatch
from server.command.host import cmd_ping
from server.command.router import cmd_halt, cmd_ifconfig, cmd_resume

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
def client(tmp_path, monkeypatch):
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        c.post("/sim/start")
        yield c


def test_routes_endpoint(client):
    r = client.get("/devices/r1/routes")
    assert r.status_code == 200
    assert "rules" in r.json()


def test_interfaces_endpoint(client):
    r = client.get("/devices/h1/interfaces")
    assert r.status_code == 200
    ifaces = r.json()["interfaces"]
    assert len(ifaces) == 1
    assert ifaces[0]["address"] == "10.0.0.1"


def test_unknown_device_returns_404(client):
    r = client.get("/devices/ghost/interfaces")
    assert r.status_code == 404


def test_nat_table_endpoint(client):
    # Routers expose their NAT-table snapshot — needed so the SPA can recover
    # the current state after a page reload (events only carry incremental
    # changes, so without a fetch the inspector panel would stay empty until
    # the next translation happens).
    r = client.get("/devices/r1/nat-table")
    assert r.status_code == 200
    body = r.json()
    assert "entries" in body
    assert isinstance(body["entries"], list)


def test_nat_table_endpoint_returns_empty_for_host(client):
    # Hosts have no NAT table. Return an empty list (so the client can treat
    # the endpoint uniformly without special-casing host vs. router).
    r = client.get("/devices/h1/nat-table")
    assert r.status_code == 200
    assert r.json() == {"entries": []}


def test_command_ifconfig(client):
    r = client.post("/devices/h1/command", json={"cmd": "ifconfig"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"]
    assert "10.0.0.1" in body["output"]


def test_command_ping(client):
    r = client.post("/devices/h1/command", json={"cmd": "ping h2 -W 1.0"})
    assert r.status_code == 200
    out = r.json()["output"]
    assert "h2" in out


def test_command_send_does_not_block(client):
    r = client.post("/devices/h1/command", json={"cmd": "send h2 hello"})
    assert r.status_code == 200
    assert r.json()["ok"]


def test_command_route(client):
    r = client.post("/devices/r1/command", json={"cmd": "route"})
    assert r.status_code == 200
    assert r.json()["ok"]


def test_help_host_lists_host_commands_only(client):
    r = client.post("/devices/h1/command", json={"cmd": "help"})
    assert r.status_code == 200
    out = r.json()["output"]
    for keep in ("ifconfig", "send", "ping", "route", "help"):
        assert keep in out, f"missing {keep!r} in host help: {out!r}"
    for forbidden in ("neighbors", "update_cost"):
        assert forbidden not in out, f"router-only {forbidden!r} leaked into host help"


def test_help_router_lists_router_commands_only(client):
    r = client.post("/devices/r1/command", json={"cmd": "help"})
    assert r.status_code == 200
    out = r.json()["output"]
    for keep in ("ifconfig", "route", "update_cost", "neighbors", "help"):
        assert keep in out, f"missing {keep!r} in router help: {out!r}"
    for forbidden in ("send", "ping"):
        assert forbidden not in out, f"host-only {forbidden!r} leaked into router help"


def test_host_rejects_router_only_commands(client):
    for cmd in ("neighbors", "update_cost eth0 5"):
        r = client.post("/devices/h1/command", json={"cmd": cmd})
        body = r.json()
        assert not body["ok"]
        assert "unknown command" in body["output"]



def test_set_gateway_updates_host(client):
    r = client.post("/devices/h1/command", json={"cmd": "set_gateway 10.0.0.254"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"]
    assert "10.0.0.254" in body["output"]
    # confirm route now shows the new gateway
    r2 = client.post("/devices/h1/command", json={"cmd": "route"})
    assert "10.0.0.254" in r2.json()["output"]


def test_set_gateway_rejects_off_network(client):
    r = client.post("/devices/h1/command", json={"cmd": "set_gateway 192.168.99.1"})
    body = r.json()
    assert not body["ok"]
    assert "not in host network" in body["output"]


def test_set_gateway_rejects_invalid_address(client):
    r = client.post("/devices/h1/command", json={"cmd": "set_gateway not-an-ip"})
    body = r.json()
    # cmd handlers return ok=True with a "syntax: ..." or "...: invalid ..." body;
    # the actual signal is whether the gateway was set.
    assert "invalid address" in body["output"]
    r2 = client.post("/devices/h1/command", json={"cmd": "route"})
    assert "not-an-ip" not in r2.json()["output"]


def test_set_gateway_on_router_unknown_command(client):
    # set_gateway is host-only — router should not recognize it
    r = client.post("/devices/r1/command", json={"cmd": "set_gateway 10.0.0.1"})
    body = r.json()
    assert not body["ok"]
    assert "unknown command" in body["output"]


def test_router_rejects_host_only_commands(client):
    for cmd in ("send h1 hi", "ping h1"):
        r = client.post("/devices/r1/command", json={"cmd": cmd})
        body = r.json()
        assert not body["ok"]
        assert "unknown command" in body["output"]


def test_protocol_config_endpoint_sets_hello_and_refresh(client):
    r = client.post(
        "/sim/protocol_config",
        json={"hello_interval": 5, "lsa_refresh_interval": 15},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["hello_interval"] == 5.0
    assert body["lsa_refresh_interval"] == 15.0
    # confirm via server state
    state = client.app.state.sim_state
    for router in state.as_obj.routers().values():
        proto = router.protocol()
        assert proto._hello_interval == 5.0  # noqa: SLF001
        assert proto._lsa_refresh_interval == 15.0  # noqa: SLF001
        assert proto._dead_interval == 15.0  # noqa: SLF001
        assert proto._max_age == 30.0  # noqa: SLF001


def test_protocol_config_endpoint_rejects_non_positive(client):
    for bad in (
        {"hello_interval": 0, "lsa_refresh_interval": 10},
        {"hello_interval": -1, "lsa_refresh_interval": 10},
        {"hello_interval": 5, "lsa_refresh_interval": 0},
        {"hello_interval": 5, "lsa_refresh_interval": -3},
    ):
        r = client.post("/sim/protocol_config", json=bad)
        assert r.status_code == 400, f"{bad!r} should be 400, got {r.status_code}"


def test_protocol_config_endpoint_rejects_missing_keys(client):
    for bad in (
        {"hello_interval": 5},
        {"lsa_refresh_interval": 10},
        {},
        {"hello_interval": None, "lsa_refresh_interval": 10},
    ):
        r = client.post("/sim/protocol_config", json=bad)
        assert r.status_code == 400, f"{bad!r} should be 400, got {r.status_code}"


def test_old_refresh_interval_endpoint_removed(client):
    # StaticFiles catch-all returns 405 for non-GET on unmatched paths;
    # 404 would appear without the html=True static mount. Either confirms
    # the route no longer exists in the API router.
    r = client.post("/sim/refresh_interval", json={"seconds": 5})
    assert r.status_code in (404, 405), (
        f"old endpoint should be gone, got {r.status_code}"
    )


def test_cmd_ifconfig_down_disables(router_with_iface):
    r = router_with_iface
    out = cmd_ifconfig(r, ["eth0", "down"])
    assert r.interface("eth0").is_up() is False
    assert "down" in out


def test_cmd_ifconfig_up_enables(router_with_iface):
    r = router_with_iface
    r.interface("eth0").disable()
    out = cmd_ifconfig(r, ["eth0", "up"])
    assert r.interface("eth0").is_up() is True
    assert "up" in out


def test_cmd_ifconfig_no_args_still_shows(router_with_iface):
    out = cmd_ifconfig(router_with_iface, [])
    assert "eth0" in out and "addr=" in out


def test_cmd_halt_and_resume(router_with_iface):
    r = router_with_iface
    assert "halted" in cmd_halt(r, [])
    assert r.is_halted() is True
    assert "resumed" in cmd_resume(r, [])
    assert r.is_halted() is False


def test_cmd_ping_count_sends_n_probes(monkeypatch, ping_host):
    host = ping_host
    calls = []
    monkeypatch.setattr(host, "ping", lambda addr, timeout: calls.append(addr) or 0.001)
    monkeypatch.setattr("time.sleep", lambda s: None)   # skip the default 1 s gaps
    out = cmd_ping(host, ["10.0.0.2", "-c", "3"], as_obj=None)
    assert len(calls) == 3
    assert "3 sent" in out and "received" in out
    # Per-probe lines must NOT appear in the return value — they stream via events.
    assert "time=" not in out and "ms" not in out


def test_cmd_ping_count_one_is_default(monkeypatch, ping_host):
    host = ping_host
    calls = []
    monkeypatch.setattr(host, "ping", lambda addr, timeout: calls.append(addr) or 0.001)
    cmd_ping(host, ["10.0.0.2"], as_obj=None)
    assert len(calls) == 1


def test_cmd_ping_count_rejects_nonpositive(ping_host):
    host = ping_host
    assert "positive" in cmd_ping(host, ["10.0.0.2", "-c", "0"], as_obj=None).lower()


def test_cmd_ping_interval_sleeps_between_probes(monkeypatch, ping_host):
    # -i spaces probes out: a sleep occurs *between* probes, not after the last.
    host = ping_host
    monkeypatch.setattr(host, "ping", lambda addr, timeout: 0.001)
    sleeps = []
    monkeypatch.setattr("time.sleep", lambda s: sleeps.append(s))
    out = cmd_ping(host, ["10.0.0.2", "-c", "3", "-i", "2"], as_obj=None)
    assert sleeps == [2.0, 2.0]      # 2 gaps between 3 probes
    assert "3 sent" in out


def test_cmd_ping_defaults_to_one_second_interval(monkeypatch, ping_host):
    # Like real ping: probes are 1 s apart by default (no -i needed), so live
    # topology edits affect later probes.
    host = ping_host
    monkeypatch.setattr(host, "ping", lambda addr, timeout: 0.001)
    sleeps = []
    monkeypatch.setattr("time.sleep", lambda s: sleeps.append(s))
    cmd_ping(host, ["10.0.0.2", "-c", "3"], as_obj=None)
    assert sleeps == [1.0, 1.0]


def test_cmd_ping_interval_zero_sends_back_to_back(monkeypatch, ping_host):
    host = ping_host
    monkeypatch.setattr(host, "ping", lambda addr, timeout: 0.001)
    sleeps = []
    monkeypatch.setattr("time.sleep", lambda s: sleeps.append(s))
    cmd_ping(host, ["10.0.0.2", "-c", "3", "-i", "0"], as_obj=None)
    assert sleeps == []


def test_cmd_ping_interval_rejects_negative(ping_host):
    out = cmd_ping(ping_host, ["10.0.0.2", "-i", "-1"], as_obj=None)
    assert "non-negative" in out.lower()


def test_cmd_ping_interval_rejects_garbage(ping_host):
    out = cmd_ping(ping_host, ["10.0.0.2", "-i", "abc"], as_obj=None)
    assert "syntax" in out.lower()


def test_cmd_ping_interval_uses_gate_and_aborts_on_stop(monkeypatch, ping_host):
    # When the AS exposes a PauseGate, the inter-probe wait goes through it so a
    # mid-ping Stop aborts the remaining probes.
    host = ping_host
    calls = []
    monkeypatch.setattr(host, "ping", lambda addr, timeout: calls.append(addr) or 0.001)

    class _FakeGate:
        def __init__(self):
            self.sleeps = 0

        def sleep(self, _d):
            self.sleeps += 1
            return (False, True)   # signal "stopped" on the first inter-probe wait

        def wait_or_stop(self, timeout=None):
            return (True, False)

    class _FakeAS:
        def __init__(self, gate):
            self._g = gate

        def gate(self):
            return self._g

    gate = _FakeGate()
    cmd_ping(host, ["10.0.0.2", "-c", "5", "-i", "1"], as_obj=_FakeAS(gate))
    # First probe sent, gate.sleep reports stopped → loop breaks before probe 2.
    assert len(calls) == 1
    assert gate.sleeps == 1


def test_topology_roundtrip_preserves_config(client):
    src = """
internet:
  name: loom
  config:
    packet_duration_ms: 2400
    theme: dark
  autonomous_systems:
    main:
      asn: 65000
      config:
        protocol:
          hello_interval: 5
          lsa_refresh_interval: 15
      networks:
        lan1: 100.100.100.0/24
      hosts:
        h1:
          network: lan1
          address: 100.100.100.10
      routers:
        r1:
          interfaces:
            eth0:
              network: lan1
              address: 100.100.100.1
              cost: 10
"""
    assert client.post("/topology", json={"yaml": src}).status_code == 200
    dumped = yaml.safe_load(client.get("/topology").json()["yaml"])
    internet = dumped["internet"]
    assert internet["config"] == {"packet_duration_ms": 2400, "theme": "dark"}
    proto = internet["autonomous_systems"]["main"]["config"]["protocol"]
    assert proto["hello_interval"] == 5.0
    assert proto["lsa_refresh_interval"] == 15.0


def test_topology_roundtrip_preserves_asn(client):
    src = """
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 64500
      networks:
        lan1: 100.100.100.0/24
      hosts:
        h1:
          network: lan1
          address: 100.100.100.10
      routers:
        r1:
          interfaces:
            eth0:
              network: lan1
              address: 100.100.100.1
              cost: 10
"""
    assert client.post("/topology", json={"yaml": src}).status_code == 200
    dumped = yaml.safe_load(client.get("/topology").json()["yaml"])
    assert dumped["internet"]["autonomous_systems"]["main"]["asn"] == 64500


def test_topology_dump_reflects_runtime_protocol_change(client):
    src = """
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan1: 100.100.100.0/24
      hosts:
        h1:
          network: lan1
          address: 100.100.100.10
      routers:
        r1:
          interfaces:
            eth0:
              network: lan1
              address: 100.100.100.1
              cost: 10
"""
    assert client.post("/topology", json={"yaml": src}).status_code == 200
    assert client.post(
        "/sim/protocol_config",
        json={"hello_interval": 8, "lsa_refresh_interval": 24},
    ).status_code == 200
    dumped = yaml.safe_load(client.get("/topology").json()["yaml"])
    proto = dumped["internet"]["autonomous_systems"]["main"]["config"]["protocol"]
    assert proto["hello_interval"] == 8.0
    assert proto["lsa_refresh_interval"] == 24.0


# ---------------------------------------------------------------------------
# Fix C: unbalanced-quote command returns ok=False instead of raising 500
# ---------------------------------------------------------------------------


def test_unbalanced_quote_command_returns_error_not_500(client):
    """A command with an unbalanced quote must return ok=False, not a 500."""
    r = client.post("/devices/h1/command", json={"cmd": 'send h2 "hi'})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "syntax" in body["output"].lower() or "quotation" in body["output"].lower()


def test_unbalanced_quote_dispatch_returns_error_dict():
    """dispatch() must return {ok: False, output: ...} for unbalanced quotes."""
    net = Network("lan", NetworkAddress("10.0.0.0/24"))
    host = Host("h1", net, Address("10.0.0.1"))

    result = dispatch(host, 'send h2 "hi')
    assert isinstance(result, dict)
    assert result["ok"] is False
    assert result["output"]  # some error message
