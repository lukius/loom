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
""")


@pytest.fixture
def client(tmp_path, monkeypatch):
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        yield c


@pytest.mark.xfail(strict=True, reason="devices/{name}/interfaces lands in Task 16")
def test_add_host_via_patch(client):
    client.post("/sim/start")
    client.post("/sim/pause")
    r = client.post("/sim/resume", json={"patch": [
        {"op": "add_host", "name": "h2", "network": "lan1", "address": "10.0.0.2"}
    ]})
    assert r.status_code == 200
    # smoke check: h2 now exists
    devices = client.get("/devices/h2/interfaces").json()
    assert devices["interfaces"]


def test_invalid_patch_rejected_atomically(client):
    client.post("/sim/start")
    client.post("/sim/pause")
    r = client.post("/sim/resume", json={"patch": [
        {"op": "add_host", "name": "h2", "network": "lan1", "address": "10.0.0.2"},
        {"op": "add_host", "name": "h3", "network": "nonexistent", "address": "10.0.0.3"},  # noqa: E501
    ]})
    assert r.status_code == 400
    # both h2 and h3 should be absent — atomic rejection
    # (404 here because the /devices/{name}/interfaces route is not yet defined;
    # Task 16 will add it and these checks will verify real "host not found" semantics)
    assert client.get("/devices/h2/interfaces").status_code == 404
    assert client.get("/devices/h3/interfaces").status_code == 404


def test_empty_patch_is_noop(client):
    client.post("/sim/start")
    client.post("/sim/pause")
    r = client.post("/sim/resume", json={"patch": []})
    assert r.status_code == 200
    assert r.json()["state"] == "running"


def test_resume_without_patch_works(client):
    client.post("/sim/start")
    client.post("/sim/pause")
    r = client.post("/sim/resume")
    assert r.status_code == 200
    assert r.json()["state"] == "running"


def test_update_cost_patch(client):
    # No router in SAMPLE, so this should be rejected as router_not_found.
    client.post("/sim/start")
    client.post("/sim/pause")
    r = client.post("/sim/resume", json={"patch": [
        {"op": "update_cost", "router": "r99", "iface": "eth0", "cost": 5}
    ]})
    assert r.status_code == 400


def test_update_cost_invalid_value_returns_400(tmp_path, monkeypatch):
    yaml_with_router = textwrap.dedent("""
    as:
      name: t
      networks:
        lan1: "10.0.0.0/24"
      routers:
        r1: {interfaces: {eth0: {network: lan1, address: "10.0.0.254", cost: 1}}}
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml_with_router)
    monkeypatch.setenv("NETROUTING_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": yaml_with_router})
        c.post("/sim/start")
        c.post("/sim/pause")
        r = c.post(
            "/sim/resume",
            json={"patch": [
                {"op": "update_cost", "router": "r1", "iface": "eth0",
                 "cost": "not-a-number"}
            ]},
        )
    assert r.status_code == 400
    assert "invalid_cost" in r.json().get("detail", "")
