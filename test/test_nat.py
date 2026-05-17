import threading
import unittest

from entities import Address, Router
from entities.nat import NATTable, flow_id
from entities.packet import PingReply, PingRequest, UserMessage


class NATTableTest(unittest.TestCase):

    def test_register_then_lookup_returns_original_src(self):
        table = NATTable()
        rewritten = Address('200.100.0.1')
        original_dst = Address('8.8.8.8')
        original_src = Address('192.168.1.10')
        table.register(rewritten, original_dst, flow_id=1, original_src=original_src)

        self.assertEqual(
            table.lookup(rewritten, original_dst, flow_id=1),
            original_src,
        )

    def test_lookup_miss_returns_none(self):
        table = NATTable()
        self.assertIsNone(
            table.lookup(Address('200.100.0.1'), Address('8.8.8.8'), flow_id=1)
        )

    def test_two_hosts_same_destination_multiplex_by_flow_id(self):
        # The crux: two private hosts behind one router talk to the same
        # public destination concurrently. Their NAT entries must coexist.
        table = NATTable()
        rewritten = Address('200.100.0.1')
        dst = Address('8.8.8.8')
        h_a = Address('192.168.1.10')
        h_b = Address('192.168.1.20')
        table.register(rewritten, dst, flow_id=42, original_src=h_a)
        table.register(rewritten, dst, flow_id=43, original_src=h_b)
        self.assertEqual(table.lookup(rewritten, dst, flow_id=42), h_a)
        self.assertEqual(table.lookup(rewritten, dst, flow_id=43), h_b)

    def test_lru_evicts_when_over_capacity(self):
        table = NATTable(max_entries=2)
        dst = Address('1.1.1.1')
        for i in range(3):
            table.register(
                Address(f'10.0.0.{i + 1}'), dst,
                flow_id=i, original_src=Address(f'192.168.0.{i + 1}'),
            )
        # Oldest (10.0.0.1) should be gone; the two newer ones present.
        self.assertIsNone(table.lookup(Address('10.0.0.1'), dst, flow_id=0))
        self.assertEqual(
            table.lookup(Address('10.0.0.2'), dst, flow_id=1),
            Address('192.168.0.2'),
        )
        self.assertEqual(
            table.lookup(Address('10.0.0.3'), dst, flow_id=2),
            Address('192.168.0.3'),
        )

    def test_re_register_refreshes_lru_position(self):
        table = NATTable(max_entries=2)
        a, b, c = Address('10.0.0.1'), Address('10.0.0.2'), Address('10.0.0.3')
        dst = Address('1.1.1.1')
        orig_a = Address('192.168.0.1')
        orig_b = Address('192.168.0.2')
        orig_c = Address('192.168.0.3')
        table.register(a, dst, flow_id=1, original_src=orig_a)
        table.register(b, dst, flow_id=2, original_src=orig_b)
        table.register(a, dst, flow_id=1, original_src=orig_a)  # refresh a
        table.register(c, dst, flow_id=3, original_src=orig_c)  # evicts b
        self.assertEqual(table.lookup(a, dst, flow_id=1), orig_a)
        self.assertIsNone(table.lookup(b, dst, flow_id=2))

    def test_snapshot_returns_entries_in_lru_order(self):
        table = NATTable()
        rewritten = Address('200.100.0.1')
        dst = Address('8.8.8.8')
        table.register(rewritten, dst, flow_id=1, original_src=Address('192.168.1.10'))
        table.register(rewritten, dst, flow_id=2, original_src=Address('192.168.1.20'))
        snap = table.snapshot()
        self.assertEqual(len(snap), 2)
        self.assertEqual(snap[-1], {
            'rewritten_src': '200.100.0.1',
            'dst': '8.8.8.8',
            'flow_id': 2,
            'original_src': '192.168.1.20',
        })

    def test_concurrent_register_is_thread_safe(self):
        table = NATTable(max_entries=10_000)
        dst = Address('1.1.1.1')

        def worker(start):
            for i in range(1000):
                hi = (start + i) // 256 % 256
                lo = (start + i) % 256
                rewritten = Address(f'10.{hi}.{lo}.1')
                table.register(
                    rewritten, dst,
                    flow_id=start + i,
                    original_src=Address('192.168.0.1'),
                )

        threads = [
            threading.Thread(target=worker, args=(s,))
            for s in range(0, 4000, 1000)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Should not crash, should not exceed cap.
        self.assertLessEqual(len(table._entries), 10_000)


class FlowIdHelperTest(unittest.TestCase):

    def test_ping_request_uses_seq(self):
        self.assertEqual(flow_id(PingRequest(seq=7)), 7)

    def test_ping_reply_uses_seq(self):
        self.assertEqual(flow_id(PingReply(seq=7, request_ts=0.0)), 7)

    def test_user_message_returns_none(self):
        self.assertIsNone(flow_id(UserMessage('hi')))

    def test_arbitrary_object_without_seq_returns_none(self):
        self.assertIsNone(flow_id(object()))


class RouterNATWiringTest(unittest.TestCase):

    def test_router_constructs_its_own_nat_table(self):
        r = Router('r1')
        self.assertIsInstance(r.nat_table(), NATTable)

    def test_each_router_has_its_own_table(self):
        a, b = Router('a'), Router('b')
        self.assertIsNot(a.nat_table(), b.nat_table())
