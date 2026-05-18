import collections
import threading
import traceback
from abc import ABC, abstractmethod
from typing import Iterable

from entities.address import NullAddress
from entities.event import EventTracer

from .graph import NetworkGraph
from .messages import Datagram, RoutingMessage


class RoutingProtocol(ABC):
    """Abstract interface every routing protocol must implement.

    Today there's only one concrete subclass (LinkStateProtocol). The
    interface exists so a second protocol (e.g. simplified BGP) can be
    added to a Router without redesigning Router's protocol-holding shape.

    Each concrete protocol owns its own keepalive lifecycle and produces
    routes via `installed_rules()`; the Router's RIB merges across all
    its protocols (see D.1.c).
    """

    @abstractmethod
    def start(self) -> None: ...

    @abstractmethod
    def stop(self) -> None: ...

    @abstractmethod
    def handle_incoming_message(self, msg, interface) -> None: ...

    @abstractmethod
    def installed_rules(self) -> Iterable:
        """Yield this protocol's contributions to the RIB.

        Each rule carries `(prefix, next_hop, interface)` (today's
        `RoutingRule` shape). Administrative distance ordering is the
        RIB's responsibility, not the protocol's.
        """


class LinkStateProtocol(RoutingProtocol):

    KEEPALIVE_INTERVAL = 10

    def __init__(self, router):
        self._router = router
        self._lock = threading.Lock()

        self._seqs_by_address = collections.defaultdict(lambda: -1)
        self._seqs = collections.defaultdict(lambda: 0)

        self._stopped = False
        self._stop_event = threading.Event()
        self._keepalive_interval = self.KEEPALIVE_INTERVAL
        self._keepalive_thread = threading.Thread(
            target=self._keepalive_loop, daemon=True
        )

        self._init_graph()
        self._graph_updated = True

    def keepalive_interval(self):
        return self._keepalive_interval

    def set_keepalive_interval(self, seconds):
        if not isinstance(seconds, (int, float)) or seconds <= 0:
            raise ValueError(f"keepalive interval must be positive (got {seconds!r})")
        self._keepalive_interval = float(seconds)

    def start(self):
        # Always clear the stop flag first. A start() that follows a prior
        # stop() on the same protocol instance (e.g. tests reusing a router,
        # or the shell `read` re-loading a topology after pings stopped the
        # threads) would otherwise see _stopped=True and exit on first wake.
        self._stopped = False
        self._stop_event.clear()
        if self._keepalive_thread is not None and self._keepalive_thread.is_alive():
            return                                    # idempotent on running
        self._keepalive_thread = threading.Thread(
            target=self._keepalive_loop, daemon=True
        )
        self._keepalive_thread.start()

    def _init_graph(self):
        self._graph = NetworkGraph()
        self._graph.add_router(self._router)

    def handle_incoming_message(self, msg, interface):
        local_changed = self.update_state()

        src_addr = msg.src_address()
        seq = msg.seq()

        with self._lock:
            if seq > self._seqs_by_address[src_addr]:
                self._flood_msg(msg, interface)
                self._seqs_by_address[src_addr] = seq

                changed = self._update_graph(msg) or local_changed
                self._recompute_if_dirty(changed)

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

    def _recompute_if_dirty(self, changed: bool):
        if not changed:
            return

        routing_table = self._router.routing_table()
        routing_table.clear()
        paths = self._graph.shortest_paths(self._router)
        for prefix in self._graph.networks():
            path = paths.get(prefix)
            if path is None or len(path) < 2:
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

        EventTracer._broadcast(
            {
                "kind": "routing_table_changed",
                "device": self._router.name(),
                "rules": [
                    {
                        "prefix": str(r.prefix()),
                        "next_hop": str(r.next_hop()),
                        "iface": r.interface().name(),
                    }
                    for r in routing_table.rules()
                ],
            }
        )

    def _handle_update(self):
        changed = self.update_state()
        self._recompute_if_dirty(changed)

        for _, interface in self._router.interfaces().items():
            # NB: per-interface sequence is wrong for LSP semantics. Real
            # LSP protocols use a single per-origin sequence so all
            # neighbours converge on one canonical view. Fixing this
            # needs the link-state extension work (single-sequence-per-
            # origin) which is deferred until the BGP work makes the
            # layering meaningful — see
            # docs/superpowers/specs/2026-05-18-pre-external-routing-prep-design.md
            # section 2.1.
            self._seqs[interface.name()] += 1
            seq = self._seqs[interface.name()]

            msg = RoutingMessage(interface, seq)

            for name, iface in self._router.interfaces().items():
                prefix = iface.network().address()
                if prefix.is_private():
                    continue
                cost = iface.cost()
                msg.add_destination(prefix, cost)

            net_broadcast = interface.network().broadcast_address()
            datagram = Datagram(
                src_addr=interface.address(), dst_addr=net_broadcast, payload=msg
            )
            interface.send_to(datagram, dst_addr=net_broadcast)

    def _flood_msg(self, msg, interface):
        for name, iface in self._router.interfaces().items():
            if name == interface.name():
                continue

            net_broadcast = iface.network().broadcast_address()
            datagram = Datagram(
                src_addr=iface.address(), dst_addr=net_broadcast, payload=msg
            )
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
        # Synchronous shutdown: setting `_stop_event` wakes the keepalive
        # thread out of its interval wait, then we join. Callers (tests,
        # server session reloads) can rely on the thread being fully
        # unwound when stop() returns, so a subsequent start() — or a
        # neighbouring test — can't race a stale tick.
        self._stopped = True
        self._stop_event.set()
        if self._keepalive_thread is not None and self._keepalive_thread.is_alive():
            self._keepalive_thread.join(timeout=2.0)

    def _keepalive_loop(self):
        gate = self._router.gate()
        # Initial tick so neighbors learn about us at t~0 instead of after one interval.
        if gate is not None:
            running, stopped = gate.wait_or_stop()
            if stopped:
                return
            if running:
                self._safe_tick()
        else:
            self._safe_tick()
        while not self._stopped:
            # Sleep on the protocol's own stop event so that protocol.stop()
            # (called e.g. by SimState.load_from_session without involving
            # the AS-level gate) wakes the thread immediately. AS.stop() and
            # protocol.stop() are paired by system.stop(), so AS-level
            # shutdown still terminates promptly via the second call.
            if self._stop_event.wait(timeout=self._keepalive_interval):
                break
            if gate is not None:
                running, stopped = gate.wait_or_stop()
                if stopped:
                    break
                if not running:
                    continue  # paused; loop again without ticking
            self._safe_tick()

    def installed_rules(self):
        """Yield rules currently installed by this protocol.

        Today LinkStateProtocol writes directly into the router's
        RoutingTable via _recompute_if_dirty. This accessor returns
        those rules so the Router-level RIB merge (introduced in D.1.c)
        can see what each protocol contributes without changing the
        current write path.
        """
        return list(self._router.routing_table().rules())

    def _safe_tick(self):
        try:
            self._handle_update()
        except Exception:
            traceback.print_exc()
