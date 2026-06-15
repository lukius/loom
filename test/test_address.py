import unittest

import pytest

from entities import Address, NetworkAddress


class AddressTest(unittest.TestCase):

    def test_eq_hash_contract_same_subnet(self):
        a = NetworkAddress('192.168.1.0/24')
        b = NetworkAddress('192.168.1.50/24')
        self.assertEqual(a, b)  # both canonicalize to 192.168.1.0/24
        self.assertEqual(hash(a), hash(b))

    def test_eq_structural_different_subnets(self):
        a = NetworkAddress('192.168.1.0/24')
        b = NetworkAddress('192.168.2.0/24')
        self.assertNotEqual(a, b)

    def test_host_bits_canonicalized(self):
        canonical = NetworkAddress('192.168.1.0/24')
        with_host_bits = NetworkAddress('192.168.1.50/24')
        self.assertEqual(canonical, with_host_bits)
        self.assertEqual(hash(canonical), hash(with_host_bits))

    def test_contains_subnet_membership(self):
        net_addr = NetworkAddress('192.168.1.0/24')
        self.assertTrue(net_addr.contains(Address('192.168.1.1')))
        self.assertTrue(net_addr.contains(Address('192.168.1.254')))
        self.assertFalse(net_addr.contains(Address('192.168.2.1')))

    def test_str_uses_canonical_prefix(self):
        addr = NetworkAddress('192.168.1.50/24')
        self.assertEqual(str(addr), '192.168.1.0/24')

    def test_basic_address_matching(self):
        net_addr = NetworkAddress('100.100.100.0/24')

        host_addrs = [
            Address('100.100.100.1'),
            Address('100.100.100.2'),
            Address('100.100.100.254'),
            Address('100.100.100.15')
        ]

        for addr in host_addrs:
            self.assertTrue(net_addr.matches(addr))

    def test_address_matching_changing_masks(self):
        net_addr1 = NetworkAddress('100.100.196.100/18')
        net_addr2 = NetworkAddress('100.100.248.0/21')

        host_addrs = [
            Address('100.100.192.1'),
            Address('100.100.211.254'),
            Address('100.100.200.10'),
            Address('100.100.193.100'),
            Address('100.100.247.200')
        ]

        for addr in host_addrs:
            self.assertTrue(net_addr1.matches(addr))
            self.assertFalse(net_addr2.matches(addr))

    def test_addresses_not_matching(self):
        net_addr = NetworkAddress('100.100.100.0/24')

        host_addrs = [
            Address('100.100.0.1'),
            Address('200.100.100.2'),
            Address('100.100.99.254'),
            Address('100.1.100.15')
        ]

        for addr in host_addrs:
            self.assertFalse(net_addr.matches(addr))

    def test_broadcast_address(self):
        net_addr = NetworkAddress('100.100.100.0/24')
        self.assertEqual(net_addr.broadcast(), '100.100.100.255')

        net_addr = NetworkAddress('100.100.96.0/21')
        self.assertEqual(net_addr.broadcast(), '100.100.103.255')

    def test_broadcast_address_slash32(self):
        net_addr = NetworkAddress('1.2.3.4/32')
        self.assertEqual(net_addr.broadcast(), '1.2.3.4')

    def test_broadcast_address_slash0(self):
        net_addr = NetworkAddress('0.0.0.0/0')
        self.assertEqual(net_addr.broadcast(), '255.255.255.255')


class AddressIsPrivateTest(unittest.TestCase):

    # 10.0.0.0/8 boundary
    def test_10_dot_lower_boundary_inside(self):
        self.assertTrue(Address('10.0.0.0').is_private())

    def test_10_dot_upper_boundary_inside(self):
        self.assertTrue(Address('10.255.255.255').is_private())

    def test_just_below_10_dot_not_private(self):
        self.assertFalse(Address('9.255.255.255').is_private())

    def test_just_above_10_dot_not_private(self):
        self.assertFalse(Address('11.0.0.0').is_private())

    # 172.16.0.0/12 boundary
    def test_172_16_lower_inside(self):
        self.assertTrue(Address('172.16.0.0').is_private())

    def test_172_31_upper_inside(self):
        self.assertTrue(Address('172.31.255.255').is_private())

    def test_172_15_not_private(self):
        self.assertFalse(Address('172.15.255.255').is_private())

    def test_172_32_not_private(self):
        self.assertFalse(Address('172.32.0.0').is_private())

    # 192.168.0.0/16 boundary
    def test_192_168_lower_inside(self):
        self.assertTrue(Address('192.168.0.0').is_private())

    def test_192_168_upper_inside(self):
        self.assertTrue(Address('192.168.255.255').is_private())

    def test_192_167_not_private(self):
        self.assertFalse(Address('192.167.255.255').is_private())

    def test_192_169_not_private(self):
        self.assertFalse(Address('192.169.0.0').is_private())

    # Public examples (sanity)
    def test_public_unicast_not_private(self):
        self.assertFalse(Address('8.8.8.8').is_private())

    def test_cgnat_not_private_yet(self):
        # 100.64/10 is CGNAT, not RFC 1918 — explicitly out of scope.
        self.assertFalse(Address('100.100.100.1').is_private())


class NetworkAddressIsPrivateTest(unittest.TestCase):

    def test_192_168_24_is_private(self):
        self.assertTrue(NetworkAddress('192.168.1.0/24').is_private())

    def test_10_8_is_private(self):
        self.assertTrue(NetworkAddress('10.0.0.0/8').is_private())

    def test_10_24_subnet_is_private(self):
        self.assertTrue(NetworkAddress('10.20.30.0/24').is_private())

    def test_172_20_is_private(self):
        self.assertTrue(NetworkAddress('172.20.0.0/16').is_private())

    def test_public_24_is_not_private(self):
        self.assertFalse(NetworkAddress('200.100.0.0/24').is_private())

    def test_cgnat_not_private(self):
        self.assertFalse(NetworkAddress('100.64.0.0/10').is_private())


def test_address_hash_matches_equality_on_octet_value():
    """Equal Addresses must hash equal regardless of constructor input form.

    Today the parser canonicalises before constructing so this never bites,
    but any future programmatic construction path could create two equal
    Addresses with different `_address` strings — they must still hash
    equal to be safely usable as dict keys / set members.
    """
    a = Address('10.0.0.1')
    b = Address('10.0.0.1')
    assert a == b
    assert hash(a) == hash(b)

    # Pin: hash is on the canonical octet tuple, not the input string.
    assert hash(a) == hash(tuple(a.octets()))


def test_network_matches_slash32():
    """NetworkAddress._matches must not raise IndexError for a /32 prefix.

    divmod(32, 8) == (4, 0), which previously indexed octets[4] on a
    4-element list, crashing the forwarding hot path and SPF thread.
    A /32 must match only the exact host address and nothing else.
    """
    host_route = NetworkAddress('10.0.0.1/32')

    # Must match the exact host — no IndexError.
    assert host_route.matches(Address('10.0.0.1')) is True

    # Must not match an adjacent host.
    assert host_route.matches(Address('10.0.0.2')) is False
    assert host_route.matches(Address('10.0.0.0')) is False

    # Sanity: /0, /24, /30, /31 still behave correctly.
    assert NetworkAddress('0.0.0.0/0').matches(Address('1.2.3.4')) is True
    assert NetworkAddress('10.0.0.0/24').matches(Address('10.0.0.42')) is True
    assert NetworkAddress('10.0.0.0/24').matches(Address('10.0.1.1')) is False
    assert NetworkAddress('10.0.0.0/30').matches(Address('10.0.0.2')) is True
    assert NetworkAddress('10.0.0.0/30').matches(Address('10.0.0.4')) is False
    assert NetworkAddress('10.0.0.0/31').matches(Address('10.0.0.1')) is True
    assert NetworkAddress('10.0.0.0/31').matches(Address('10.0.0.2')) is False


def test_address_eq_is_octet_based_not_string_based():
    """Address.__eq__ must compare by octet values, not raw input strings.

    Two Address objects with the same numeric value but different string
    representations (e.g. leading zeros) must compare equal and be
    interchangeable as dict keys and set members.
    """
    canonical = Address('10.0.0.1')
    leading_zero = Address('010.0.0.1')

    # Equality must hold despite different _address strings.
    assert canonical == leading_zero
    assert leading_zero == canonical

    # Must be usable as equivalent set members.
    assert leading_zero in {canonical}
    assert canonical in {leading_zero}

    # Must be interchangeable as dict keys.
    d = {canonical: 'value'}
    assert d[leading_zero] == 'value'

    # Genuinely different addresses must remain unequal.
    assert Address('10.0.0.1') != Address('10.0.0.2')

    # Same-spelling equality must still hold.
    assert Address('192.168.1.1') == Address('192.168.1.1')


def test_network_matches_does_not_mutate_caller():
    """Address._matches must not write into the caller's octets list.

    Regression: prior implementation did `octets[idx] &= bitmask`, so a
    caller that obtained `octets` and reused it afterwards would observe
    silent corruption. octets() returns a copy today, which made the bug
    invisible — this test pins down the property directly.
    """
    net = NetworkAddress('10.0.5.0/24')
    addr = Address('10.0.5.42')
    octets_in = addr.octets()
    snapshot = list(octets_in)

    assert net.matches(addr) is True

    # The list the user obtained must be untouched.
    octets_after_first = addr.octets()
    assert octets_after_first == snapshot

    # Directly verify _matches doesn't write into its argument.
    local = list(snapshot)
    net._matches(local)
    assert local == snapshot


# --- Octet validation (Task 5 item 1) ---

def test_address_too_few_octets_raises_value_error():
    """Address('1.2.3') must raise ValueError, not a raw IndexError."""
    with pytest.raises(ValueError, match='1.2.3'):
        Address('1.2.3')


def test_address_octet_above_255_raises_value_error():
    """Address('999.1.2.500') must reject out-of-range octets with ValueError."""
    with pytest.raises(ValueError, match='999.1.2.500'):
        Address('999.1.2.500')


def test_network_address_too_few_octets_raises_value_error():
    """NetworkAddress propagates the octet validation from BaseAddress."""
    with pytest.raises(ValueError, match='1.2.3'):
        NetworkAddress('1.2.3/24')


def test_network_address_octet_out_of_range_raises_value_error():
    """NetworkAddress propagates the range check from BaseAddress."""
    with pytest.raises(ValueError, match='300.0.0.0'):
        NetworkAddress('300.0.0.0/24')


def test_address_zero_octets_raises_value_error():
    """Empty string address must raise ValueError."""
    with pytest.raises(ValueError):
        Address('')


def test_address_five_octets_raises_value_error():
    """Five-octet string must raise ValueError."""
    with pytest.raises(ValueError):
        Address('1.2.3.4.5')


def test_address_negative_octet_raises_value_error():
    """Negative octet value must raise ValueError."""
    with pytest.raises(ValueError):
        Address('10.0.0.-1')


# --- Canonical __str__ (Task 5 item 2) ---

def test_address_str_is_canonical_for_leading_zero_octet():
    """str(Address('010.0.0.1')) must render '10.0.0.1', not '010.0.0.1'."""
    addr = Address('010.0.0.1')
    assert str(addr) == '10.0.0.1'


def test_address_str_rebuilds_from_octets():
    """Address.__str__ must equal '.'.join(map(str, octets()))."""
    addr = Address('192.168.001.100')
    assert str(addr) == '.'.join(map(str, addr.octets()))
