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

    _events = dict()
    _lock = Lock()

    _subscribers: list = []
    _sub_lock = Lock()

    @classmethod
    def subscribe(cls, fn):
        """Register *fn* as a subscriber; return a callable that unsubscribes it."""
        with cls._sub_lock:
            cls._subscribers.append(fn)

        def unsubscribe():
            with cls._sub_lock:
                try:
                    cls._subscribers.remove(fn)
                except ValueError:
                    pass

        return unsubscribe

    @classmethod
    def _broadcast(cls, event: dict) -> None:
        """Deliver *event* to all current subscribers.

        Exceptions raised by individual subscribers are logged and swallowed
        so that one bad subscriber cannot prevent others from receiving events.
        """
        with cls._sub_lock:
            snapshot = list(cls._subscribers)
        for fn in snapshot:
            try:
                fn(event)
            except Exception:
                _logger.exception("subscriber raised in EventTracer._broadcast")

    @classmethod
    def register_message_event(cls, message, on_sent=None, on_received=None, on_forwarded=None):
        event = MessageEvent(message, on_sent=on_sent, on_received=on_received, on_forwarded=on_forwarded)
        with cls._lock:
            cls._events[message] = event
        return event

    @classmethod
    def message_sent(cls, src, dst, msg):
        with cls._lock:
            event = cls._events.get(msg)

        if event is not None:
            return event.on_sent(src, dst, msg)

    @classmethod
    def message_received(cls, src, msg):
        with cls._lock:
            event = cls._events.get(msg)

        if event is not None:
            return event.on_received(src, msg)

    @classmethod
    def datagram_forwarded(cls, src, dst, datagram):
        with cls._lock:
            event = cls._events.get(datagram.payload())

        if event is not None:
            return event.on_forwarded(src, dst, datagram)
