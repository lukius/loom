> 🌐 **English** · [Español](../es/user-guide/terminals.md)

# Terminals

Every host and router in `loom` has a terminal. The terminal is the way
you interact with a single device. For example, you may ask a host what's
on its interfaces or instruct it to ping another device; or you may view
a router's routing table and tweak its costs, among other actions.

## Opening and closing a terminal

- **Open.** Double-click any host or router on the canvas. A popup
  opens with the device's name as its title.
- **Close.** Click the **X** on the popup, or press <kbd>Ctrl+D</kbd>
  when the prompt is empty.
- **Multiple terminals.** Open as many as you want. Each one is independent.
- **Position and size.** Drag the title bar to move; drag the corners
  to resize. Position and size persist per device.

![Two terminals open simultaneously](../images/30-two-terminals.png)

## Keyboard

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Submit the typed command |
| <kbd>Ctrl+L</kbd> | Clear the output area |
| <kbd>Ctrl+D</kbd> | Close the terminal (only when the prompt is empty) |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Walk command history |
| <kbd>Tab</kbd> | Command completion (basic) |

The terminal does not swallow normal browser shortcuts unless the prompt
has focus, so <kbd>Ctrl+R</kbd> is still page reload.

## Command set

The available commands depend on whether the terminal is attached to a
host or to a router. Both kinds share `ifconfig`, `route`, and `help`.

Every example below is taken from the **bundled sample topology** — three
hosts (`h1`, `h2`, `h3`), three LANs (`lan1`, `lan2`, `lan3`), three
routers (`r1`, `r2`, `r3`), and the `p2p1` link between `r1` and `r3`. It
is what the canvas shows on a first visit; see
[Getting started](getting-started.md) for a picture of it. Load it any
time from **Import** → `sample.yaml` to follow along.

### Common to hosts and routers

#### `ifconfig`

Show interface configuration.

```
ifconfig
```

For a **host** (one interface plus an optional gateway):

```
iface_h1: addr=200.100.0.10 net=lan1 (200.100.0.0/24) cost=0
  gateway: 200.100.0.1
```

For a **router** (one line per interface, no gateway line):

```
eth0: addr=200.100.0.1 net=lan1 (200.100.0.0/24) cost=10 up
eth1: addr=100.200.0.1 net=lan2 (100.200.0.0/24) cost=15 up
eth2: addr=10.0.0.1 net=p2p1 (10.0.0.0/30) cost=5 up
```

Each line ends with `up` or `down` to reflect the current admin state
of that interface. Use `ifconfig <iface> up|down` to change it.

Cost on a host's interface is always `0` — costs are a routing-protocol
concept and only matter on routers.

#### `route`

On a **router**: dump the routing table. Here is `r2`'s, once the network
has settled:

```
route
```

```
prefix               next_hop        iface
200.100.0.0/24       0.0.0.0         eth0
100.200.0.0/24       0.0.0.0         eth1
150.10.10.0/24       100.200.0.10    eth1
```

`0.0.0.0` next-hop means the destination is directly connected on the
listed interface. `lan3` is reached via `r3` (`100.200.0.10` on `eth1`)
rather than `r2`'s own `eth2`, because the path through `lan2` to `r3`
is cheaper (cost 8+5=13) than `r2`'s direct link to `lan3` (cost 15).
[Routing tables](routing-tables.md) covers how to read one in full, and
shows the same table in the inspector.

Run `route` before the network has settled and every next hop reads
`0.0.0.0`: a router starts out knowing only what it is directly attached
to, and learned routes like the one above appear as the advertisements
come in.

On a **host**: show the configured default gateway.

```
route
```

```
gateway: 200.100.0.1
```

If no gateway is configured:

```
gateway: (none)
```

#### `help`

List the commands available for this device kind.

```
# host:
available: ifconfig, send <dst> <msg>, ping <dst> [-W t] [-c n] [-i s], route, set_gateway <ip>, help
terminal: clear, Ctrl+L (clear), Ctrl+D (close)

# router:
available: route, update_cost <iface> <cost>, ifconfig [<iface> up|down], halt, resume, neighbors, help
terminal: clear, Ctrl+L (clear), Ctrl+D (close)
```

---

### Host-only commands

#### `send <dst> <message>`

Send a data message from this host to `<dst>`. `<dst>` can be a
hostname (resolved via the AS host table) or a literal IP.

```
send h2 hello
```

```
sent 5 bytes to 100.200.0.20
```

Or with quoting (the terminal uses shell-style quoting, so a
multi-word message can be wrapped in double quotes):

```
send h2 "hello world"
```

```
sent 11 bytes to 100.200.0.20
```

The destination host receives the message silently — no
"message received" notification appears in the UI by default.

#### `ping <dst> [-W <seconds>] [-c <count>] [-i <seconds>]`

Send an echo request and wait for a reply (default timeout 3 s).

```
ping h3
```

```
seq=0 150.10.10.30: time=12.34 ms
--- h3 ping statistics ---
1 sent, 1 received, 0% loss
```

Override the timeout:

```
ping h3 -W 0.5
```

If unreachable (no host answers the ping):

```
seq=0 200.100.0.99: timeout
--- 200.100.0.99 ping statistics ---
1 sent, 0 received, 100% loss
```

Errors:

```
ping h2: no route to host: no gateway configured
```

— happens when the destination is off-link and the host has no gateway
configured.

`ping` measures round-trip time using a monotonic clock — RTTs reflect
the actual wall-clock time the simulator took to thread the packet
through the topology. With a busy simulator (lots of routing chatter
or many ping flows running in parallel), expect single-digit
millisecond RTTs on tiny topologies.

Use `-c <count>` to send that many probes. The terminal sends them **one
at a time**, waiting for each probe's round trip to finish animating
before sending the next, then pausing one second (like real `ping`)
between them. Each reply line appears as its reply returns on the canvas,
and a summary line prints at the end:

```
ping h2 -c 4 -W 1.5
```

```
seq=0 100.200.0.20: time=3.21 ms
seq=1 100.200.0.20: time=2.88 ms
seq=2 100.200.0.20: time=3.05 ms
seq=3 100.200.0.20: time=2.94 ms
--- h2 ping statistics ---
4 sent, 4 received, 0% loss
```

![A counted ping streams each reply into the terminal as it arrives, then prints a summary](../images/62-ping-count.png)

Because the next probe isn't sent until the previous one's animation has
finished, that pause is a real window to change the topology mid-sequence
and watch the change take effect. Disable an interface (or halt a router)
on the route during the pause — the next probe is then sent fresh, so
once the network has reconverged it's forwarded along the recomputed
route and its animation follows that new path.

Use `-i <seconds>` to size the pause — make it longer if you need more
time to edit, or `-i 0` to send each probe immediately after the previous
one finishes (still one at a time, just no pause):

```
ping h3 -c 8 -i 2
```

The pause ends immediately if you Stop the sim.

Replies appear one line at a time, as each arrives — you don't wait for
the whole run to finish before seeing results. Close the terminal
mid-sequence and the remaining results are discarded silently.

#### `set_gateway <ip>`

Update the host's default gateway.

```
set_gateway 200.100.0.254
```

```
gateway set to 200.100.0.254
```

The new gateway must be inside the host's network, else:

```
gateway 10.0.0.1 not in host network
```

For hosts on a `/30` or `/31` **link**, the gateway is the peer's IP
and is set automatically by the parser. `set_gateway` for those hosts
is allowed but pointless — change the link wiring if you want a
different peer.

---

### Router-only commands

#### `update_cost <iface> <cost>`

Set an interface's cost. The new value propagates via the next
LSA flood.

```
update_cost eth0 25
```

```
cost of eth0 set to 25
```

`<cost>` must be a positive integer.

```
update_cost eth0 -5
```

```
cost must be positive
```

```
update_cost eth9 1
```

```
r1: invalid interface eth9
```

#### `neighbors`

List directly-connected router neighbors.

```
neighbors
```

```
  r1     via lan1     (200.100.0.1)  cost=10
  r1     via lan2     (100.200.0.1)  cost=15
  r3     via lan2     (100.200.0.10) cost=20
  r3     via lan3     (150.10.10.10) cost=5
```

The view is built from the router's local protocol graph, so it only
shows neighbors this router has *heard about*. A new neighbor takes
up to one Hello interval to appear here.

If the router has no router peers, or hasn't completed its first
Hello exchange:

```
(no neighbors yet)
```

#### `halt`

Gracefully take the router offline: it floods a withdrawal LSA so
neighbors remove it from their graphs immediately, then stops
forwarding.

```
halt
```

```
r1 halted
```

#### `resume`

Bring a halted router back online. It re-announces its links and
resumes forwarding.

```
resume
```

```
r1 resumed
```

#### `ifconfig <iface> up|down`

Bring a single interface up or down without halting the whole router.
Taking an interface down gracefully withdraws that link from the
routing-protocol advertisements; bringing it back up re-announces it.

```
ifconfig eth0 down
```

```
eth0 down
```

```
ifconfig eth0 up
```

```
eth0 up
```

---

## Command not found

An unrecognized command reports back and changes nothing:

```
foo bar
```

```
unknown command: foo
```

There is no shell-level pipe or redirection — each command is one
line, one response rendered verbatim.

Quoting works as in a normal shell, so `send h2 "hello world"` delivers
one message rather than two words.

If you want to see how a typed line reaches the device — or to drive the
same commands from outside the browser — the wire format is documented in
[the server API reference](../architecture/server-api.md#post-devicesnamecommand).

## When the sim is idle or stopped

Terminals stay open after a Stop, but there is no longer a simulation
behind them, so any command reports back:

```
ping h3
```

```
[error] no topology loaded
```

Click **Start** and the same command works again — same terminal, same
window position. Nothing needs to be reopened.
