import logging
from datetime import datetime
from threading import Lock

_logger = logging.getLogger(__name__)


class Event:

    _id_seq = 0
    _id_lock = Lock()

    @classmethod
    def _new_id(cls):
        with cls._id_lock:
            event_id = cls._id_seq
            cls._id_seq += 1
            return event_id

    def __init__(self):
        self._id = self._new_id()
        self._lock = Lock()
        self._callbacks = list()

    def id(self):
        return self._id

    def add_callback(self, callback):
        with self._lock:
            self._callbacks.append(callback)


class MessageEvent(Event):

    def __init__(self, message, on_sent=None, on_received=None, on_forwarded=None):
        super().__init__()
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


class EventLog:

    def __init__(self):
        self._logs = list()
        self._lock = Lock()

    def add_log(self, log):
        timestamp = datetime.now()
        log = f'[{timestamp}] {log}'
        with self._lock:
            self._logs.append(log)

    def dump(self):
        with self._lock:
            return self._logs

    def dump_string(self):
        with self._lock:
            return '\n'.join(self._logs)


class EventTracer:
    """Per-Internet event bus.

    Instances own their own subscribers and event log. The class-level
    methods (``EventTracer._broadcast(...)`` etc.) delegate to the
    currently-active instance set via ``set_current()``. With one
    ``Internet`` per process today, behavior is identical to the previous
    class-level singleton, but the seam exists for per-``Internet``
    isolation in tests and for a multi-``Internet`` future.
    """

    _current: 'EventTracer | None' = None
    _current_lock = Lock()

    def __init__(self):
        self._events = dict()
        self._lock = Lock()
        self._subscribers = []
        self._sub_lock = Lock()

    # ---- class-level API (delegates to current) ----

    @classmethod
    def set_current(cls, tracer: 'EventTracer | None') -> None:
        with cls._current_lock:
            cls._current = tracer

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
        """Register *fn* as a subscriber; return a callable that unsubscribes it."""
        with self._sub_lock:
            self._subscribers.append(fn)

        def unsubscribe():
            with self._sub_lock:
                try:
                    self._subscribers.remove(fn)
                except ValueError:
                    pass

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
