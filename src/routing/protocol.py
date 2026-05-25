import threading
import time
import traceback
from abc import ABC, abstractmethod
from typing import Iterable

from entities.address import NullAddress
from entities.event import EventTracer

from .hello import Hello
from .lsa import LSA
from .lsdb import LSDB
from .messages import Datagram
from .neighbor import NeighborTable
from .policy import RFC1918_OUTBOUND, RouteMap


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

    def __init__(self, router, outbound_policy=None):
        self._router = router
        self._lock = threading.Lock()
        self._outbound_policy = (
            outbound_policy if outbound_policy is not None else RFC1918_OUTBOUND
        )

        self._seq = 0
        self._lsdb = LSDB(router)
        self._neighbor_table = NeighborTable()
        self._hello_interval: float = 10.0
        self._dead_interval: float = 30.0
        self._lsa_refresh_interval: float = 30.0
        self._max_age: float = 60.0
        # Permit-all policy for the local LSA stored in the LSDB — local
        # connectivity (including RFC 1918 prefixes) must appear in the
        # local graph so Dijkstra can route to directly-connected networks.
        # The outbound policy controls what gets FLOODED to peers, not what
        # goes into the local LSDB.
        self._local_policy = RouteMap(rules=[], default='permit')
        self._graph = self._lsdb.build_graph(eligible_origins=set())

        self._stopped = False
        self._stop_event = threading.Event()
        self._keepalive_interval = float(self.KEEPALIVE_INTERVAL)
        self._keepalive_thread = threading.Thread(
            target=self._keepalive_loop, daemon=True
        )

        self._graph_updated = True

    def keepalive_interval(self):
        return self._keepalive_interval

    def set_keepalive_interval(self, seconds):
        if not isinstance(seconds, (int, float)) or seconds <= 0:
            raise ValueError(f"keepalive interval must be positive (got {seconds!r})")
        self._keepalive_interval = float(seconds)

    # Canonical ratios from the loom-OSPF spec.
    _DEAD_INTERVAL_RATIO = 3
    _MAX_AGE_RATIO = 2

    def set_timers(self, hello_interval: float, lsa_refresh_interval: float):
        """Update protocol timers in one shot.

        Validates positivity and derives dead_interval = 3·hello and
        max_age = 2·refresh from the canonical loom-OSPF ratios.
        """
        if not isinstance(hello_interval, (int, float)) or hello_interval <= 0:
            raise ValueError(
                f"hello_interval must be positive (got {hello_interval!r})"
            )
        if (
            not isinstance(lsa_refresh_interval, (int, float))
            or lsa_refresh_interval <= 0
        ):
            raise ValueError(
                f"lsa_refresh_interval must be positive (got {lsa_refresh_interval!r})"
            )
        self._hello_interval = float(hello_interval)
        self._lsa_refresh_interval = float(lsa_refresh_interval)
        self._dead_interval = self._hello_interval * self._DEAD_INTERVAL_RATIO
        self._max_age = self._lsa_refresh_interval * self._MAX_AGE_RATIO

    def lsdb(self):
        return self._lsdb

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

    def stop(self):
        # Best-effort: flood a withdrawal LSA out every interface BEFORE
        # the thread is set up to exit, so peers can purge us immediately
        # instead of waiting max_age.
        try:
            self._flood_withdrawal()
        except Exception:
            traceback.print_exc()
        self._stopped = True
        self._stop_event.set()
        if self._keepalive_thread is not None and self._keepalive_thread.is_alive():
            self._keepalive_thread.join(timeout=2.0)

    def _flood_withdrawal(self):
        lsa = LSA.withdrawal(self._router, seq=self._next_seq())
        for _, iface in self._router.interfaces().items():
            broadcast = iface.network().broadcast_address()
            dgram = Datagram(
                src_addr=iface.address(), dst_addr=broadcast, payload=lsa,
            )
            iface.send_to(dgram, dst_addr=broadcast)

    def handle_incoming_message(self, msg, interface):
        if isinstance(msg, LSA):
            self._handle_incoming_lsa(msg, interface)
            return
        if isinstance(msg, Hello):
            self._handle_incoming_hello(msg, interface)
            return
        # Unknown message kind — drop.

    def _handle_incoming_lsa(self, lsa, interface):
        now = time.monotonic()
        with self._lock:
            # Ensure local links are reflected in the LSDB before installing
            # an external LSA so that _rebuild_graph_and_recompute always
            # has a current view of local connectivity.
            self._refresh_local_lsa()
            result = self._lsdb.install(lsa, now=now)
            if not result.is_accepted():
                return
            self._flood_lsa(lsa, exclude=interface)
            if result.changed_graph():
                self._rebuild_graph_and_recompute()

    def _handle_incoming_hello(self, hello, interface):
        now = time.monotonic()
        peer_listed_us = self._router in hello.neighbours_heard()
        transition = self._neighbor_table.record_hello(
            interface, hello.originator(),
            peer_listed_us=peer_listed_us,
            dead_interval=self._dead_interval,
            now=now,
        )
        if transition is None:
            return
        self._broadcast_neighbor_state_changed(transition)
        if transition.went_down():
            self._lsdb.purge(transition.neighbor().peer())
        # State change → eligibility may have changed.
        self._rebuild_graph_and_recompute()

    def _broadcast_neighbor_state_changed(self, transition):
        n = transition.neighbor()
        EventTracer._broadcast({
            "kind": "neighbor_state_changed",
            "device": self._router.name(),
            "interface": n.interface().name(),
            "peer": n.peer().name(),
            "state": transition.after().value,
            "last_hello_at": n.last_hello_at(),
            "peer_acked_at": n.peer_acked_at(),
        })

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def update_state(self):
        """Compatibility shim.

        Today's tests call update_state() to force-refresh local-iface
        info into the graph. After this task the local LSA carries
        that info via the LSDB; calling update_state() now re-installs
        the local LSA (with permit-all policy so all local networks are
        reflected in the graph). Tests using update_state() continue to work.
        """
        with self._lock:
            return self._refresh_local_lsa()

    def _refresh_local_lsa(self) -> bool:
        # Local LSA uses permit-all so the local graph includes all directly
        # connected networks (including RFC 1918). The outbound policy only
        # controls what is flooded to peers in _handle_update.
        lsa = LSA.from_router(
            self._router, seq=self._next_seq(), policy=self._local_policy,
        )
        result = self._lsdb.install(lsa, now=time.monotonic())
        if result.is_accepted() and result.changed_graph():
            self._rebuild_graph_and_recompute()
        return result.changed_graph()

    def _handle_update(self):
        """Originate a fresh Hello + LSA cycle. Sweeps dead-interval
        expiries, emits per-interface Hellos, and floods the local LSA.
        Called by the keepalive loop."""
        now = time.monotonic()
        with self._lock:
            # Sweep neighbours: catch dead-interval expiries that no
            # incoming hello can signal.
            for transition in self._neighbor_table.sweep_transitions(
                dead_interval=self._dead_interval, now=now,
            ):
                self._broadcast_neighbor_state_changed(transition)
                if transition.went_down():
                    self._lsdb.purge(transition.neighbor().peer())

            # Sweep expired LSAs: origins whose last refresh is older than
            # max_age are purged. The local router's own LSA is excluded —
            # it is always refreshed by this very loop.
            expired = self._lsdb.expired_origins(max_age=self._max_age, now=now)
            graph_dirty = False
            for origin in expired:
                if origin is self._router:
                    continue
                if self._lsdb.purge(origin):
                    graph_dirty = True
            if graph_dirty:
                self._rebuild_graph_and_recompute()

            # Build + install our LSA locally (permit-all so local graph
            # includes all directly connected networks including RFC 1918).
            seq = self._next_seq()
            local_lsa = LSA.from_router(
                self._router, seq=seq, policy=self._local_policy,
            )
            result = self._lsdb.install(local_lsa, now=now)
            if result.is_accepted() and result.changed_graph():
                self._rebuild_graph_and_recompute()

            # Flooded LSA: outbound policy applied — RFC 1918 prefixes omitted.
            flooded_lsa = LSA.from_router(
                self._router, seq=seq, policy=self._outbound_policy,
            )
            # Emit hellos (per-interface) + LSA (shared object).
            for _, iface in self._router.interfaces().items():
                broadcast = iface.network().broadcast_address()
                # Hello — per-interface content (lists non-DOWN neighbours heard
                # on this interface).
                listed = self._neighbor_table.neighbours_heard_on(
                    iface, dead_interval=self._dead_interval, now=now,
                )
                hello = Hello(originator=self._router, neighbours_heard=listed)
                hello_dgram = Datagram(
                    src_addr=iface.address(), dst_addr=broadcast, payload=hello,
                )
                iface.send_to(hello_dgram, dst_addr=broadcast)
                # LSA — shared object across all interfaces.
                lsa_dgram = Datagram(
                    src_addr=iface.address(), dst_addr=broadcast, payload=flooded_lsa,
                )
                iface.send_to(lsa_dgram, dst_addr=broadcast)

    def _flood_lsa(self, lsa, exclude):
        """Re-flood `lsa` out every interface except `exclude` (the inbound)."""
        for name, iface in self._router.interfaces().items():
            if name == exclude.name():
                continue
            broadcast = iface.network().broadcast_address()
            dgram = Datagram(
                src_addr=iface.address(), dst_addr=broadcast, payload=lsa,
            )
            iface.send_to(dgram, dst_addr=broadcast)

    def _rebuild_graph_and_recompute(self):
        now = time.monotonic()
        bidi = self._neighbor_table.bidirectional_peers(
            dead_interval=self._dead_interval, now=now,
        )
        # Eligible origins: direct TWO_WAY neighbours are always trusted. For
        # non-adjacent origins (origins we've never exchanged Hellos with),
        # trust them only when at least one TWO_WAY adjacency exists — this
        # allows multi-hop LSA flooding to build the full graph while still
        # excluding unverified LSAs injected with no adjacency context at all.
        if bidi:
            known_direct = {n.peer() for n in self._neighbor_table.all()}
            eligible = {
                o for o in self._lsdb.origins()
                if o is not self._router and (o in bidi or o not in known_direct)
            }
        else:
            eligible = bidi  # empty set — no trusted context yet
        self._graph = self._lsdb.build_graph(eligible_origins=eligible)
        self._recompute_routing_table()

    def _recompute_routing_table(self):
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

        rules_payload = [
            {
                "prefix": str(r.prefix()),
                "next_hop": str(r.next_hop()),
                "iface": r.interface().name(),
            }
            for r in routing_table.rules()
        ]

        # LS-protocol-level: the link-state graph dictated a new set of
        # rules. Emitted whenever LinkStateProtocol writes into the
        # routing table; downstream tooling that wants to know "the LS
        # protocol changed its view" subscribes to lsdb_changed.
        EventTracer._broadcast(
            {
                "kind": "lsdb_changed",
                "device": self._router.name(),
                "rules": rules_payload,
            }
        )

        # BGP-FOLLOWUP: today LinkStateProtocol fires routing_table_changed
        # itself because it owns the write into the routing table. When BGP
        # arrives and the Router-level RIB merge takes over the write path,
        # move this broadcast out of here and into the merge step. lsdb_changed
        # above is correctly per-protocol and stays.
        EventTracer._broadcast(
            {
                "kind": "routing_table_changed",
                "device": self._router.name(),
                "rules": rules_payload,
            }
        )

    def installed_rules(self):
        # BGP-FOLLOWUP: today this returns the full routing table because LS
        # writes there directly. Once BGP is the second protocol, this should
        # return only the rules THIS protocol contributed (so the Router-level
        # RIB merge can apply administrative distance correctly).
        """Yield rules currently installed by this protocol.

        Today LinkStateProtocol writes directly into the router's
        RoutingTable via _recompute_routing_table. This accessor returns
        those rules so the Router-level RIB merge (introduced in D.1.c)
        can see what each protocol contributes without changing the
        current write path.
        """
        return list(self._router.routing_table().rules())

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

    def _safe_tick(self):
        try:
            self._handle_update()
        except Exception:
            traceback.print_exc()
