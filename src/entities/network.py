import queue
import threading
import traceback

from .address import Address
from .base import Entity
from .device import NetworkDevice


class Network(Entity):

    def __init__(self, name, address, gate=None):
        super().__init__(name)
        self._address = address
        self._gate = gate
        # Keyed by interface IP address (unique per network), not by iface.name().
        # Interface names are only unique per-device — e.g. r1.eth0 and r2.eth0
        # both sit on the same LAN — so keying by name would clobber siblings.
        self._interfaces = dict()
        self._in_queue = queue.Queue()

        self._stopped = False
        self._pkt_thread = threading.Thread(target=self._pkt_loop, daemon=True)
        self._pkt_thread.start()

    def address(self):
        return self._address

    def broadcast_address(self):
        return self._address.broadcast()

    def add_interface(self, interface):
        self._interfaces[interface.address()] = interface
        interface._set_out_queue(self._in_queue)

    def devices(self) -> dict:
        return {
            interface.device().name(): interface.device()
            for interface in self._interfaces.values()
        }

    def has_device(self, device: NetworkDevice) -> bool:
        for iface in self._interfaces.values():
            if iface.device() == device:
                return True
        return False

    def contains_address(self, address: Address) -> bool:
        return self._address.matches(address)

    def stop(self):
        for iface in self._interfaces.values():
            iface.stop()
        self._in_queue.put(None)

    def join(self):
        self._pkt_thread.join()

    def _dispatch_packet(self, packet):
        dst = packet.destination()
        if dst == self.broadcast_address():
            self._dispatch_broadcast(packet)
        else:
            self._dispatch_unicast(packet, dst)

    def _dispatch_unicast(self, packet, dst):
        dst_interface = self._interface_with_address(dst)
        dst_interface.receive(packet)

    def _dispatch_broadcast(self, packet):
        for dst_iface in self._interfaces.values():
            dst_iface.receive(packet)

    def _interface_with_address(self, address):
        iface = self._interfaces.get(address)
        if iface is None:
            raise Exception(f'{address} not in {self._name}')
        return iface

    def _pkt_loop(self):
        while not self._stopped:
            if self._gate is not None:
                running, stopped = self._gate.wait_or_stop()
                if stopped:
                    self._stopped = True
                    continue
            try:
                packet = self._in_queue.get(timeout=0.05)
            except queue.Empty:
                continue
            if packet is None:
                self._stopped = True
                continue
            if self._gate is not None and not self._gate.is_running():
                # Gate was paused between the check above and the dequeue:
                # put the packet back so it stays observable in the queue.
                self._in_queue.put(packet)
                continue
            try:
                self._dispatch_packet(packet)
            except Exception:
                traceback.print_exc()

