import queue
import threading
import traceback

from .address import Address
from .base import Entity
from .event import EventTracer
from .exception import InterfaceNotReadyException
from .packet import Datagram, Frame, PingReply, PingRequest, RoutingMessage, UserMessage

# How often (seconds) a gate-parked worker re-checks its own stop flag so
# that stop() is noticed within one poll interval rather than after the full
# join timeout.  Mirrors LinkStateProtocol._PAUSE_POLL_INTERVAL.
_PAUSE_POLL_INTERVAL = 0.1

_PACKET_KIND = {
    "Hello": "hello",
    "LSA": "routing_flood",
    "RoutingMessage": "routing_flood",
    "UserMessage": "user_datagram",
    "PingRequest": "ping_request",
    "PingReply": "ping_reply",
}

# Deferred imports: routing.lsa / routing.hello import entities.packet.Message;
# placing these after module-level code avoids the circular-init race.
from routing.hello import Hello  # noqa: E402, PLC0415
from routing.lsa import LSA  # noqa: E402, PLC0415


def _classify(payload) -> str:
    return _PACKET_KIND.get(type(payload).__name__, "unknown")


def _summarize_payload(payload) -> dict:
    """Per-Message-subclass metadata broadcast on each packet event as
    ``payload``. Free-form by design — future message types add their own
    keys without coordinating with subscribers."""
    if isinstance(payload, UserMessage):
        body = payload.payload()
        try:
            n = len(body)
        except TypeError:
            n = 0
        summary = {"bytes": n}
        if isinstance(body, str):
            summary["text"] = body
        return summary
    if isinstance(payload, PingRequest):
        return {"seq": payload.seq}
    if isinstance(payload, PingReply):
        return {"seq": payload.seq, "request_ts": payload.request_ts}
    if isinstance(payload, Hello):
        return {
            "originator": payload.originator().name(),
            "neighbors_heard": [r.name() for r in payload.neighbors_heard()],
        }
    if isinstance(payload, LSA):
        return {
            "seq": payload.seq(),
            "originator": payload.origin().name(),
            "destinations": [
                {"prefix": str(p), "cost": c}
                for p, c in payload.links().items()
            ],
        }
    if isinstance(payload, RoutingMessage):
        return {
            "seq": payload.seq(),
            "destinations": [],
        }
    return {}


class Interface(Entity):

    def __init__(self, name, network, address, cost=0, gate=None):
        super().__init__(name)
        self._net = network
        self._address = address
        self._cost = cost
        self._gate = gate
        self._device = None
        self._up = True

        self._in_queue = queue.Queue()
        self._out_queue = None

        self._stopped = False
        self._stop_event = threading.Event()
        self._pkt_thread = threading.Thread(target=self._pkt_loop, daemon=True)
        self._pkt_thread.start()

    def device(self):
        return self._device

    def network(self):
        return self._net

    def address(self):
        return self._address

    def cost(self):
        return self._cost

    def set_cost(self, cost: int):
        self._cost = cost

    def is_up(self) -> bool:
        return self._up

    def disable(self) -> None:
        self._up = False
        self._emit_state()

    def enable(self) -> None:
        self._up = True
        self._emit_state()

    def _emit_state(self) -> None:
        EventTracer._broadcast(
            {
                "kind": "interface_state_changed",
                "device": self._device.name() if self._device else None,
                "interface": self._name,
                "up": self._up,
            }
        )

    def stop(self):
        # Set the stop event BEFORE the sentinel so a gate-parked worker's
        # next poll sees the flag and exits without waiting for the gate to
        # resume.  The None sentinel wakes a worker blocked on queue.get().
        self._stop_event.set()
        self._in_queue.put(None)
        self._pkt_thread.join(timeout=2.0)

    def join(self):
        self._pkt_thread.join()

    def send_to(self, datagram: Datagram, dst_addr: Address):
        if not self._up:
            return  # administratively down — do not transmit
        frame = Frame(src_addr=self._address, dst_addr=dst_addr, payload=datagram)
        self._out_queue.put(frame)
        # `payload_id` identifies a single Message instance (one direction);
        # `flow` is the conversation key the payload reports — stable across
        # NAT rewrites of src/dst and shared between request and reply when
        # the payload supports it (see Message.flow_key).
        payload = datagram.payload()
        payload_id = str(payload.id()) if hasattr(payload, "id") else None
        flow = payload.flow_key() if hasattr(payload, "flow_key") else None
        payload_src = str(datagram.source())
        payload_dst = str(datagram.destination())
        EventTracer._broadcast(
            {
                "kind": "packet",
                "type": _classify(payload),
                "payload_id": payload_id,
                "payload_src": payload_src,
                "payload_dst": payload_dst,
                "flow": flow,
                "src": {
                    "device": self._device.name() if self._device else None,
                    "iface": self._name,
                    "address": str(self._address),
                },
                "dst": {"address": str(dst_addr)},
                "network": self._net.name(),
                "payload": _summarize_payload(payload),
            }
        )

    def receive(self, datagram):
        self._in_queue.put(datagram)

    def _set_device(self, device):
        self._device = device

    def _set_out_queue(self, net_queue):
        self._out_queue = net_queue

    def _await_gate_running(self) -> bool:
        """Block until the gate is RUNNING, or until this interface is stopped.

        Returns True when the loop should proceed (gate running or no gate),
        False when it should exit (gate stopped, or stop() was called on this
        interface).

        When the gate is PAUSED, polls every _PAUSE_POLL_INTERVAL seconds and
        re-checks _stop_event each time, so stop() is noticed within one poll
        interval instead of after the full join timeout.
        """
        if self._gate is None:
            return True
        while not self._stop_event.is_set():
            running, stopped = self._gate.wait_or_stop(timeout=_PAUSE_POLL_INTERVAL)
            if stopped:
                return False        # AS gate stopped
            if running:
                return True         # gate resumed — proceed
            # (False, False): timeout while paused — re-check _stop_event
        return False                # stop() set _stop_event

    def _pkt_loop(self):
        while not self._stopped:
            frame = self._in_queue.get()
            if frame is None:
                self._stopped = True
                continue
            if not self._await_gate_running():
                self._stopped = True
                continue
            try:
                if self._device is None:
                    raise InterfaceNotReadyException()
                self._device.handle_packet(frame.payload(), self)
            except Exception:
                traceback.print_exc()
