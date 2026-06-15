import time as _time
import uuid


class Packet:

    def __init__(self, src_addr, dst_addr, payload):
        self._src_addr = src_addr
        self._dst_addr = dst_addr
        self._payload = payload

    def source(self):
        return self._src_addr

    def destination(self):
        return self._dst_addr

    def payload(self):
        return self._payload

    def rewrite_source(self, addr):
        self._src_addr = addr

    def rewrite_destination(self, addr):
        self._dst_addr = addr


class Frame(Packet):
    # Semantic L2 wrapper — no added state by design. Used as a marker at
    # Interface.send_to so the dispatch loop can distinguish the outer frame
    # from the encapsulated Datagram payload.
    pass


class Message:
    # NAT multiplexing: request/reply subtypes that may run concurrently
    # from a single private LAN should expose a `seq` attribute matching
    # on request and reply. See entities/nat.py::flow_id().

    def __init__(self):
        self._id = uuid.uuid4()

    def type(self):
        return self.__class__

    def id(self):
        return self._id

    def flow_key(self) -> str:
        # Stable identifier for the end-to-end conversation this message
        # belongs to. Keyed on the payload, not the packet's address pair,
        # so it survives NAT rewriting src/dst mid-path. Request/reply
        # subtypes (PingReply) override this to echo the originating
        # request's key, so both directions share one conversation id.
        return str(self._id)

    def __eq__(self, other):
        if other.__class__ != self.__class__:
            return False
        return self._id == other.id()

    def __hash__(self):
        return hash(self._id)


class UserMessage(Message):

    def __init__(self, payload):
        super().__init__()
        self._payload = payload

    def payload(self):
        return self._payload


class PingRequest(Message):
    def __init__(self, seq: int):
        super().__init__()
        self._seq = seq
        self._sent_at = _time.monotonic()

    @property
    def seq(self) -> int: return self._seq

    @property
    def sent_at(self) -> float: return self._sent_at


class PingReply(Message):
    def __init__(self, seq: int, request_ts: float, request_id=None):
        super().__init__()
        self._seq = seq
        self._request_ts = request_ts
        # Echoed from the originating PingRequest so request + reply share
        # a single conversation key (see Message.flow_key).
        self._request_id = request_id

    @property
    def seq(self) -> int: return self._seq

    @property
    def request_ts(self) -> float: return self._request_ts

    @property
    def request_id(self): return self._request_id

    def flow_key(self) -> str:
        if self._request_id is None:
            return super().flow_key()
        return str(self._request_id)


def _payload_id(payload) -> str | None:
    """Return a string payload identifier, or None if the payload has no id.

    Centralised here so interface.py and router.py share the same guard rather
    than each repeating the ``hasattr`` idiom inline.
    """
    return str(payload.id()) if hasattr(payload, "id") else None


# Re-exported so `from entities.packet import Datagram, RoutingMessage` and
# `from entities import Datagram, RoutingMessage` still resolve. Canonical
# home for these wire-format classes is routing.messages.
from routing.lsa import RoutingMessage  # noqa: E402, F401
from routing.messages import Datagram  # noqa: E402, F401
