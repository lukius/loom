import uuid

from .address import NetworkAddress


class Packet(object):

    def __init__(self, src_addr, dst_addr, payload):
        self._src_addr = src_addr
        self._dst_addr = dst_addr
        self._payload = payload

    def source(self):
        return self._src_addr

    def destination(self):
        return self._dst_addr

    def payload(self):
        return self._payload


class Frame(Packet):

    pass


class Datagram(Packet):

    pass


class Message(object):

    def __init__(self):
        self._id = uuid.uuid4()

    def type(self):
        return self.__class__

    def id(self):
        return self._id

    def __eq__(self, other):
        if other.__class__ != self.__class__:
            return False
        return self._id == other.id()

    def __hash__(self):
        return hash(self._id)


class RoutingMessage(Message):

    def __init__(self, src, seq: int):
        super().__init__()
        self._src = src
        self._seq = seq
        self._dests = dict()

    def seq(self):
        return self._seq

    def src_address(self):
        return self._src.address()

    def src_router(self):
        return self._src.device()

    def destinations(self):
        return self._dests

    def add_destination(self, prefix: NetworkAddress, cost: int):
        self._dests[prefix] = cost


class UserMessage(Message):

    def __init__(self, payload):
        super().__init__()
        self._payload = payload

    def payload(self):
        return self._payload
