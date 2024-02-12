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

    def __repr__(self) -> str:
        return str(self)


class Address(BaseAddress):

    def __str__(self) -> str:
        return self._address

    def __eq__(self, other) -> bool:
        if isinstance(other, str):
            try:
                other = Address(other)
            except Exception:
                return False
        if other.__class__ != self.__class__:
            return False
        return self._address == other._address

    def __hash__(self) -> int:
        return hash(self._address)


class NetworkAddress(BaseAddress):

    def __init__(self, address: str):
        address, mask = address.split('/')
        super().__init__(address)
        self._mask = int(mask)

    def mask(self) -> int:
        return self._mask

    def matches(self, address: Address) -> bool:
        return self._matches(address.octets())

    def _matches(self, octets: List[int]) -> bool:
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

    def __str__(self) -> str:
        return f'{self._address}/{self._mask}'

    def __eq__(self, other) -> bool:
        if isinstance(other, str):
            try:
                other = NetworkAddress(other)
            except Exception:
                return False
        if other.__class__ != self.__class__:
            return False
        return self._matches(other.octets()) and self._mask == other._mask

    def __hash__(self) -> int:
        return hash(self._address) ^ self._mask


NullAddress = Address('0.0.0.0')



