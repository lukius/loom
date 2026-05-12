from __future__ import annotations

import asyncio
import threading
from typing import Set


class EventBus:
    """Threadsafe fan-out from worker threads to asyncio WS handlers."""

    def __init__(
        self, loop: asyncio.AbstractEventLoop | None = None, max_queue: int = 1000
    ):
        self._loop = loop
        self._max_queue = max_queue
        self._queues: Set[asyncio.Queue] = set()
        self._lock = threading.Lock()
        self._overflow_count = 0

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue(maxsize=self._max_queue)
        with self._lock:
            self._queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._queues.discard(q)

    def emit(self, event: dict) -> None:
        """Called from any thread. Non-blocking. Drops oldest on overflow."""
        if self._loop is None:
            return
        with self._lock:
            queues = list(self._queues)
        for q in queues:
            self._loop.call_soon_threadsafe(self._enqueue, q, event)

    def _enqueue(self, q: asyncio.Queue, event: dict) -> None:
        if q.full():
            try:
                q.get_nowait()
                self._overflow_count += 1
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            self._overflow_count += 1

    @property
    def overflow_count(self) -> int:
        return self._overflow_count
