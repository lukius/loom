from typing import List


class BaseAddress(object):

    _octets: List[int]

    def __init__(self, address: str):
        self._address = address

        octets = address.split('.')
        self._octets = [
            int(octets[0]),
            int(octets[1]),
            int(octets[2]),
            int(octets[3])
        ]

    def octets(self) -> list:
        return list(self._octets)


class Address(BaseAddress):

    pass


class NetworkAddress(BaseAddress):

    def __init__(self, address: str):
        address, mask = address.split('/')
        super().__init__(address)
        self._mask = int(mask)

    def matches(self, address: Address) -> bool:
        octets = address.octets()

        idx, bits = divmod(self._mask, 8)
        bitmask = 0xff - (1 << (8 - bits)) + 1

        octets[idx] &= bitmask
        net_octet = self._octets[idx] & bitmask
        if octets[idx] != net_octet:
            return False

        for i in range(idx):
            if octets[i] != self._octets[i]:
                return False

        return True



