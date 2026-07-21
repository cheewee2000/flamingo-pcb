# Interactive push-and-shove — Phase 1: Attach & Drag (design)

**Date:** 2026-07-21
**Status:** design for review

Phase 1 of a three-phase effort toward full KiCad-style push-and-shove trace
editing. This phase delivers **rubber-band attach + trace drag** with **45°
geometry** and **no shoving** (overlaps are left for DRC to flag). Phases 2
(shove tracks) and 3 (shove vias + component-drag shoving + polish) are separate
spec → plan → build cycles built on this foundation.

## Goal

1. **Moving a component drags its connected traces along.** When a component
   moves/rotates/flips, each line-track endpoint touching one of its pads
   follows the pad to its new position; only the pad-attached segment is
   reshaped ("stretch the attached end"), kept on the 45° grid. Works from both
   the **UI drag** and the **MCP `move_component` tool** — today an MCP or UI
   move silently detaches traces because `Track.seg` stores absolute points and
   nothing re-anchors them.
2. **Traces become directly draggable.** Dragging a line segment translates it
   and re-solves its two neighbor segments to stay connected, all on 45°.
3. **Live preview, atomic commit.** During a drag the UI previews the reshaped
   geometry (running the engine primitive in-browser); on drop it commits the
   move + reshape as a single `transaction` op = one undo step. No mid-drag ops
   (consistent with the existing "server is the authority on commit" rule).

## Non-goals (later phases / out of scope)

- **No shoving / collision handling** — moving copper may overlap neighbors;
  the existing DRC clearance check flags it. (Phase 2/3.)
- **No via dragging or via shoving.** Vias stay put in Phase 1. (Phase 3.)
- **No arc reshaping.** Line segments only; an attached *arc* segment is left
  untouched (see Edge cases). Arcs are rare in autorouted output.
- **Component drag does not shove neighbors** — it only rubber-bands its own
  traces. (Phase 3.)
- No re-routing / topology change: rubber-band preserves the trace's segment
  topology (it may add/remove at most one corner segment per attached end).

## Architecture

All geometry is **pure and lives in `@flamingo/engine`** (unit-tested in the
node test env). The UI imports it and runs it live during a drag for the ghost
preview; the MCP tool calls the same helper. The authoritative change is a
single op applied on drop (UI) or on tool-call (MCP). This reuses the existing
`select.ts` ghost-then-commit-on-drop pattern and the engine op/undo log.

```
            ┌──────────────── @flamingo/engine (pure) ────────────────┐
            │ connectivity.ts:  tracksAtPoint / tracksAtPad           │
            │ reroute.ts:        route45, rubberBandReshape,          │
            │                    dragSegmentReshape                   │
            │ ops.ts:            reshapeTracks op, transaction op     │
            └───────▲───────────────────────▲────────────────────────┘
                    │ preview + commit       │ commit
        ┌───────────┴──────────┐   ┌─────────┴──────────────┐
        │ ui/tools/select.ts   │   │ server/mcp.ts          │
        │ (drag ghost + drop)  │   │ move_component tool     │
        └──────────────────────┘   └────────────────────────┘
```

## Engine components

### 1. Connectivity query (`connectivity.ts`)

Fills the mapped gap ("no function answers *which tracks touch this pad*").

```ts
/** Line-track endpoints coincident with point p on `layer`, within EPSILON_MM.
 *  Optionally filtered to one net. Arc-segment ends are excluded (Phase 1). */
export function tracksAtPoint(
  b: Board, p: Point, layer: LayerId, net?: string,
): { trackId: string; end: 'start' | 'end' }[];

/** Line-track endpoints touching a component's pad (its anchor, on each copper
 *  layer the pad occupies). Built on padAnchor + padCopperLayers + tracksAtPoint. */
export function tracksAtPad(
  b: Board, refdes: string, padNumber: string,
): { trackId: string; end: 'start' | 'end'; layer: LayerId }[];
```

`EPSILON_MM` (0.01) and `padAnchor`/`padCopperLayers` already exist. These are
pure lookups, no mutation.

### 2. 45° geometry primitive (`reroute.ts`, new module)

```ts
/** A ≤2-segment 45° (H/V/diagonal) line path from `from` to `to`.
 *  - collinear on an axis or exact diagonal → 1 segment
 *  - otherwise → a diagonal leg + an axis leg (an "elbow")
 *  `hint.diagFirst` picks elbow orientation (diagonal-out vs axis-out); default
 *  chosen to best match `hint.prevDir` (the inland segment's direction) so the
 *  stretch keeps the trace's existing shape. */
export function route45(
  from: Point, to: Point, hint?: { diagFirst?: boolean; prevDir?: Point },
): PathSeg[];
```

Elbow math: let `dx=to.x-from.x`, `dy=to.y-from.y`. If `dx===0 || dy===0 ||
abs(dx)===abs(dy)` → single `{type:'line', from, to}`. Else the diagonal leg
covers `min(abs(dx),abs(dy))` at 45°, the axis leg covers the remainder; the
corner point is `from + diag` or `from + axis` per `diagFirst`. Pure; fully
unit-testable with concrete coordinates.

### 3. Rubber-band reshape (`reroute.ts`)

```ts
/** For a set of pad-anchor moves (old→new world point on a layer), reshape the
 *  attached line-track segments so their touching endpoint follows to `newAt`,
 *  keeping the segment's far vertex fixed and re-solving that vertex→newAt with
 *  route45. Returns the atomic edit (ids to remove, new tracks to add). Arc
 *  segments and via endpoints are skipped (left in place). New tracks inherit
 *  layer/width/net from the original and get fresh ids. */
export function rubberBandReshape(
  b: Board,
  moves: { trackId: string; end: 'start' | 'end'; newAt: Point }[],
): { removeIds: string[]; add: Track[] };
```

Callers build `moves` by pairing `tracksAtPad` results (before the move) with
the pad's new anchor (after the move). Because it works purely from old→new
pad anchors, it handles translation, rotation, and side-flip uniformly (a
rotated/flipped component just yields new pad anchors).

### 4. Drag-segment reshape (`reroute.ts`) — for direct trace drag

```ts
/** Translate one line track by `delta` and re-solve the neighbor segments at
 *  each of its (pre-move) endpoints to stay attached, on 45°. Returns the
 *  atomic edit. The dragged segment keeps its direction (a 45° segment
 *  translated stays 45°); each neighbor is re-solved via rubberBandReshape
 *  against the moved endpoint. Arc neighbors are left in place. */
export function dragSegmentReshape(
  b: Board, trackId: string, delta: Point,
): { removeIds: string[]; add: Track[] };
```

### 5. Ops (`ops.ts`)

```ts
| { op: 'reshapeTracks'; remove: string[]; add: Track[] }
| { op: 'transaction'; ops: Op[] }
```

- **`reshapeTracks`** — atomically removes the listed track ids and adds the
  given tracks. Validates like `addTracks` (net exists, layer valid for the
  board's copper-layer count). Handler mirrors the existing `addTracks` /
  `removeItem` logic.
- **`transaction`** — applies its sub-ops in order as **one undo unit**. It is
  **atomic**: if any sub-op returns an `OpError`, already-applied sub-ops are
  rolled back and the transaction returns the error (no partial state). It
  records a single compound inverse in the op log so one `undo` reverts the
  whole thing (and `redo` re-applies it). *Integration point:* the implementer
  must wire the compound inverse into the existing op-log/undo mechanism in
  `ops.ts` / `document.ts` — spec'd here as a contract; the plan details the
  mechanism after reading the current undo implementation.

The rubber-band move commits as:
`transaction([ moveComponents(moves), reshapeTracks({remove, add}) ])`.
A trace drag commits as `reshapeTracks({remove, add})` (single op, no
transaction needed) — or wrapped in a transaction only if it ever carries
multiple sub-ops.

## Entry points

### UI drag (`ui/src/tools/select.ts`)

- **Component drag** (existing `dragComps` path): in `onPointerMove`, in
  addition to the current pad/courtyard ghost, compute `rubberBandReshape` for
  the drag delta and draw the reshaped traces as a ghost overlay. On
  `onPointerUp` past the drag threshold, commit the `transaction`
  (`moveComponents` + `reshapeTracks`). Group moves (multi-selection) gather
  attached tracks across all moved components.
- **Trace drag** (new path): when the pointer-down `hitEditTarget` is
  `kind:'track'` on a line segment, arm a track drag (mirroring `dragComps`);
  `onPointerMove` previews `dragSegmentReshape(delta)`; `onPointerUp` commits
  `reshapeTracks`. A track hit on an arc falls through to plain select (Phase 1
  doesn't drag arcs).
- If `select.ts` grows unwieldy, extract the trace-drag logic to a new
  `ui/src/tools/drag-route.ts` with a small, focused interface. (Judgment call
  during implementation; note in the plan.)

The UI preview and the committed result use the **same engine helpers**, so
what you see while dragging is exactly what commits.

### MCP `move_component` (`server/src/mcp.ts`)

After computing the new position/rotation/side (as today), the tool computes
`rubberBandReshape` for the affected pads and applies the same
`transaction([ moveComponent, reshapeTracks ])` instead of a bare
`moveComponent`. This keeps the two entry points in parity (the CLAUDE.md
anti-drift rule) and fixes the current silent-detach behavior for
prompt-driven moves. A future flag could opt out of rubber-banding, but Phase 1
makes it the default (matches the user's intent: "traces should move with it").

## Edge cases

- **Attached segment is an arc** → skipped; that endpoint is not reshaped (the
  trace may detach at that pad). Documented limitation; arcs are uncommon.
- **Pad with several attached segments** (T/star at a pad) → each attached line
  segment is reshaped independently against the same new anchor.
- **Endpoint sits on a via, not a pad** → not a component-move case; for trace
  drag the neighbor at a via is still a line-track endpoint and is re-solved
  (the via itself doesn't move in Phase 1).
- **Degenerate move** (`newAt` equals the fixed far vertex) → produce no
  segment for that end (drop the zero-length track); never emit a zero-length
  `line`.
- **route45 with equal legs / axis-aligned** → single segment (no spurious
  corner).
- **Group move** → union of attached tracks across all moved components; a
  track attached at *both* ends to two moved pads has both ends re-solved.

## Testing

- **`route45`** — unit tests: axis-aligned, exact diagonal, both elbow
  orientations, `prevDir` hint selection, degenerate (from==to).
- **`tracksAtPoint` / `tracksAtPad`** — endpoint matching within epsilon; arc
  ends excluded; multi-layer pad; net filter.
- **`rubberBandReshape` / `dragSegmentReshape`** — on a small fixture board:
  moving a pad yields `removeIds`/`add` that reconnect to `newAt`, keep the far
  vertex, stay 45°, and preserve width/layer/net; arcs skipped; degenerate
  drop.
- **`reshapeTracks` + `transaction` ops** — apply correctness, validation
  errors, and **atomic rollback** on a failing sub-op; **single-step undo/redo**
  round-trip.
- **MCP `move_component`** — a placed component with a routed trace: after the
  tool call, the trace still connects (island count unchanged) and is 45°.
- **UI drag wiring** — build + manual QA (the node test env can't drive DOM);
  covered by the plan's manual-verification step on a real board.

## File structure

- `packages/engine/src/connectivity.ts` — add `tracksAtPoint`, `tracksAtPad`.
- `packages/engine/src/reroute.ts` — **new**: `route45`, `rubberBandReshape`,
  `dragSegmentReshape`.
- `packages/engine/src/ops.ts` — add `reshapeTracks` + `transaction` ops and
  handlers; wire compound-inverse undo.
- `packages/engine/src/index.ts` — export the new engine surface.
- `packages/server/src/mcp.ts` — `move_component` computes rubber-band + commits
  the transaction.
- `packages/ui/src/tools/select.ts` — component-drag rubber-band ghost + commit;
  trace-drag path (or extract to `packages/ui/src/tools/drag-route.ts`).

Explicitly **not** touched in Phase 1: DRC, zone fill, export, autoroute,
Freerouting, the 3D viewer.

## Phase boundary

Phase 1 ends with: traces stay attached when components move (UI + MCP), traces
are draggable, everything stays 45°, overlaps are DRC-flagged. Phase 2 adds the
shove engine (collision detection during a drag, push neighbors along 45° hulls,
cascade + spring-back) on top of `reroute.ts` and the `transaction` op.
