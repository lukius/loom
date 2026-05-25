import threading
from enum import Enum
from typing import Optional


class NeighborState(Enum):
    DOWN = 'down'
    INIT = 'init'
    TWO_WAY = 'two_way'


class Neighbor:
    """A single (interface, peer_router) tracking record.

    State derived (not stored) from timestamps:
    - DOWN: no recent hello, or never heard
    - INIT: heard recently, peer hasn't acked us
    - TWO_WAY: heard recently AND peer acked us → bidirectional
    """

    def __init__(self, interface, peer):
        self._interface = interface
        self._peer = peer
        self._last_hello_at: Optional[float] = None
        self._peer_acked_at: Optional[float] = None

    def peer(self):
        return self._peer

    def interface(self):
        return self._interface

    def last_hello_at(self) -> Optional[float]:
        return self._last_hello_at

    def peer_acked_at(self) -> Optional[float]:
        return self._peer_acked_at

    def heard_hello(self, peer_listed_us: bool, now: float):
        self._last_hello_at = now
        if peer_listed_us:
            self._peer_acked_at = now

    def state(self, dead_interval: float, now: float) -> NeighborState:
        if self._last_hello_at is None:
            return NeighborState.DOWN
        if now - self._last_hello_at > dead_interval:
            return NeighborState.DOWN
        if self._peer_acked_at is None:
            return NeighborState.INIT
        if now - self._peer_acked_at > dead_interval:
            return NeighborState.INIT
        return NeighborState.TWO_WAY


class NeighborTransition:
    """A computed state-change. Returned by NeighborTable when a
    record_hello or sweep moves a neighbour between states. Drives
    the neighbor_state_changed event broadcast and the LSDB-purge
    side-effect on transitions to DOWN.
    """

    def __init__(self, neighbor: Neighbor, before: NeighborState, after: NeighborState):
        self._neighbor = neighbor
        self._before = before
        self._after = after

    def neighbor(self) -> Neighbor:
        return self._neighbor

    def before(self) -> NeighborState:
        return self._before

    def after(self) -> NeighborState:
        return self._after

    def went_down(self) -> bool:
        return (self._after is NeighborState.DOWN
                and self._before is not NeighborState.DOWN)


class NeighborTable:
    """Per-router neighbour catalogue. Hides (interface, peer) keying."""

    def __init__(self):
        self._neighbors: dict = {}        # (iface_name, peer) -> Neighbor
        self._last_state: dict = {}       # (iface_name, peer) -> NeighborState
        self._lock = threading.Lock()

    def _key(self, interface, peer):
        return (interface.name(), peer)

    def record_hello(self, interface, peer, peer_listed_us: bool,
                     dead_interval: float, now: float):
        with self._lock:
            key = self._key(interface, peer)
            neighbor = self._neighbors.get(key)
            before = self._last_state.get(key, NeighborState.DOWN)
            if neighbor is None:
                neighbor = Neighbor(interface, peer)
                self._neighbors[key] = neighbor
            neighbor.heard_hello(peer_listed_us, now)
            after = neighbor.state(dead_interval, now)
            self._last_state[key] = after
            if after is before:
                return None
            return NeighborTransition(neighbor, before, after)

    def neighbours_heard_on(self, interface, dead_interval: float, now: float):
        with self._lock:
            result = []
            for key, neighbor in self._neighbors.items():
                iface_name, peer = key
                if iface_name != interface.name():
                    continue
                st = neighbor.state(dead_interval, now)
                if st is NeighborState.DOWN:
                    continue
                result.append(peer)
            return result

    def bidirectional_peers(self, dead_interval: float, now: float):
        with self._lock:
            return {
                peer for (iface_name, peer), n in self._neighbors.items()
                if n.state(dead_interval, now) is NeighborState.TWO_WAY
            }

    def sweep_transitions(self, dead_interval: float, now: float):
        with self._lock:
            transitions = []
            for key, neighbor in self._neighbors.items():
                before = self._last_state.get(key, NeighborState.DOWN)
                after = neighbor.state(dead_interval, now)
                if after is before:
                    continue
                self._last_state[key] = after
                transitions.append(NeighborTransition(neighbor, before, after))
            return transitions

    def on_interface(self, interface):
        with self._lock:
            return [
                n for (iface_name, _), n in self._neighbors.items()
                if iface_name == interface.name()
            ]

    def all(self):
        with self._lock:
            return list(self._neighbors.values())
