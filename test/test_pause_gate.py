import threading
import time

from entities.clock import PauseGate


def test_gate_starts_running():
    gate = PauseGate()
    running, stopped = gate.wait_or_stop(timeout=0.05)
    assert running is True
    assert stopped is False


def test_pause_blocks_until_resume():
    gate = PauseGate()
    gate.pause()

    result = []
    def worker():
        result.append(gate.wait_or_stop(timeout=1.0))
    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.05)
    assert not result          # still blocked
    gate.resume()
    t.join(timeout=0.5)
    assert result == [(True, False)]


def test_stop_wakes_paused_gate():
    gate = PauseGate()
    gate.pause()

    result = []
    def worker():
        result.append(gate.wait_or_stop())
    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.05)
    gate.stop()
    t.join(timeout=0.2)
    assert result == [(False, True)]


def test_pause_resume_idempotent():
    gate = PauseGate()
    gate.pause()
    gate.pause()
    gate.resume()
    gate.resume()
    running, stopped = gate.wait_or_stop(timeout=0.05)
    assert (running, stopped) == (True, False)


def test_multiple_workers_all_unblock_on_resume():
    gate = PauseGate()
    gate.pause()
    started = threading.Barrier(11)
    results = []
    lock = threading.Lock()

    def worker():
        started.wait()
        r = gate.wait_or_stop(timeout=1.0)
        with lock:
            results.append(r)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(10)]
    for t in threads:
        t.start()
    started.wait()
    time.sleep(0.05)
    assert results == []
    gate.resume()
    for t in threads:
        t.join(timeout=0.5)
    assert len(results) == 10
    assert all(r == (True, False) for r in results)


def test_wait_or_stop_timeout_returns_false_when_paused():
    gate = PauseGate()
    gate.pause()
    running, stopped = gate.wait_or_stop(timeout=0.05)
    assert (running, stopped) == (False, False)
