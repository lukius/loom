# The Web UI

This is a guided tour of the SPA. Every clickable affordance is covered
here, organized by region.

## Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│  Toolbar (always visible)                                              │
├──────────┬───────────────────────────────────┬─────────────────────────┤
│          │                                   │                         │
│  Left    │            Canvas                 │   Right pane            │
│  nav     │            (SVG, drag/pan/zoom)   │   (Inspector)           │
│          │                                   │                         │
└──────────┴───────────────────────────────────┴─────────────────────────┘
```

Both side panes are resizable: drag the vertical splitters between
them. The widths persist to `localStorage` (`LAYOUT_KEY = 'loom.layout'`)
with min/max bounds.

![Three-pane layout: nav, canvas, inspector](../images/05-layout.png)

## Toolbar

From left to right:

| Group | Control | What it does |
|---|---|---|
| Project | **Project name** | Editable AS name. Persisted; round-trips to/from YAML. |
| Project | **Import** | Open a picker listing the YAML topologies in `samples/`; click one to load it, or use **Browse local file…** to pick any `.yaml` on your computer. |
| Project | **Export** | Open the browser's save dialog so you can pick a folder and filename for the current topology. The suggested name is the loaded source filename with a `.session` suffix (e.g. `sample.session.yaml`). |
| Build | **LAN** (<kbd>N</kbd>) | Add a network rail at the canvas center. Disabled while running. |
| Build | **Host** (<kbd>H</kbd>) | Add a host. Disabled while running. |
| Build | **Router** (<kbd>R</kbd>) | Add a router. Disabled while running. |
| View | **Reset view** (<kbd>F</kbd>) | Fit topology to the visible canvas. |
| Sim | **Start / Stop** (<kbd>Space</kbd>) | Toggle between `idle` and `running`. Starts: serializes YAML → POST `/topology` → POST `/sim/start`. |
| Sim | **Pause / Resume** (<kbd>P</kbd>) | Toggle between `running` and `paused`. The label shows pending patch ops while paused. |
| Sim | **Reset** | Idle-only: discard the session and re-clone from the source YAML. |
| Sim | **Refresh** | Routing-protocol keepalive interval in seconds (1–300). Enabled while sim is loaded. |
| Sim | **Packet speed** | Per-hop animation duration in ms (200–5000). Local to the SPA; doesn't talk to the server. |
| View | **Chatter** | Mute or unmute routing-protocol packet animations. |
| View | **Costs** | Show or hide link cost labels at each router interface. |
| View | **Interfaces** | Show or hide interface name + count badges. |
| Theme | **Theme buttons** | Light / dark / contrast — persisted to `localStorage`. |

The **Refresh** field is disabled when the sim is `idle` — there's
nothing to apply the new interval to until a topology is loaded and
running.

### Keyboard shortcuts

| Key | Action |
|---|---|
| <kbd>Space</kbd> | Start / Stop |
| <kbd>P</kbd> | Pause / Resume |
| <kbd>N</kbd> | Add LAN |
| <kbd>H</kbd> | Add host |
| <kbd>R</kbd> | Add router |
| <kbd>F</kbd> | Fit view |
| <kbd>Esc</kbd> | Clear selection / close context menu |
| <kbd>Delete</kbd> | Delete the selected node |

Shortcuts are **disabled** while an input or textarea has focus (so
typing inside a terminal doesn't accidentally fire **Router**), and
while any modifier is held (so <kbd>Ctrl+R</kbd> remains the browser's
reload).

## Canvas

The canvas is an SVG with three coordinate systems (world / view /
screen). You interact with it through three gestures:

- **Click a node** — selects it. The inspector populates on the right.
- **Drag a node** — moves it. Coordinates are persisted.
- **Drag the empty canvas** — pans. The pan/zoom is also persisted.
- **Scroll on the canvas** — zooms about the cursor.
- **Right-click a node** — opens the context menu (rename, duplicate,
  delete).
- **Double-click a host or router** — opens its terminal popup.

### What you see

- **Hosts** appear as workstation icons.
- **Routers** appear as cube icons.
- **LANs (multi-access networks)** appear as horizontal or vertical
  rails with end caps and one tick per attached interface. Drag the
  rail's handle to lengthen it; drag the rail body to move it.
- **Point-to-point links** appear as direct edges between the two
  endpoints, with a draggable midpoint label that carries the link's
  name and CIDR.
- **Interface labels** (when **Interfaces** is on) show the interface
  name and address at each connection point.
- **Cost labels** (when **Costs** is on) show the metric at each router
  interface.

Selection is shown by a highlight ring around the node.

### Private LANs

Networks whose CIDR falls in an RFC1918 range (`10.0.0.0/8`, `172.16.0.0/12`,
or `192.168.0.0/16`) render in a **muted neutral tone** instead of the
default accent color. The same muting applies to the interface labels on
the router side of those LANs. The visual cue lets you spot the NAT
boundary at a glance: muted = behind NAT, in color = directly routed.

![Private LANs render in a muted tone; the public LAN keeps the accent color](../images/50-private-lan-tone.png)

Hosts, edges, and router icons stay at full chroma — only the LAN rail and
its router-side iface labels change tone. Selection and hover styling
still apply on top, so a selected private LAN is still clearly highlighted.

See [NAT and private LANs](nat-and-private-lans.md) for how traffic
actually crosses that boundary and how to inspect the gateway router's
NAT table.

### Pan and zoom

| Gesture | What |
|---|---|
| Drag empty space | Pan |
| Scroll wheel | Zoom about cursor |
| **Reset view** button or <kbd>F</kbd> | Fit topology to canvas |
| **+** / **−** buttons | Discrete zoom about canvas center |

## Packet animations

Every datagram that traverses a fabric is drawn as a small colored
rectangle traveling between its endpoints. The color encodes the
packet type — `user_datagram`, `routing_flood`, `ping_request`,
`ping_reply` — and the toolbar's **Chatter** toggle filters out the
routing-protocol packets when you want a quieter canvas.

### Inspecting packet internals

**Pause the simulation, then hover the mouse over any frozen packet
dot — a tooltip pops up with the packet's internals.** Pausing freezes
in-flight packet animations in place, so the canvas effectively becomes
a step-through debugger.

The tooltip shows:

- The **packet type** (`user_datagram` / `routing_flood` /
  `ping_request` / `ping_reply` / `unknown`).
- The **original endpoints** of the conversation — the L3 source and
  destination as they were when the packet was created.
- A second **`hop:`** line, only when the current animation segment is
  between addresses that differ from the original endpoints — i.e.
  when a router is forwarding a datagram across a fabric. Single-hop
  and broadcast packets don't show this line.

![Hover a paused packet to inspect its endpoints](../images/40-packet-tooltip.png)

This is the canonical debugging move when you're trying to trace where
traffic is actually going: pause, hover each frozen dot in order, and
read off the per-hop trail. While the simulation is running, packets
move too fast for the tooltip to land on the dot reliably — pause
first.

### NAT annotations

Packets that crossed a NAT hop show the translation in their tooltip.
Pause the simulation and hover over the packet to see lines like
`NAT @ r_a: 192.168.1.10 → 198.51.100.1`. Selecting the egress router
in the inspector opens a NAT table panel listing live entries — each row
shows the original private source, the rewritten public source, the
destination, and the flow ID. The table grows as traffic flows; entries
are bounded by least-recent-use eviction.

![Inspector panel for an egress router, showing one active NAT translation](../images/51-nat-panel.png)

See [NAT and private LANs](nat-and-private-lans.md) for the broader
workflow.

## Left pane (navigation)

The left pane lists all entities grouped by type — networks, links,
hosts, routers. Click a name to select; right-click for the context
menu. The same selection model as the canvas; the two stay in sync.

The **Save state** indicator — `autosaved` under normal operation,
`saving…` for a brief moment after a mutation — sits in the **top
bar**, next to the editable project name.

## Right pane (inspector)

The inspector renders **one panel per selected node**, with sections
that vary by node type. The whole panel is visible at once — there are
no tabs to switch between.

For every node type:

- **Identifier / name** — editable. Renames are validated for
  uniqueness.
- **Properties** — address, network/link membership, gateway (hosts
  only).
- **Duplicate / Delete** — bottom of the panel. Duplicate clones the
  node with a new name; Delete removes it.

Type-specific sections:

| Selection | Extra sections |
|---|---|
| Network | (CIDR only) |
| Link | (CIDR only) |
| Host | Fabric type, network/link, IP, default gateway |
| Router | Interfaces list (one row per interface, expandable) + Routing table |

### Router inspector

For a selected router, the inspector includes both the interface list
(name · network · address · cost, plus `+ Add interface`) **and** the
current routing table. The routing table re-fetches via
`GET /devices/{name}/routes` on selection and re-fetches on every
`routing_table_changed` event for this device. Columns: prefix, next
hop, interface.

A directly-connected route shows `0.0.0.0` as the next hop — that's
the simulator's sentinel value meaning "deliver to the packet's
destination on this interface." See [Routing tables](routing-tables.md)
for what to read into this.

## Terminals

Double-click any host or router to open a floating terminal. Each
terminal is a self-contained popup with:

- A title bar showing the device name.
- A scrollable output area.
- A prompt with `#`.
- Drag-to-move and drag-to-resize handles on the corners.

Position and size persist per device.

Keyboard inside a terminal:

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Submit the typed command |
| <kbd>Ctrl+L</kbd> | Clear the output area |
| <kbd>Ctrl+D</kbd> | Close the terminal (when the prompt is empty) |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Command history |

Multiple terminals can be open at once. Commands and their output are
isolated per terminal; nothing is shared.

For the full command set, see [Terminals](terminals.md).

## Context menu (right-click)

| Item | Behavior |
|---|---|
| **Rename** | Inline rename, validated for uniqueness. |
| **Duplicate** | Clone the node with a new name; useful for routers. |
| **Delete** | Same as the <kbd>Delete</kbd> shortcut. |

All three are **disabled** while the sim is running (the sim must be
paused or idle to mutate topology). The menu is dismissed by clicking
anywhere outside it or pressing <kbd>Esc</kbd>.

## Status indicators

- **Save state** (top bar, next to the project name): `autosaved` / `saving…`.
- **Sim state** is implicit in the toolbar — the Start button label
  changes between **Start** / **Stop**, and the Pause label changes
  between **Pause** / **Resume (N edits)**.
- **Connection banner**: if the WebSocket disconnects, a yellow strip
  appears at the bottom — *"connection lost — retrying"*. Reconnection
  is automatic (exponential backoff, max 8 s).
