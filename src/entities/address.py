from typing import List


class BaseAddress:

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

    def is_private(self) -> bool:
        """Return True if this address falls within an RFC 1918 private range."""
        return any(p.contains(self) for p in _RFC1918_PREFIXES)

    def __eq__(self, other) -> bool:
        if isinstance(other, str):
            try:
                other = Address(other)
            except Exception:
                return False
        if other.__class__ != self.__class__:
            return False
        return self._octets == other._octets

    def __hash__(self) -> int:
        return hash(tuple(self._octets))


class NetworkAddress(BaseAddress):

    def __init__(self, address: str):
        address, mask = address.split('/')
        super().__init__(address)
        self._mask = int(mask)
        self._canonicalize()

    def _canonicalize(self):
        idx, bits = divmod(self._mask, 8)
        if bits > 0:
            host_bitmask = (1 << (8 - bits)) - 1
            self._octets[idx] &= ~host_bitmask & 0xff
            for i in range(idx + 1, 4):
                self._octets[i] = 0
        else:
            for i in range(idx, 4):
                self._octets[i] = 0

    def mask(self) -> int:
        return self._mask

    def matches(self, address: BaseAddress) -> bool:
        return self._matches(address.octets())

    def contains(self, address: BaseAddress) -> bool:
        return self._matches(address.octets())

    def broadcast(self) -> Address:
        idx, bits = divmod(self._mask, 8)
        octets = list()
        for i in range(idx):
            octets.append(self._octets[i])
        if idx < len(self._octets):
            bitmask = (1 << (8 - bits)) - 1
            octets.append(self._octets[idx] | bitmask)
            for i in range(idx + 1, 4):
                octets.append(0xff)
        addr_str = '.'.join(map(str, octets))
        return Address(addr_str)

    def _matches(self, octets: List[int]) -> bool:
        idx, bits = divmod(self._mask, 8)
        bitmask = 0xff - (1 << (8 - bits)) + 1

        masked = octets[idx] & bitmask
        net_octet = self._octets[idx] & bitmask
        if masked != net_octet:
            return False

        for i in range(idx):
            if octets[i] != self._octets[i]:
                return False

        return True

    def is_private(self) -> bool:
        """Return True if the network address falls within an RFC 1918 private range."""
        return any(p.contains(self) for p in _RFC1918_PREFIXES)

    def __str__(self) -> str:
        return '.'.join(map(str, self._octets)) + f'/{self._mask}'

    def __eq__(self, other) -> bool:
        if isinstance(other, str):
            try:
                other = NetworkAddress(other)
            except Exception:
                return False
        if other.__class__ != self.__class__:
            return False
        return self._octets == other._octets and self._mask == other._mask

    def __hash__(self) -> int:
        return hash(tuple(self._octets)) ^ self._mask


NullAddress = Address('0.0.0.0')

_RFC1918_PREFIXES = (
    NetworkAddress('10.0.0.0/8'),
    NetworkAddress('172.16.0.0/12'),
    NetworkAddress('192.168.0.0/16'),
)

