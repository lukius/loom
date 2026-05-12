import textwrap

import pytest

SAMPLE = textwrap.dedent("""
as:
  name: t
  networks:
    lan1: "10.0.0.0/24"
  hosts:
    h1: {network: lan1, address: "10.0.0.1"}
""")


@pytest.fixture
def source_yaml(tmp_path):
    p = tmp_path / "src.yaml"
    p.write_text(SAMPLE)
    return p


def test_session_file_created_on_first_use(source_yaml):
    from server.persistence import prepare_session

    session = prepare_session(source_yaml)
    assert session.exists()
    assert session.read_text() == SAMPLE
    assert session.name.endswith(".session.yaml")
    assert source_yaml.read_text() == SAMPLE  # source untouched


def test_session_reset_reclones(source_yaml):
    from server.persistence import prepare_session, reset_session

    session = prepare_session(source_yaml)
    session.write_text("mutated")
    new_session = reset_session(source_yaml)
    assert new_session.read_text() == SAMPLE


def test_sim_state_transitions(source_yaml):
    from server.state import SimState

    s = SimState(source_yaml)
    assert s.state == "idle"

    s.load_from_session()
    assert s.state == "idle"

    s.start()
    assert s.state == "running"

    s.pause()
    assert s.state == "paused"

    s.resume()
    assert s.state == "running"

    s.stop()
    assert s.state == "idle"


def test_invalid_transitions_raise(source_yaml):
    from server.state import InvalidStateTransition, SimState

    s = SimState(source_yaml)
    with pytest.raises(InvalidStateTransition):
        s.pause()  # from idle
    s.load_from_session()
    s.start()
    with pytest.raises(InvalidStateTransition):
        s.resume()  # from running


def test_start_is_idempotent(source_yaml):
    from server.state import SimState

    s = SimState(source_yaml)
    s.load_from_session()
    s.start()
    s.start()  # no-op
    assert s.state == "running"


def test_stop_then_start_works(source_yaml):
    from server.state import SimState

    s = SimState(source_yaml)
    s.load_from_session()
    s.start()
    s.stop()
    s.load_from_session()
    s.start()  # second cycle
    assert s.state == "running"
    s.stop()
