import collections
import threading


class NATTable:
    """Per-router source-NAT table.

    Outbound flows from a private source crossing to a public egress are
    recorded here as (rewritten_src, original_dst, flow_id) -> original_src.

    Without a transport layer there are no L4 ports, so the flow_id —
    extracted from the payload via flow_id() below — plays the role of
    a pseudo-port. This lets two private hosts on the same tenant LAN
    talk to the same public destination concurrently without one
    stealing the other's replies. Payloads with no flow identity
    register flow_id=None and share a single slot per (src, dst);
    that's fine for fire-and-forget messages with no reply.

    Entries persist until LRU-evicted at capacity to bound memory for
    long sims. There is no time-based expiration and no clearing on
    inbound match.
    """

    def __init__(self, max_entries: int = 1024):
        self._entries = dict()
        self._order = collections.OrderedDict()
        # Flows this router has carried *into* private space (public source,
        # private destination). Their return leg belongs to a conversation
        # opened from outside and must cross back untranslated — see
        # note_inbound_flow. Bounded like the entry table.
        self._inbound_flows = collections.OrderedDict()
        self._lock = threading.Lock()
        self._max = max_entries

    def register(self, rewritten_src, original_dst, flow_id, original_src):
        """Record a NAT mapping, refreshing LRU position if it already exists."""
        key = (rewritten_src, original_dst, flow_id)
        with self._lock:
            self._entries[key] = original_src
            if key in self._order:
                del self._order[key]
            self._order[key] = None
            while len(self._order) > self._max:
                old, _ = self._order.popitem(last=False)
                self._entries.pop(old, None)

    def lookup(self, rewritten_src, original_dst, flow_id):
        """Return the original source address for this flow, or None on miss."""
        with self._lock:
            return self._entries.get((rewritten_src, original_dst, flow_id))

    def note_inbound_flow(self, flow_id):
        """Record that `flow_id` entered private space from the outside.

        Source-NAT belongs to conversations opened from inside. When the
        public side opens one, translating the reply would deliver it from
        the router's address instead of the host that was addressed, and the
        sender would discard it as unrelated. `flow_id=None` payloads carry
        no conversation identity and are not tracked.
        """
        if flow_id is None:
            return
        with self._lock:
            if flow_id in self._inbound_flows:
                del self._inbound_flows[flow_id]
            self._inbound_flows[flow_id] = None
            while len(self._inbound_flows) > self._max:
                self._inbound_flows.popitem(last=False)

    def is_inbound_flow(self, flow_id) -> bool:
        """Whether `flow_id` was opened from the public side."""
        if flow_id is None:
            return False
        with self._lock:
            return flow_id in self._inbound_flows

    def snapshot(self):
        """Return entries in LRU order (oldest first, most recent last).

        Each entry is a JSON-serializable dict; consumed by
        `nat_table_changed` subscribers.
        """
        with self._lock:
            return [
                {
                    'rewritten_src': str(rewritten),
                    'dst': str(dst),
                    'flow_id': fid,
                    'original_src': str(self._entries[(rewritten, dst, fid)]),
                }
                for (rewritten, dst, fid) in self._order
            ]


def flow_id(payload):
    """Return a NAT multiplex discriminator for this payload, or None.

    Delegates to the payload's `flow_key()` — the same end-to-end
    conversation identifier used to group hops in `packet` events.
    Requests use their own Message id; replies echo their originating
    request's id. This keys NAT on the conversation, so two private
    hosts behind one NAT router pinging the same destination concurrently
    get distinct NAT entries even when their per-host `seq` counters
    happen to collide.

    Payloads without a `flow_key` (arbitrary objects) get flow_id=None
    and share a single NAT slot per (rewritten_src, original_dst).
    """
    flow_key = getattr(payload, 'flow_key', None)
    if flow_key is None:
        return None
    return flow_key() if callable(flow_key) else flow_key
