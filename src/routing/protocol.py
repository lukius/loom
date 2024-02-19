import collections
import threading
import time

from .graph import NetworkGraph


class RoutingProtocol(object):

    KEEPALIVE_INTERVAL = 30

    def __init__(self, router):
        self._router = router
        self._graph = NetworkGraph()
        self._lock = threading.Lock()

        self._seqs = collections.defaultdict(lambda: 0)
        self._prev_state = collections.defaultdict(lambda: 0)

        self._stopped = False
        self._keepalive_thread = threading.Thread(target=self._keepalive_loop, daemon=True)
        self._keepalive_thread.start()

    def handle_incoming_message(self, msg, interface):
        pass

    def _update_state(self):
        state_changed = False

        interfaces = self._router.interfaces()
        if len(interfaces) != len(self._prev_state):
            state_changed = True

        for name, iface in interfaces.items():
            prev_cost = self._prev_state[name]
            if prev_cost != iface.cost():
                state_changed = True
            self._prev_state[name] = iface.cost()

        return state_changed

    def _handle_update(self, interface):
        from entities import RoutingMessage, Datagram

        self._seqs[interface.name()] += 1
        seq = self._seqs[interface.name()]

        msg = RoutingMessage(interface, seq)

        for name, iface in self._router.interfaces().items():
            if name == interface.name():
                continue

            prefix = iface.network().address()
            cost = iface.cost()
            msg.add_destination(prefix, cost)

        net_broadcast = interface.network().broadcast_address()
        datagram = Datagram(src_addr=interface.address(), dst_addr=net_broadcast, payload=msg)
        interface.send_to(datagram, dst_addr=net_broadcast)

    def stop(self):
        self._stopped = True

    def _keepalive_loop(self):
        while not self._stopped:
            time.sleep(self.KEEPALIVE_INTERVAL)
            state_changed = self._update_state()
            if state_changed:
                for _, iface in self._router.interfaces().items():
                    self._handle_update(iface)