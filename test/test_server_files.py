"""Tests for the sample-listing, sample-read, and source-name endpoints.

These back the SPA's Import file picker (which lists `samples/`) and
the Export default-filename derivation (which uses the source basename).
"""

import textwrap

import pytest
from fastapi.testclient import TestClient

from server.app import create_app

SAMPLE = textwrap.dedent("""\
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
def env(tmp_path, monkeypatch):
    samples = tmp_path / "samples"
    samples.mkdir()
    src = samples / "alpha.yaml"
    src.write_text(SAMPLE)
    (samples / "beta.yaml").write_text(SAMPLE)
    # Session clones must be filtered out of the listing.
    (samples / "alpha.session.yaml").write_text(SAMPLE)
    # Non-YAML files must be filtered out.
    (samples / "readme.txt").write_text("not a topology")
    monkeypatch.setenv("LOOM_TOPOLOGY", str(src))
    monkeypatch.setenv("LOOM_SAMPLES", str(samples))
    return {"samples": samples, "src": src}


def test_samples_lists_yaml_files_sorted(env):
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/samples")
        assert r.status_code == 200
        body = r.json()
        assert body["files"] == ["alpha.yaml", "beta.yaml"]


def test_samples_excludes_session_clones(env):
    app = create_app()
    with TestClient(app) as c:
        body = c.get("/samples").json()
        assert "alpha.session.yaml" not in body["files"]


def test_samples_excludes_non_yaml(env):
    app = create_app()
    with TestClient(app) as c:
        body = c.get("/samples").json()
        assert "readme.txt" not in body["files"]


def test_samples_read_returns_yaml(env):
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/samples/alpha.yaml")
        assert r.status_code == 200
        assert r.json()["yaml"] == SAMPLE


def test_samples_read_missing_is_404(env):
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/samples/nope.yaml")
        assert r.status_code == 404


def test_samples_read_rejects_path_traversal(env, tmp_path):
    secret = tmp_path / "secret.yaml"
    secret.write_text("nope")
    app = create_app()
    with TestClient(app) as c:
        # Subpaths under /samples/ are not registered routes — FastAPI returns
        # 404 for the unmatched route, which is the safe outcome.
        # httpx normalises bare `..` away in the URL, so the meaningful
        # cases here are: encoded traversal, a name with a separator,
        # and an absolute path leaking into the dynamic segment.
        for evil in ("..%2Fsecret.yaml", "subdir%2Ffile.yaml", "..%5C..%5Cetc"):
            r = c.get(f"/samples/{evil}")
            assert r.status_code in (400, 404), f"{evil} returned {r.status_code}"


def test_topology_source_returns_basename(env):
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/topology/source")
        assert r.status_code == 200
        assert r.json() == {"name": "alpha.yaml"}
