import collections
import threading
import time

from .graph import NetworkGraph


class RoutingProtocol(object):

    KEEPALIVE_INTERVAL = 30

    def __init__(self, router):
        self._router = router
        self._lock = threading.Lock()

        self._seqs_by_address = collections.defaultdict(lambda: 0)
        self._seqs = collections.defaultdict(lambda: 0)
        self._prev_state = collections.defaultdict(lambda: 0)

        self._stopped = False
        self._keepalive_thread = threading.Thread(target=self._keepalive_loop, daemon=True)
        self._keepalive_thread.start()

        self._init_graph()

    def _init_graph(self):
        self._graph = NetworkGraph()
        self._graph.add_node(self._router)
        for _, iface in self._router.interfaces().items():
            prefix = iface.network().address()
            cost = iface.cost()
            self._graph.add_node(prefix)
            self._graph.add_edge(src=self._router, dst=prefix, weight=cost)

    def handle_incoming_message(self, msg, interface):
        src_addr = msg.src_address()
        seq = msg.seq()
        with self._lock:
            if seq > self._seqs_by_address[src_addr]:
                self._flood_msg(msg, interface)
                self._seqs_by_address[src_addr] = seq

                updated = self._update_graph(msg)
                if updated:
                    # TODO
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

        # TODO: same seq
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

    def _flood_msg(self, msg, interface):
        from entities import Datagram

        for name, iface in self._router.interfaces().items():
            if name == interface.name():
                continue

            net_broadcast = iface.network().broadcast_address()
            datagram = Datagram(src_addr=iface.address(), dst_addr=net_broadcast, payload=msg)
            iface.send_to(datagram, dst_addr=net_broadcast)

    def _update_graph(self, msg):
        updated = False
        src_router = msg.src_router().name()

        if src_router not in self._graph:
            self._graph.add_node(src_router)
            updated = True

        for prefix, cost in msg.destinations().items():
            if prefix not in self._graph:
                self._graph.add_node(prefix)
                updated = True

            current_cost = self._graph.weight(src=src_router, dst=prefix)
            if current_cost != cost:
                self._graph.add_edge(src=src_router, dst=prefix, weight=cost)
                updated = True

        return updated

    def stop(self):
        self._stopped = True

    def _keepalive_loop(self):
        while not self._stopped:
            time.sleep(self.KEEPALIVE_INTERVAL)
            state_changed = self._update_state()
            if state_changed:
                for _, iface in self._router.interfaces().items():
                    self._handle_update(iface)