from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

import yaml

from entities import Address, Host, Interface, Link, Network, NetworkAddress, Router
from entities.event import EventTracer
from parser import Parser

from .persistence import atomic_write, prepare_session


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

    # ---- transitions ----

    def load_from_session(self):
        """Parse the session file into an AS. Routers are built but not started."""
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

    def _validate_op(  # noqa: C901 (complexity OK here)
        self,
        op: dict,
        fabrics: set,
        devices: set,
        addr_owner: dict,
    ) -> None:
        kind = op.get("op")
        if kind == "add_network":
            if not all(k in op for k in ("name", "address")):
                raise InvalidStateTransition("invalid_patch", kind)
            if op["name"] in fabrics:
                raise InvalidStateTransition("duplicate_name", op["name"])
            fabrics.add(op["name"])
        elif kind == "add_link":
            if not all(k in op for k in ("name", "address")):
                raise InvalidStateTransition("invalid_patch", kind)
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
        elif kind == "remove_network":
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
        elif kind == "add_host":
            if not all(k in op for k in ("name", "address")):
                raise InvalidStateTransition("invalid_patch", kind)
            fabric_key = self._iface_fabric_key(op, kind)
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
        elif kind == "remove_host":
            if op.get("name") not in self._as.hosts():
                raise InvalidStateTransition("host_not_found", op.get("name", ""))
            devices.discard(op["name"])
        elif kind == "add_router":
            if not all(k in op for k in ("name", "interfaces")):
                raise InvalidStateTransition("invalid_patch", kind)
            if op["name"] in devices:
                raise InvalidStateTransition("duplicate_name", op["name"])
            seen: dict[tuple[str, str], str] = {}
            for iface in op["interfaces"]:
                fabric_key = self._iface_fabric_key(iface, kind)
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
        elif kind == "remove_router":
            if op.get("name") not in self._as.routers():
                raise InvalidStateTransition("router_not_found", op.get("name", ""))
            devices.discard(op["name"])
        elif kind == "update_cost":
            r = self._as.routers().get(op.get("router"))
            if r is None or op.get("iface") not in r.interfaces():
                raise InvalidStateTransition("interface_not_found", op.get("iface", ""))
            try:
                cost = int(op.get("cost", 0))
            except (ValueError, TypeError):
                raise InvalidStateTransition("invalid_cost", str(op.get("cost", "")))
            if cost <= 0:
                raise InvalidStateTransition("invalid_cost", str(op.get("cost", "")))
        else:
            raise InvalidStateTransition("unknown_op", str(kind))

    def _fabric_for(self, fabric_key: str, name: str):
        """Resolve a fabric reference to its live Network or Link entity."""
        return self._as.link(name) if fabric_key == "link" else self._as.network(name)

    def _apply_op(self, op: dict) -> None:
        kind = op["op"]
        if kind == "add_network":
            net = Network(
                op["name"], NetworkAddress(op["address"]), gate=self._as.gate()
            )
            self._as.add_network(net)
        elif kind == "add_link":
            link = Link(op["name"], NetworkAddress(op["address"]), gate=self._as.gate())
            self._as.add_link(link)
        elif kind == "remove_network":
            net = self._as.network(op["name"])
            net.stop()
            del self._as.networks()[op["name"]]
        elif kind == "add_host":
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
        elif kind == "remove_host":
            host = self._as.host(op["name"])
            host.network().remove_interface(host.interface().address())
            host.interface().stop()
            del self._as.hosts()[op["name"]]
        elif kind == "add_router":
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
        elif kind == "remove_router":
            router = self._as.router(op["name"])
            router.stop()
            for iface in list(router.interfaces().values()):
                iface.network().remove_interface(iface.address())
                iface.stop()
            del self._as.routers()[op["name"]]
        elif kind == "update_cost":
            self._as.router(op["router"]).update_interface(op["iface"], int(op["cost"]))
        else:
            raise InvalidStateTransition("unknown_op", kind)

    def _persist(self) -> None:
        atomic_write(self.session_path, self._dump_yaml())

    def _dump_yaml(self) -> str:
        def fabric_kv(fabric):
            # Interface (and Host) fabric refs round-trip back to the same
            # YAML key the parser accepted: `link:` for point-to-point Links,
            # `network:` for multi-access Networks.
            key = "link" if isinstance(fabric, Link) else "network"
            return key, fabric.name()

        def iface_dict(iface):
            key, name = fabric_kv(iface.network())
            return {
                key: name,
                "address": str(iface.address()),
                "cost": iface.cost(),
            }

        def host_dict(host):
            key, name = fabric_kv(host.network())
            d = {key: name, "address": str(host.address())}
            if host.gateway():
                d["gateway"] = str(host.gateway())
            return d

        as_block = {
            "asn": getattr(self._as, "_asn", 65000),
            "networks": {
                n.name(): str(n.address()) for n in self._as.networks().values()
            },
        }
        # Conventional order (matching the source schema): networks, then
        # links (if any), then hosts, then routers. `links:` is omitted on
        # link-free topologies to keep simple sample files clean.
        if self._as.links():
            as_block["links"] = {
                lnk.name(): str(lnk.address()) for lnk in self._as.links().values()
            }
        as_block["hosts"] = {h.name(): host_dict(h) for h in self._as.hosts().values()}
        as_block["routers"] = {
            r.name(): {
                "interfaces": {i.name(): iface_dict(i) for i in r.interfaces().values()}
            }
            for r in self._as.routers().values()
        }
        internet_block = {
            "name": self._internet.name() if self._internet else "loom",
        }
        if self._internet is not None and self._internet.config():
            internet_block["config"] = dict(self._internet.config())
        internet_block["autonomous_systems"] = {self._as.name(): as_block}
        root = {"internet": internet_block}
        return yaml.safe_dump(root, sort_keys=False)

    def stop(self):
        """Transition any state -> idle. No-op if already idle."""
        with self._edit_lock:
            with self._lock:
                if self._state == "idle":
                    return
                if self._internet is not None:
                    self._internet.stop()
                    self._internet = None
                    self._as = None
                self._state = "idle"
