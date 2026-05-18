from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

import yaml

from entities import Address, Host, Interface, Link, Network, NetworkAddress, Router
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
        self._as = None
        self._state = "idle"
        self._lock = threading.RLock()

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
            if self._as is not None:
                self._as.stop()
            # `start_routing=False`: build routers without starting their
            # keepalive threads. Starting them here would let the initial
            # routing tick fire — emitting packet events on a sim that is
            # still 'idle' — before /sim/start has been called.
            self._as = Parser(str(self.session_path)).parse(start_routing=False)
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
        with self._lock:
            if self._state != "paused":
                raise InvalidStateTransition(self._state, "running")
            if patch:
                self._apply_patch(patch)
            self._as.gate().resume()
            self._state = "running"
            self._persist()

    # ---- patch helpers ----

    def _apply_patch(self, patch: list[dict]) -> None:
        """Two-phase: validate all ops, then apply all. Atomic on validation."""
        for op in patch:
            self._validate_op(op)
        for op in patch:
            self._apply_op(op)

    def _validate_op(self, op: dict) -> None:  # noqa: C901 (complexity OK here)
        kind = op.get("op")
        if kind == "add_network":
            if not all(k in op for k in ("name", "address")):
                raise InvalidStateTransition("invalid_patch", kind)
            if op["name"] in self._as.networks():
                raise InvalidStateTransition("duplicate_name", op["name"])
        elif kind == "remove_network":
            if op.get("name") not in self._as.networks():
                raise InvalidStateTransition("network_not_found", op.get("name", ""))
            net_name = op["name"]
            users = [h.name() for h in self._as.hosts().values()
                     if h.network().name() == net_name]
            users += [r.name() for r in self._as.routers().values()
                      if any(i.network().name() == net_name
                             for i in r.interfaces().values())]
            if users:
                raise InvalidStateTransition("network_in_use", ",".join(users))
        elif kind == "add_host":
            if not all(k in op for k in ("name", "network", "address")):
                raise InvalidStateTransition("invalid_patch", kind)
            if op["network"] not in self._as.networks():
                raise InvalidStateTransition("network_not_found", op["network"])
            if op["name"] in self._as.hosts() or op["name"] in self._as.routers():
                raise InvalidStateTransition("duplicate_name", op["name"])
            owner = self._address_owner(op["network"], op["address"])
            if owner:
                raise InvalidStateTransition("address_in_use", owner)
        elif kind == "remove_host":
            if op.get("name") not in self._as.hosts():
                raise InvalidStateTransition("host_not_found", op.get("name", ""))
        elif kind == "add_router":
            if not all(k in op for k in ("name", "interfaces")):
                raise InvalidStateTransition("invalid_patch", kind)
            if op["name"] in self._as.hosts() or op["name"] in self._as.routers():
                raise InvalidStateTransition("duplicate_name", op["name"])
            seen: dict[tuple[str, str], str] = {}
            for iface in op["interfaces"]:
                net_name = iface.get("network")
                if net_name not in self._as.networks():
                    raise InvalidStateTransition(
                        "network_not_found", net_name or ""
                    )
                addr = iface.get("address", "")
                # Intra-router collision: two ifaces in this op on the same
                # net with the same address.
                key = (net_name, addr)
                if key in seen:
                    raise InvalidStateTransition(
                        "address_in_use",
                        f"{op['name']}/{iface.get('name', '')}",
                    )
                seen[key] = iface.get("name", "")
                # Collision with an existing host or router interface.
                owner = self._address_owner(net_name, addr)
                if owner:
                    raise InvalidStateTransition("address_in_use", owner)
        elif kind == "remove_router":
            if op.get("name") not in self._as.routers():
                raise InvalidStateTransition("router_not_found", op.get("name", ""))
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

    def _address_owner(self, net_name: str, address: str) -> str:
        """Return a label for the host/iface that owns `address` on `net_name`.

        Empty string when the address is free. Used by the patch validator
        to keep `Network._interfaces` (keyed by address) from being silently
        clobbered when an add_host/add_router op carries a colliding address.
        """
        for h in self._as.hosts().values():
            if h.network().name() == net_name and h.address() == address:
                return h.name()
        for r in self._as.routers().values():
            for ifname, iface in r.interfaces().items():
                if iface.network().name() == net_name and iface.address() == address:
                    return f"{r.name()}/{ifname}"
        return ""

    def _apply_op(self, op: dict) -> None:
        kind = op["op"]
        if kind == "add_network":
            net = Network(
                op["name"], NetworkAddress(op["address"]), gate=self._as.gate()
            )
            self._as.add_network(net)
        elif kind == "remove_network":
            net = self._as.network(op["name"])
            net.stop()
            del self._as.networks()[op["name"]]
        elif kind == "add_host":
            net = self._as.network(op["network"])
            gw = Address(op["gateway"]) if op.get("gateway") else None
            host = Host(
                op["name"], net, Address(op["address"]),
                gw_address=gw, gate=self._as.gate(),
            )
            net.add_interface(host.interface())
            self._as.add_host(host)
        elif kind == "remove_host":
            host = self._as.host(op["name"])
            host.interface().stop()
            del self._as.hosts()[op["name"]]
        elif kind == "add_router":
            router = Router(op["name"])
            for iface_spec in op["interfaces"]:
                net = self._as.network(iface_spec["network"])
                iface = Interface(
                    iface_spec["name"], net,
                    Address(iface_spec["address"]),
                    cost=int(iface_spec.get("cost", 1)),
                    gate=self._as.gate(),
                )
                net.add_interface(iface)
                router.add_interface(iface)
            self._as.add_router(router)
            router.start()
        elif kind == "remove_router":
            router = self._as.router(op["name"])
            router.stop()
            for iface in list(router.interfaces().values()):
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

        as_dict = {
            "name": self._as.name(),
            "networks": {
                n.name(): str(n.address())
                for n in self._as.networks().values()
            },
        }
        # Conventional order (matching the source schema): networks, then
        # links (if any), then hosts, then routers. `links:` is omitted on
        # link-free topologies to keep simple sample files clean.
        if self._as.links():
            as_dict["links"] = {
                lnk.name(): str(lnk.address())
                for lnk in self._as.links().values()
            }
        as_dict["hosts"] = {
            h.name(): host_dict(h) for h in self._as.hosts().values()
        }
        as_dict["routers"] = {
            r.name(): {
                "interfaces": {
                    i.name(): iface_dict(i)
                    for i in r.interfaces().values()
                }
            }
            for r in self._as.routers().values()
        }
        return yaml.safe_dump({"as": as_dict}, sort_keys=False)

    def stop(self):
        """Transition any state -> idle. No-op if already idle."""
        with self._lock:
            if self._state == "idle":
                return
            if self._as is not None:
                self._as.stop()
                self._as = None
            self._state = "idle"
