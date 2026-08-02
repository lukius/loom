import logging
import threading
import time
from abc import ABC, abstractmethod
from typing import Iterable

from entities.address import NullAddress
from entities.clock import wait_for_gate
from entities.event import EventTracer

from .hello import Hello
from .lsa import LSA
from .lsdb import LSDB
from .messages import Datagram
from .neighbor import NeighborTable
from .policy import PERMIT_ALL, RFC1918_OUTBOUND
from .scheduler import Scheduler

_logger = logging.getLogger(__name__)


class RoutingProtocol(ABC):
    """Abstract interface every routing protocol must implement.

    Today there's only one concrete subclass (LinkStateProtocol). The
    interface exists so a second protocol (e.g. simplified BGP) can be
    added to a Router without redesigning Router's protocol-holding shape.

    Each concrete protocol owns its own keepalive lifecycle and produces
    routes via `installed_rules()`; the Router's RIB merges across all
    its protocols.
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

    def local_links_changed(self) -> None:
        """Local interface state (cost, neighbor reachability, …) changed.

        Default no-op. Protocols that derive their advertisements from
        local interface state override this to re-emit immediately
        instead of waiting for the next periodic refresh.
        """


class LinkStateProtocol(RoutingProtocol):

    def __init__(self, router, outbound_policy=None):
        self._router = router
        self._lock = threading.Lock()
        self._seq_lock = threading.Lock()
        self._outbound_policy = (
            outbound_policy if outbound_policy is not None else RFC1918_OUTBOUND
        )

        self._seq = time.monotonic_ns()
        self._lsdb = LSDB(router)
        self._neighbor_table = NeighborTable()

        # Lifecycle state and scheduler initialised before set_timers so that
        # set_timers can unconditionally reference them (no hasattr scaffolding).
        self._stopped = False
        self._stop_event = threading.Event()
        self._wake_event = threading.Event()
        self._scheduler = Scheduler()
        self._protocol_thread = None

        # Bootstrap timer state to the canonical loom-OSPF production defaults
        # (hello=10s, refresh=30s, dead=30s, max_age=60s).
        # _scheduler/_wake_event exist so set_timers schedules the initial
        # deadlines; _protocol_thread is None so loop_running is False and
        # reconciliation treats all deadlines as absent (→ fire_at = now+interval).
        # _schedule_initial_deadlines overwrites those with fresh timestamps when
        # the loop starts, so the construction-time scheduling is effectively a
        # no-op on observable behaviour.
        self.set_timers(hello_interval=10.0, lsa_refresh_interval=30.0)

        # Permit-all policy for the local LSA stored in the LSDB — local
        # connectivity (including RFC 1918 prefixes) must appear in the
        # local graph so Dijkstra can route to directly-connected networks.
        # The outbound policy controls what gets FLOODED to peers, not what
        # goes into the local LSDB.
        self._local_policy = PERMIT_ALL
        self._graph = self._lsdb.build_graph(eligible_origins=set())

        self._protocol_thread = threading.Thread(
            target=self._protocol_loop, daemon=True,
        )

    # Canonical ratios from the loom-OSPF spec.
    _DEAD_INTERVAL_RATIO = 3
    _MAX_AGE_RATIO = 2

    def set_timers(self, hello_interval: float, lsa_refresh_interval: float):
        """Update protocol timers in one shot.

        Validates positivity and derives dead_interval = 3·hello and
        max_age = 2·refresh from the canonical loom-OSPF ratios.
        """
        self._validate_positive(hello_interval, "hello_interval")
        self._validate_positive(lsa_refresh_interval, "lsa_refresh_interval")
        self._hello_interval = float(hello_interval)
        self._lsa_refresh_interval = float(lsa_refresh_interval)
        self._dead_interval = self._hello_interval * self._DEAD_INTERVAL_RATIO
        self._max_age = self._lsa_refresh_interval * self._MAX_AGE_RATIO
        # Max-age check runs at the same cadence as LSA refresh so that a
        # stale LSA is caught within one refresh interval after it expires.
        self._maxage_check_interval = self._lsa_refresh_interval
        # Refresh the scheduler so a live config change takes effect on the
        # next loop iteration.
        now = time.monotonic()
        loop_running = (
            self._protocol_thread is not None
            and self._protocol_thread.is_alive()
        )
        for name, interval in (
            ('hello', self._hello_interval),
            ('lsa_refresh', self._lsa_refresh_interval),
            ('maxage_check', self._maxage_check_interval),
        ):
            self._reconcile_deadline(name, interval, now, loop_running)
        # Wake a parked protocol loop so it picks up the new cadence promptly
        # instead of waiting until the old timer fires.
        self._wake_event.set()

    @staticmethod
    def _validate_positive(value, label: str) -> None:
        """Raise ValueError if *value* is not a positive number."""
        if not isinstance(value, (int, float)) or value <= 0:
            raise ValueError(f"{label} must be positive (got {value!r})")

    def _reconcile_deadline(
        self, name: str, interval: float, now: float, loop_running: bool
    ) -> None:
        """Schedule *name* with a fire_at that honours an in-flight deadline.

        When the loop is running and the existing deadline is further away
        than the new interval, reset fire_at to now+interval so the loop
        fires at the new (shorter) cadence.  When the loop is not running
        (bootstrap or pre-start), preserve the existing fire_at to avoid
        spurious immediate fires on start.  A brand-new timer (no existing
        deadline) always schedules at now+interval.
        """
        existing = self._scheduler.peek_deadline(name)
        if existing is None:
            fire_at = now + interval
        elif loop_running and (existing - now) > interval:
            fire_at = now + interval
        else:
            fire_at = existing
        self._scheduler.schedule(name, base_interval=interval, fire_at=fire_at)

    def hello_interval(self) -> float:
        return self._hello_interval

    def lsa_refresh_interval(self) -> float:
        return self._lsa_refresh_interval

    def lsdb(self):
        return self._lsdb

    def start(self):
        # Always clear the stop flag first. A start() that follows a prior
        # stop() on the same protocol instance (e.g. tests reusing a router)
        # would otherwise see _stopped=True and exit on first wake.
        self._stopped = False
        self._stop_event.clear()
        if self._protocol_thread is not None and self._protocol_thread.is_alive():
            return                                    # idempotent on running
        self._protocol_thread = threading.Thread(
            target=self._protocol_loop, daemon=True,
        )
        self._protocol_thread.start()

    def stop(self):
        # Best-effort: flood a withdrawal LSA out every interface BEFORE
        # the thread is set up to exit, so peers can purge us immediately
        # instead of waiting max_age.
        try:
            self._flood_withdrawal()
        except Exception:
            _logger.exception("error flooding withdrawal LSA on stop")
        self._stopped = True
        self._stop_event.set()
        self._wake_event.set()  # ensure a parked loop exits immediately
        if self._protocol_thread is not None and self._protocol_thread.is_alive():
            self._protocol_thread.join(timeout=2.0)

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
        # A router is the sole authority on its own LSA. An LSA that names us
        # as origin is an echo of our own flood that a peer re-flooded back
        # over a different network. Installing it would let the echo's
        # sequence number race our locally-managed one, and re-flooding it
        # would feed the loop — a self-sustaining LSA storm. The local LSA is
        # owned exclusively by the refresh/announce path, so drop self-echoes.
        if lsa.origin() is self._router:
            return
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
        peer_listed_us = self._router in hello.neighbors_heard()
        transition = self._neighbor_table.record_hello(
            interface, hello.originator(),
            peer_listed_us=peer_listed_us,
            dead_interval=self._dead_interval,
            now=now,
        )
        if transition is None:
            return
        with self._lock:
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
        with self._seq_lock:
            self._seq += 1
            return self._seq

    def _refresh_local_lsa(self) -> bool:
        # Local LSA uses permit-all so the local graph includes all directly
        # connected networks (including RFC 1918). The outbound policy only
        # controls what is flooded to peers in _run_keepalive_cycle.
        lsa = LSA.from_router(
            self._router, seq=self._next_seq(), policy=self._local_policy,
        )
        result = self._lsdb.install(lsa, now=time.monotonic())
        if result.is_accepted() and result.changed_graph():
            self._rebuild_graph_and_recompute()
        return result.changed_graph()

    def _run_keepalive_cycle(self):
        """Run one full keepalive cycle synchronously.

        Sweeps dead neighbors and expired LSAs, then emits a Hello and an
        LSA on every up interface — the same three steps the background
        protocol loop executes on each scheduled tick.
        """
        now = time.monotonic()
        self._sweep_dead_and_expired(now)
        self._emit_hello_on_up_interfaces(now)
        self._emit_lsa_on_up_interfaces(now)

    def _sweep_dead_and_expired(self, now: float):
        with self._lock:
            changed = False
            for transition in self._neighbor_table.sweep_transitions(
                dead_interval=self._dead_interval, now=now,
            ):
                self._broadcast_neighbor_state_changed(transition)
                if transition.went_down():
                    self._lsdb.purge(transition.neighbor().peer())
                # A state change alters which origins are eligible, and a
                # purge here removes the dead peer's links for good — the
                # max-age path below can no longer notice it. Recompute now
                # or the table keeps forwarding through a router that is
                # gone. Mirrors _handle_incoming_hello's transition branch.
                changed = True
            expired = self._lsdb.expired_origins(max_age=self._max_age, now=now)
            for origin in expired:
                if origin is self._router:
                    continue
                if self._lsdb.purge(origin):
                    changed = True
            if changed:
                self._rebuild_graph_and_recompute()

    def _emit_hello_on_up_interfaces(self, now: float):
        with self._lock:
            for _, iface in self._router.interfaces().items():
                if not iface.is_up():
                    continue
                broadcast = iface.network().broadcast_address()
                listed = self._neighbor_table.neighbors_heard_on(
                    iface, dead_interval=self._dead_interval, now=now,
                )
                hello = Hello(originator=self._router, neighbors_heard=listed)
                dgram = Datagram(
                    src_addr=iface.address(), dst_addr=broadcast, payload=hello,
                )
                iface.send_to(dgram, dst_addr=broadcast)

    def local_links_changed(self) -> None:
        # A locally-driven cost or interface change must propagate now,
        # not at the next periodic lsa_refresh tick (which can be up to
        # lsa_refresh_interval + jitter away — ~37s with defaults).
        # Emit a fresh LSA, install it locally (recomputes SPF if links
        # actually changed), and flood it out every up interface so peers
        # converge too.
        now = time.monotonic()
        self._emit_lsa_on_up_interfaces(now)
        # Reset the periodic refresh deadline so a flurry of edits doesn't
        # produce a tail of identical periodic refreshes right behind us.
        if self._scheduler.peek_deadline('lsa_refresh') is not None:
            self._scheduler.schedule(
                'lsa_refresh',
                base_interval=self._lsa_refresh_interval,
                fire_at=now + self._lsa_refresh_interval,
            )

    def _emit_lsa_on_up_interfaces(self, now: float):
        with self._lock:
            seq = self._next_seq()
            # Install a permit-all LSA locally so the local graph includes
            # all directly connected networks (including RFC 1918).
            local_lsa = LSA.from_router(
                self._router, seq=seq, policy=self._local_policy,
            )
            local_result = self._lsdb.install(local_lsa, now=now)
            if local_result.is_accepted() and local_result.changed_graph():
                self._rebuild_graph_and_recompute()
            # Flood with outbound policy: RFC 1918 prefixes omitted.
            flooded_lsa = LSA.from_router(
                self._router, seq=seq, policy=self._outbound_policy,
            )
            for _, iface in self._router.interfaces().items():
                if not iface.is_up():
                    continue
                broadcast = iface.network().broadcast_address()
                dgram = Datagram(
                    src_addr=iface.address(), dst_addr=broadcast, payload=flooded_lsa,
                )
                iface.send_to(dgram, dst_addr=broadcast)

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
        # Eligible origins: direct TWO_WAY neighbors are always trusted. For
        # non-adjacent origins (origins we've never exchanged Hellos with),
        # trust them only when at least one TWO_WAY adjacency exists — this
        # allows multi-hop LSA flooding to build the full graph while still
        # excluding unverified LSAs injected with no adjacency context at all.
        if bidi:
            seen_direct_peers = {n.peer() for n in self._neighbor_table.all()}
            eligible = {
                o for o in self._lsdb.origins()
                if o is not self._router and (o in bidi or o not in seen_direct_peers)
            }
        else:
            eligible = bidi  # empty set — no trusted context yet
        self._graph = self._lsdb.build_graph(eligible_origins=eligible)
        self._recompute_routing_table()

    def _recompute_routing_table(self):
        routing_table = self._router.routing_table()
        routing_table.clear()
        paths = self._graph.shortest_paths(self._router)
        self._build_rules_from_paths(paths, routing_table)
        rules_payload = [
            {
                "prefix": str(r.prefix()),
                "next_hop": str(r.next_hop()),
                "iface": r.interface().name(),
            }
            for r in routing_table.rules()
        ]
        self._emit_rule_change_events(rules_payload)

    def _build_rules_from_paths(self, paths, routing_table) -> None:
        """Install routing rules derived from shortest-path results."""
        for prefix in self._graph.networks():
            path = paths.get(prefix)
            if path is None or len(path) < 2:
                continue
            next_hop_network = path[1]
            next_hop_address = self._next_hop_address(next_hop_network, path)
            for _, iface in self._router.interfaces().items():
                if iface.network().address() == next_hop_network:
                    routing_table.add_rule(prefix, next_hop_address, iface)
                    break

    def _next_hop_address(self, next_hop_network, path):
        """Resolve the next-hop IP for a path via an intermediate router.

        Returns NullAddress when the destination is directly connected
        (path length <= 2, meaning no intermediate router node), or the
        IP address of the intermediate router's interface on next_hop_network
        when a multi-hop path is present.
        """
        if len(path) <= 2:
            return NullAddress
        next_hop_router = path[2]
        for _, iface in next_hop_router.interfaces().items():
            if iface.network().address() == next_hop_network:
                return iface.address()
        return NullAddress

    def _emit_rule_change_events(self, rules_payload: list) -> None:
        """Broadcast lsdb_changed and routing_table_changed with the new rules."""
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

    def withdraw(self) -> None:
        """Flood a withdrawal LSA out every interface (graceful departure).

        Called before interfaces are disabled, so the withdrawal actually
        transmits — peers purge this origin immediately instead of waiting
        for max_age.
        """
        self._flood_withdrawal()

    def announce(self) -> None:
        """Emit Hello + LSA on every up interface right now (re-announce).

        Used on restore so a re-enabled interface / resumed router rejoins
        at t~=0 rather than after a full interval.

        Any adjacency tracked on a just-restored interface across its down
        period is stale: while the interface was down the peer's Hellos were
        dropped, so the cached neighbor state no longer reflects reality.
        Forget those records first so the peer's returning Hello drives a
        genuine DOWN→…→TWO_WAY transition — which retriggers the SPF
        recompute. Without this, a stale TWO_WAY record absorbs the
        returning Hello silently and the routing table never reconverges.
        """
        for _, iface in self._router.interfaces().items():
            if iface.is_up():
                self._neighbor_table.clear_on(iface)
        now = time.monotonic()
        self._emit_hello_on_up_interfaces(now)
        self._emit_lsa_on_up_interfaces(now)

    def installed_rules(self):
        # BGP-FOLLOWUP: today this returns the full routing table because LS
        # writes there directly. Once BGP is the second protocol, this should
        # return only the rules THIS protocol contributed (so the Router-level
        # RIB merge can apply administrative distance correctly).
        """Yield rules currently installed by this protocol.

        Today LinkStateProtocol writes directly into the router's
        RoutingTable via _recompute_routing_table. This accessor returns
        those rules so the Router-level RIB merge can see what each
        protocol contributes without changing the current write path.
        """
        return list(self._router.routing_table().rules())

    def _schedule_initial_deadlines(self):
        now = time.monotonic()
        self._scheduler.schedule(
            'hello',
            base_interval=self._hello_interval,
            fire_at=now + self._hello_interval,
        )
        self._scheduler.schedule(
            'lsa_refresh', base_interval=self._lsa_refresh_interval,
            fire_at=now + self._lsa_refresh_interval,
        )
        self._scheduler.schedule(
            'maxage_check', base_interval=self._maxage_check_interval,
            fire_at=now + self._maxage_check_interval,
        )

    def _protocol_loop(self):
        gate = self._router.gate()
        # Initial tick: hello + LSA at t≈0 (no jitter).
        now = time.monotonic()
        if not wait_for_gate(gate, self._stop_event):
            return
        self._safe_tick_initial(now)
        self._schedule_initial_deadlines()

        while not self._stopped:
            now = time.monotonic()
            wait_for = max(0.0, self._scheduler.next_deadline() - now)
            self._wake_event.wait(timeout=wait_for)
            self._wake_event.clear()
            if self._stopped:
                break
            if not wait_for_gate(gate, self._stop_event):
                break
            now = time.monotonic()
            for name in self._scheduler.elapsed(now):
                self._dispatch(name, now)

    def _safe_tick_initial(self, now: float):
        try:
            self._emit_hello_on_up_interfaces(now)
            self._emit_lsa_on_up_interfaces(now)
        except Exception:
            _logger.exception("error during initial protocol tick")

    def _dispatch(self, name: str, now: float):
        try:
            if name == 'hello':
                self._emit_hello_on_up_interfaces(now)
            elif name == 'lsa_refresh':
                self._emit_lsa_on_up_interfaces(now)
            elif name == 'maxage_check':
                self._sweep_dead_and_expired(now)
        except Exception:
            _logger.exception("error dispatching protocol tick %r", name)
