# Packets

`loom` models two layers and a payload:

```
┌────────────────────────────────────────────────────┐
│ Frame   (src_addr_L2, dst_addr_L2, payload)        │  ← what travels on a fabric
│   payload = Datagram                               │
└───────────────┬────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────┐
│ Datagram  (src_addr_L3, dst_addr_L3, ttl, payload) │  ← what survives forwarding
│   payload = Message                                │
└───────────────┬────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────┐
│ Message  (subtype-specific fields)                 │  ← the application bits
└────────────────────────────────────────────────────┘
```

`Frame`, `Message`, and their user/ping subclasses live in
[`src/entities/packet.py`](../../src/entities/packet.py). `Datagram` lives
in [`src/routing/messages.py`](../../src/routing/messages.py) (re-exported
from [`entities/packet.py`](../../src/entities/packet.py) for back-compat).
`RoutingMessage` is an abstract base in
[`src/routing/lsa.py`](../../src/routing/lsa.py) (also re-exported).

## `Packet` (base)

```python
class Packet:
    def __init__(self, src_addr, dst_addr, payload):
        self._src_addr = src_addr
        self._dst_addr = dst_addr
        self._payload = payload
```

Five accessors/mutators: `source()`, `destination()`, `payload()`, and the
NAT mutators `rewrite_source(addr)` / `rewrite_destination(addr)` which
overwrite the stored address in place. `Frame` inherits directly (it adds
nothing); `Datagram` extends it with TTL.

## `Frame`

The L2 envelope. Built by `Interface.send_to`:

```python
frame = Frame(src_addr=self._address, dst_addr=dst_addr, payload=datagram)
self._out_queue.put(frame)
```

- `src_addr` is always the interface's own address: the local hop,
  not the original sender.
- `dst_addr` is the L2 next-hop: either the L3 destination (when the
  next hop is "directly connected" via `NullAddress`) or the next-hop
  router's address.
- `payload` is the `Datagram`, which carries the unchanged L3 endpoints.

The L2 vs. L3 distinction is what makes routing work: every hop
re-frames the datagram with new `src_addr`/`dst_addr` but leaves the
inner `Datagram.source()` / `Datagram.destination()` alone.

`Network._dispatch_unicast` keys delivery on `frame.destination()`: the
L2 next-hop. `Link._dispatch_packet` uses structural peer resolution:
deliver to the interface whose `address()` is not `frame.source()`.
That's deliberately not address-based, so two parallel links can reuse
the same `/30` without cross-talk.

## `Datagram`

```python
_DEFAULT_TTL = 64

class Datagram(Packet):
    def __init__(self, src_addr, dst_addr, payload, ttl=_DEFAULT_TTL):
        super().__init__(src_addr, dst_addr, payload)
        self._ttl = ttl

    def ttl(self): return self._ttl
    def decrement_ttl(self): self._ttl -= 1
```

The L3 packet. `src_addr` / `dst_addr` are the **end-to-end endpoints**:
re-framing at each hop leaves them alone, which is the whole point of the
L2/L3 split above. The one thing that does rewrite them is NAT, via the
`rewrite_source` / `rewrite_destination` mutators: see
[`nat.md`](nat.md). That is also why `flow_key()` is keyed on the payload
rather than on this address pair.

TTL handling lives in `Router._handle_forwarding`:

```python
packet.decrement_ttl()
if packet.ttl() <= 0:
    _logger.warning("TTL expired: dropping datagram to %s", dst)
    return None
```

Two consequences:

- Hosts do not decrement TTL. `Host._handle_message` is the terminal
  receiver; TTL is only touched on forwarding hops.
- TTL-expired packets are dropped silently (logged via the standard
  logging framework). No ICMP-style notification.

The rest of `_handle_forwarding` (the route lookup, the exceptions it
raises on a miss, the `NullAddress` next-hop substitution) is a `Router`
concern rather than a packet one; see
[`entities.md`](entities.md#router-routerpy).

## `Message`

```python
class Message:
    def __init__(self):
        self._id = uuid.uuid4()

    def type(self):
        return self.__class__

    def id(self):
        return self._id

    def flow_key(self) -> str:
        return str(self._id)
```

A `Message` is identified by a fresh UUID. Two `Message` instances are
equal iff they have the same class and the same `_id`: important
because `EventTracer.register_message_event` uses the message as a dict
key, and the routing protocol uses sequence numbers separately from
message identity.

`flow_key()` returns a stable conversation identifier keyed on the
payload, not the packet's address pair. This means it survives NAT
rewrites of `src`/`dst` mid-path. Request/reply subtypes (`PingReply`)
override `flow_key()` to echo the originating request's key, so both
directions of a conversation share one id.

Four subclasses live alongside the base.

### `UserMessage`

The payload of a user-level `send`:

```python
class UserMessage(Message):
    def __init__(self, payload):
        super().__init__()
        self._payload = payload

    def payload(self):
        return self._payload
```

Constructed by `cmd_send` in the host terminal and handed to
`Host.send_message_to`, which wraps it in a `Datagram`: the host never
builds the `UserMessage` itself. The `payload` is everything after the
destination, joined with single spaces. The terminal splits the command
line with `shlex.split`, so quoting survives: both `send h2 hello world`
and `send h2 "hello world"` yield a payload of `hello world`.

### `RoutingMessage`

`RoutingMessage` is an abstract base
([`src/routing/lsa.py`](../../src/routing/lsa.py)). Two concrete subclasses
carry the protocol wire traffic: `LSA` and `Hello`.

#### `LSA`

```python
class LSA(RoutingMessage):
    @classmethod
    def from_router(cls, router, seq, policy) -> 'LSA': ...
    @classmethod
    def withdrawal(cls, router, seq) -> 'LSA': ...
    def __init__(self, origin, seq, is_withdrawal=False): ...
    def origin(self): return self._origin
    def seq(self): return self._seq
    def attachments(self): ...                  # fabric -> Attachment(cost, prefix)
    def add_attachment(self, fabric, cost, prefix=None): ...
    def links(self): ...                        # NetworkAddress -> cost (announced only)
    def add_link(self, prefix, cost): ...       # convenience over add_attachment
    def is_withdrawal(self): return self._is_withdrawal
    def is_newer_than(self, other): return self._seq > other.seq()
    def has_same_links_as(self, other): return self._attachments == other._attachments
```

Origination: `LinkStateProtocol._emit_lsa_on_up_interfaces` builds **two
`LSA`s per cycle from one sequence number**, both via
`LSA.from_router(router, seq, policy)`, differing only in policy. The
permit-all one is installed into the local LSDB (so private prefixes
appear in the local graph); the policy-filtered one is the **single
object** sent out every up interface, so all N emissions carry the same
`seq`. See [`policy.md`](policy.md) for the split.

`seq` is per-origin (one counter per router), not per-interface.
Receivers dedup in `LSDB.install`, which keeps the highest sequence number
ever accepted from each origin and rejects anything with
`seq <= last_seen_seq`:

- **`seq <= last_seen_seq`**: `InstallResult.rejected()`. The LSA is
  dropped outright: not installed, not re-flooded, no recompute. This
  is what terminates the flood, since a router receiving the same LSA from
  two neighbors re-floods only the first copy.
- `seq > last_seen_seq`, same links: accepted and re-flooded (so
  downstream peers refresh too), but `changed_graph()` is `False`, so no
  shortest-path recompute.
- `seq > last_seen_seq`, different links: accepted, re-flooded, and
  `changed_graph()` is `True`, triggering the recompute.

The last-seen sequence number survives the LSA it came from: a withdrawal
purges the origin's entry but leaves the number behind as a tombstone, so
duplicate withdrawals and stale re-announcements are still rejected rather
than looking brand-new. `LSA.is_newer_than` exists as a comparison helper
but is not what the LSDB dedup path calls.

#### `Hello`

```python
class Hello(RoutingMessage):
    def __init__(self, originator, neighbors_heard): ...
    def originator(self): return self._originator
    def neighbors_heard(self): return list(self._neighbors_heard)
```

`_emit_hello_on_up_interfaces` builds **one `Hello` per interface**
(each carries that interface's per-fabric `neighbors_heard` list). Unlike
`LSA`, a `Hello` carries no sequence number: it is never re-flooded, so
there is nothing to dedup.

See [`routing-protocol.md`](routing-protocol.md) for the full
flooding rules.

### `PingRequest` and `PingReply`

```python
class PingRequest(Message):
    def __init__(self, seq: int):
        super().__init__()
        self._seq = seq
        self._sent_at = _time.monotonic()
    # exposes .seq and .sent_at as @property

class PingReply(Message):
    def __init__(self, seq: int, request_ts: float, request_id=None):
        super().__init__()
        self._seq = seq
        self._request_ts = request_ts
        self._request_id = request_id
    # exposes .seq, .request_ts, .request_id as @property

    def flow_key(self) -> str:
        # Echo the originating request's UUID so request + reply share
        # one conversation key. Falls back to self._id when request_id
        # is None.
        if self._request_id is None:
            return super().flow_key()
        return str(self._request_id)
```

The flow, steps 1 and 4 run on the caller's thread while step 3 runs on
the receiving interface's thread, which is why the handshake needs two
dicts and an event:

1. `Host.ping(dst, timeout)` allocates `seq = next(self._ping_seq)`,
   registers a `(str(dst), seq) → threading.Event` in `_pending_pings`,
   sends a `Datagram(payload=PingRequest(seq))`, then blocks on
   `evt.wait(timeout)`.
2. The destination host's `_handle_message` sees a `PingRequest`, sends
   back a `PingReply(seq, request_ts=msg.sent_at)`.
3. The originating host's `_handle_message` matches the reply by
   `(str(packet.source()), msg.seq)`, records
   `_ping_results[key] = time.monotonic() - msg.request_ts`, sets the
   event.
4. `evt.wait` returns and the caller deletes its own `key` from both
   dicts: from `_pending_pings` because the waiter is spent, and from
   `_ping_results` with a `pop` that reads the RTT and removes it in one
   step, so neither dict accumulates entries across pings. It returns that
   RTT. On timeout the same two deletions run and `ping` returns `None`,
   so a reply that arrives late finds no waiter and is dropped.

The reply carries the request's `sent_at` value as `request_ts`.
That's important: the destination host doesn't keep state per ping; it
echoes the request's timestamp back so the originator can compute RTT
locally without clock-sync issues.

If a host has no gateway and the destination is off-link, `ping` raises
`ValueError("no route to host: no gateway configured")` *before* sending
anything (and the pending-pings entry is rolled back).

## Packet classification

`Interface.send_to` emits a `packet` event with a `type` field.
Classification is by `type(payload).__name__`:

```python
_PACKET_KIND = {
    "Hello":       "hello",
    "LSA":         "routing_flood",
    "UserMessage": "user_datagram",
    "PingRequest": "ping_request",
    "PingReply":   "ping_reply",
}
```

Unknown classes get `"unknown"`.

Two correlation ids accompany every packet event:

- `payload_id` = `str(message.id())`: identifies the single direction of
  a flow. A ping request and its reply have different `payload_id`s.
- `flow` = `payload.flow_key()`: the stable end-to-end conversation UUID.
  The ping pair shares the same `flow` (because `PingReply.flow_key()`
  echoes the request's UUID), so subscribers can group both directions.
  This value survives NAT rewrites of `src`/`dst` mid-path.

Each event also carries a `payload` dict with per-Message-subclass
metadata:

| `type`          | `payload` keys                          |
|-----------------|-----------------------------------------|
| `user_datagram` | `{"bytes": <int>}` always; `"text": <str>` when the body is a string |
| `ping_request`  | `{"seq": <int>}`                        |
| `ping_reply`    | `{"seq": <int>, "request_ts": <float>}` |
| `routing_flood` | `{"seq": <int>, "originator": <str>, "destinations": [{"prefix": <str>, "cost": <int>}, ...], "attachments": [{"fabric": <str>, "cost": <int>}, ...]}` |
| `hello`         | `{"originator": <str>, "neighbors_heard": [<str>, ...]}` |
| anything else   | `{}`                                    |

The shape is intentionally free-form: future message types add their own
keys without coordinating with subscribers.

The `packet` event is the only event `Interface.send_to` emits. Routers
emit their own kinds as they translate or answer traffic, `nat`,
`nat_table_changed` and `router_intercept`, and hosts emit `ping_result`
once per probe. Those are event contracts rather than packet formats:

- [`server-api.md`](server-api.md#ws-wsevents): the wire shape of every
  event kind, `packet` included.
- [`nat.md`](nat.md): when a rewrite happens, how the flow key is
  derived, and the LRU bound on the table.

---

## Code references

| Concern | File | Symbol |
|---|---|---|
| Carrier + L2 frame | [`src/entities/packet.py`](../../src/entities/packet.py) | `Packet`, `Frame` |
| Payload base | [`src/entities/packet.py`](../../src/entities/packet.py) | `Message`, `Message.flow_key` |
| User + ping payloads | [`src/entities/packet.py`](../../src/entities/packet.py) | `UserMessage`, `PingRequest`, `PingReply` |
| Routing carrier | [`src/routing/messages.py`](../../src/routing/messages.py) | `Datagram` |
| Routing payloads | [`src/routing/lsa.py`](../../src/routing/lsa.py), [`src/routing/hello.py`](../../src/routing/hello.py) | `RoutingMessage`, `LSA`, `Hello` |
| Transmit + `packet` event | [`src/entities/interface.py`](../../src/entities/interface.py) | `Interface.send_to`, `_classify`, `_summarize_payload` |
| Forwarding + TTL | [`src/entities/router.py`](../../src/entities/router.py) | `Router._handle_forwarding` |
| Terminal delivery | [`src/entities/host.py`](../../src/entities/host.py) | `Host._handle_message`, `Host.ping` |
| Tests | [`test/test_packet_handling.py`](../../test/test_packet_handling.py), [`test/test_forwarding.py`](../../test/test_forwarding.py) | none |
