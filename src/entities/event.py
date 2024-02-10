class Event(object):

    def __init__(self):
        pass


class RoutingEvent(Event):

    def __init__(self, datagram):
        super().__init__()
        self._datagram = datagram
        self._hops = list()

    def add_hop(self):
        pass

