import unittest

from entities.address import NetworkAddress
from routing.policy import (
    PolicyDecision,
    PrefixList,
    RouteMap,
    RouteMapRule,
)


class PrefixListTest(unittest.TestCase):

    def test_matches_when_prefix_contains_target(self):
        plist = PrefixList([NetworkAddress('10.0.0.0/8')])
        self.assertTrue(plist.matches(NetworkAddress('10.5.0.0/16')))

    def test_does_not_match_when_no_prefix_contains_target(self):
        plist = PrefixList([NetworkAddress('10.0.0.0/8')])
        self.assertFalse(plist.matches(NetworkAddress('192.168.0.0/16')))

    def test_matches_when_any_of_several_contains_target(self):
        plist = PrefixList([
            NetworkAddress('10.0.0.0/8'),
            NetworkAddress('172.16.0.0/12'),
            NetworkAddress('192.168.0.0/16'),
        ])
        self.assertTrue(plist.matches(NetworkAddress('172.20.0.0/16')))


class PolicyDecisionTest(unittest.TestCase):

    def test_permit_is_permitted(self):
        d = PolicyDecision.permit(NetworkAddress('10.0.0.0/24'))
        self.assertTrue(d.is_permitted())
        self.assertFalse(d.is_denied())

    def test_deny_is_denied(self):
        d = PolicyDecision.deny(NetworkAddress('10.0.0.0/24'))
        self.assertTrue(d.is_denied())
        self.assertFalse(d.is_permitted())

    def test_prefix_round_trips(self):
        p = NetworkAddress('10.0.0.0/24')
        d = PolicyDecision.permit(p)
        self.assertEqual(d.prefix(), p)


class RouteMapTest(unittest.TestCase):

    def test_no_rules_returns_permit_default(self):
        rmap = RouteMap(rules=[], default='permit')
        d = rmap.apply(NetworkAddress('10.0.0.0/24'))
        self.assertTrue(d.is_permitted())

    def test_no_rules_returns_deny_default(self):
        rmap = RouteMap(rules=[], default='deny')
        d = rmap.apply(NetworkAddress('10.0.0.0/24'))
        self.assertTrue(d.is_denied())

    def test_first_matching_rule_wins(self):
        rmap = RouteMap(rules=[
            RouteMapRule(match=PrefixList([NetworkAddress('10.0.0.0/8')]),
                         action='deny'),
            RouteMapRule(match=PrefixList([NetworkAddress('10.0.0.0/16')]),
                         action='permit'),
        ], default='permit')
        # Both rules match 10.0.0.0/16; first wins → deny.
        d = rmap.apply(NetworkAddress('10.0.0.0/16'))
        self.assertTrue(d.is_denied())

    def test_falls_through_to_default_on_no_match(self):
        rmap = RouteMap(rules=[
            RouteMapRule(match=PrefixList([NetworkAddress('10.0.0.0/8')]),
                         action='deny'),
        ], default='permit')
        d = rmap.apply(NetworkAddress('200.0.0.0/24'))
        self.assertTrue(d.is_permitted())
