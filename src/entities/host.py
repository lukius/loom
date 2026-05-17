import itertools
import threading
import time

from .address import Address
from .device import NetworkDevice
from .event import EventTracer
from .interface import Interface  # noqa: F401
from .packet import Datagram, PingReply, PingRequest, UserMessage

PING_TIMEOUT_S = 3.0


class Host(NetworkDevice):

    def __init__(self, name, net, address, gw_address=None, gate=None):
        super().__init__(name)

        iface_name = f'iface_{name}'
        self._interface = Interface(iface_name, net, address, gate=gate)
        self.add_interface(self._interface)

        self._gw_address = gw_address
        self._gate = gate

        self._ping_seq = itertools.count()
        self._ping_lock = threading.Lock()
        self._pending_pings: dict[tuple, threading.Event] = {}
        self._ping_results: dict[tuple, float] = {}

    def network(self):
        return self._interface.network()

    def address(self):
        return self._interface.address()

    def interface(self):
        return self._interface

    def gateway(self):
        return self._gw_address

    def set_gateway(self, addr: Address) -> None:
        if not self._interface.network().contains_address(addr):
            raise ValueError(f"gateway {addr} not in host network")
        self._gw_address = addr

    def send_message_to(self, msg: UserMessage, addr: Address):
        src = self.address()
        datagram = Datagram(src_addr=src, dst_addr=addr, payload=msg)
        if self._interface.network().contains_address(addr):
            dst_addr = addr
        else:
            dst_addr = self._gw_address
        if dst_addr is None:
            raise ValueError("no route to host: no gateway configured")
        self._interface.send_to(datagram, dst_addr=dst_addr)

        return EventTracer.message_sent(src=src, dst=addr, msg=msg)

    def ping(self, dst_addr: Address, timeout: float = PING_TIMEOUT_S):
        seq = next(self._ping_seq)
        key = (str(dst_addr), seq)
        evt = threading.Event()
        with self._ping_lock:
            self._pending_pings[key] = evt

        request = PingRequest(seq)
        datagram = Datagram(src_addr=self.address(), dst_addr=dst_addr, payload=request)
        if self._interface.network().contains_address(dst_addr):
            send_dst = dst_addr
        elif self._gw_address is None:
            with self._ping_lock:
                self._pending_pings.pop(key, None)
            raise ValueError("no route to host: no gateway configured")
        else:
            send_dst = self._gw_address
        self._interface.send_to(datagram, dst_addr=send_dst)

        arrived = evt.wait(timeout=timeout)
        with self._ping_lock:
            self._pending_pings.pop(key, None)
            rtt = self._ping_results.pop(key, None)

        return rtt if arrived else None

    def _handle_message(self, msg, interface, packet):
        if isinstance(msg, PingRequest):
            originator = packet.source()
            reply = PingReply(
                seq=msg.seq, request_ts=msg.sent_at, request_id=msg.id(),
            )
            datagram = Datagram(
                src_addr=self.address(), dst_addr=originator, payload=reply
            )
            if self._interface.network().contains_address(originator):
                send_dst = originator
            else:
                send_dst = self._gw_address or originator
            self._interface.send_to(datagram, dst_addr=send_dst)
            return
        if isinstance(msg, PingReply):
            originator = packet.source()
            key = (str(originator), msg.seq)
            with self._ping_lock:
                evt = self._pending_pings.get(key)
                if evt is None:
                    return
                self._ping_results[key] = time.monotonic() - msg.request_ts
                evt.set()
            return
        if msg.type() == UserMessage:
            return EventTracer.message_received(src=self.address(), msg=msg)

    def _handle_forwarding(self, packet):
        # TODO
        raise Exception(f'{self._name}: cannot forward datagrams')
