import logging
from collections import OrderedDict
from threading import Lock

# Maximum number of in-flight message events tracked by EventTracer._events.
# Oldest entries are evicted first once the registry reaches this size.
# 4096 is comfortably larger than any realistic in-flight population.
_MAX_TRACKED_EVENTS = 4096

_logger = logging.getLogger(__name__)


class Event:
    """Minimal base for simulator events."""


class MessageEvent(Event):

    def __init__(self, message, on_sent=None, on_received=None, on_forwarded=None):
        self._message = message
        self._on_sent = on_sent or (lambda *a, **kw: None)
        self._on_received = on_received or (lambda *a, **kw: None)
        self._on_forwarded = on_forwarded or (lambda *a, **kw: None)

    def message(self):
        return self._message

    def on_sent(self, *args, **kwargs):
        return self._on_sent(*args, **kwargs)

    def on_received(self, *args, **kwargs):
        return self._on_received(*args, **kwargs)

    def on_forwarded(self, *args, **kwargs):
        return self._on_forwarded(*args, **kwargs)


class EventTracer:
    """Per-Internet event bus.

    Instances own their own subscribers and event log. The class-level
    methods (``EventTracer._broadcast(...)`` etc.) delegate to the
    currently-active instance set via ``set_current()``. With one
    ``Internet`` per process today, behavior is identical to the previous
    class-level singleton, but the seam exists for per-``Internet``
    isolation in tests and for a multi-``Internet`` future.

    When ``set_current()`` replaces one tracer with another, any subscribers
    registered on the previous tracer are carried over to the new one, so
    long-lived subscribers (e.g. a server-side event bridge registered at
    startup) remain active across topology reloads.
    """

    _current: 'EventTracer | None' = None
    _current_lock = Lock()

    def __init__(self):
        self._events = OrderedDict()
        self._lock = Lock()
        self._subscribers = []
        self._sub_lock = Lock()

    # ---- class-level API (delegates to current) ----

    @classmethod
    def set_current(cls, tracer: 'EventTracer') -> None:
        """Make `tracer` the current process-wide tracer.

        Subscribers registered on the previous current tracer are
        carried over to the new one. This preserves long-lived
        subscribers (e.g. the server's EventBus bridge registered at
        lifespan startup) across `Internet` reloads, while still
        allowing tests to isolate by setting `_current = None` first.
        """
        with cls._current_lock:
            previous = cls._current
            cls._current = tracer

        if previous is None or tracer is None or previous is tracer:
            return

        # Snapshot the previous tracer's subscribers, then append them
        # to the new one's subscriber list.
        with previous._sub_lock:
            carried = list(previous._subscribers)
        if not carried:
            return
        with tracer._sub_lock:
            for fn in carried:
                if fn not in tracer._subscribers:
                    tracer._subscribers.append(fn)

    @classmethod
    def current(cls) -> 'EventTracer':
        with cls._current_lock:
            if cls._current is None:
                cls._current = EventTracer()
            return cls._current

    @classmethod
    def subscribe(cls, fn):
        return cls.current().subscribe_instance(fn)

    @classmethod
    def _broadcast(cls, event: dict) -> None:
        cls.current()._broadcast_instance(event)

    @classmethod
    def register_message_event(
        cls, message, on_sent=None, on_received=None, on_forwarded=None
    ):
        return cls.current().register_message_event_instance(
            message, on_sent=on_sent, on_received=on_received, on_forwarded=on_forwarded
        )

    @classmethod
    def message_sent(cls, src, dst, msg):
        return cls.current().message_sent_instance(src, dst, msg)

    @classmethod
    def message_received(cls, src, msg):
        return cls.current().message_received_instance(src, msg)

    @classmethod
    def datagram_forwarded(cls, src, dst, datagram):
        return cls.current().datagram_forwarded_instance(src, dst, datagram)

    # ---- instance-level API ----

    def subscribe_instance(self, fn):
        """Register *fn* as a subscriber; return a callable that unsubscribes it.

        The returned callable removes *fn* from the currently-active tracer
        (``EventTracer.current()``) as well as from the instance it was
        originally registered on.  This ensures that after a ``set_current()``
        carry-over (which propagates *fn* to a new tracer), calling
        ``unsubscribe()`` silences *fn* on the new tracer rather than only
        on the now-retired original.
        """
        with self._sub_lock:
            self._subscribers.append(fn)

        origin = self

        def _remove_from(tracer):
            with tracer._sub_lock:  # noqa: SLF001
                try:
                    tracer._subscribers.remove(fn)  # noqa: SLF001
                except ValueError:
                    pass

        def unsubscribe():
            current = EventTracer.current()
            _remove_from(current)
            if origin is not current:
                _remove_from(origin)

        return unsubscribe

    def _broadcast_instance(self, event: dict) -> None:
        """Deliver *event* to all current subscribers.

        Exceptions raised by individual subscribers are logged and swallowed
        so that one bad subscriber cannot prevent others from receiving events.
        """
        with self._sub_lock:
            snapshot = list(self._subscribers)
        for fn in snapshot:
            try:
                fn(event)
            except Exception:
                _logger.exception("subscriber raised in EventTracer._broadcast")

    def register_message_event_instance(
        self, message, on_sent=None, on_received=None, on_forwarded=None
    ):
        event = MessageEvent(
            message, on_sent=on_sent, on_received=on_received, on_forwarded=on_forwarded
        )
        with self._lock:
            self._events[message] = event
            # Evict the oldest entry when the registry exceeds the cap so that
            # _events remains bounded for the lifetime of a tracer.
            if len(self._events) > _MAX_TRACKED_EVENTS:
                self._events.popitem(last=False)
        return event

    def message_sent_instance(self, src, dst, msg):
        with self._lock:
            event = self._events.get(msg)
        if event is not None:
            return event.on_sent(src, dst, msg)

    def message_received_instance(self, src, msg):
        with self._lock:
            event = self._events.get(msg)
        if event is not None:
            return event.on_received(src, msg)

    def datagram_forwarded_instance(self, src, dst, datagram):
        with self._lock:
            event = self._events.get(datagram.payload())
        if event is not None:
            return event.on_forwarded(src, dst, datagram)
