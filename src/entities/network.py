import queue
import threading

from .base import Entity
from .device import NetworkDevice
from .address import Address


class Network(Entity):

    def __init__(self, name, address):
        super().__init__(name)
        self._address = address
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
        self._interfaces[interface.name()] = interface
        interface._set_out_queue(self._in_queue)

    def devices(self) -> dict:
        return {
            interface.device().name(): interface.device()
            for _, interface in self._interfaces.items()
        }

    def has_device(self, device: NetworkDevice) -> bool:
        for _, iface in device.interfaces().items():
            net_iface = self._interfaces.get(iface.name())
            if net_iface is not None and net_iface.device() == device:
                return True
        return False

    def contains_address(self, address: Address) -> bool:
        return self._address.matches(address)

    def stop(self):
        for _, iface in self._interfaces.items():
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
        for _, dst_iface in self._interfaces.items():
            dst_iface.receive(packet)

    def _interface_with_address(self, address):
        for _, iface in self._interfaces.items():
            if iface.address() == address:
                return iface
        raise Exception(f'{address} not in {self._name}')

    def _pkt_loop(self):
        while not self._stopped:
            packet = self._in_queue.get()
            if packet is None:
                self._stopped = True
                continue
            self._dispatch_packet(packet)

