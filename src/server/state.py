from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

import yaml

from entities import Address, Host, Interface, Link, Network, NetworkAddress, Router
from entities.event import EventTracer
from parser import Parser

from .persistence import atomic_write, prepare_session
from .persistence import reset_session as _reset_session_file


class InvalidStateTransition(Exception):
    def __init__(self, from_state, to_state):
        super().__init__(f"invalid transition: {from_state} -> {to_state}")
        self.from_state = from_state
        self.to_state = to_state


class SimState:
    """Lifecycle controller for a running AS. Serializes state transitions.

    States: idle -> running <-> paused; running/paused -> idle via stop().
    """

    def __init__(self, source: Path):
        self._source = Path(source)
        self._session: Optional[Path] = None
        self._internet = None
        self._as = None
        self._state = "idle"
        self._lock = threading.RLock()
        self._edit_lock = threading.Lock()

    # ---- accessors ----

    @property
    def state(self) -> str:
        return self._state

    @property
    def as_obj(self):
        return self._as

    @property
    def source(self) -> Path:
        return self._source

    @property
    def session_path(self) -> Path:
        if self._session is None:
            self._session = prepare_session(self._source)
        return self._session

    # ---- safe readers ----

    def device_under_lock(self, name: str):
        """Resolve a device by name under _lock.

        Raises InvalidStateTransition('no_topology', ...) if no topology is
        loaded, or propagates HostNotFoundException/RouterNotFoundException
        (both subclass EntityException) if the name is unknown. Callers map
        these to 409/404 respectively.

        The returned device object is valid at the moment of resolution. If the
        caller needs to act on it, it should do so promptly; operations on
        entities from a torn-down sim are idempotent (stops, disabled ifaces)
        and will not raise unhandled exceptions.
        """
        with self._lock:
            if self._as is None:
                raise InvalidStateTransition("no_topology", "device_lookup")
            return self._as.device(name)

    def as_obj_under_lock(self):
        """Return the current AS object under _lock, or None if idle.

        Use this when the caller needs a single consistent snapshot of _as
        for both a None-check and subsequent attribute access (avoiding TOCTOU).
        """
        with self._lock:
            return self._as

    def routers_under_lock(self) -> list:
        """Return a stable snapshot of the routers list under _lock.

        Prevents 'dictionary changed size during iteration' if stop() or
        load_from_session() rebuilds the routers dict concurrently.
        Returns an empty list when no topology is loaded.
        """
        with self._lock:
            if self._as is None:
                return []
            return list(self._as.routers().values())

    def dump_yaml_under_lock(self) -> str | None:
        """Return the current topology as YAML under _lock, or None if idle.

        Both the None-check and the dump are inside a single _lock acquisition
        so stop() cannot null _as between them.
        """
        with self._lock:
            if self._as is None:
                return None
            return self._dump_yaml()

    # ---- transitions ----

    def load_from_session(self):
        """Parse the session file into an AS. Routers are built but not started.

        Takes _edit_lock then _lock (matching stop()'s ordering) so that a
        load cannot race an in-flight edit() or stop() that is still joining
        old worker threads.
        """
        with self._edit_lock:
            with self._lock:
                if self._internet is not None:
                    self._internet.stop()
                # `start_routing=False`: build routers without starting their
                # keepalive threads. Starting them here would let the initial
                # routing tick fire — emitting packet events on a sim that is
                # still 'idle' — before /sim/start has been called.
                internet = Parser(str(self.session_path)).parse(start_routing=False)
                self._internet = internet
                self._as = internet.single_as()
                self._state = "idle"

    def reset_session(self):
        """Re-clone the source file and reload the topology atomically.

        Under _edit_lock (matching load_from_session's ordering): reclones the
        source onto the session path, clears the cached session reference, then
        re-parses — all in one critical section so no concurrent editor or loader
        can observe the partially-reset state.
        """
        with self._edit_lock:
            self._session = _reset_session_file(self._source)
            with self._lock:
                if self._internet is not None:
                    self._internet.stop()
                internet = Parser(str(self._session)).parse(start_routing=False)
                self._internet = internet
                self._as = internet.single_as()
                self._state = "idle"

    def start(self):
        """Transition idle -> running. No-op if already running."""
        with self._lock:
            if self._state == "running":
                return
            if self._state != "idle":
                raise InvalidStateTransition(self._state, "running")
            if self._as is None:
                raise InvalidStateTransition("no_topology", "running")
            self._as.gate().resume()
            for r in self._as.routers().values():
                r.start()
            self._state = "running"

    def pause(self):
        """Transition running -> paused."""
        with self._lock:
            if self._state != "running":
                raise InvalidStateTransition(self._state, "paused")
            self._as.gate().pause()
            self._state = "paused"

    def resume(self, patch: list[dict] | None = None):
        """Transition paused -> running, applying an optional topology patch."""
        with self._edit_lock:
            with self._lock:
                if self._state != "paused":
                    raise InvalidStateTransition(self._state, "running")
                if patch:
                    self._apply_patch(patch)
                self._as.gate().resume()
                self._state = "running"
                self._persist()

    def edit(self, patch: list[dict] | None = None):
        """Apply a topology patch to a running sim, atomically against other
        editors. Validate-all-then-apply-all under the editor lock; readers
        (packet/protocol threads) snapshot interface dicts and never block.

        _lock is held across _apply_patch and _persist so that a concurrent
        GET /topology (_dump_yaml under _lock) cannot observe a half-mutated
        dict. EventTracer._broadcast is called AFTER _lock is released to
        avoid running subscriber callbacks under the lock.
        """
        if not patch:
            return
        with self._edit_lock:
            with self._lock:
                if self._state != "running":
                    raise InvalidStateTransition(self._state, "edit")
                self._apply_patch(patch)
                self._persist()
        EventTracer._broadcast({"kind": "topology_changed", "ops": patch})

    # ---- patch helpers ----

    def _apply_patch(self, patch: list[dict]) -> None:
        """Validate the whole patch against a virtual post-patch state — so
        cross-op references like `add_link` followed by `add_host(link=…)`
        in the same patch resolve — then apply every op for real. The
        patch stays atomic: any validation failure aborts before apply.
        """
        self._validate_patch(patch)
        for op in patch:
            self._apply_op(op)

    def _validate_patch(self, patch: list[dict]) -> None:
        fabrics = set(self._as.networks().keys()) | set(self._as.links().keys())
        devices = set(self._as.hosts().keys()) | set(self._as.routers().keys())
        # Address ownership keyed by (fabric_name, address_str). Tracks adds
        # made earlier in the same patch so collisions are caught even when
        # the colliding peer is itself a freshly-queued add.
        addr_owner: dict[tuple[str, str], str] = {}
        for h in self._as.hosts().values():
            addr_owner[(h.network().name(), str(h.address()))] = h.name()
        for r in self._as.routers().values():
            for ifn, iff in r.interfaces().items():
                addr_owner[(iff.network().name(), str(iff.address()))] = (
                    f"{r.name()}/{ifn}"
                )

        for op in patch:
            self._validate_op(op, fabrics, devices, addr_owner)

    def _iface_fabric_key(self, op_or_iface: dict, op_kind: str) -> str:
        """Return the fabric key (`network` or `link`) carried by an op.

        Exactly one of the two must be present; raises invalid_patch otherwise.
        """
        has_net = "network" in op_or_iface
        has_link = "link" in op_or_iface
        if has_net == has_link:  # both or neither
            raise InvalidStateTransition("invalid_patch", op_kind)
        return "network" if has_net else "link"

    # ---- per-op validators ----

    def _validate_add_network(
        self, op: dict, fabrics: set, devices: set, addr_owner: dict
    ) -> None:
        if not all(k in op for k in ("name", "address")):
            raise InvalidStateTransition("invalid_patch", "add_network")
        if op["name"] in fabrics:
            raise InvalidStateTransition("duplicate_name", op["name"])
        fabrics.add(op["name"])

    def _validate_add_link(
        self, op: dict, fabrics: set, devices: set, addr_owner: dict
    ) -> None:
        if not all(k in op for k in ("name", "address")):
            raise InvalidStateTransition("invalid_patch", "add_link")
        if op["name"] in fabrics:
            raise InvalidStateTransition("duplicate_name", op["name"])
        # Defer CIDR-format validation to construct-time below, but bail
        # early on obviously wrong shapes.
        try:
            NetworkAddress(op["address"])
        except Exception as e:
            raise InvalidStateTransition("invalid_link_cidr", str(e))
        # Links are /30 or /31 only — same rule the parser enforces.
        cidr = op["address"]
        prefix = cidr.rsplit("/", 1)[-1] if "/" in cidr else ""
        if prefix not in ("30", "31"):
            raise InvalidStateTransition("invalid_link_cidr", cidr)
        fabrics.add(op["name"])

    def _validate_remove_network(
        self, op: dict, fabrics: set, devices: set, addr_owner: dict
    ) -> None:
        if op.get("name") not in self._as.networks():
            raise InvalidStateTransition("network_not_found", op.get("name", ""))
        net_name = op["name"]
        users = [
            h.name()
            for h in self._as.hosts().values()
            if h.network().name() == net_name
        ]
        users += [
            r.name()
            for r in self._as.routers().values()
            if any(i.network().name() == net_name for i in r.interfaces().values())
        ]
        if users:
            raise InvalidStateTransition("network_in_use", ",".join(users))
        fabrics.discard(net_name)

    def _validate_add_host(
        self, op: dict, fabrics: set, devices: set, addr_owner: dict
    ) -> None:
        if not all(k in op for k in ("name", "address")):
            raise InvalidStateTransition("invalid_patch", "add_host")
        fabric_key = self._iface_fabric_key(op, "add_host")
        fabric_name = op[fabric_key]
        if fabric_name not in fabrics:
            raise InvalidStateTransition(f"{fabric_key}_not_found", fabric_name)
        if op["name"] in devices:
            raise InvalidStateTransition("duplicate_name", op["name"])
        key = (fabric_name, op["address"])
        if key in addr_owner:
            raise InvalidStateTransition("address_in_use", addr_owner[key])
        devices.add(op["name"])
        addr_owner[key] = op["name"]

    def _validate_remove_host(
        self, op: dict, fabrics: set, devices: set, addr_owner: dict
    ) -> None:
        if op.get("name") not in self._as.hosts():
            raise InvalidStateTransition("host_not_found", op.get("name", ""))
        devices.discard(op["name"])

    def _validate_add_router(
        self, op: dict, fabrics: set, devices: set, addr_owner: dict
    ) -> None:
        if not all(k in op for k in ("name", "interfaces")):
            raise InvalidStateTransition("invalid_patch", "add_router")
        if op["name"] in devices:
            raise InvalidStateTransition("duplicate_name", op["name"])
        seen: dict[tuple[str, str], str] = {}
        for iface in op["interfaces"]:
            fabric_key = self._iface_fabric_key(iface, "add_router")
            fabric_name = iface[fabric_key]
            if fabric_name not in fabrics:
                raise InvalidStateTransition(f"{fabric_key}_not_found", fabric_name)
            addr = iface.get("address", "")
            # Intra-router collision: two ifaces in this op on the same
            # fabric with the same address.
            key = (fabric_name, addr)
            if key in seen:
                raise InvalidStateTransition(
                    "address_in_use",
                    f"{op['name']}/{iface.get('name', '')}",
                )
            seen[key] = iface.get("name", "")
            if key in addr_owner:
                raise InvalidStateTransition("address_in_use", addr_owner[key])
            addr_owner[key] = f"{op['name']}/{iface.get('name', '')}"
        devices.add(op["name"])

    def _validate_remove_router(
        self, op: dict, fabrics: set, devices: set, addr_owner: dict
    ) -> None:
        if op.get("name") not in self._as.routers():
            raise InvalidStateTransition("router_not_found", op.get("name", ""))
        devices.discard(op["name"])

    def _validate_update_cost(
        self, op: dict, fabrics: set, devices: set, addr_owner: dict
    ) -> None:
        r = self._as.routers().get(op.get("router"))
        if r is None or op.get("iface") not in r.interfaces():
            raise InvalidStateTransition("interface_not_found", op.get("iface", ""))
        try:
            cost = int(op.get("cost", 0))
        except (ValueError, TypeError):
            raise InvalidStateTransition("invalid_cost", str(op.get("cost", "")))
        if cost <= 0:
            raise InvalidStateTransition("invalid_cost", str(op.get("cost", "")))

    _VALIDATORS: dict = {}  # populated after class body; see end of class

    def _validate_op(
        self,
        op: dict,
        fabrics: set,
        devices: set,
        addr_owner: dict,
    ) -> None:
        kind = op.get("op")
        handler = self._VALIDATORS.get(kind)
        if handler is None:
            raise InvalidStateTransition("unknown_op", str(kind))
        handler(self, op, fabrics, devices, addr_owner)

    def _fabric_for(self, fabric_key: str, name: str):
        """Resolve a fabric reference to its live Network or Link entity."""
        return self._as.link(name) if fabric_key == "link" else self._as.network(name)

    # ---- per-op appliers ----

    def _apply_add_network(self, op: dict) -> None:
        net = Network(op["name"], NetworkAddress(op["address"]), gate=self._as.gate())
        self._as.add_network(net)

    def _apply_add_link(self, op: dict) -> None:
        link = Link(op["name"], NetworkAddress(op["address"]), gate=self._as.gate())
        self._as.add_link(link)

    def _apply_remove_network(self, op: dict) -> None:
        net = self._as.network(op["name"])
        net.stop()
        del self._as.networks()[op["name"]]

    def _apply_add_host(self, op: dict) -> None:
        fabric_key = "link" if "link" in op else "network"
        fabric = self._fabric_for(fabric_key, op[fabric_key])
        gw = Address(op["gateway"]) if op.get("gateway") else None
        host = Host(
            op["name"],
            fabric,
            Address(op["address"]),
            gw_address=gw,
            gate=self._as.gate(),
        )
        fabric.add_interface(host.interface())
        self._as.add_host(host)

    def _apply_remove_host(self, op: dict) -> None:
        host = self._as.host(op["name"])
        host.network().remove_interface(host.interface().address())
        host.interface().stop()
        del self._as.hosts()[op["name"]]

    def _apply_add_router(self, op: dict) -> None:
        router = Router(op["name"])
        for iface_spec in op["interfaces"]:
            fabric_key = "link" if "link" in iface_spec else "network"
            fabric = self._fabric_for(fabric_key, iface_spec[fabric_key])
            iface = Interface(
                iface_spec["name"],
                fabric,
                Address(iface_spec["address"]),
                cost=int(iface_spec.get("cost", 1)),
                gate=self._as.gate(),
            )
            fabric.add_interface(iface)
            router.add_interface(iface)
        self._as.add_router(router)
        router.start()

    def _apply_remove_router(self, op: dict) -> None:
        router = self._as.router(op["name"])
        router.stop()
        for iface in list(router.interfaces().values()):
            iface.network().remove_interface(iface.address())
            iface.stop()
        del self._as.routers()[op["name"]]

    def _apply_update_cost(self, op: dict) -> None:
        self._as.router(op["router"]).update_interface(op["iface"], int(op["cost"]))

    _APPLIERS: dict = {}  # populated after class body; see end of class

    def _apply_op(self, op: dict) -> None:
        kind = op["op"]
        handler = self._APPLIERS.get(kind)
        if handler is None:
            raise InvalidStateTransition("unknown_op", kind)
        handler(self, op)

    def _persist(self) -> None:
        atomic_write(self.session_path, self._dump_yaml())

    # ---- YAML serialisation helpers ----

    @staticmethod
    def _fabric_kv(fabric):
        """Return the (yaml_key, fabric_name) pair for a fabric reference.

        Interface (and Host) fabric refs round-trip back to the same YAML key
        the parser accepted: ``link:`` for point-to-point Links, ``network:``
        for multi-access Networks.
        """
        key = "link" if isinstance(fabric, Link) else "network"
        return key, fabric.name()

    @staticmethod
    def _iface_dict(iface):
        key, name = SimState._fabric_kv(iface.network())
        return {key: name, "address": str(iface.address()), "cost": iface.cost()}

    @staticmethod
    def _host_dict(host):
        key, name = SimState._fabric_kv(host.network())
        d = {key: name, "address": str(host.address())}
        if host.gateway():
            d["gateway"] = str(host.gateway())
        return d

    def _build_as_block(self) -> dict:
        """Build the per-AS YAML mapping (asn, config, networks, links, hosts, routers).

        Conventional key order (matching the source schema): asn, config (if
        present), networks, links (if any — omitted on link-free topologies),
        hosts, routers.
        """
        as_block: dict = {"asn": self._as.asn()}

        routers = list(self._as.routers().values())
        if routers:
            proto = routers[0].protocol()
            as_block["config"] = {
                "protocol": {
                    "hello_interval": proto.hello_interval(),
                    "lsa_refresh_interval": proto.lsa_refresh_interval(),
                }
            }
        elif self._as.protocol_config():
            as_block["config"] = {"protocol": dict(self._as.protocol_config())}

        as_block["networks"] = {
            n.name(): str(n.address()) for n in self._as.networks().values()
        }
        # Conventional order (matching the source schema): networks, then
        # links (if any), then hosts, then routers. `links:` is omitted on
        # link-free topologies to keep simple sample files clean.
        if self._as.links():
            as_block["links"] = {
                lnk.name(): str(lnk.address()) for lnk in self._as.links().values()
            }
        as_block["hosts"] = {
            h.name(): self._host_dict(h) for h in self._as.hosts().values()
        }
        as_block["routers"] = {
            r.name(): {
                "interfaces": {
                    i.name(): self._iface_dict(i) for i in r.interfaces().values()
                }
            }
            for r in self._as.routers().values()
        }
        return as_block

    def _dump_yaml(self) -> str:
        internet_block: dict = {
            "name": self._internet.name() if self._internet else "loom",
        }
        if self._internet is not None and self._internet.config():
            internet_block["config"] = dict(self._internet.config())
        internet_block["autonomous_systems"] = {
            self._as.name(): self._build_as_block()
        }
        return yaml.safe_dump({"internet": internet_block}, sort_keys=False)

    def stop(self):
        """Transition any state -> idle. No-op if already idle.

        The state flip and ref-nulling happen INSIDE _lock so readers always
        see a consistent view.  _lock is then RELEASED before the blocking
        internet.stop() joins, so GET /topology and start() are not stalled
        for the join duration.  _edit_lock is kept held across the joins so
        that no concurrent load_from_session() or edit() can swap the
        EventTracer or mutate the topology while old worker threads are still
        alive (H3 invariant).
        """
        with self._edit_lock:
            with self._lock:
                if self._state == "idle":
                    return
                internet = self._internet
                self._internet = None
                self._as = None
                self._state = "idle"
            # _lock released; _edit_lock still held across the blocking joins.
            if internet is not None:
                internet.stop()


# Dispatch tables populated after the class body so they can reference bound
# unbound methods by name without forward-reference issues.
SimState._VALIDATORS = {
    "add_network": SimState._validate_add_network,
    "add_link": SimState._validate_add_link,
    "remove_network": SimState._validate_remove_network,
    "add_host": SimState._validate_add_host,
    "remove_host": SimState._validate_remove_host,
    "add_router": SimState._validate_add_router,
    "remove_router": SimState._validate_remove_router,
    "update_cost": SimState._validate_update_cost,
}

SimState._APPLIERS = {
    "add_network": SimState._apply_add_network,
    "add_link": SimState._apply_add_link,
    "remove_network": SimState._apply_remove_network,
    "add_host": SimState._apply_add_host,
    "remove_host": SimState._apply_remove_host,
    "add_router": SimState._apply_add_router,
    "remove_router": SimState._apply_remove_router,
    "update_cost": SimState._apply_update_cost,
}
