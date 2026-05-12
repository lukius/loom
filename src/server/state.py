from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

from .persistence import prepare_session


class InvalidStateTransition(Exception):
    def __init__(self, from_state, to_state):
        super().__init__(f"invalid transition: {from_state} -> {to_state}")
        self.from_state = from_state
        self.to_state = to_state


class SimState:
    """Lifecycle controller for a running AS. Serializes state transitions.

    States: idle -> running <-> paused; running/paused -> idle via stop().
    """

    def __init__(self, source: Path):
        self._source = Path(source)
        self._session: Optional[Path] = None
        self._as = None
        self._state = "idle"
        self._lock = threading.RLock()

    # ---- accessors ----

    @property
    def state(self) -> str:
        return self._state

    @property
    def as_obj(self):
        return self._as

    @property
    def source(self) -> Path:
        return self._source

    @property
    def session_path(self) -> Path:
        if self._session is None:
            self._session = prepare_session(self._source)
        return self._session

    # ---- transitions ----

    def load_from_session(self):
        """Parse the session file into an AS. Routers are built but not started."""
        from parser import Parser  # noqa: PLC0415 (parser is a local package)

        with self._lock:
            if self._as is not None:
                self._as.stop()
            self._as = Parser(str(self.session_path)).parse()
            # Parser.parse() calls router.start() — stop them for "idle" semantics.
            for r in self._as.routers().values():
                r.stop()
            self._state = "idle"

    def start(self):
        """Transition idle -> running. No-op if already running."""
        with self._lock:
            if self._state == "running":
                return
            if self._state != "idle":
                raise InvalidStateTransition(self._state, "running")
            if self._as is None:
                raise InvalidStateTransition("no_topology", "running")
            self._as.gate().resume()
            for r in self._as.routers().values():
                r.start()
            self._state = "running"

    def pause(self):
        """Transition running -> paused."""
        with self._lock:
            if self._state != "running":
                raise InvalidStateTransition(self._state, "paused")
            self._as.gate().pause()
            self._state = "paused"

    def resume(self):
        """Transition paused -> running."""
        with self._lock:
            if self._state != "paused":
                raise InvalidStateTransition(self._state, "running")
            self._as.gate().resume()
            self._state = "running"

    def stop(self):
        """Transition any state -> idle. No-op if already idle."""
        with self._lock:
            if self._state == "idle":
                return
            if self._as is not None:
                self._as.stop()
                self._as = None
            self._state = "idle"
