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

        self._stopped = False
        self._keepalive_thread = threading.Thread(target=self._keepalive_loop, daemon=True)

        self._init_graph()
        self._graph_updated = True

    def start(self):
        self._keepalive_thread.start()

    def _init_graph(self):
        self._graph = NetworkGraph()
        self._graph.add_router(self._router)

    def handle_incoming_message(self, msg, interface):
        from entities.address import NullAddress

        self.update_state()

        src_addr = msg.src_address()
        seq = msg.seq()

        with self._lock:
            if seq > self._seqs_by_address[src_addr]:
                self._flood_msg(msg, interface)
                self._seqs_by_address[src_addr] = seq

                updated = self._update_graph(msg)
                if updated:
                    routing_table = self._router.routing_table()
                    routing_table.clear()
                    paths = self._graph.shortest_paths(self._router)
                    for prefix in self._graph.networks():
                        path = paths.get(prefix, list())
                        if len(path) < 2:
                            continue
                        next_hop_network = path[1]
                        next_hop_address = NullAddress
                        if len(path) > 2:
                            next_hop = path[2]
                            for _, iface in next_hop.interfaces().items():
                                if iface.network().address() == next_hop_network:
                                    next_hop_address = iface.address()
                                    break

                        for _, iface in self._router.interfaces().items():
                            if iface.network().address() == next_hop_network:
                                routing_table.add_rule(prefix, next_hop_address, iface)
                                break

    def update_state(self):
        with self._lock:
            self._graph_updated = False

            for _, iface in self._router.interfaces().items():
                prefix = iface.network().address()
                cost = iface.cost()

                if prefix not in self._graph:
                    self._graph.add_network(prefix)
                    self._graph_updated = True

                prev_cost = self._graph.weight(src=self._router, dst=prefix)
                if prev_cost != cost:
                    self._graph_updated = True
                    self._graph.add_edge(src=self._router, dst=prefix, weight=cost)

            return self._graph_updated

    def _handle_update(self):
        from entities import RoutingMessage, Datagram

        self.update_state()

        for _, interface in self._router.interfaces().items():
            # TODO: same seq
            self._seqs[interface.name()] += 1
            seq = self._seqs[interface.name()]

            msg = RoutingMessage(interface, seq)

            for name, iface in self._router.interfaces().items():
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
        self._graph_updated = False
        src_router = msg.src_router()

        if src_router not in self._graph:
            self._graph.add_router(src_router)
            self._graph_updated = True

        for prefix, cost in msg.destinations().items():
            if prefix not in self._graph:
                self._graph.add_network(prefix)
                self._graph_updated = True

            current_cost = self._graph.weight(src=src_router, dst=prefix)
            if current_cost != cost:
                self._graph.add_edge(src=src_router, dst=prefix, weight=cost)
                self._graph_updated = True

        return self._graph_updated

    def stop(self):
        self._stopped = True

    def _keepalive_loop(self):
        while not self._stopped:
            self._handle_update()
            time.sleep(self.KEEPALIVE_INTERVAL)
