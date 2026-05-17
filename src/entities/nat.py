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

    def snapshot(self):
        """Return entries in LRU order (oldest first, most recent last).

        Each entry is a dict suitable for JSON serialization. Used by
        the SPA inspector to render the per-router NAT table panel.
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

    The discriminator must match between a request and its
    corresponding reply so the reply correctly reverse-translates at
    the egress router. Today this is the shared `seq` on PingRequest
    and PingReply.

    New request/reply Message subtypes that can run concurrently from
    the same private LAN should expose a `seq` attribute (matching on
    request and reply). When/if a more general convention is needed,
    rename this helper to look for an explicit `flow_id()` method on
    payloads instead.
    """
    seq = getattr(payload, 'seq', None)
    if seq is None:
        return None
    return seq() if callable(seq) else seq
