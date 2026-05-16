# Shell CLI (Legacy REPL)

Before there was a web UI, `loom` was a `cmd.Cmd` REPL. The shell is
still maintained — same simulator core underneath, just a different
front-end. Use it when you want a fast command-line workflow or a
scriptable interface for tests.

## Running

```bash
cd src
python loom.py shell
```

```
loom shell v1.0
# 
```

The prompt is `# `. Type `help` to list commands; `help <cmd>` shows
that command's docstring.

```
# help
Documented commands (type help <topic>):
========================================
exit  help  ifconfig  neighbors  ping  read  route  send  set_gateway  update_cost
```

## Working-directory quirk

The shell entry point uses bare-package imports
(`from entities import ...`), which means **the shell must run from
`src/`**. From the repo root it won't import.

That also means relative paths to topology files are resolved against
`src/`:

```
# read samples/sample.yaml          # WRONG — looks for src/samples/sample.yaml
# read ../samples/sample.yaml       # right — relative to src/
# read /absolute/path/to/foo.yaml   # also right
```

Pytest and `ruff` are configured to run from the repo root via
`pyproject.toml`'s `pythonpath = ["src"]`. They don't share the shell's
cwd quirk.

## Commands

### `read <path>`

Load a YAML topology. Replaces the currently loaded AS (stopping it
first, if any).

```
# read ../samples/sample.yaml
```

No success message — the next prompt is the only feedback. On error,
the underlying `ParsingException` message is printed:

```
# read /tmp/bad.yaml
missing "as" key
```

After `read`, all other commands become available.

### `route <device>`

Print the routing table of `<device>` (host or router).

```
# route r1
Prefix               Next hop        Interface
200.100.0.0/24       0.0.0.0         eth0      
100.200.0.0/24       0.0.0.0         eth1      
150.10.10.0/24       10.0.0.2        eth2      
10.0.0.0/30          0.0.0.0         eth2      
```

For a **host**, the table is empty (hosts have no routing table); use
`ifconfig` to see the gateway instead.

### `send <src> <dst> <message>`

Send a `UserMessage` from one host to another. The message is a
**single whitespace-delimited token** — no spaces, no quoting.

```
# send h1 h2 hello
```

For multi-word messages, use the per-device terminal in the web UI,
which goes through `shlex.split`. The shell deliberately uses a
3-tuple `split()` for simplicity.

### `update_cost <router> <iface> <cost>`

Set an interface's cost. `<cost>` must be a positive integer.

```
# update_cost r1 eth0 25
```

No success message. The change propagates on the next keepalive.

```
# update_cost r1 eth0 -5
syntax: update_cost <router: str> <interface: str> <cost: int>
```

### `set_gateway <host> <ip>`

Set a host's default gateway. The IP must be inside the host's
network.

```
# set_gateway h1 200.100.0.254
h1: gateway set to 200.100.0.254
```

For hosts on a link, the gateway is auto-filled by the parser; you can
`set_gateway` to override, but the new gateway must still be in the
link's subnet.

### `ifconfig <device>`

Show interfaces and (for hosts) the gateway.

```
# ifconfig h1
iface_h1: addr=200.100.0.10 net=lan1 (200.100.0.0/24) cost=0
  gateway: 200.100.0.1
```

```
# ifconfig r1
eth0: addr=200.100.0.1 net=lan1 (200.100.0.0/24) cost=10
eth1: addr=100.200.0.1 net=lan2 (100.200.0.0/24) cost=15
eth2: addr=10.0.0.1 net=p2p1 (10.0.0.0/30) cost=5
```

### `neighbors <router>`

List directly-connected router neighbors.

```
# neighbors r2
  r1     via lan1     (200.100.0.1)  cost=10
  r1     via lan2     (100.200.0.1)  cost=15
  r3     via lan2     (100.200.0.10) cost=20
  r3     via lan3     (150.10.10.10) cost=5
```

Reads from the router's protocol-local `_graph`. Empty until the first
keepalive has been received.

### `ping <src> <dst> [-W <seconds>]`

Send a `PingRequest` from `<src>` and wait for a `PingReply`.

`<dst>` can be a hostname (resolved via the AS host table) or a literal
IP. Default timeout: 3 seconds.

```
# ping h1 h3
ping h1 -> h3 (150.10.10.30): time=12.34 ms
```

```
# ping h1 200.100.0.99
ping h1 -> 200.100.0.99: timeout after 3.00 s
```

Custom timeout:

```
# ping h1 h3 -W 0.5
ping h1 -> h3 (150.10.10.30): time=12.34 ms
```

If the source host can't route to the destination:

```
# ping h1 h2
ping h1 -> h2: no route to host: no gateway configured
```

### `exit`

Shut down the simulator (stops the AS, killing all worker threads) and
exit. There is no graceful Ctrl-C handler — Ctrl-C raises
`KeyboardInterrupt` and exits without `AS.stop()`, which is fine
because daemon threads die with the process.

## What's missing vs. the web UI

The shell does not have:

- A graphical canvas.
- A way to add or remove devices after `read` (no `add_host`, no
  `add_router`). You can edit costs via `update_cost`.
- Patch-while-paused workflow — the shell is "always running."
- Packet animations (the events flow through `EventTracer`, but the
  shell doesn't subscribe).
- Multiple simultaneous terminals (each `cmd.Cmd` invocation is a
  single REPL).

For exploration and demos, use the web UI. For scripted runs and
test fixtures, the shell is faster — drive it via `subprocess.run` and
pipe a sequence of commands into stdin.

## Scripting example

A small test fixture that boots the simulator, pings, and exits:

```bash
cd src
python loom.py shell <<'EOF'
read ../samples/sample.yaml
ping h1 h3
ping h1 h2
exit
EOF
```

Wait a few seconds before the first ping if you want to give the
routing protocol time to converge — the shell does not block until
convergence on its own.

