from .address import Address


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

    def type(self):
        return self.__class__


class RoutingMessage(Message):

    def __init__(self):
        super().__init__()


class UserMessage(Message):

    def __init__(self, payload):
        super().__init__()
        self._payload = payload

    def payload(self):
        return self._payload
