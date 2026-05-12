import threading


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
