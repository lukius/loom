# Parser & Validator

The YAML loader and the structural validator live in `src/parser/`. They
are the only path from on-disk topology to a live `AS` instance —
everything else in the codebase assumes the AS is already well-formed.

```
parser/
├── parser.py      # Parser — Parser(filename).parse() -> AS
├── validator.py   # SystemValidator (address, network, link, device, host)
├── exception.py   # ParsingException
└── __init__.py
```

## Top-level shape

The parser expects a YAML document with one mandatory key, `internet:`.
Inside it, an optional `name:` field labels the internet instance, and
`autonomous_systems:` is a mapping where each key is the AS short name.
The literal layout:

```yaml
internet:
  name: loom                 # optional; defaults to 'loom'
  autonomous_systems:
    main:                    # AS short name — the mapping key
      asn: 65000             # optional; reserved for BGP, ignored today
      networks:              # required, may be empty {} (but rarely is)
        lan1: "10.0.0.0/24"
      links:                 # optional
        p2p1: "10.0.0.0/30"
      routers:               # optional (no routers = no routing)
        r1:
          interfaces:
            eth0:
              network: lan1
              address: "10.0.0.1"
              cost: 5
      hosts:                 # optional
        h1:
          network: lan1
          address: "10.0.0.10"
          gateway: "10.0.0.1"
```

The `internet:` wrapper exists so YAML files for the simulator are
immediately distinguishable from arbitrary YAML and so future extensions
(inter-AS links, BGP peering) can add new top-level siblings without
breaking parsers. The AS short name is the mapping key under
`autonomous_systems:` — there is no separate `name:` field inside each
AS block. Any future emitter must produce the same shape.

## `Parser.parse()` flow

```mermaid
flowchart TD
  A[open file] --> B[yaml.safe_load]
  B --> C{has 'internet' key?}
  C -- no --> X[ParsingException: missing &quot;internet&quot; key]
  C -- yes --> D[iterate 'autonomous_systems' mapping]
  D --> E[create AS from short-name key]
  E --> F[parse networks]
  F --> G{has 'links'?}
  G -- yes --> H[parse links]
  G -- no --> I
  H --> I[parse routers]
  I --> J[parse hosts]
  J --> K[post-pass: validate link endpoints + fill host gateways]
  K --> L{start_routing?}
  L -- yes --> N[router.start for each router]
  L -- no --> M
  N --> M[return AS]
```

A failure at any step raises `ParsingException` with a descriptive
message. The AS is **partially constructed** at that point — threads
have already been spawned for networks/links — but the caller (the shell
or the FastAPI `SimState`) is expected to `as_obj.stop()` and discard it.
There is no in-parser rollback.

Three notes:

1. **`Parser.parse(start_routing=True)` starts each router's protocol** by
   default. The shell relies on this — it just calls `Parser(...).parse()`
   and the routing protocol comes up. The server layer opts out: it calls
   `Parser(...).parse(start_routing=False)` because `idle` semantics demand
   that routers wait for an explicit `/sim/start` before broadcasting their
   first keepalive. Starting then stopping would race the initial tick and
   leak `packet` events on the event bus while the sim is still `idle`.
2. **Hosts on a link** are parsed *after* the link itself, but the link's
   peer may not be attached yet (in the case of two hosts on the same
   link). The parser collects `hosts_on_links = [(host, explicit_gw_or_None), ...]`
   during the host pass, then resolves gateways in `_post_pass_links`
   once every endpoint is attached.
3. **Cost defaults to 1.** Omitting `cost:` on a router interface yields
   `cost=1`. The validator does not require costs to be unique or
   distinct.

## Address parsing

Every address-shaped field is parsed by `_parse_net_address` (for
prefixes) or directly by `Address(...)` (for hosts), with
`SystemValidator.validate_address` enforcing dotted-quad syntax and
octet ranges before the `Address` constructor runs.

A `NetworkAddress("10.1.2.3/24")` is **canonicalized** at construction —
the parser receives `10.1.2.0/24` back, regardless of what the user
typed. This makes prefix equality (`==`) and prefix-in-prefix tests
correct even when the user accidentally writes a host bit set.

## Networks

`_parse_networks` walks the `networks:` mapping. For each entry:

1. Parse and validate the CIDR address.
2. Construct a `Network(name, address, gate=system.gate())` — this
   already spawns the fabric's daemon thread.
3. Validate uniqueness (no duplicate name, no duplicate address).
4. Register on the AS.

A failed validation aborts the parse via `ParsingException`. The already-
spawned thread will be cleaned up by `AS.stop()` on the caller's side.

## Links

`_parse_links` mirrors networks, with one extra check: `Link.__init__`
rejects masks other than `/30` and `/31`, raising `ValueError`. The
parser catches the `ValueError` and re-raises as `ParsingException` for
a uniform error type.

Validator-side rules (`LinkValidator`):

- Mask must be `/30` or `/31` (same check as the constructor — belt and
  suspenders).
- Name must not collide with a network's name.
- Name must not collide with another link's name.

The post-pass (`_post_pass_links`) then enforces **exactly two
endpoints** per link, raising if a link is left with 0 or 1 interfaces
after the parse completes.

## Routers

`_parse_routers` iterates the `routers:` mapping. For each router:

1. Require an `interfaces:` block (no implicit zero-interface routers).
2. For each interface:
   - Mutually exclusive `network:` / `link:` (must have exactly one).
   - Resolve to the actual `Network` / `Link` instance (raise if not
     found).
   - Validate the address.
   - Parse the optional `cost:` (default 1, must be a non-negative int).
   - Construct an `Interface(...)`, attach to the fabric, attach to the
     router.
3. Validate the assembled router via `DeviceValidator`:
   - Each interface's address must be valid for its fabric:
     - On a `Network`: `net.contains_address(addr)`.
     - On a `Link`: `link.is_valid_host_address(addr)` — rejects `/30`
       network and broadcast, accepts both `/31` halves.
   - No two interfaces of any router/host share an address on the same
     fabric.

## Hosts

`_parse_hosts` is similar but split into two phases:

**Phase 1 — straight parse and partial validation** (per host):

1. Mutually exclusive `network:` / `link:`.
2. Resolve the fabric; validate the address.
3. Parse optional `gateway:`:
   - On a `Network`: apply immediately as `Address(gw_str)`.
   - On a `Link`: store the literal string; the post-pass will validate
     against the link peer.
4. Address-in-fabric checks:
   - On a `Link`: address must be `link.contains_address(addr)` and
     `link.is_valid_host_address(addr)`.
   - On a `Network`: `network.contains_address(addr)`, plus
     `HostValidator.validate` for the gateway-in-network check.
5. Construct the `Host`, attach its interface to the fabric, register on
   the AS.

**Phase 2 — link post-pass** (`_post_pass_links`):

1. Assert every link has exactly two endpoints.
2. For each host-on-link:
   - Find the peer interface via `link.peer_of(host.interface())`.
   - If the user supplied an explicit `gateway:`, it **must** match the
     peer's IP, else `ParsingException`.
   - Set the host's gateway to the peer's address.

This is why host-on-link declarations work without specifying a gateway
— the parser fills it in once the peer is known. An explicit gateway is
allowed (and validated) for clarity but is never required on a link.

## Validators

`SystemValidator` is a thin facade over five concrete validators. Each
returns a `ValidationResult` (`ValidationSuccess` or
`ValidationFailure(reason)`):

| Validator | What it checks |
|---|---|
| `AddressValidator` | Dotted-quad syntax + octet range `[0, 255]` |
| `NetworkValidator` | No duplicate name, no duplicate prefix |
| `LinkValidator` | `/30` or `/31` mask, no name collision with networks or other links |
| `DeviceValidator` | Each interface address is in-fabric and not duplicated within the AS |
| `HostValidator` | Inherits `DeviceValidator`, then checks `gateway in network` |

`DeviceValidator._addr_already_used` walks every router and every host
to check for duplicate addresses on the same fabric. That's `O(R · K + H)`
per validation; the parser invokes it once per device, so the overall
parse is `O(R · K · (R · K + H))`.

## Errors and fixtures

Failures all surface as `ParsingException` with a message that includes
the offending entity name and the underlying reason — e.g.
`r1: eth0: address already in use by r2`, `lan2: invalid netmask 99`,
`p2p1: link CIDR must be /30 or /31, got /28`.

The test suite drives `Parser.parse()` against **deliberately invalid
YAML fixtures** under `test/resources/`:

- `invalid_address.yaml`, `invalid_netmask.yaml`,
  `invalid_router_address.yaml`, ... — assert the matching validator
  message.
- `link_too_many_endpoints.yaml`, `link_bad_mask.yaml`, ... — assert
  link-specific failures.
- `missing_as.yaml`, `missing_networks.yaml` — assert structural
  failures.

**Most fixtures under `test/resources/` are intentionally broken** —
they exist to assert the parser rejects them with the right message.
Don't "fix" them. New parser/validator failure modes belong as
additional fixtures referenced from `test/test_parser.py`.

## Where the parser is called

| Caller | What it does next |
|---|---|
| `src/shell/shell.py:do_read` | `self._system = Parser(arg).parse()` — replaces the live AS, stopping the previous one first |
| `src/server/state.py:load_from_session` | Parses the session file, then **stops every router** to enforce `idle` semantics before the next `/sim/start` |

Nothing else parses YAML. The web layer reads the topology back via
`GET /topology` from the session file directly (no re-parse on read).
