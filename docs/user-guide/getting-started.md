> 🌐 **English** · [Español](../es/user-guide/getting-started.md)

# Getting Started

This guide takes you from a fresh clone to a live simulation with a ping
between two hosts.

## Scope

`loom` is a network routing simulator: it only models L3 concepts such as IPv4 forwarding,
addressing, routing tables and link-state convergence.
There is no L2 and no L4. Frames are
abstract envelopes; payloads are message-type objects delivered intact.

## Install

```bash
git clone git@gitlab.com:lukius/netrouting.git
cd netrouting

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`loom` has three runtime dependencies and no system-level prerequisites
beyond Python 3.11+ itself.

## Run the web UI

The default entry point starts the FastAPI server and serves the SPA:

```bash
cd src
python loom.py
```

You should see:

```
INFO:     Started server process [...]
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). On a first visit the
canvas comes pre-populated with the sample topology — three hosts (`h1`,
`h2`, `h3`), three LANs (`lan1`, `lan2`, `lan3`), three routers (`r1`,
`r2`, `r3`), and one `/30` point-to-point link (`p2p1`) between `r1` and
`r3`:

![Initial canvas with the sample topology loaded](../images/01-canvas-initial.png)

The page state — pan, zoom, current topology, theme, and toolbar
toggles — is persisted to the browser's local storage. Reload and you'll be back where
you were, editing your own topology rather than the sample.

## Press Start

Click the green **Start** button in the toolbar (or press <kbd>Space</kbd>).

What happens, in order:

1. The canvas is checked for anything unfinished — a LAN without a
   range, a host without an address. If something is missing, Start is
   aborted and the item in question is selected so you can go fill it in.
2. The topology is handed to the simulator, which brings every device up
   and starts each router's routing protocol.
3. Within a few hundred milliseconds, routing-protocol packets start
   flooding across the canvas — the small pale-indigo packets
   ("chatter").
4. As routers converge, their routing tables fill in — click any router
   to watch. The toolbar's **Pause** button appears, and **Reset** stays
   unavailable until you stop.

![Simulation running — routing-protocol chatter visible](../images/02-running.png)

You can keep building while the simulation runs: add a LAN or a
point-to-point link, give it a valid range, and it joins the live
network right away. Attaching devices is the part that waits — hosts and
routers you add while running stay unattached until you pause or stop,
as does renaming or re-addressing anything that already exists.

If you don't see chatter, click the **Chatter** toolbar button — it
toggles the routing-protocol animations on and off.

## Your first ping

Double-click `h1` to open its terminal. The popup looks like this:

![h1 terminal popup](../images/03-terminal.png)

Type:

```
ifconfig
```

You'll see the host's single interface (`iface_h1`), its address
(`200.100.0.10`), the network it belongs to (`lan1`), and its gateway
(`200.100.0.1`).

Now ping `h3`:

```
ping h3
```

Output:

```
seq=0 150.10.10.30: time=12.34 ms
--- h3 ping statistics ---
1 sent, 1 received, 0% loss
```

On the canvas, watch the request travel `h1` → `r1` → `r3` → `h3`: `h1`
hands it to its default gateway `r1`, which forwards it straight across
the `p2p1` link to `r3`, which delivers it on `lan3`. That route costs
5 + 5 = 10; going the long way through `lan2` would have cost 15 + 5.

The reply does **not** retrace that path. `h3` hands it to *its* own
gateway, `r2`, which sits directly on `lan1` and delivers it to `h1` in
a single hop — never touching the link the request came in on. Nothing
is wrong: every device forwards independently using its own routing
table, so **routing need not be symmetric**. The route a packet takes
tells you nothing about the route its reply will take.

One thing you won't find in anyone else's routing table is `p2p1`'s own
range, `10.0.0.0/30`. Routers don't advertise private ranges to their
neighbors, so only `r1` and `r3` — the two ends — hold a route to it.
The link still carries traffic for everyone else's benefit; it just
isn't a destination anybody outside can name. See
[NAT and private LANs](nat-and-private-lans.md) for where that rule
matters most.

Try a non-existent host:

```
ping h99
```

```
ping: invalid destination: h99
```

Or a routable address that doesn't exist:

```
ping 200.100.0.99
```

Times out after the default 3 seconds and prints:

```
seq=0 200.100.0.99: timeout
--- 200.100.0.99 ping statistics ---
1 sent, 0 received, 100% loss
```

## Inspect a routing table

Click any router on the canvas — say `r2`. The right pane shows the
router's interfaces and current routing table together:

![r2 routing table](../images/04-routes.png)

Each row is one rule: a destination prefix, the next-hop IP (or
`0.0.0.0` if directly connected), and the outgoing interface name. The
table refreshes on its own whenever the router's view of the network
changes — a routing update arriving, a cost edit, a device added or
removed. `r2`'s table is worth a look after the ping above: it is the
router that carried the reply back to `lan1`.

## Stop the simulation

Click the red **Stop** button (Start replaced) or press <kbd>Space</kbd>.
The simulation returns to `idle`: routers stop exchanging routing
messages and the network is torn down, while your topology stays on the
canvas. **Reset** becomes available again, and **Protocol** greys out.

You can also **pause** (press <kbd>P</kbd>) — that freezes the entire
simulation without dropping it. While paused, you can add or remove
devices and change interface costs; those edits are held until you click
**Resume**, then applied together. See
[Running simulations](running-simulations.md) for the full lifecycle.

## Where to next

- [Web UI](web-ui.md) — full tour of the toolbar, canvas, inspector, and
  terminals.
- [Building topologies](building-topologies.md) — add your own LANs,
  hosts, routers, and point-to-point links.
- [YAML format](yaml-format.md) — write topologies by hand or import
  them; understand how the SPA saves and resumes.

## Troubleshooting

**"Address already in use" on port 8000.** Another `loom` process is
already running, or another service holds the port. Either kill it or
launch with a different port: `LOOM_PORT=8765 python loom.py`.

**The canvas is empty.** The sample topology loads by itself on a first
visit, but a browser reload brings back whatever you last had on the
canvas — including an empty one, if you cleared it with **New**. Click
**Import topology…** in the empty state and pick `sample.yaml` from the
list to get the sample back.

**Packets don't animate.** Make sure the sim is `running` (not paused or
idle), and that the **Chatter** toggle isn't muting all packets. The
**Packet speed** field controls the animation speed (in milliseconds per
hop, 200–5000).

**A router you just added has no routes yet.** Routers greet each other
on a timer, so a device added to a running simulation is only noticed at
the next round of greetings — up to one **Hello interval** (10 s by
default). Drop the **Hello interval** to `1` s in the **Protocol**
popover to speed neighbor discovery while you explore.

**A change to the YAML didn't take effect.** After startup the simulator
works from a private copy of your topology, not the file you edited on
disk. Stop the simulation and click **Reset** in the toolbar to throw
that copy away and re-read the source, or restart `loom.py`. The source
is named via `LOOM_TOPOLOGY` (default `samples/sample.yaml`).
