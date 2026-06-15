from .lsa import RoutingMessage


class Hello(RoutingMessage):
    """Liveness message: carries originator + per-interface neighbors-heard.

    Built per-interface (not shared): each interface's Hello lists only
    the peers heard on that specific fabric; see docs/architecture/routing-protocol.md.
    """

    def __init__(self, originator, neighbors_heard):
        super().__init__()
        self._originator = originator
        self._neighbors_heard = list(neighbors_heard)

    def originator(self):
        return self._originator

    def neighbors_heard(self) -> list:
        return list(self._neighbors_heard)
