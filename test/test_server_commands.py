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
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))
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
