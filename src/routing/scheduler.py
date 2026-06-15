import random
import threading
from typing import Optional


class Scheduler:
    """Tracks named deadlines with per-tick jitter.

    Used by LinkStateProtocol._protocol_loop to honour three
    independent timers (hello, lsa-refresh, max-age sweep) in one
    thread. Jitter draws each next-deadline from
    [lo·base, hi·base], defaulting to the IS-IS convention
    [0.75·base, 1.25·base].

    Tests can pass jitter_range=(1.0, 1.0) for deterministic
    behaviour, or pass a seeded RNG via the `rng` parameter.

    Thread-safety: schedule/next_deadline/elapsed are protected by an
    internal lock so that set_timers (caller thread) and _protocol_loop
    (protocol thread) can access the dicts concurrently without data races.
    """

    def __init__(
        self,
        jitter_range: tuple[float, float] = (0.75, 1.25),
        rng: Optional[random.Random] = None,
    ):
        self._deadlines: dict[str, float] = {}
        self._intervals: dict[str, float] = {}
        self._rng = rng or random.Random()
        self._lo, self._hi = jitter_range
        self._lock = threading.Lock()

    def schedule(self, name: str, base_interval: float, fire_at: float) -> None:
        """Register a named timer with its base interval and initial deadline."""
        with self._lock:
            self._intervals[name] = float(base_interval)
            self._deadlines[name] = float(fire_at)

    def peek_deadline(self, name: str) -> float | None:
        """Return the current deadline for *name*, or None if not scheduled."""
        with self._lock:
            return self._deadlines.get(name)

    def next_deadline(self) -> float:
        """Return the earliest deadline across all registered timers."""
        with self._lock:
            return min(self._deadlines.values())

    def elapsed(self, now: float) -> list[str]:
        """Return names of timers due at *now* and reschedule each with jitter."""
        with self._lock:
            due = [name for name, t in self._deadlines.items() if now >= t]
            for name in due:
                base = self._intervals[name]
                jitter = self._rng.uniform(self._lo, self._hi)
                self._deadlines[name] = now + base * jitter
            return due
