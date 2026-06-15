# Running Simulations

Once you've built (or loaded) a topology, the sim has a lifecycle: it
starts, runs, pauses, resumes, and eventually stops. This guide explains
each transition and what's safe at each step.

## States

```
                  ┌─────────────────────┐
                  │       idle          │   ← initial state
                  │  no AS in memory    │
                  └──────────┬──────────┘
                             │ Start
                             ▼
                  ┌─────────────────────┐
                  │      running        │
                  │  threads alive,     │
                  │  keepalives ticking │
                  └─────┬───────────┬───┘
              Pause     │           │   Stop
                        ▼           ▼
              ┌──────────────────┐  ┌──────────────────┐
              │     paused       │  │       idle       │
              │  threads parked  │  └──────────────────┘
              │  on PauseGate    │
              └────────┬─────────┘
                       │ Resume (with optional patch)
                       └───►  running
```

The UI mirrors this state machine — at any moment, the toolbar's
**Start/Stop** and **Pause/Resume** buttons reflect the server's
authoritative state, as fed by the WebSocket `sim_state` events.

## Start

Click **Start** (or press <kbd>Space</kbd>). The SPA does, in order:

1. Checks the topology is complete — every LAN and link has a network
   range, every host is attached to one and has an address, and every
   router interface has an address. If something's missing, Start is
   aborted, a plain-English message names what to fix, and the item in
   question is selected so you can jump straight to it and fill it in.
2. Serializes the current canvas to YAML.
3. POSTs to `/topology` — the server validates and constructs a fresh
   autonomous system. On any validation error, the start is aborted
   and the toolbar surfaces the error via toast.
4. POSTs to `/sim/start` — the server starts the simulation and every
   router's keepalive.

![Start names what's incomplete and selects it — here a LAN with no range yet](../images/07-start-preflight.png)

If the topology was already loaded (e.g. you stopped and want to start
again with the same topology), step 1+2 is a no-op overwrite of the
same YAML. The session file is updated either way.

**While running:**

- The **Add LAN / Host / Router** toolbar buttons are enabled — you can
  add networks, links, hosts, and routers directly on the canvas. Each
  new entity is applied to the live system as soon as you give it a
  valid address or CIDR; an incomplete or invalid value simply stays
  pending until you finish it. Your selection and viewport are preserved
  when the topology updates.
- **Drag any node or link label** to reposition it on the canvas —
  hosts, routers, networks, and p2p link midpoint labels can all be
  moved freely while the sim runs. Repositioning is purely visual and
  does not affect the running simulation. In-flight packet animations
  follow nodes as you move them. Trying to drag a host or router onto a
  *different* network or link while running shows a red blocked cue on
  the target and snaps the node back on release — to reassign a device
  to a different network, stop the sim first.
- Right-click → **Rename / Duplicate / Delete** in the canvas is
  blocked.
- The inspector's editable fields are read-only (interface
  re-addressing and host/network reassignment require pausing or
  stopping first).
- The **Protocol** button is active — you can re-tune the Hello and
  LSA-refresh intervals live.
- Right-click a router → **Halt router**, **Crash router**, or
  **Resume router** to take a router offline or bring it back, without
  stopping the sim. A halted/crashed router grays out on the canvas.
- Select a router → use the **Disable / Fail / Enable** buttons next
  to each interface in the inspector to control individual interfaces.
  A downed interface's edge turns into a solid gray wire with a small ✕
  at its midpoint, so it's clearly distinct from a (dashed) point-to-point
  link. Traffic sent toward a downed interface is dropped where it would
  enter the link — you'll see the packet leave the source and fade out
  instead of reaching the device.

![A halted router and its links render grayed-out while the rest of the topology keeps running](../images/60-router-halted.png)

![The inspector's per-interface controls: a downed interface offers Enable; the others offer Disable and Fail](../images/61-interface-controls.png)

**First pings may drop while the network converges.** After you click
Start, give the routers a few seconds to exchange routes before pinging.
Until all routers have heard from their neighbors, some packets — especially
between hosts on different networks — will be dropped. If your first ping
times out, wait a moment and try again. (The default Hello interval is
10 s; lower the **Hello interval** in the **Protocol** popover to 1 s if
you want neighbors to be discovered faster.)

### Streamed ping output

When you run `ping` from a device terminal while the sim is running,
each ICMP reply (or timeout) appears in the terminal **as it arrives**,
one line at a time — you don't wait for all probes to finish before
seeing results. The final summary still prints at the end. If the
terminal is closed, results are discarded silently.

With `ping -c N` in a device terminal, the probes animate **one round-trip
at a time**: each request travels to the destination and its reply comes
back, then the terminal waits one second (like real `ping`) before
sending the next probe. You follow them individually instead of seeing
all `N` dots ride the wire at once.

Because each probe is only sent **after the previous one has finished
animating**, that pause is a real window to watch traffic **reroute
live**: while a counted ping runs, disable an interface or halt a router
on the route during the pause. The next probe is then sent fresh, so once
the network reconverges it's forwarded along the recomputed route and its
animation follows that new path — no matter how long the route is. Size
the pause with `-i <seconds>` (e.g. `-i 2` for more editing time, `-i 0`
for none). The pause ends when you Stop.

## Pause

Click **Pause** (or press <kbd>P</kbd>). The SPA POSTs to `/sim/pause`;
the server pauses every simulator thread at its next safe point.

Effects, observable in the canvas:

- Packet animations freeze (in-flight frames stay parked on the wire).
- Routing-protocol keepalives stop ticking.
- The **Pause** button becomes **Resume**.

Pause is also the natural pairing with the Packets panel (see [web-ui.md](web-ui.md)) — frozen animations make the badge-to-row mapping easy to read.

**While paused, you can edit:**

- Add a LAN, host, or router.
- Duplicate a LAN, host, router, or link.
- Delete any of the above.
- Update an interface cost.
- Edit names and addresses (with the same uniqueness/validity rules
  enforced by the validator).

Each mutation appears in the **Resume** button label as a counter:
*Resume (3 edits)*. These ops accumulate in the SPA's pending-edits
queue; nothing is applied to the server until you Resume.

While paused, you cannot **Start** (already started) or **Stop** the sim
through the toolbar without first stopping the underlying simulation
(Stop is allowed from paused, but it discards the queued patch).

## Resume

Click **Resume**. The SPA:

1. Reconciles the pending-edits queue against the current canvas:
   `add_*` ops are rewritten with the latest values (so a network you
   added and then renamed is sent with its current name), and any op
   whose target was deleted between Pause and Resume is dropped.
2. POSTs the reconciled patch to `/sim/resume`.

The server validates the entire patch atomically:

- If any op fails validation, the **whole patch is rejected** with a
  `400 Bad Request` and a description of the failing op. The sim
  remains paused; the patch stays in the SPA so you can fix the
  problem.
- If validation passes, every op is applied in order, then the gate is
  resumed and the routing protocol continues from where it left off.

Common patch-validation errors:

| Error | Cause |
|---|---|
| `duplicate_name` | `add_*` with a name that's now taken. |
| `address_in_use` | `add_host` / `add_router` carries an IP already held by another host or router interface on the same network. |
| `network_in_use` | `remove_network` for a LAN still attached to a host or router. |
| `network_not_found` | `add_host` / `add_router` references a non-existent network. |
| `interface_not_found` | `update_cost` for a router that doesn't have that interface. |
| `invalid_cost` | Cost is non-numeric or non-positive. |

The reconciliation step is what makes "pause → add → rename → resume"
feel natural: you don't think about the patch wire format, just the
final shape you want.

## Stop

Click **Stop** (or press <kbd>Space</kbd> again). The SPA POSTs to
`/sim/stop`; the server tears the simulation down:

- Every network, link, router, and interface receives the stop signal
  and its worker threads exit cleanly.
- The simulation is discarded.
- The state returns to `idle`.

What survives:

- The **session YAML file** (`<source>.session.yaml`). The next Start
  will re-read it.
- The SPA's canvas state. Stop and Start without touching the topology
  and you're right back where you were.
- The terminals on screen — they continue to refer to a no-longer-
  existing simulation. Commands sent to a stopped sim return `409 no
  topology loaded`. Close and re-open the terminal after Start to get
  a clean session.

If you've been editing the canvas while idle (after a stop, but before
the next start), those edits **are not** on the server yet — they live
in the SPA's local state and `localStorage`. The next Start serializes
them to YAML and pushes via `/topology`.

## Reset

Click **Reset** (only enabled when idle). This:

1. Deletes `<source>.session.yaml`.
2. Re-clones from the source file (`samples/sample.yaml` by default, or
   whatever `LOOM_TOPOLOGY` points at).
3. Re-parses the source into a fresh autonomous system.
4. The SPA fetches the new YAML and replaces the canvas.

Use Reset when the session has drifted from the source and you want to
roll back. The source file is **never modified** by the SPA — Reset
discards only the session clone.

## Tuning the protocol intervals

Click **Protocol** in the toolbar to open the Protocol settings popover.
Two fields are tunable:

- **Hello interval** — how often routers send neighbor-discovery messages
  (default 10 s). Lower = neighbors detected and declared alive more quickly;
  higher = quieter, but slower to detect new neighbors.
- **LSA refresh interval** — how often routers re-advertise their full
  link-state (default 30 s). Lower = routes re-advertise more frequently,
  faster convergence after a change; higher = quieter canvas.

Changes are applied to every router the moment you click **Apply**. The new
value takes effect at the next interval boundary on each router, so the
maximum lag is the *previous* interval's value.

To speed up initial convergence when exploring: lower the **Hello interval**
to 1 s. To make a running simulation re-advertise routes more aggressively:
lower the **LSA refresh interval**. Dropping either to 1 s makes the protocol
visibly chatter on the canvas at roughly one cycle per second.

## Edits while idle vs. paused vs. running: a comparison

| Action | Idle (sim not started) | Paused (sim is loaded) | Running |
|---|---|---|---|
| Where the edit lives | SPA local state + `localStorage` | SPA local state + pending-edits queue | Applied immediately to the live AS |
| When the server sees it | On next **Start** (whole YAML) | On **Resume** (incremental patch) | On each completed add/change |
| Validation | Full re-parse on start | Per-op validation on resume | Per-op validation on each commit |
| If it fails | Start aborts; topology stays unloaded | Resume rejected; patch preserved for editing | Edit rejected; canvas resynced from server |
| Convergence impact | Routers start from scratch | Existing routing state is preserved; new edges feed in | New edges and devices feed in with zero downtime |

If you're prototyping ("does this CIDR work?"), idle edits + Start are
fine — the parser tells you within seconds. If you're testing
incremental convergence ("what happens when I bring up r4 *while
running*?"), you can add it live without pausing — or pause, make
several related changes at once, and resume atomically.

## Tips

- **Lower the Hello interval when exploring.** The default 10 s is
  realistic but slow for neighbor discovery. Drop it to 1 s while you're
  poking, then restore it when you want a quieter canvas.
- **Pause before bulk edits.** The patch list batches efficiently; the
  one server round-trip is cheaper than starting and stopping for each
  change.
- **Use Reset, not Stop+Start, when the session has gotten weird.**
  Stop just unloads the AS; Reset throws the session away and starts
  from the source.
- **The session file is in the same directory as the source.** If you
  pointed `LOOM_TOPOLOGY` at `/path/to/lab.yaml`, the session lives at
  `/path/to/lab.session.yaml`. Both are plain YAML; you can `git
  diff` them.
