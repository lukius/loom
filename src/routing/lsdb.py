import threading
from typing import Iterable, Optional

from .graph import NetworkGraph


class InstallResult:
    """Outcome of LSDB.install.

    - is_accepted(): the LSA was new or newer than what we had.
      Accepted LSAs are re-flooded by callers.
    - changed_graph(): the install changed link content.
      Only graph-changing installs trigger SPF recompute.
    """

    @classmethod
    def accepted(cls, changed_graph: bool) -> 'InstallResult':
        return cls(accepted=True, changed_graph=changed_graph)

    @classmethod
    def rejected(cls) -> 'InstallResult':
        return cls(accepted=False, changed_graph=False)

    def __init__(self, accepted: bool, changed_graph: bool):
        self._accepted = accepted
        self._changed_graph = changed_graph

    def is_accepted(self) -> bool:
        return self._accepted

    def changed_graph(self) -> bool:
        return self._changed_graph


class LSDB:
    """The link-state database: LSAs keyed by originating router.

    Canonical store of network state from this router's perspective.
    The NetworkGraph is derived; LSAs are the source of truth.
    """

    def __init__(self, local_router):
        self._local = local_router
        self._by_origin: dict = {}      # origin -> (LSA, installed_at)
        self._lock = threading.Lock()

    def install(self, lsa, now: float) -> InstallResult:
        with self._lock:
            if lsa.is_withdrawal():
                purged = self._by_origin.pop(lsa.origin(), None) is not None
                return InstallResult.accepted(changed_graph=purged)

            current = self._by_origin.get(lsa.origin())
            if current is not None:
                existing, _ = current
                if not lsa.is_newer_than(existing):
                    return InstallResult.rejected()
                changed = not lsa.has_same_links_as(existing)
            else:
                changed = True
            self._by_origin[lsa.origin()] = (lsa, now)
            return InstallResult.accepted(changed_graph=changed)

    def lsa_for(self, origin) -> Optional:
        with self._lock:
            current = self._by_origin.get(origin)
            return current[0] if current is not None else None

    def purge(self, origin) -> bool:
        with self._lock:
            return self._by_origin.pop(origin, None) is not None

    def lsas(self) -> Iterable:
        with self._lock:
            return [entry[0] for entry in self._by_origin.values()]

    def origins(self) -> Iterable:
        with self._lock:
            return list(self._by_origin.keys())

    def age_of(self, origin, now: float) -> Optional[float]:
        with self._lock:
            current = self._by_origin.get(origin)
            if current is None:
                return None
            return now - current[1]

    def expired_origins(self, max_age: float, now: float) -> list:
        with self._lock:
            return [
                origin for origin, (_, installed_at) in self._by_origin.items()
                if now - installed_at > max_age
            ]

    def build_graph(self, eligible_origins: set) -> NetworkGraph:
        graph = NetworkGraph()
        graph.add_router(self._local)
        with self._lock:
            # Local router's own LSA is always eligible if installed.
            local_entry = self._by_origin.get(self._local)
            if local_entry is not None:
                lsa, _ = local_entry
                for prefix, cost in lsa.links().items():
                    if prefix not in graph:
                        graph.add_network(prefix)
                    graph.add_edge(src=self._local, dst=prefix, weight=cost)

            for origin, (lsa, _) in self._by_origin.items():
                if origin is self._local:
                    continue
                if origin not in eligible_origins:
                    continue
                if origin not in graph:
                    graph.add_router(origin)
                for prefix, cost in lsa.links().items():
                    if prefix not in graph:
                        graph.add_network(prefix)
                    graph.add_edge(src=origin, dst=prefix, weight=cost)
        return graph
