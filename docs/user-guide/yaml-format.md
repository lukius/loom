# YAML Format

The topology is described in YAML. The same format is used by:

- The bundled sample (`samples/sample.yaml`).
- The SPA's **Import / Export** dialogs.
- The server's `POST /topology` and the session file it persists
  internally (see [Save and resume workflow](#save-and-resume-workflow)).

There is exactly one schema. Every consumer goes through the same
parser.

## Top-level shape

```yaml
internet:
  name: loom              # optional; defaults to 'loom' when absent
  autonomous_systems:
    main:
      asn: 65000          # preserved across round-trips; not yet used for routing (reserved for BGP)
      networks:
        lan1: "200.100.0.0/24"
        ...
      links:
        p2p1: "10.0.0.0/30"
        ...
      hosts:
        h1:
          network: "lan1"
          address: "200.100.0.10"
          gateway: "200.100.0.1"
        ...
      routers:
        r1:
          interfaces:
            eth0:
              network: "lan1"
              address: "200.100.0.1"
              cost: 10
            ...
```

The `internet:` key is mandatory at the top level. Inside it, an
optional `name:` field labels the internet instance, and
`autonomous_systems:` is a mapping where each key is the AS short name
and each value holds that AS's entity blocks (`networks`, `links`,
`routers`, `hosts`). Names within an AS must be unique across the kinds
they collide with — see [Naming rules](#naming-rules) below.

> **Note (SPA export):** When you **Export** from the SPA, `internet.name`
> and the autonomous-systems key are both set to the project name you typed
> in the header bar — the SPA keeps them in sync. The `loom` default only
> applies when you hand-write YAML without a `name:` field.

Single-AS topologies put one entry under `autonomous_systems:`,
conventionally named `main`. Multiple ASes are reserved for the future
BGP work.

The `asn:` field is read and preserved across round-trips (Export →
Import and `GET /topology`) but is not yet used by the link-state
protocol. It defaults to 65000 when absent. Pick something in the
private 64512–65535 range; BGP support is future work.

A minimal valid topology with no devices:

```yaml
internet:
  autonomous_systems:
    main:
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
- Two networks may share the same prefix only if it is an RFC 1918
  private range (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
  Public prefixes must remain unique.
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
- `cost:` is optional; defaults to `1`. Must be a positive integer (≥ 1); `0` is rejected.
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

## Optional `config:` blocks

Two optional `config:` blocks let you persist settings alongside the
topology. Both are optional — omitting them leaves all defaults in place.

### Top-level `internet.config`

Placed directly under `internet:`, alongside `name:` and
`autonomous_systems:`. Any key/value pairs you write here are stored
and re-emitted verbatim on **Export** and `GET /topology`. The SPA
currently reads `packet_duration_ms` (packet animation duration in
milliseconds; default 1800).

```yaml
internet:
  config:
    packet_duration_ms: 2400
  autonomous_systems:
    ...
```

### Per-AS `config.protocol`

Placed inside an AS block, under `config.protocol:`. Sets the
routing-protocol timers applied to every router in that AS at parse
time.

```yaml
autonomous_systems:
  main:
    config:
      protocol:
        hello_interval: 5           # seconds; default 10
        lsa_refresh_interval: 15    # seconds; default 30
    networks:
      ...
```

Rules:
- Both `hello_interval` and `lsa_refresh_interval` must be given
  together — specifying only one is a parse error.
- Both must be positive numbers (int or float). Booleans are rejected.
- `dead_interval` (3 × hello) and `max_age` (2 × refresh) remain
  derived and are not written to YAML.

### A complete example with config blocks

```yaml
internet:
  name: loom
  config:
    packet_duration_ms: 2400
  autonomous_systems:
    main:
      asn: 65000
      config:
        protocol:
          hello_interval: 5
          lsa_refresh_interval: 15
      networks:
        lan1: "100.100.100.0/24"
      routers:
        r1:
          interfaces:
            eth0:
              network: lan1
              address: "100.100.100.1"
              cost: 10
      hosts:
        h1:
          network: lan1
          address: "100.100.100.10"
```

The SPA's **Export** always writes both blocks. **Import** restores
them, so packet duration and protocol timer values persist across
sessions.

## Naming rules

- `networks` and `links` share a namespace — no network can have the
  same name as a link.
- `hosts` and `routers` share a namespace — no host can have the same
  name as a router.
- Names are case-sensitive ASCII; the parser doesn't sanitize them
  beyond YAML's own rules. Avoid spaces.
- The empty string is technically allowed as a name. Don't.

## Costs

Cost is the **transmit-side** metric for a router interface. The
routing protocol uses these as edge weights in the network graph.

- Type: integer.
- Range: positive (validated when you apply the change; the parser
  also coerces to integer and rejects non-integer values).
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
internet:
  autonomous_systems:
    main:
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

This is the bundled `samples/sample.yaml`. Click **Import** in the SPA
and pick `sample.yaml` from the list to drop it onto the canvas; click
**Export** to save it to disk.

## Save and resume workflow

`loom` distinguishes between the **source file** and the **session
file**:

- **Source file** — what `LOOM_TOPOLOGY` points at (default
  `samples/sample.yaml`). The simulator never writes to this file.
- **Session file** — a clone kept in a temporary directory
  (`$TMPDIR/loom` on Linux/macOS, overridable via `LOOM_SESSION_DIR`),
  named `<stem>.<8-hex-hash>.session.yaml`. The hash disambiguates two
  source files that share a basename. All in-process mutations land
  here.

Because the session file lives outside the source tree, a read-only
source directory is fine and your project folder stays clean.

Lifecycle:

| Event | Effect on session file |
|---|---|
| First `/topology` call or `/sim/start` | Created (cloned from source) if missing |
| `/sim/resume` with a patch | Re-serialized to YAML (atomic write) |
| `POST /topology` | Overwritten with the new YAML |
| `POST /topology/reset` | Deleted and re-cloned from source |
| `loom.py` exit | Untouched — persists across runs |

The OS typically wipes `$TMPDIR` on reboot (Linux/macOS mount `/tmp`
as tmpfs). Set `LOOM_SESSION_DIR` to a stable path if you want session
files to survive reboots.

### Saving and resuming work

To **save** a topology you built in the SPA:

1. **Export** → the browser's save dialog opens with a suggested
   filename derived from the loaded source (e.g. `sample.yaml`; a
   `.session` stem is stripped so the name doesn't grow on each
   round-trip). Pick a folder and confirm.

To **resume** a saved topology:

1. Point `LOOM_TOPOLOGY` at your file: `LOOM_TOPOLOGY=/path/to/lab.yaml python loom.py`.
2. Or run `loom` with the default source, then click **Import →
   Browse local file…** in the SPA and pick your YAML.

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
