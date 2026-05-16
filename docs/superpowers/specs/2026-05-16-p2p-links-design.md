# Point-to-Point Links — Design

**Date:** 2026-05-16
**Branch:** `feature/p2p-links`
**Status:** approved-for-planning

## Problem

The simulator models every fabric as a multi-access LAN (`entities/Network`). Real autonomous systems also have point-to-point links — wires connecting exactly two devices, typically two routers but sometimes a host and a router (or two hosts). These have distinct properties:

- Exactly two endpoints; no broadcast domain.
- Typically a /30 (RFC 791-style, four addresses: net / 2 hosts / broadcast) or /31 (RFC 3021, two host addresses).
- A host attached to a p2p link has only one possible "next hop" — the peer — so an explicit gateway setting is redundant.

The current model can technically express a p2p link as a 2-host LAN with a /30 subnet, but: there is no schema affordance for it, the UI renders a redundant intermediate LAN node, the validator has no way to enforce the "two endpoints only" rule, and there is no host gateway-auto-fill. This spec adds a first-class `Link` abstraction.

## Goals

1. Introduce a `Link` entity that is a sibling of `Network`, sharing a duck-typed "fabric" surface so existing code paths (routing protocol, forwarding, routing tables) work unchanged.
2. Support /30 and /31 CIDRs (numbered links only — unnumbered is out of scope).
3. Add a YAML schema: top-level `links:` map and a per-interface `link:` key as an alternative to `network:`.
4. Render p2p links in the web UI as a direct edge between the two endpoints, with no intermediate fabric node.
5. Permit any mix of LAN and link interfaces on the same router. Hosts on a link do not need a `gateway:`.
6. Stay strictly within TDD discipline: every behavioral commit is paired with covering tests; the suite is never red between commits.

## Non-Goals

- **Unnumbered links.** Each end of a p2p link carries an IP. Unnumbered support would require new next-hop semantics in `RoutingTable` and is deferred.
- **Per-link cost shorthand.** Costs remain per-interface, which matches OSPF/IS-IS and the existing `Interface.cost()` model. Asymmetric costs across a link are allowed.
- **New shell commands.** Existing `route`, `send`, `ping`, `update_cost`, `neighbors`, `ifconfig` work transparently because they delegate to entities whose behavior does not change.

## Architecture

### The Link entity (duck-typed fabric)

`Link` lives in `src/entities/link.py`, parallel to `Network`. Both are "fabrics" that an `Interface` attaches to via its `_net` field. Because `Network` already has the surface that `Interface`, `Router`, `RoutingProtocol`, etc. depend on, and `Link` exposes the same surface, **no change is needed in `Interface`, `Router`, `Host`, `RoutingProtocol`, or `RoutingTable`**.

The shared surface (duck-typed; not enforced by an ABC):

| Method | Network | Link |
|---|---|---|
| `name()` | from `Entity` | from `Entity` |
| `address() -> NetworkAddress` | the CIDR | the /30 or /31 CIDR |
| `broadcast_address() -> Address` | all-ones | all-ones (also returned for /31; never load-bearing for dispatch) |
| `contains_address(a) -> bool` | prefix match | prefix match |
| `add_interface(iface)` | dict by IP, unbounded | dict by IP, capped at 2 |
| `has_device(d) / devices()` | as-is | as-is |
| `stop() / join()` | as-is | as-is |
| `peer_of(iface) -> Interface` | n/a | new: the other endpoint, or `None` until two are attached |

### `_FabricBase` refactor

To avoid two divergent copies of the queue/loop/dispatch boilerplate, `entities/_fabric.py` introduces a private `_FabricBase` that owns:

- `_in_queue`, `_stopped`, `_pkt_thread`
- `_pkt_loop` (gate-aware, identical to today's `Network._pkt_loop`)
- `stop()`, `join()`
- `add_interface(iface)` (default unbounded; `Link` overrides to cap at 2)

`Network` becomes a thin subclass that adds `address()`, `broadcast_address()`, `contains_address()`, `devices()`, `has_device()`, and the existing `_dispatch_packet` with its unicast/broadcast split. The `_FabricBase` does **not** prescribe a dispatch policy — subclasses implement `_dispatch_packet(frame)`.

### Link dispatch policy

A p2p link has exactly two endpoints; any frame entering one end goes to the other. `Frame` carries `src_addr` (set by `Interface.send_to` to its own IP), so:

```python
def _dispatch_packet(self, frame):
    for addr, iface in self._interfaces.items():
        if addr != frame.src_addr():
            iface.receive(frame)
            return
```

This works identically for /30 (where the routing protocol's flood is addressed to `.3`) and /31 (where the flood happens to be addressed to the peer's IP). No unicast-vs-broadcast split, no dependence on `dst_addr`, no echo back to the sender. `Link.broadcast_address()` is still exposed (the routing protocol reads `iface.network().broadcast_address()` to build the flood's `dst_addr`), but the Link does not act on it during dispatch.

## Runtime data flow (unchanged code paths)

The routing protocol and forwarding code remain untouched because `Link` is duck-typed as a fabric. Specifically:

- **Keepalive flood** (`RoutingProtocol._handle_update`): reads `iface.network().broadcast_address()`, sends via `interface.send_to(...)`. On a link the frame enters `Link._in_queue`, `Link._pkt_loop` calls `_dispatch_packet`, the peer's `Interface._pkt_loop` picks it up.
- **Graph + Dijkstra** (`RoutingProtocol.update_state`, `NetworkGraph`): the link's prefix is added as a graph node and edged to each adjacent router with `iface.cost()`. Dijkstra is oblivious.
- **Routing tables** (`RoutingProtocol._recompute_if_dirty`): rule for the link's own prefix uses `NullAddress` (directly connected). Rules for networks behind the peer use the peer's IP as next-hop. `_recompute_if_dirty` already discovers the peer's address by walking `next_hop.interfaces()` for one whose `iface.network().address()` matches — works for links unchanged.
- **Forwarding** (`Router._handle_forwarding`): longest-prefix match returns `(next_hop_addr, out_iface)`; `out_iface.send_to(packet, next_hop_addr)` deposits into `Link._in_queue`; dispatch delivers to the peer.
- **Hosts** (`Host.send_message_to`, `Host.ping`, `Host._handle_message`): use `self._interface.network().contains_address(addr)` to decide local-vs-gateway. For a host on a link, `network()` returns the `Link`, `contains_address` works the same, and the gateway (auto-filled by the parser to the peer's IP) is used for off-link destinations.

## YAML schema

```yaml
as:
  name: test_as
  networks:
    lan1: "200.100.0.0/24"
  links:
    p2p1: "10.0.0.0/30"          # router-to-router (typical)
    h3link: "10.0.1.0/31"        # host-to-router, /31 (RFC 3021)
  hosts:
    h1: { network: lan1, address: "200.100.0.10", gateway: "200.100.0.1" }
    h3: { link: h3link, address: "10.0.1.0" }   # no gateway needed
  routers:
    r1:
      interfaces:
        eth0: { network: lan1, address: "200.100.0.1", cost: 10 }
        eth1: { link:    p2p1, address: "10.0.0.1",    cost: 5 }
    r2:
      interfaces:
        eth0: { link:    p2p1, address: "10.0.0.2",    cost: 5 }
        eth1: { link:    h3link, address: "10.0.1.1",  cost: 1 }
```

### Schema rules (enforced by parser + new `LinkValidator`)

- An interface must declare **exactly one** of `network:` or `link:`. Declaring both or neither is an error.
- A link CIDR must be `/30` or `/31`. Anything wider is rejected.
- A link must end up with exactly two interfaces attached after all devices are parsed. Validator pass after parsing.
- Endpoint addresses must be valid host addresses inside the link's CIDR:
  - `/30`: `.1` and `.2` (`.0` is network, `.3` is broadcast).
  - `/31`: `.0` and `.1` (RFC 3021).
- Hosts attached to a link **may omit `gateway:`**. The parser auto-fills it with the peer endpoint's address (via `Link.peer_of`). If the user does specify a gateway, it must equal the peer's IP.
- A name may not appear in both `networks:` and `links:`.
- Existing `network:` schemas continue to work unchanged. Mixing networks and links on the same router is allowed.

## Web UI

### State (`web/state.js`)

```js
state.links = {};   // links[name] = { cidr, x, y }   // x,y are the midpoint label's coords (draggable)
```

Interfaces on routers and the single interface on a host now carry **either** a `network:` or a `link:` field (mutually exclusive). Same field name on both shapes — no other state changes.

### YAML round-trip (`web/app.js`)

- On load: a top-level `links:` block is read into `state.links`. Interfaces with `link:` retain the `link` field in state.
- On save: any interface with `link:` is emitted under `link:` (never `network:`), and `state.links` is emitted under `links:`.

### Canvas (`web/canvas.js`)

P2P links render as a **direct edge** between the two endpoints (router↔router, host↔router, or host↔host). No intermediate fabric node is drawn. The edge has:

- A midpoint label showing the link's name and CIDR. The label is draggable; its position is persisted in `state.links[name].{x,y}`.
- Per-end small cost tags (one per direction) near each endpoint.
- Hit-testing on the edge selects the link itself: `state.selection = { kind: 'link', name }`.
- Hover highlights both endpoints + the edge.

A small helper `linkEndpoint(deviceName, linkName)` resolves the device's iface attached to that link and returns the device's node position as the edge anchor.

### Inspector (`web/inspector.js`)

- New `Links` nav section, sibling to `Networks`. Lists every link.
- Right-pane editor for a link: name (editable), CIDR (**immutable** at creation), and the two endpoints (read-only, derived from interfaces).
- To create a link: add a new entry in the inspector, then in each participating device's interface editor switch the fabric-type dropdown from `Network` to `Link` and pick this link name. The validator catches the "exactly two endpoints" rule before sim start.
- Per-interface editor: a fabric-type dropdown (`Network` / `Link`) plus a name dropdown filtered to the corresponding map.
- Right-click on a p2p edge: rename / duplicate / delete, mirroring the existing network context menu.

### Sample topology (`samples/sample.yaml` + `web/state.js` sample)

Add a **new** /30 p2p link between two routers (`r1`↔`r3` or similar), keeping all existing LANs. The SPA's offline `SAMPLE` constant in `state.js` is updated to match so the in-browser demo shows the link without needing the server.

## Validation, errors, and edge cases

- **Self-echo on /31**: explicitly handled by the "deliver to non-sender" dispatch rule.
- **Asymmetric costs**: supported, like LANs today. Each end's `cost:` is independent.
- **Routing-flood deduplication**: `RoutingProtocol.handle_incoming_message` already dedups by `(src_address, seq)`. With Link dispatch never echoing, this is doubly safe.
- **A link with one endpoint at parse end**: validation error, with the link name in the message.
- **A link with three or more candidate endpoints**: `Link.add_interface` raises during parsing; parser converts to a `ParsingException` mentioning the link name.
- **A host on a link with an explicit gateway that isn't the peer**: validation error.
- **CIDR not /30 or /31**: validation error at link-parsing time.
- **Host-to-host links**: allowed by the schema (a link's two endpoints may both be hosts). On-link delivery works because `Host.send_message_to`/`ping` short-circuit via `network().contains_address(...)`. Off-link destinations are unreachable from a host-to-host link because neither endpoint can forward — this matches the existing "hosts cannot forward" rule and is not a new limitation.

## Testing strategy

### Python (`pytest`)

- **`test/test_link.py`** (new). Construction, `add_interface` capping at 2, `address()`/`broadcast_address()`/`contains_address()`, `peer_of()`, dispatch correctness (frame from A delivered to B; frame from B delivered to A; never echoed to sender), `stop()`/`join()`.
- **`test/test_parser.py`** (extended). Positive: a link parses; mixed `network:`/`link:` interfaces on one router; host on a link auto-fills gateway. Negative fixtures under `test/resources/`:
  - `link_too_wide.yaml`
  - `link_three_endpoints.yaml`
  - `link_one_endpoint.yaml`
  - `link_iface_both_keys.yaml`
  - `link_iface_neither_key.yaml`
  - `link_addr_outside_cidr.yaml`
  - `link_host_wrong_gateway.yaml`
  - `link_name_collides_with_network.yaml`
- **`test/test_routing_table.py`** and **`test/test_protocol.py`** (extended). After convergence on a topology with a p2p link, every router has the expected directly-connected rule and a peer-as-next-hop rule for networks reachable via the peer.
- **`test/test_forwarding.py`** (extended). Forward a unicast datagram across a /30 and across a /31 link; TTL decrement; no echo to sender.
- **`test/test_ping.py`** (extended). Ping a host behind a p2p link from a host on a LAN, and vice versa, for both /30 and /31.

### JavaScript (`vitest`)

- **`web/state.test.js`**: round-trip an interface with `link:`; persist+restore `state.links`; load+save YAML preserves `links:`.
- **`web/canvas.test.js`**: edge rendering for a link-attached interface; selection sets `state.selection.kind = 'link'`; midpoint label honors stored `x/y`.
- **`web/inspector.test.js`** (new helpers as needed): link list, immutable CIDR after creation, fabric-type dropdown on interface editor, prevent saving a link with the wrong endpoint count.

### E2E (`playwright`)

- One new case under `e2e/`: load updated `samples/sample.yaml`, start sim, assert routing tables include a rule for the link's prefix, send a ping that crosses the link, observe a packet animate along the edge.

## Rollout / commit plan

TDD per `CLAUDE.md` (red → green → refactor); one passing suite per commit; conventional commits, one-liner messages, no co-author trailer; docs ride in the same commit as the behavior change.

1. `refactor: extract _FabricBase from Network` — pure refactor; suite stays green.
2. `feat(entities): add Link fabric for point-to-point connections` — `entities/link.py` and `test/test_link.py`.
3. `feat(parser): support top-level links: and per-interface link: key` — parser + `LinkValidator` + positive cases in `test/test_parser.py` + negative fixtures.
4. `test(routing): verify p2p links converge and forward` — should pass against 1–3 with no source changes; proves the duck-typing claim.
5. `feat(web): model links in state and round-trip YAML` — `state.js`, `app.js`, `state.test.js`. Sample fallback in `state.js` updated.
6. `feat(web): render p2p links as direct edges` — `canvas.js`, `styles.css`, `canvas.test.js`.
7. `feat(web): inspector support for links` — `inspector.js`, `inspector.test.js`.
8. `feat(samples): add a p2p link between routers in sample.yaml` — turns on the e2e demo.
9. `test(e2e): smoke a p2p link end-to-end` — Playwright case.
10. `docs: document p2p links` — `README.md` gets a short subsection; `CLAUDE.md` gets a key-design bullet on the `Link` fabric + the "two-endpoint, deliver-to-non-sender" rule. `CLAUDE.md` stays under 200 lines.

Per-commit gates: `pytest` green, `ruff check src/ test/` clean, `npm test` green after steps 5–7. Doc-sync rides in the same commit when the change is observable; step 10 only covers user-facing summaries that don't belong inline anywhere else.

## Open questions

None at design time. Anything that surfaces during implementation will be raised before changing scope.
