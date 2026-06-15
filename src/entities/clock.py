import threading

# How often (seconds) a gate-parked worker re-checks its own stop flag so
# that stop() is noticed within one poll interval rather than after the full
# join timeout.  Kept here as the canonical constant; interface.py and
# _fabric.py import it from here rather than defining their own copy.
_PAUSE_POLL_INTERVAL = 0.1


def wait_for_gate(gate: "PauseGate | None", stop_event: threading.Event,
                  poll: float = _PAUSE_POLL_INTERVAL) -> bool:
    """Block until the gate is RUNNING, or until the caller's stop event fires.

    Returns:
        True  — gate is running (or absent): the caller should proceed.
        False — gate was stopped, or ``stop_event`` was set: the caller
                should exit its worker loop.

    When the gate is PAUSED, polls every ``poll`` seconds and re-checks
    ``stop_event`` each time, so ``stop()`` is noticed within one poll
    interval rather than after the full join timeout.
    """
    if gate is None:
        return True
    while not stop_event.is_set():
        running, stopped = gate.wait_or_stop(timeout=poll)
        if stopped:
            return False        # AS gate stopped
        if running:
            return True         # gate resumed — proceed
        # (False, False): timeout while paused — re-check stop_event
    return False                # stop_event was set by caller's stop()


class PauseGate:
    """A two-state gate worker threads block on each loop iteration.

    Carries an internal running-event and stopped-event so callers can
    distinguish "resume" from "stop" without polling separately.
    """

    def __init__(self):
        self._running = threading.Event()
        self._running.set()
        self._stopped = threading.Event()

    def pause(self) -> None:
        self._running.clear()

    def resume(self) -> None:
        self._running.set()

    def stop(self) -> None:
        self._stopped.set()
        self._running.set()  # release any blocked waiters

    def is_running(self) -> bool:
        return self._running.is_set() and not self._stopped.is_set()

    def is_paused(self) -> bool:
        return not self._running.is_set() and not self._stopped.is_set()

    def wait_or_stop(self, timeout: float | None = None) -> tuple[bool, bool]:
        """Block until running, stopped, or timeout. Returns (running, stopped).

        - (True,  False): we are running — proceed.
        - (False, True ): stop was signalled — exit the loop.
        - (False, False): timeout expired while paused — caller may poll.
        """
        woken = self._running.wait(timeout=timeout)
        if self._stopped.is_set():
            return (False, True)
        return (woken, False)

    def sleep(self, duration: float) -> tuple[bool, bool]:
        """Sleep for `duration` seconds, returning early only if stopped.

        Returns (ticked, stopped):
        - (True,  False): full interval elapsed — safe to tick.
        - (False, True ): stop was signalled — exit the loop.

        Callers should check the gate for pause *after* `sleep` returns `(True, False)`.
        """
        interrupted = self._stopped.wait(timeout=duration)
        if interrupted:
            return (False, True)
        return (True, False)
