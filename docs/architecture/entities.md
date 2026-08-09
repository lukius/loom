> 🌐 **English** · [Español](../es/architecture/entities.md)

# Entities

The simulator's domain model lives in `src/entities/`. Every class here is
a normal Python object — there is no ORM, no schema, no framework. The
`AS` instance is the single root that owns everything else.

```
Entity (base.py)
├── AS                  (system.py)        ── root container
├── NetworkDevice       (device.py)
│   ├── Router          (router.py)        ── forwards datagrams
│   └── Host            (host.py)          ── endpoint; cannot forward
├── _FabricBase         (_fabric.py)       ── private base for packet fabrics
│   ├── Network         (network.py)       ── multi-access LAN
│   └── Link            (link.py)          ── /30 or /31 point-to-point
└── Interface           (interface.py)     ── attaches a device to a fabric

Address / NetworkAddress (address.py)     ── IPv4 + CIDR primitives
NullAddress              (constant)        ── "directly connected" sentinel
```

The rest of this document walks each class in turn — purpose, key methods,
invariants, and the traps you'll hit if you ignore them.

---

## `Entity` (`base.py`)

```python
class Entity:
    def __init__(self, name):
        self._name = name

    def name(self):
        return self._name
```

The simplest possible base class. Just gives everything a name. Don't
extend it with metaclass magic — half the codebase assumes
`obj.name()` is cheap and never raises.

---

## `AS` (`system.py`)

The autonomous system. One per process. Owns:

- `_networks`, `_links`, `_routers`, `_hosts` — dicts keyed by entity
  name.
- `_gate: PauseGate` — the **single** pause gate that every worker thread
  in this AS blocks on.

Lookup methods:

| Method | Behavior |
|---|---|
| `network(name)` | Raises `NetworkNotFoundException` if absent |
| `link(name)` | Raises `LinkNotFoundException` |
| `router(name)` | Raises `RouterNotFoundException` |
| `host(name)` | Raises `HostNotFoundException` |
| `device(name)` | Tries `host(name)`, falls back to `router(name)` — used by the API's `/devices/{name}` routes |

Mutation:

- `add_network`, `add_link`, `add_host` — straightforward.
- `add_router(r)` — also injects `r._as_gate = self._gate` so the router's
  protocol thread gates on the same `PauseGate` as the rest.

Lifecycle:

- `stop()` cascades: signals the gate stopped, stops every network, link,
  and router. Routers each stop their `LinkStateProtocol` thread.

The AS never knows about the FastAPI server or the event bus.
`SimState` wraps it but the AS itself is a pure-Python object you could
instantiate in a unit test.

---

## `Address` and `NetworkAddress` (`address.py`)

`BaseAddress` parses dotted-quad into `self._octets`. `Address` is just
the host form; `NetworkAddress(address)` parses `"a.b.c.d/M"` and
**canonicalizes** the octets — the host bits are zeroed at construction:

```python
NetworkAddress("10.1.2.3/24")  # canonicalized to 10.1.2.0/24
```

Important methods on `Address`:

- `is_private()` — `True` iff the address falls within an RFC 1918 range
  (10/8, 172.16/12, 192.168/16).

Important methods on `NetworkAddress`:

- `mask()` — the prefix length (`int`).
- `matches(addr)` / `contains(addr)` — `True` iff `addr` is inside this
  prefix. (They're identical; both names exist.)
- `broadcast()` — returns the broadcast `Address`
  (`NetworkAddress("10.1.2.0/24").broadcast()` → `Address("10.1.2.255")`).
- `is_private()` — same RFC 1918 test, applied to the network address
  itself.

`NullAddress = Address('0.0.0.0')` is a **module-level sentinel** used by
`RoutingTable` to mean "this destination is on a directly connected
network — deliver to `packet.destination()` itself, no next-hop
indirection." Don't compare with `is`; the `Address.__eq__` operator
handles it.

---

## `NetworkDevice` (`device.py`)

Common base for `Host` and `Router`. Holds `self._interfaces` keyed by
`iface.name()` (within a device, names like `eth0` are unique).

Key method: **`handle_packet(packet, interface)`** — called by the
`Interface`'s packet loop. It drops packets arriving on an
admin-down interface, then decides whether the packet is *for me*
or needs forwarding:

```python
def handle_packet(self, packet, interface):
    if not interface.is_up():
        return  # ingress interface administratively down — drop
    dst = packet.destination()
    net_broadcast_addr = interface.network().broadcast_address()
    own_addresses = {iface.address() for iface in list(self._interfaces.values())}
    if dst in own_addresses or dst == net_broadcast_addr:
        self._handle_message(packet.payload(), interface, packet)
    else:
        self._handle_forwarding(packet)
```

The `own_addresses` set matches the destination against **any** of the
device's interfaces, not just the one the packet arrived on — this is how
a `PingRequest` addressed to a router's far-side IP lands in
`_handle_message` rather than being forwarded back toward itself.
The broadcast-address check lets routing-protocol floods land in
`_handle_message` instead of being recursively forwarded.

Equality is by `(class, name)` — `Host('h1') != Router('h1')`.

---

## `Router` (`router.py`)

A `NetworkDevice` plus a `RoutingTable` plus a `LinkStateProtocol`. Four
responsibilities:

1. **Forward datagrams.** `_handle_forwarding(packet)`:
   - Decrement TTL; drop via `_logger.warning(...)` if `<= 0`.
   - `routing_table.match(dst)` → `MatchingResult`.
   - If not matched, raises `NoRouteToHostException`, or
     `NoNATEgressException` when the source is private but the router has
     no public interface to egress through.
   - If `next_hop is NullAddress`, substitute `packet.destination()` as the
     real next hop (the destination is on the directly connected network).
   - Hand the datagram to `out_iface.send_to(packet, next_hop)` and emit
     `EventTracer.datagram_forwarded`.

2. **Apply source/destination NAT** at private↔public boundaries. On
   outbound (private source crossing to a public egress), rewrites the
   source and registers the flow in the per-router `NATTable`; emits
   `nat` (outbound) and `nat_table_changed` events. On inbound (public
   destination arriving from a public interface), reverses the rewrite
   using the NAT table; emits `nat` (inbound). See
   [`nat.md`](nat.md) for the translation rules and
   [`server-api.md`](server-api.md#ws-wsevents) for the event shapes.

3. **Speak the routing protocol.** `_handle_routing_message` iterates
   `self.protocols()` (each a `LinkStateProtocol`) and calls
   `handle_incoming_message`. `PingRequest` addressed to any of the
   router's own interface IPs is answered by `_reply_to_ping`, which
   emits a `router_intercept` event and sends a `PingReply` back.
   `PingReply` is silently dropped — routers do not initiate pings.

4. **Run the protocol.** `start()` and `stop()` iterate `self.protocols()`
   and toggle each protocol's thread. `halt(graceful=True)` floods a
   withdrawal LSA (graceful) or silently downs all interfaces (crash),
   then emits `device_state_changed`. `resume()` re-enables interfaces,
   re-announces via every protocol, and emits `device_state_changed`.
   `disable_interface(name)` / `enable_interface(name)` bring individual
   interfaces up or down (with optional graceful re-announcement).

The `RoutingTable` (defined in the same file) is a list of
`RoutingRule(prefix, next_hop, interface)` with four operations under a
single `Lock`: `add_rule`, `clear`, `remove_rule`, `rules()`, and
**`match`** which does linear longest-prefix-match. Linear is fine for
the simulator's scale; do not introduce a trie unless profiling says so.

`match` returns a `MatchingResult`. Construct via
`MatchingResult.matched(next_hop, interface)` (hit) or
`MatchingResult.not_matched()` (miss); query via `is_matched()`.
Accessors `next_hop()` and `interface()` return `None` on a miss.

---

## `Host` (`host.py`)

A `NetworkDevice` with **exactly one** `Interface` and an optional
gateway `Address`. Cannot forward — `_handle_forwarding` raises.

The interesting methods:

- **`send_message_to(msg, addr)`** — wraps `msg` in a `Datagram` with
  TTL=64, picks the L2 destination (the destination itself if on the same
  network, otherwise the gateway), pushes to the interface, and emits
  `EventTracer.message_sent`.
- **`set_gateway(addr)`** — must be inside the host's network, else
  `ValueError`. The terminal's `set_gateway` command routes through here.
- **`ping(dst_addr, timeout=3.0)`** — synchronous from the caller's view:
  1. Allocates a per-flow `(dst, seq)` key, registers a
     `threading.Event`, sends a `PingRequest`.
  2. Calls `evt.wait(timeout)`.
  3. When the matching `PingReply` arrives, `_handle_message` records
     `rtt = time.monotonic() - request_ts` and sets the event.
  4. Returns the RTT or `None` on timeout.

  Per-flow state lives in `_pending_pings` and `_ping_results`, both
  protected by `_ping_lock`. The `_ping_seq` is an `itertools.count` so
  sequence numbers monotonically increase across calls.

If a host has no gateway and the destination is off-link, `send_message_to`
and `ping` raise `ValueError("no route to host: no gateway configured")`.

---

## `Interface` (`interface.py`)

An `Interface` attaches a `NetworkDevice` to a `_FabricBase` (a `Network`
or `Link`). It owns:

- `_address`, `_cost`, `_net` (the fabric), `_device` (set later by the
  device).
- `_in_queue` — frames coming **in** from the fabric.
- `_out_queue` — frames going **out** to the fabric (set by the fabric on
  `add_interface`).
- `_pkt_thread` — daemon that drains `_in_queue` and dispatches to
  `_device.handle_packet`.

Lifecycle on the inbound thread (`_pkt_loop`):

1. `frame = self._in_queue.get()` (blocking)
2. If `frame is None` → mark stopped and exit.
3. Call `_await_gate_running()` (delegates to `clock.wait_for_gate`);
   returns `False` → mark stopped and exit.
4. If `self._device is None` → raise `InterfaceNotReadyException`.
5. `device.handle_packet(frame.payload(), self)`.
   Exceptions are caught and logged so the loop survives bad frames.

`_await_gate_running()` polls `wait_for_gate(self._gate, self._stop_event)`:
returns `True` to proceed, `False` to exit. This is **dequeue-then-gate** —
not gate-then-dequeue — so a frame that's already been dequeued is processed
when the gate re-opens rather than re-queued.

Lifecycle on the outbound side (`send_to`):

```python
def send_to(self, datagram: Datagram, dst_addr: Address):
    if not self._up:
        return  # administratively down — do not transmit
    frame = Frame(src_addr=self._address, dst_addr=dst_addr, payload=datagram)
    self._out_queue.put(frame)
    # plus: emit EventTracer "packet" event (see below)
```

The event dict includes both a **`payload_id`** (uniquely identifies one
Message instance — one direction) and a **`flow`** key (the end-to-end
conversation identifier reported by the payload via `Message.flow_key()`).
The flow is a **stable conversation UUID** keyed on the payload — not
on packet sequence numbers and not on the packet's address pair — so it
survives NAT rewrites of src/dst as the packet crosses private↔public
boundaries. `PingReply` overrides `flow_key` to echo its originating
`PingRequest`'s id, so a single ping (request + reply, even across NAT)
reports one flow. The same value is the NAT-table discriminator (see
`entities/nat.py::flow_id`), so two private hosts with colliding
sequence numbers each get their own NAT entry.

Two fields are derived to keep `Frame.source()` valid for the fabric's
peer-resolution code:

- `frame.source()` is **always** the interface's own address — the L2
  hop, not the original L3 source.
- `frame.destination()` is the L2 next-hop, not the L3 destination.
- `frame.payload() = Datagram` carries the real L3 source / destination.

This is why `Network._dispatch_unicast` keys on `dst_addr` (which is the
L2 next-hop) and `Link._dispatch_packet` keys on "not the source"
(structural peer resolution, immune to IP collisions across different
links — see [`link.py:75`](../../src/entities/link.py)).

---

## `_FabricBase` (`_fabric.py`) — private

Shared base for `Network` and `Link`. Owns:

- `_interfaces` — keyed by **interface IP address**, not by `iface.name()`.
  Interface names are only unique per-device (`r1.eth0` and `r2.eth0`
  both sit on the same LAN); keying by name would clobber siblings.
- `_in_queue` — frames arriving from any attached interface's outbound
  queue.
- `_pkt_thread` — daemon that drains and calls `_dispatch_packet`.

The `_pkt_loop` is **gate-then-dequeue**: it checks the gate first, then
attempts a short-timeout dequeue. If the gate was paused between the check
and the dequeue, the packet is put back so it remains in the queue while
the sim is paused — no `packet` events are emitted for frames that haven't
been dispatched yet.

Subclasses must implement `_dispatch_packet(packet)`.

---

## `Network` (`network.py`)

A multi-access LAN. `_dispatch_packet` looks at the frame's L2
destination:

- Broadcast address → `_dispatch_broadcast`: deliver to every interface.
- Anything else → `_dispatch_unicast`: look up the interface by IP and
  deliver only there.

Raises if the address isn't found in `_interfaces` — that's a bug in the
sender, not a normal condition.

`devices()` returns `{name: NetworkDevice}` derived from the attached
interfaces; useful for tools that want "everything on this LAN."

---

## `Link` (`link.py`)

A `/30` or `/31` point-to-point fabric — exactly two endpoints. Strict
construction-time check:

```python
if mask not in (30, 31):
    raise ValueError(f"Link requires /30 or /31 CIDR, got /{mask}")
```

`add_interface` enforces `MAX_ENDPOINTS = 2`, raising
`TooManyEndpointsException` on the third attempt.

`_dispatch_packet` does **not** look up the destination by address —
that would break when two parallel links happen to reuse the same `/30`
(the address namespace is local to the fabric, not global). Instead it
walks `_interfaces` and delivers to the one whose `address()` is not
equal to `frame.source()`. If only one endpoint has been attached yet
(construction race during patch apply), the frame is dropped silently.

`is_valid_host_address(addr)`:

- `/30`: rejects network (`.0`) and broadcast (`.3`) — only `.1` / `.2`
  are usable.
- `/31`: per RFC 3021, both addresses are valid hosts.

`peer_of(interface)` returns the other endpoint's `Interface`, or `None`
if it hasn't joined yet. The parser's `_post_pass_links` uses this to
auto-fill a host's gateway to its peer's IP.

---

## `Event` and `EventTracer` (`event.py`)

`EventTracer` is a **per-`Internet`-instance** event bus. The
class-level methods (`EventTracer._broadcast(...)`, `subscribe()`, etc.)
delegate to the currently-active instance set via `set_current()`.
When `set_current()` replaces one tracer with another, subscribers
registered on the previous tracer are carried over to the new one, so
long-lived subscribers (e.g. the server's event bridge registered at
startup) remain active across topology reloads.

It is two things at once:

1. **A typed callback registry** for message lifecycle: register a
   `MessageEvent` keyed by message identity, then any thread can call
   `message_sent`, `message_received`, or `datagram_forwarded` to fire
   the matching callback. Lets a caller observe a single `send` invocation's
   complete lifecycle.

2. **A broadcast pub/sub bus.**
   `EventTracer.subscribe(fn)` registers a callback that receives
   **every** `_broadcast(event_dict)` call. Broadcasts snapshot the
   subscriber list under a brief instance lock, then release it before
   fan-out, so subscribers cannot deadlock the bus. Subscriber exceptions
   are logged and swallowed so one bad subscriber can't kill the rest.

Both modes coexist by design: the callback registry is keyed by message
identity; the broadcast bus is instance-wide. The two don't see each other.

---

## `PauseGate` (`clock.py`)

A two-state gate with three signals: running, paused, stopped. See
[`concurrency.md`](concurrency.md) for the full lifecycle. The relevant
contract here:

- `wait_or_stop(timeout=None) → (running, stopped)` — block until
  running, stopped, or timeout.
- `sleep(duration) → (ticked, stopped)` — sleep, returning early only on
  stop.

Every worker thread in the simulator must use one of these (or both).
`time.sleep` directly is forbidden in workers — it ignores stop and pause.

---

## `Packet` and its subclasses

Covered in detail in [`packets.md`](packets.md). The short version:

- `Frame` — the L2 envelope (`src_addr`, `dst_addr`, `payload`); lives
  in `entities/packet.py`.
- `Datagram` — the L3 packet (TTL=64 by default, decremented per hop);
  canonical home is `routing/messages.py`, re-exported from
  `entities/packet.py`.
- `Message` — the payload inside the datagram (`entities/packet.py`).
  Subclasses:
  - `UserMessage(payload)` — user-level send.
  - `RoutingMessage` — abstract base in `routing/lsa.py`; concrete wire
    types are `LSA(origin, seq, is_withdrawal=False)` (link-state
    advertisement) and `Hello(originator, neighbors_heard)` (liveness),
    both in the `routing/` package.
  - `PingRequest(seq)` / `PingReply(seq, request_ts, request_id=None)` —
    ping pair. `PingReply` exposes `.request_id` and overrides `flow_key()`
    to echo the originating `PingRequest`'s id, so request and reply share
    one conversation key.
