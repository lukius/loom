"""Tests for the ``loom`` entry point's environment handling."""

import loom
import server


def _capture_run(monkeypatch):
    """Replace ``server.run`` with a spy and return the captured kwargs."""
    captured = {}
    monkeypatch.setattr(server, "run", lambda **kwargs: captured.update(kwargs))
    return captured


def test_binds_loopback_on_port_8000_by_default(monkeypatch):
    monkeypatch.delenv("LOOM_HOST", raising=False)
    monkeypatch.delenv("LOOM_PORT", raising=False)
    captured = _capture_run(monkeypatch)

    loom.main()

    assert captured == {"host": "127.0.0.1", "port": 8000}


def test_loom_host_overrides_the_bind_address(monkeypatch):
    monkeypatch.setenv("LOOM_HOST", "0.0.0.0")
    monkeypatch.delenv("LOOM_PORT", raising=False)
    captured = _capture_run(monkeypatch)

    loom.main()

    assert captured["host"] == "0.0.0.0"


def test_loom_port_overrides_the_bind_port(monkeypatch):
    monkeypatch.delenv("LOOM_HOST", raising=False)
    monkeypatch.setenv("LOOM_PORT", "8123")
    captured = _capture_run(monkeypatch)

    loom.main()

    assert captured["port"] == 8123
