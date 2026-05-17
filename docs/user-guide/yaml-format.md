# YAML Format

The topology is described in YAML. The same format is used by:

- The bundled sample (`samples/sample.yaml`).
- The legacy shell's `read` command.
- The SPA's **Import / Export** dialogs.
- The server's `POST /topology` and the persisted
  `<source>.session.yaml`.

There is exactly one schema. Every consumer goes through the same
parser.

## Top-level shape

```yaml
as:
  name: my_as          # optional; falls back to "unnamed_entity_N"
  networks: { ... }    # required (may be empty, in theory)
  links:    { ... }    # optional
  routers:  { ... }    # optional
  hosts:    { ... }    # optional
```

The `as:` key is mandatory at the top level. Inside it, `name:` and
each entity block (`networks`, `links`, `routers`, `hosts`) are
mappings keyed by entity name. Names must be unique across the kinds
they collide with — see [Naming rules](#naming-rules) below.

A minimal valid topology with no devices:

```yaml
as:
  name: empty
  networks:
    lan1: "10.0.0.0/24"
```

This loads but does nothing useful — no traffic to forward, no routers
to flood. The validator does not require at least one device.

## Networks

A network is a multi-access LAN. Each entry maps a name to a CIDR
prefix.

```yaml
networks:
  lan1: "200.100.0.0/24"
  lan2: "100.200.0.0/24"
  office_a: "10.10.0.0/16"
```

Rules:

- The CIDR is **canonicalized** at parse time — host bits are zeroed.
  `"10.1.2.3/24"` becomes `10.1.2.0/24`.
- Mask between 0 and 32 (in practice useful prefixes are `/8` through
  `/29`; for `/30` or `/31` use `links:` instead).
- No two networks may share the same prefix.
- No two networks may share the same name.

## Links

A link is a `/30` or `/31` point-to-point fabric with exactly two
endpoints. Declared under `links:`:

```yaml
links:
  p2p1: "10.0.0.0/30"
  p2p2: "192.168.5.0/31"
```

Rules:

- Mask must be `/30` or `/31`. Anything else is rejected with
  *"link CIDR must be /30 or /31, got /N"*.
- The link name must not collide with a network name.
- The link must have **exactly two** endpoints once the rest of the
  YAML is processed (one or three endpoints → parser error).
- For `/30` links: only `.1` and `.2` are usable host addresses
  (`.0` is the network, `.3` is broadcast).
- For `/31` links: both `.0` and `.1` are usable (RFC 3021).

## Routers

A router is a mapping with one mandatory `interfaces:` block:

```yaml
routers:
  r1:
    interfaces:
      eth0:
        network: "lan1"
        address: "200.100.0.1"
        cost: 10
      eth1:
        link: "p2p1"
        address: "10.0.0.1"
        cost: 5
```

Rules per interface:

- Exactly one of `network:` or `link:` must be present.
- `address:` must be valid for the chosen fabric (in-prefix; on a
  `/30` link, not the network or broadcast IP).
- `cost:` is optional; defaults to `1`. Must be a non-negative integer.
- The named network or link must exist (declared elsewhere in the YAML
  before parsing reaches this point).

Within a single router, interface names (`eth0`, `eth1`, ...) must be
unique. Across the AS, no two interfaces on the same fabric may share
an address.

A router with zero interfaces is rejected: `r1: no interfaces declared`.

## Hosts

```yaml
hosts:
  h1:
    network: "lan1"
    address: "200.100.0.10"
    gateway: "200.100.0.1"
```

Or on a link:

```yaml
hosts:
  h2:
    link: "p2p1"
    address: "10.0.0.2"
    # gateway is auto-filled to the peer's IP
```

Rules:

- Exactly one of `network:` or `link:` (mutually exclusive).
- `address:` must be valid for the fabric.
- On a **network**, `gateway:` is optional. If present, it must be
  inside the host's subnet. If absent, the host cannot reach off-link
  destinations.
- On a **link**, `gateway:` is auto-filled to the peer's IP. If you
  supply one explicitly, it **must** match the peer; mismatched
  gateways are rejected.
- Hosts have exactly one interface. There is no syntax for a
  multi-homed host.

## Naming rules

- `networks` and `links` share a namespace — no network can have the
  same name as a link.
- `hosts` and `routers` share a namespace — no host can have the same
  name as a router.
- Names are case-sensitive ASCII; the parser doesn't sanitize them
  beyond YAML's own rules. Avoid spaces; the legacy shell's
  whitespace-split arguments will choke.
- The empty string is technically allowed as a name. Don't.

## Costs

Cost is the **transmit-side** metric for a router interface. The
routing protocol uses these as edge weights in the network graph.

- Type: integer.
- Range: positive (validated server-side in `update_cost`; the parser
  also coerces to `int` and rejects non-integer values).
- Default: `1`.
- Direction: **per interface**, not symmetric. `r1.eth0` cost 10 and
  `r2.eth0` cost 5 (both on `lan1`) means routing decisions favor
  paths that exit through `r2.eth0` (cheaper) over those through
  `r1.eth0` (more expensive).

## Order doesn't matter (between blocks)

The parser handles networks → links → routers → hosts as a fixed
phase order, but YAML mappings within each phase are unordered. You
can:

```yaml
routers:
  r3: { interfaces: { ... } }
  r1: { interfaces: { ... } }
  r2: { interfaces: { ... } }
```

— and they all load the same. Just don't reference a network or link
that hasn't been declared yet in its own block.

## A complete example

```yaml
as:
  name: test_as
  networks:
    lan1: "200.100.0.0/24"
    lan2: "100.200.0.0/24"
    lan3: "150.10.10.0/24"
  links:
    p2p1: "10.0.0.0/30"
  hosts:
    h1: { network: "lan1", address: "200.100.0.10", gateway: "200.100.0.1" }
    h2: { network: "lan2", address: "100.200.0.20", gateway: "100.200.0.2" }
    h3: { network: "lan3", address: "150.10.10.30", gateway: "150.10.10.1" }
  routers:
    r1:
      interfaces:
        eth0: { network: "lan1", address: "200.100.0.1",   cost: 10 }
        eth1: { network: "lan2", address: "100.200.0.1",   cost: 15 }
        eth2: { link:    "p2p1", address: "10.0.0.1",       cost: 5  }
    r2:
      interfaces:
        eth0: { network: "lan1", address: "200.100.0.254", cost: 5  }
        eth1: { network: "lan2", address: "100.200.0.2",   cost: 8  }
        eth2: { network: "lan3", address: "150.10.10.1",   cost: 15 }
    r3:
      interfaces:
        eth0: { network: "lan2", address: "100.200.0.10",  cost: 20 }
        eth1: { network: "lan3", address: "150.10.10.10",  cost: 5  }
        eth2: { link:    "p2p1", address: "10.0.0.2",      cost: 5  }
```

This is the bundled `samples/sample.yaml`. Click **Load sample** in
the SPA to drop it onto the canvas; click **Export** to get it back as
text.

## Save and resume workflow

`loom` distinguishes between the **source file** and the **session
file**:

- **Source file** — what `LOOM_TOPOLOGY` points at (default
  `samples/sample.yaml`). The simulator never writes to this file.
- **Session file** — a clone next to the source, named
  `<basename>.session<.ext>`. All in-process mutations land here.

```
samples/
├── sample.yaml          ← source (read-only from loom's perspective)
└── sample.session.yaml  ← session (created on first /topology or /sim/* call)
```

Lifecycle:

| Event | Effect on session file |
|---|---|
| First `/topology` call or `/sim/start` | Created (cloned from source) if missing |
| `/sim/resume` with a patch | Re-serialized to YAML (atomic write) |
| `POST /topology` | Overwritten with the new YAML |
| `POST /topology/reset` | Deleted and re-cloned from source |
| `loom.py` exit | Untouched — persists across runs |

### Saving and resuming work

To **save** a topology you built in the SPA:

1. **Export** → modal opens with the YAML.
2. **Copy to clipboard**, paste into a file, save.

Or open `<source>.session.yaml` directly — it's the same YAML the SPA
would Export.

To **resume** a saved topology:

1. Point `LOOM_TOPOLOGY` at your file: `LOOM_TOPOLOGY=/path/to/lab.yaml python loom.py`.
2. Or run `loom` with the default source, then **Import** your YAML
   into the SPA.

For round-trip stability:

- **The session file is canonical YAML.** `loom` serializes blocks in
  a predictable order (`networks` → `hosts` → `routers`) but does not
  preserve comments or unusual layouts.
- **Coordinates are not persisted server-side.** Node `(x, y)` lives
  only in the SPA's `localStorage`. A YAML import on a fresh browser
  will place nodes at canvas-center defaults; rearrange and the layout
  persists.

### YAML written by the SPA

The SPA's **Export** produces the same shape as the server's
serialized session file. It emits hosts and routers with full
interface blocks and omits coordinate metadata. The two formats are
byte-compatible round trip, so you can edit YAML offline, **Import**,
and the canvas redraws without surprises.

### A note about quotation

The bundled `sample.yaml` quotes most strings (`"10.0.0.0/24"`). YAML
treats `10.0.0.0/24` as a string anyway because of the slash, so the
quotes are aesthetic; the parser accepts unquoted forms too:

```yaml
networks:
  lan1: 10.0.0.0/24       # also valid
```

Pick one and stick with it.
