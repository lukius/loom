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
