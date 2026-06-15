from typing import List


class BaseAddress:

    _octets: List[int]

    def __init__(self, address: str):
        parts = address.split('.')
        if len(parts) != 4:
            raise ValueError(f'invalid IP address: {address!r}')
        try:
            parsed = [int(p) for p in parts]
        except ValueError:
            raise ValueError(f'invalid IP address: {address!r}') from None
        for octet in parsed:
            if octet < 0 or octet > 255:
                raise ValueError(f'invalid IP address: {address!r}')
        self._octets = parsed

    def octets(self) -> list:
        return list(self._octets)

    def __repr__(self) -> str:
        return str(self)


class Address(BaseAddress):

    def __str__(self) -> str:
        return '.'.join(map(str, self._octets))

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

    def _split(self):
        """Return (whole_octet_index, remaining_bits) for this prefix length."""
        return divmod(self._mask, 8)

    def _host_bitmask(self, bits: int) -> int:
        """Return the intra-octet mask with host bits set (net bits clear)."""
        return (1 << (8 - bits)) - 1

    def _canonicalize(self):
        idx, bits = self._split()
        if bits > 0:
            self._octets[idx] &= ~self._host_bitmask(bits) & 0xff
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
        # Alias for matches(); kept as a distinct name for readability at call sites.
        return self.matches(address)

    def broadcast(self) -> Address:
        idx, bits = self._split()
        octets = list()
        for i in range(idx):
            octets.append(self._octets[i])
        if idx < len(self._octets):
            octets.append(self._octets[idx] | self._host_bitmask(bits))
            for i in range(idx + 1, 4):
                octets.append(0xff)
        addr_str = '.'.join(map(str, octets))
        return Address(addr_str)

    def _matches(self, octets: List[int]) -> bool:
        idx, bits = self._split()

        if idx < len(self._octets):
            net_bitmask = ~self._host_bitmask(bits) & 0xff
            if octets[idx] & net_bitmask != self._octets[idx] & net_bitmask:
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

