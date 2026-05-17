import textwrap

import pytest
from fastapi.testclient import TestClient

from server.app import create_app

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


def test_refresh_interval_endpoint_updates_all_routers(client):
    r = client.post("/sim/refresh_interval", json={"seconds": 3})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["seconds"] == 3
    # confirm via server state
    state = client.app.state.sim_state
    for router in state.as_obj.routers().values():
        assert router._protocol.keepalive_interval() == 3


def test_refresh_interval_rejects_invalid_values(client):
    for bad in (0, -5, 301, "abc", None):
        r = client.post("/sim/refresh_interval", json={"seconds": bad})
        assert r.status_code == 400, f"{bad!r} should be 400, got {r.status_code}"


def test_refresh_interval_requires_started_sim(tmp_path, monkeypatch):
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        # never started
        r = c.post("/sim/refresh_interval", json={"seconds": 5})
        assert r.status_code == 409


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
