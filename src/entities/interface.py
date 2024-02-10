import queue
import threading

from .base import Entity
from .address import Address
from .packet import Datagram, Frame


class Interface(Entity):

    def __init__(self, name, network, address, cost=0):
        super().__init__(name)
        self._net = network
        self._address = address
        self._cost = cost
        self._device = None

        self._in_queue = queue.Queue()
        self._out_queue = None

        self._pkt_thread = threading.Thread(target=self._pkt_loop, daemon=True)
        self._stopped = False
        self._pkt_thread.start()

    def device(self):
        return self._device

    def network(self):
        return self._net

    def address(self):
        return self._address

    def cost(self):
        return self._cost

    def send_to(self, datagram: Datagram, dst_addr: Address):
        frame = Frame(src_addr=self._address, dst_addr=dst_addr, payload=datagram)
        self._out_queue.put(frame)

    def _set_device(self, device):
        self._device = device

    def _set_out_queue(self, net_queue):
        self._out_queue = net_queue

    def _pkt_loop(self):
        while not self._stopped:
            packet = self._in_queue.get()
            if self._device is None:
                # TODO: interface not ready exception
                raise Exception('interface not ready')
            self._device.handle_packet(packet, self)
