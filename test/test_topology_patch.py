import textwrap

import pytest
from fastapi.testclient import TestClient

from server.app import create_app

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
""")


@pytest.fixture
def client(tmp_path, monkeypatch):
    src = tmp_path / "src.yaml"
    src.write_text(SAMPLE)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": SAMPLE})
        yield c


def test_add_host_via_patch(client):
    client.post("/sim/start")
    client.post("/sim/pause")
    r = client.post(
        "/sim/resume",
        json={
            "patch": [
                {
                    "op": "add_host",
                    "name": "h2",
                    "network": "lan1",
                    "address": "10.0.0.2",
                }
            ]
        },
    )
    assert r.status_code == 200
    # smoke check: h2 now exists
    devices = client.get("/devices/h2/interfaces").json()
    assert devices["interfaces"]


def test_invalid_patch_rejected_atomically(client):
    client.post("/sim/start")
    client.post("/sim/pause")
    r = client.post(
        "/sim/resume",
        json={
            "patch": [
                {
                    "op": "add_host",
                    "name": "h2",
                    "network": "lan1",
                    "address": "10.0.0.2",
                },
                {
                    "op": "add_host",
                    "name": "h3",
                    "network": "nonexistent",
                    "address": "10.0.0.3",
                },  # noqa: E501
            ]
        },
    )
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
    r = client.post(
        "/sim/resume",
        json={
            "patch": [
                {"op": "update_cost", "router": "r99", "iface": "eth0", "cost": 5}
            ]
        },
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# address_in_use — patch validator must reject add_host / add_router whose
# address is already used by an existing host or router interface on the same
# network. (Duplicating an entity in the SPA clones the address verbatim, so
# Resume must catch the collision rather than silently clobbering the LAN's
# address-keyed interface map.)
# ---------------------------------------------------------------------------
def test_add_host_with_duplicate_address_rejected(client):
    client.post("/sim/start")
    client.post("/sim/pause")
    r = client.post(
        "/sim/resume",
        json={
            "patch": [
                {
                    "op": "add_host",
                    "name": "h2",
                    "network": "lan1",
                    "address": "10.0.0.1",
                }
            ]
        },
    )
    assert r.status_code == 400
    assert "address_in_use" in r.json().get("detail", "")
    # Atomic rejection: h2 should not exist.
    assert client.get("/devices/h2/interfaces").status_code == 404


def _two_lan_yaml() -> str:
    return textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "10.0.0.0/24"
            lan2: "10.0.1.0/24"
          hosts:
            h1: {network: lan1, address: "10.0.0.1"}
            h2: {network: lan2, address: "10.0.1.1"}
    """)


@pytest.fixture
def two_lan_client(tmp_path, monkeypatch):
    yaml = _two_lan_yaml()
    src = tmp_path / "src.yaml"
    src.write_text(yaml)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": yaml})
        yield c


def test_add_router_single_iface_with_duplicate_address_rejected(two_lan_client):
    two_lan_client.post("/sim/start")
    two_lan_client.post("/sim/pause")
    r = two_lan_client.post(
        "/sim/resume",
        json={
            "patch": [
                {
                    "op": "add_router",
                    "name": "r1",
                    "interfaces": [
                        {
                            "name": "eth0",
                            "network": "lan1",
                            "address": "10.0.0.1",
                            "cost": 1,
                        },
                    ],
                },
            ]
        },
    )
    assert r.status_code == 400
    assert "address_in_use" in r.json().get("detail", "")


def test_add_router_multi_iface_one_address_collides(two_lan_client):
    # Mirrors the SPA's duplicateRouter: the clone keeps every interface's
    # address; if even one of those addresses is now in use, the whole patch
    # must be rejected.
    two_lan_client.post("/sim/start")
    two_lan_client.post("/sim/pause")
    r = two_lan_client.post(
        "/sim/resume",
        json={
            "patch": [
                {
                    "op": "add_router",
                    "name": "r1",
                    "interfaces": [
                        {
                            "name": "eth0",
                            "network": "lan1",
                            "address": "10.0.0.254",
                            "cost": 1,
                        },
                        {
                            "name": "eth1",
                            "network": "lan2",
                            "address": "10.0.1.1",
                            "cost": 1,
                        },
                    ],
                },
            ]
        },
    )
    assert r.status_code == 400
    assert "address_in_use" in r.json().get("detail", "")


def test_add_router_intra_collision_on_same_network_rejected(tmp_path, monkeypatch):
    # Two of the new router's own interfaces sit on the same LAN with the same
    # address — the validator must catch this even before any pre-existing
    # device claims the address.
    yaml = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "10.0.0.0/24"
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": yaml})
        c.post("/sim/start")
        c.post("/sim/pause")
        r = c.post(
            "/sim/resume",
            json={
                "patch": [
                    {
                        "op": "add_router",
                        "name": "r1",
                        "interfaces": [
                            {
                                "name": "eth0",
                                "network": "lan1",
                                "address": "10.0.0.5",
                                "cost": 1,
                            },
                            {
                                "name": "eth1",
                                "network": "lan1",
                                "address": "10.0.0.5",
                                "cost": 1,
                            },
                        ],
                    },
                ]
            },
        )
    assert r.status_code == 400
    assert "address_in_use" in r.json().get("detail", "")


# ---------------------------------------------------------------------------
# Patch protocol must support link-attached hosts and router interfaces, plus
# add_link itself — otherwise the SPA can't ship a "build a p2p link + two
# endpoints during pause" workflow without restarting the sim.
# ---------------------------------------------------------------------------
def _link_seed_yaml() -> str:
    # Source must have a link with two endpoints (the parser rejects 0/1).
    # Tests that need to reference a pre-existing link work off this seed.
    return textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "10.0.0.0/24"
          links:
            p2p_seed: "192.168.0.0/30"
          routers:
            r1: {interfaces: {
              eth0: {network: lan1, address: "10.0.0.1", cost: 1},
              eth1: {link: p2p_seed, address: "192.168.0.1", cost: 1}}}
            r2: {interfaces: {
              eth0: {network: lan1, address: "10.0.0.2", cost: 1},
              eth1: {link: p2p_seed, address: "192.168.0.2", cost: 1}}}
    """)


def _start_paused(c, yaml):
    c.post("/topology", json={"yaml": yaml})
    c.post("/sim/start")
    c.post("/sim/pause")


def test_add_link_then_add_hosts_on_link_in_one_patch(tmp_path, monkeypatch):
    # The user's reported flow: create a link AND its two endpoints in the
    # same pause window. The validator must walk ops against a virtual
    # state so the later add_host ops see the link the earlier add_link
    # will create.
    yaml = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "10.0.0.0/24"
          hosts:
            h1: {network: lan1, address: "10.0.0.1"}
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        _start_paused(c, yaml)
        r = c.post(
            "/sim/resume",
            json={
                "patch": [
                    {"op": "add_link", "name": "newp2p", "address": "192.168.5.0/30"},
                    {
                        "op": "add_host",
                        "name": "h2",
                        "link": "newp2p",
                        "address": "192.168.5.1",
                    },
                    {
                        "op": "add_host",
                        "name": "h3",
                        "link": "newp2p",
                        "address": "192.168.5.2",
                    },
                ]
            },
        )
    assert r.status_code == 200, r.text


def test_add_link_then_add_router_with_iface_on_new_link(tmp_path, monkeypatch):
    # Same forward-reference shape (add_link → another op that references it),
    # this time via add_router. The new link gets only one endpoint, which is
    # fine at construction; the parser-time "exactly two" rule is a one-shot
    # post-pass that doesn't fire on patch apply.
    yaml = _link_seed_yaml()
    src = tmp_path / "src.yaml"
    src.write_text(yaml)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        _start_paused(c, yaml)
        r = c.post(
            "/sim/resume",
            json={
                "patch": [
                    {"op": "add_link", "name": "newp2p", "address": "192.168.9.0/30"},
                    {
                        "op": "add_router",
                        "name": "r3",
                        "interfaces": [
                            {
                                "name": "eth0",
                                "link": "newp2p",
                                "address": "192.168.9.1",
                                "cost": 1,
                            },
                        ],
                    },
                ]
            },
        )
    assert r.status_code == 200, r.text


def test_add_host_with_missing_fabric_key_is_invalid_patch(tmp_path, monkeypatch):
    yaml = _link_seed_yaml()
    src = tmp_path / "src.yaml"
    src.write_text(yaml)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        _start_paused(c, yaml)
        r = c.post(
            "/sim/resume",
            json={
                "patch": [
                    {"op": "add_host", "name": "h2", "address": "192.168.0.5"},
                ]
            },
        )
    assert r.status_code == 400
    assert "invalid_patch" in r.json().get("detail", "")


def test_add_host_with_both_network_and_link_is_invalid_patch(tmp_path, monkeypatch):
    yaml = _link_seed_yaml()
    src = tmp_path / "src.yaml"
    src.write_text(yaml)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        _start_paused(c, yaml)
        r = c.post(
            "/sim/resume",
            json={
                "patch": [
                    {
                        "op": "add_host",
                        "name": "h2",
                        "network": "lan1",
                        "link": "p2p_seed",
                        "address": "10.0.0.5",
                    },
                ]
            },
        )
    assert r.status_code == 400
    assert "invalid_patch" in r.json().get("detail", "")


def test_add_host_on_unknown_link_rejected(tmp_path, monkeypatch):
    yaml = _link_seed_yaml()
    src = tmp_path / "src.yaml"
    src.write_text(yaml)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        _start_paused(c, yaml)
        r = c.post(
            "/sim/resume",
            json={
                "patch": [
                    {
                        "op": "add_host",
                        "name": "h2",
                        "link": "ghost",
                        "address": "192.168.0.5",
                    },
                ]
            },
        )
    assert r.status_code == 400
    assert "link_not_found" in r.json().get("detail", "")


def test_add_link_with_invalid_cidr_rejected(tmp_path, monkeypatch):
    yaml = _link_seed_yaml()
    src = tmp_path / "src.yaml"
    src.write_text(yaml)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        _start_paused(c, yaml)
        r = c.post(
            "/sim/resume",
            json={
                "patch": [
                    {"op": "add_link", "name": "newp2p", "address": "10.0.0.0/24"},
                ]
            },
        )
    # Links must be /30 or /31; /24 is rejected.
    assert r.status_code == 400


def test_update_cost_invalid_value_returns_400(tmp_path, monkeypatch):
    yaml_with_router = textwrap.dedent("""
    internet:
      name: loom
      autonomous_systems:
        main:
          asn: 65000
          networks:
            lan1: "10.0.0.0/24"
          routers:
            r1: {interfaces: {eth0: {network: lan1, address: "10.0.0.254", cost: 1}}}
    """)
    src = tmp_path / "src.yaml"
    src.write_text(yaml_with_router)
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    with TestClient(create_app()) as c:
        c.post("/topology", json={"yaml": yaml_with_router})
        c.post("/sim/start")
        c.post("/sim/pause")
        r = c.post(
            "/sim/resume",
            json={
                "patch": [
                    {
                        "op": "update_cost",
                        "router": "r1",
                        "iface": "eth0",
                        "cost": "not-a-number",
                    }
                ]
            },
        )
    assert r.status_code == 400
    assert "invalid_cost" in r.json().get("detail", "")
