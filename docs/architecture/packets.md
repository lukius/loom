> 🌐 **English** · [Español](../es/architecture/packets.md)

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
`src/entities/packet.py`. `Datagram` lives in `src/routing/messages.py`
(re-exported from `entities/packet.py` for back-compat). `RoutingMessage`
is an abstract base in `src/routing/lsa.py` (also re-exported).

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

- `src_addr` is **always the interface's own address** — the local hop,
  not the original sender.
- `dst_addr` is the L2 next-hop — either the L3 destination (when the
  next hop is "directly connected" via `NullAddress`) or the next-hop
  router's address.
- `payload` is the `Datagram`, which carries the unchanged L3 endpoints.

The L2 vs. L3 distinction is what makes routing work: every hop
re-frames the datagram with new `src_addr`/`dst_addr` but leaves the
inner `Datagram.source()` / `Datagram.destination()` alone.

`Network._dispatch_unicast` keys delivery on `frame.destination()` — the
L2 next-hop. `Link._dispatch_packet` uses **structural** peer resolution:
deliver to the interface whose `address()` is **not** `frame.source()`.
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

The L3 packet. `src_addr` / `dst_addr` are the **original endpoints**;
they don't change as the datagram is forwarded.

TTL handling lives in `Router._handle_forwarding`:

```python
packet.decrement_ttl()
if packet.ttl() <= 0:
    _logger.warning("TTL expired: dropping datagram to %s", dst)
    return None
```

Two consequences:

- **Hosts do not decrement TTL.** `Host._handle_message` is the terminal
  receiver; TTL is only touched on forwarding hops.
- **TTL-expired packets are dropped silently** (logged via the standard
  logging framework). No ICMP-style notification.

When a route lookup in `_handle_forwarding` fails, the router raises:

- `NoRouteToHostException` — no matching prefix in the routing table.
- `NoNATEgressException` — the packet's source is private but the router
  has no public interface to egress through.

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
equal iff they have the same class **and** the same `_id` — important
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

Created by `Host.send_message_to` and by `cmd_send` in the host terminal.
The `payload` is a single string token. The terminal uses `shlex.split`,
so quoting is supported: `send h2 "hello world"` yields a payload of
`hello world`.

### `RoutingMessage`

`RoutingMessage` is now an abstract base (`src/routing/lsa.py`). Two
concrete subclasses carry the protocol wire traffic: `LSA` and `Hello`.

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
    def links(self): return dict(self._links)   # NetworkAddress -> cost
    def add_link(self, prefix, cost): self._links[prefix] = cost
    def is_withdrawal(self): return self._is_withdrawal
    def is_newer_than(self, other): return self._seq > other.seq()
    def has_same_links_as(self, other): return self._links == other._links
```

Origination: `LinkStateProtocol._emit_lsa_on_up_interfaces` builds
**one shared `LSA`** per cycle via `LSA.from_router(router, seq,
policy)`, installs it into the local LSDB, then sends that **same
object** out every up interface — so all N emissions carry the same `seq`.

#### `Hello`

```python
class Hello(RoutingMessage):
    def __init__(self, originator, neighbors_heard): ...
    def originator(self): return self._originator
    def neighbors_heard(self): return list(self._neighbors_heard)
```

`_emit_hello_on_up_interfaces` builds **one `Hello` per interface**
(each carries that interface's per-fabric `neighbors_heard` list).

**`seq` is per-origin (one counter per router), not per-interface.**
Receivers dedup at the LSDB by `(origin_router, seq)` via
`is_newer_than`. A refresh with the same links is accepted and
re-flooded (so downstream peers refresh too) but does NOT trigger SPF
recompute (`InstallResult.changed_graph()` returns `False`).

**See [`routing-protocol.md`](routing-protocol.md)** for the full
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

The flow:

1. `Host.ping(dst, timeout)` allocates `seq = next(self._ping_seq)`,
   registers a `(str(dst), seq) → threading.Event` in `_pending_pings`,
   sends a `Datagram(payload=PingRequest(seq))`.
2. The destination host's `_handle_message` sees a `PingRequest`, sends
   back a `PingReply(seq, request_ts=msg.sent_at)`.
3. The originating host's `_handle_message` matches the reply by
   `(str(packet.source()), msg.seq)`, records
   `_ping_results[key] = time.monotonic() - msg.request_ts`, sets the
   event.
4. The `ping` call wakes from `evt.wait`, pops the event/result and
   returns the RTT (or `None` on timeout).

**The reply carries the request's `sent_at` value** as `request_ts`.
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

- `payload_id` = `str(message.id())` — identifies the single direction of
  a flow. A ping request and its reply have **different** `payload_id`s.
- `flow` = `payload.flow_key()` — the stable end-to-end conversation UUID.
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
| `routing_flood` | `{"seq": <int>, "originator": <str>, "destinations": [{"prefix": <str>, "cost": <int>}, ...]}` |
| `hello`         | `{"originator": <str>, "neighbors_heard": [<str>, ...]}` |
| anything else   | `{}`                                    |

The shape is intentionally free-form — future message types add their own
keys without coordinating with subscribers.

### `kind: "nat"`

Emitted by a router on every hop where NAT rewrites the datagram's
addresses. Two directions:

- **`outbound`** — source NAT on an egress hop. Carries `router`,
  `direction`, `original_src`, `rewritten_src`, `dst`, `flow_id`, and
  `payload_id` (the inner message's UUID).
- **`inbound`** — destination NAT on an ingress hop. Carries `router`,
  `direction`, `rewritten_dst`, `original_dst`, `src`, `flow_id`, and
  `payload_id`.

### `kind: "nat_table_changed"`

Emitted by a router after each NAT table registration. Carries `device`
and `entries` — a list of `{rewritten_src, dst, flow_id, original_src}`
dicts in LRU order, oldest first.

### `kind: "router_intercept"`

Emitted by a router when it answers a `PingRequest` addressed to one of
its own interface IPs (via `_reply_to_ping`). Carries `router`,
`originator` (sender's address), `pinged_address`, `received_on`
(interface name the request arrived on), `owning_iface` (interface name
that owns the pinged address, or `None`), and `payload_id` (the reply's
UUID). See [`server-api.md`](server-api.md) for the full event contract.

### `kind: "ping_result"`

Emitted by a host after each `ping()` call completes (whether the reply
arrived or timed out). Carries `device` (host name), `dst`, `seq`, and
`rtt_ms` (`float` on success, `null` on timeout). See
[`server-api.md`](server-api.md) for the full event contract.

## NAT entry lifetime

NAT entries persist until LRU-evicted at capacity (default 1024 per
router). There is no time-based expiration and no clearing on inbound
match. Without a transport layer there is no notion of a "connection" or
"idle" the simulator could time out against; LRU at the configured cap
keeps memory bounded while remaining predictable. Restart the simulation
to clear all entries.

## Flow multiplexing

Concurrent flows from multiple private hosts to the same public
destination are multiplexed by `nat.flow_id(payload)`, which calls
`payload.flow_key()` — the same conversation UUID used in `packet`
events. Because `PingReply` echoes its request's UUID, request and reply
share the same NAT entry even across NAT rewrites.

Message types without `flow_key` support (arbitrary objects) get
`flow_id=None` and share a single NAT slot per `(rewritten_src,
original_dst)`. Since they have no reply, this is harmless. New
request/reply message subtypes should override `flow_key()` so the NAT
table can disambiguate concurrent flows correctly — do not rely on a `seq`
attribute.
