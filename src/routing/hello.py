from .lsa import RoutingMessage


class Hello(RoutingMessage):
    """Liveness message: carries originator + per-interface neighbours-heard.

    Built per-interface (not shared): each interface's Hello lists only
    the peers heard on that specific fabric. See spec section 2.2.
    """

    def __init__(self, originator, neighbours_heard):
        super().__init__()
        self._originator = originator
        self._neighbours_heard = list(neighbours_heard)

    def originator(self):
        return self._originator

    def neighbours_heard(self) -> list:
        return list(self._neighbours_heard)
