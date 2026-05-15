# LAN visual redesign — bus rail

**Date:** 2026-05-14
**Branch:** `feature/web-module-split` (will branch off into its own feature branch for implementation)
**Source:** user observation that the current LAN cloud silhouette becomes visually heavy at scale ("would start looking cumbersome once we have several networks on display").

## Goal

Replace the cloud silhouette for LANs with a horizontal/vertical **bus rail** — a slim resizable bar that reads as an Ethernet segment. Devices "tap into" the rail via short perpendicular drop-lines. The new form is more semantically truthful (a LAN is a shared broadcast bus), much more compact, and scales cleanly to topologies with many networks.

## Non-goals

- No change to `state.networks` schema other than two optional fields (`w`, `orientation`). Existing topologies load unchanged.
- No change to host/router rendering. Only the network node and the edges that terminate on it.
- No change to the YAML serialization format. Width and orientation are persisted into the same network blob.
- No change to packet animation logic. Animations follow the existing edges; they automatically end at the new tap point.
- No new dependencies.

## Decisions (user-confirmed)

- **Form factor:** horizontal bar rail (the "bus rail" option), not a chip card and not a medallion.
- **Resizable:** the rail has draggable endcaps that double as resize handles, so the user can stretch a busy LAN to fit more taps.
- **Two orientations:** horizontal *and* vertical. Code is parameterized by axis, not duplicated.
- **Rotate affordance:** a small button appears at the rail's far cross-axis corner on hover (and stays while selected). Click to toggle orientation. Inspector LAN panel also gets a "Rotate" button as a backup.
- **Polished aesthetic by default.** Endcaps as terminators, inline `name · CIDR` label, tap-point ticks on the bar, hover-only rotate button, smooth state transitions.
- **Color palette reuses the existing `--net` / `--accent` / `--text-*` variables** so the redesign works in both light and dark themes without new theme tokens.

## Geometry

- `NODE.network` becomes orientation-aware. The rail's **main axis** carries length `w`, the **cross axis** carries thickness `h`.
  - Default `w = 180`, min `100`, max `800`.
  - Fixed `h = 10` (rounded ends, `rx = 5`).
  - Horizontal: render width × height = `w × 10`.
  - Vertical:   render width × height = `10 × w`.
- Centered at the network's existing `(x, y)`. Resize grows symmetrically so the LAN stays anchored on its coordinate.
- `HIT_PAD.network` covers rail + label area, axis-aware: `{ main: 12, cross-near: 12, cross-far: 32 }` where "cross-far" is the side that holds the inline label.

## State

`state.networks[name]` gains two optional fields:

```js
{
  x, y,                  // unchanged
  cidr,                  // unchanged
  w?: number,            // NEW: rail length on main axis. undefined ≡ 180 (default).
  orientation?: 'h'|'v', // NEW: undefined ≡ 'h' (horizontal, backward-compatible).
}
```

Both fields are optional. Existing topologies (sample.yaml, persisted sessions) load with no migration — the absent fields fall back to defaults. New fields are persisted into the topology blob alongside `x`, `y`, `cidr`.

## Rendering

### The rail
- A single rounded `<rect>` filled with `var(--net)`. No stroke at idle (the solid fill is the visual). Rounded ends via `rx`.
- One group per LAN, identical structure to current `drawNode` — same `data-kind="network"`, same `data-name`, same hit-rect for drag/select. Inner children differ.

### Endcaps (always visible)
- A small perpendicular bar at each rail end, same `var(--net)` fill as the rail. Sized `3 × 14` on the rail's cross axis.
- Aesthetic role: makes the bar read as a bus segment with terminators rather than a generic line.
- Functional role (when selected): they **become resize handles** — see below.

### Tap ticks
- For every host/router interface attached to this LAN, draw a 4px-tall perpendicular notch inside the rail at the tap-x (main-axis position of the device, clamped to the rail's main-axis span minus a 12px inset).
- Notch fill: `var(--net-text)` (a darker shade of the LAN color — gives high contrast against the `--net` rail in both themes).
- Notches sit **inside** the rail, not poking out, so the silhouette stays clean.
- On device hover, the matching notch brightens to `var(--accent)` — a small "this is where you connect" affordance.

### Inline label
- One `<text>` node centered below the rail's main-axis bottom end (so it always sits at the lowest-y point of the LAN, regardless of orientation), in this format:
  ```
  lan_office · 10.0.1.0/24
  ```
- Three styled spans inside the text (rendered as `<tspan>`s for SVG):
  - Name in `font-size:15px; fill:var(--net-text); font-weight:600`.
  - Separator " · " in `fill:var(--text-3)`.
  - CIDR in `font-size:13px; fill:var(--text-2)`.
- Empty CIDR:
  ```
  lan_office · — no cidr
  ```
  Placeholder portion in `fill:var(--text-3); font-style:italic`.
- Vertical orientation: the label stays **horizontal** (not rotated). It sits centered below the rail's bottom end. This preserves readability and matches "labels under the icon" convention used by hosts/routers everywhere else in the SPA.

### Resize handles (selected state only)
- The endcaps upgrade in place when the LAN is selected:
  - Size grows `3 × 14` → `5 × 18`.
  - Fill switches `--net` → `--accent`.
  - A 1px outline appears in `var(--accent-border)` (subtle focus ring).
  - Cursor: `ew-resize` for horizontal rails, `ns-resize` for vertical rails.
- A new drag mode `resize-net` handles handle-drag:
  - Pointer is captured on `pointerdown` on a handle.
  - On move, `w` is computed as `2 * |pointer.main - center.main|`, clamped to `[100, 800]`.
  - The opposite endcap moves symmetrically (rail grows from center).
  - On `pointerup`, the new `w` is written to `state.networks[name].w` and `markDirty()` is called so the change persists.

### Rotate button (hover-revealed)
- Small ~18px circular SVG group, positioned just outside the rail's far end on the cross axis:
  - Horizontal rail: above the right end at `(w/2 - 9, -h/2 - 18)`.
  - Vertical rail: right of the top end at `(h/2 + 18, -w/2 + 9)`.
- Internals: a `<circle>` background + a small curved-arrow `<path>` (rotate icon).
- Default `opacity: 0`. CSS reveals it when the parent `.node.network` is hovered or selected.
- Its hit-rect has `pointer-events: all`, but the click handler calls `event.stopPropagation()` so it doesn't bubble up to the LAN's selection/drag handlers.
- Click: toggles `state.networks[name].orientation` between `'h'` and `'v'`, triggers `state:topology-changed` on the bus, persists via `markDirty()`.
- Tooltip via `<title>` child: "Rotate to vertical" / "Rotate to horizontal" based on current orientation.

### Edge tap math
- A new helper replaces the current `pointOnRoundedRect` call for network endpoints:
  ```js
  // For an edge from device (dx, dy) to a rail centered at (rx, ry) with axis a:
  //   main-axis: clamp(device.main, rail.main - w/2 + inset, rail.main + w/2 - inset)
  //   cross-axis: rail.cross +/- (h/2) depending on which side the device sits on
  function tapPointOnRail(device, rail) { ... }
  ```
- `inset = 12px`. Devices clustered near one end get their taps spread out rather than piling at the corner.
- Existing edge polyline drawing is unchanged — only the endpoint coordinate is different.

## Color spec (both themes)

All colors map to existing CSS variables defined in `web/styles.css` for `[data-theme="light"]` and `[data-theme="dark"]`. No new tokens needed.

| Element                  | CSS variable                     | Light          | Dark                          |
|--------------------------|----------------------------------|----------------|-------------------------------|
| Rail fill (idle)         | `--net`                          | `#4f46e5`      | `#818cf8`                     |
| Endcaps (idle)           | `--net`                          | (same as rail) | (same as rail)                |
| Tap ticks (idle)         | `--net-text`                     | `#4338ca`      | `#a5b4fc`                     |
| Tap tick (device hover)  | `--accent`                       | `#4f46e5`      | `#818cf8`                     |
| Label name               | `--net-text`                     | `#4338ca`      | `#a5b4fc`                     |
| Label separator " · "    | `--text-3`                       | `#a1a1aa`      | `#71717a`                     |
| Label CIDR               | `--text-2`                       | `#52525b`      | `#a1a1aa`                     |
| Empty-CIDR placeholder   | `--text-3`                       | `#a1a1aa`      | `#71717a`                     |
| Rail hover               | brightened `--net` via `color-mix(in srgb, var(--net) 88%, white)` | brighter indigo | brighter light-indigo |
| Hover drop-shadow        | `drop-shadow(0 4px 10px rgba(0,0,0,.06))` | visible | barely-visible (acceptable; the brightened fill is the primary cue) |
| Selected — halo ring     | `--accent`, 2px stroke, offset 4px outside rail | `#4f46e5`   | `#818cf8` |
| Resize handle fill       | `--accent`                       | `#4f46e5`      | `#818cf8`                     |
| Resize handle outline    | `--accent-border`                | `#c7d2fe`      | `rgba(129,140,248,.34)`       |
| Drop-target rail fill    | `--accent`                       | `#4f46e5`      | `#818cf8`                     |
| Drop-target halo         | `--accent-glow`                  | `rgba(79,70,229,.32)` | `rgba(129,140,248,.45)` (dark mode glow is already brighter — deliberate, matches existing convention) |
| Drop-target pulse        | 1s ease-in-out infinite alternate on the halo's opacity (`.6 → 1`) | same |
| Rotate button bg (idle)  | `--bg`                           | `#ffffff`      | `#0a0a0a`                     |
| Rotate button border     | `--border`                       | `#e4e4e7`      | `#232328`                     |
| Rotate button icon       | `--text-2`                       | `#52525b`      | `#a1a1aa`                     |
| Rotate button (own hover)| bg `--accent-bg`, icon `--accent`| pale indigo / indigo | translucent indigo / lighter indigo |

Contrast notes:
- Rail fill `--net` over `--bg`: WCAG-passes in both themes (vivid indigo on white / lighter indigo on near-black).
- Label name `--net-text` over `--bg`: `#4338ca` on white (AAA) and `#a5b4fc` on `#0a0a0a` (AAA).
- Tap-tick `--net-text` over rail `--net`: distinct in both themes (darker indigo on indigo light / lighter indigo on indigo dark). The 4px size keeps it readable without becoming busy.

## Visual states (combined)

| State        | Rail fill                  | Stroke / halo                                | Endcaps                       | Cursor      |
|--------------|----------------------------|----------------------------------------------|-------------------------------|-------------|
| idle         | `--net`                    | none                                         | `--net` (3×14)                | default     |
| hover        | brightened `--net`         | soft drop-shadow                             | brightened `--net` (3×14)     | move/grab   |
| selected     | `--net`                    | 2px `--accent` halo, 4px offset              | `--accent` handles (5×18, focus ring) | `ew-resize` (horizontal) / `ns-resize` (vertical) on handles; move on rail |
| drop-target  | `--accent`                 | `--accent-glow` halo, pulsing                | same fill as rail             | (no special — drop is on the dragged node) |

## Interactions

- **Select:** click the rail (any part except the rotate button or a resize handle). Same dispatch as today, via the existing node click flow.
- **Drag-to-move:** click-and-drag anywhere on the rail (but not on handles or rotate button). Existing `pointer-drag` logic, unchanged.
- **Resize:** drag a handle. New `resize-net` mode; commits to `state.networks[name].w` on release.
- **Rotate:** click the hover-revealed rotate button or the inspector's Rotate button. Toggles `state.networks[name].orientation`.
- **Drop host/router onto LAN:** unchanged behavior; hit-target is now the smaller rail+label area instead of the cloud silhouette. Drop-target glow lights up the rail.
- **Right-click context menu:** unchanged. No rotate item added (the hover button + inspector cover it).

## Test plan

- **Unit (vitest, happy-dom):**
  - `tapPointOnRail` returns expected `(x, y)` for devices above/below (horizontal) and left/right (vertical), including clamping to the rail's inset bounds.
  - `tapPointOnRail` is axis-symmetric: rotating the rail and the device by the same axis swap produces the symmetric tap point.
  - State mutations: setting `w` and `orientation` round-trips through `persist`/`restore`.
- **E2E (Playwright):**
  - LAN selection still works after the cloud → rail switch.
  - Drag-to-attach: dragging a host onto a rail attaches it (existing test stays green; just the visual target changed).
  - Resize: drag a handle, rail grows/shrinks, `w` persists across a reload.
  - Rotate: click the hover button, rail flips orientation; click again, flips back; persists.
  - Theme toggle: rail, handles, label, halo all render correctly in both light and dark mode.
- **Python suite:** unaffected (no backend changes).

## Risk / mitigations

- **Edges crowding at handles when `w` is small.** Mitigation: 12px inset already caps tap-x away from the very edge; min `w = 100` keeps room for ~6 taps.
- **Vertical rail with many vertically-stacked devices.** Same as horizontal — the user can resize. If a topology has so many devices on one LAN that even max width isn't enough, that's a topology design decision, not a tool bug.
- **Rotate button accidentally clicked during drag.** Mitigation: rotate button stops propagation; it sits outside the rail's main hit-rect; it's only visible on hover/selected.
- **Hover drop-shadow nearly invisible in dark mode.** Acceptable. The brightened fill is the primary hover cue in dark mode; shadow is decorative.

## File-level change surface

- `web/state.js`: extend `NODE.network`, `HIT_PAD.network` (axis-aware shape constants), add default rail width constant.
- `web/canvas.js`:
  - Replace the cloud branch in `drawNode` with the new rail rendering (rail + endcaps + ticks + label + rotate button).
  - Add `tapPointOnRail(device, rail)` helper; use it in `drawEdge` for network endpoints in place of `pointOnRoundedRect`.
  - Add `resize-net` to the pointer-drag dispatcher.
  - Remove (or move to dead-code-pruning) `cloudPath()`.
- `web/styles.css`: add `.canvas .node.network .rail`, `.endcap`, `.tick`, `.label`, `.rotate-btn`, state classes (`.selected`, `.drop-target`, hover rules) — replaces the existing `.cloud` block.
- `web/inspector.js`: add a "Rotate" button to the LAN inspector panel (calls the same toggle as the hover button).
- Tests:
  - `web/canvas.test.js` (new) or extend existing test file: cover `tapPointOnRail`.
  - `web/state.test.js`: cover `w` and `orientation` persistence.
  - `e2e/`: extend the SPA smoke suite with rail resize, rotate, and drop-target checks.

## Open questions

None at this point. All design decisions have been confirmed.
