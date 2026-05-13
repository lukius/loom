import queue
import threading
import traceback

from .address import Address
from .base import Entity
from .packet import Datagram, Frame

_PACKET_KIND = {
    "RoutingMessage": "routing_flood",
    "UserMessage": "user_datagram",
    "PingRequest": "ping_request",
    "PingReply": "ping_reply",
}


def _classify(payload) -> str:
    return _PACKET_KIND.get(type(payload).__name__, "unknown")


class Interface(Entity):

    def __init__(self, name, network, address, cost=0, gate=None):
        super().__init__(name)
        self._net = network
        self._address = address
        self._cost = cost
        self._gate = gate
        self._device = None

        self._in_queue = queue.Queue()
        self._out_queue = None

        self._stopped = False
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

    def stop(self):
        self._in_queue.put(None)

    def join(self):
        self._pkt_thread.join()

    def send_to(self, datagram: Datagram, dst_addr: Address):
        from .event import EventTracer

        frame = Frame(src_addr=self._address, dst_addr=dst_addr, payload=datagram)
        self._out_queue.put(frame)
        # `payload_id` identifies a single Message (one direction of a flow);
        # `flow` identifies an end-to-end conversation between two endpoints
        # (e.g. a ping request and its reply share the same flow). The UI
        # uses `flow` to animate hops sequentially across both directions.
        payload = datagram.payload()
        payload_id = str(payload.id()) if hasattr(payload, "id") else None
        payload_src = str(datagram.source())
        payload_dst = str(datagram.destination())
        endpoints = sorted([payload_src, payload_dst])
        flow = f"{endpoints[0]}<->{endpoints[1]}"
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
            }
        )

    def receive(self, datagram):
        self._in_queue.put(datagram)

    def _set_device(self, device):
        self._device = device

    def _set_out_queue(self, net_queue):
        self._out_queue = net_queue

    def _pkt_loop(self):
        while not self._stopped:
            frame = self._in_queue.get()
            if frame is None:
                self._stopped = True
                continue
            if self._gate is not None:
                running, stopped = self._gate.wait_or_stop()
                if stopped:
                    self._stopped = True
                    continue
            try:
                if self._device is None:
                    raise Exception('interface not ready')
                self._device.handle_packet(frame.payload(), self)
            except Exception:
                traceback.print_exc()
