# Push-and-Shove Phase 1 (Attach & Drag) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Moving a component drags its connected traces along (UI + MCP), traces become directly draggable, everything stays on the 45° grid, and overlaps are left for DRC — no shoving yet.

**Architecture:** All geometry is pure and lives in `@flamingo/engine` (unit-tested in the node env). The UI imports it to preview a drag live and commits on drop as a single `transaction` op; the MCP `move_component` tool calls the same helper. Undo is snapshot-based at the document layer (`document.apply` pushes one pre-op board per call), so a `transaction` is one undo step and atomic for free — the document only commits on `ok`.

**Tech Stack:** TypeScript, Vitest (node env, no jsdom), the existing engine op/undo log, plain-DOM canvas UI.

## Global Constraints

- **Units mm, y-up, rotations degrees CCW.** `Track.seg` stores absolute world points; `PathSeg` is `{type:'line';start;end}` or `{type:'arc';start;end;center;cw}`.
- **Lines only.** Phase 1 reshapes only `type:'line'` segments; arc segments are left untouched (skipped).
- **45° / octilinear.** All reshaped geometry is horizontal, vertical, or exact 45° diagonal.
- **Connectivity epsilon** `EPSILON_MM = 0.01` (connectivity.ts:29).
- **No shove, no via drag, no arc reshape, no re-route.** (Phases 2/3.)
- **Ids:** ops assign track ids via `globalThis.crypto.randomUUID()`; reshape helpers return `Omit<Track,'id'>[]` and the op assigns ids (mirrors `addTracks`, ops.ts:405-434).
- **Entry-point parity:** the rubber-band lives in a shared engine helper so both the UI drag and the MCP `move_component` tool use it (CLAUDE.md anti-drift rule).
- Copper-layer validation for added tracks: `copperLayersOf(board).includes(layer)` (ops.ts:381-386).

## File Structure

- `packages/engine/src/connectivity.ts` — add `tracksAtPoint`, `tracksAtPad` (Task 1).
- `packages/engine/src/reroute.ts` — **new**: `route45`, `rubberBandReshape`, `dragSegmentReshape` (Tasks 2-3).
- `packages/engine/src/ops.ts` — add `reshapeTracks` + `transaction` ops/handlers (Task 4).
- `packages/engine/src/index.ts` — export new surface (Tasks 1-4).
- `packages/server/src/mcp.ts` — `move_component` computes rubber-band, commits a transaction (Task 5).
- `packages/ui/src/tools/select.ts` — component-drag rubber-band ghost + commit (Task 6), trace-drag path (Task 7).

---

### Task 1: Connectivity query — `tracksAtPoint` + `tracksAtPad`

**Files:**
- Modify: `packages/engine/src/connectivity.ts`
- Modify: `packages/engine/src/index.ts` (export the two functions)
- Test: `packages/engine/test/tracks-at.test.ts` (create)

**Interfaces:**
- Consumes: existing `padAnchor`, `padWorld`, `padCopperLayers(pad, side, copperLayers)`, `copperLayersOf`, `dist`, `EPSILON_MM`.
- Produces:
  - `tracksAtPoint(b: Board, p: Point, layer: LayerId, net?: string): { trackId: string; end: 'start' | 'end' }[]`
  - `tracksAtPad(b: Board, refdes: string, padNumber: string): { trackId: string; end: 'start' | 'end'; layer: LayerId }[]`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/test/tracks-at.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tracksAtPoint, tracksAtPad } from '../src/connectivity.js';
import type { Board } from '../src/types.js';

// Minimal board: one 2-pad component (R1 pads "1"/"2") and two line tracks on
// F.Cu, one touching R1.1's anchor, one arc that must be excluded.
function fixture(): Board {
  const pads = [
    { number: '1', at: { x: -1, y: 0 }, size: { x: 0.6, y: 0.6 }, shape: 'rect' as const, layers: ['F.Cu'], rotation: 0 },
    { number: '2', at: { x: 1, y: 0 }, size: { x: 0.6, y: 0.6 }, shape: 'rect' as const, layers: ['F.Cu'], rotation: 0 },
  ];
  return {
    name: 't', copperLayers: 2, rules: 'jlcpcb-2l',
    outline: [], components: [{
      refdes: 'R1', lcsc: '', side: 'top', at: { x: 0, y: 0 }, rotation: 0,
      footprint: { name: 'r', pads, courtyard: [], silk: [], holes: [] },
      fields: {},
    }],
    nets: [{ name: 'N', class: 'default', pins: ['R1.1', 'R1.2'] }],
    netClasses: [{ name: 'default', trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }],
    tracks: [
      { id: 'tLine', layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'line', start: { x: -1, y: 0 }, end: { x: -1, y: 5 } } },
      { id: 'tArc', layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'arc', start: { x: -1, y: 0 }, end: { x: 0, y: 1 }, center: { x: 0, y: 0 }, cw: false } },
    ],
    vias: [], zones: [], keepouts: [], holes: [], silk: [], dimensions: [],
  } as unknown as Board;
}

describe('tracksAtPoint', () => {
  it('returns the line-track endpoint coincident with the point (arc excluded)', () => {
    const hits = tracksAtPoint(fixture(), { x: -1, y: 0 }, 'F.Cu');
    expect(hits).toEqual([{ trackId: 'tLine', end: 'start' }]);
  });
  it('returns nothing on a different layer', () => {
    expect(tracksAtPoint(fixture(), { x: -1, y: 0 }, 'B.Cu')).toEqual([]);
  });
  it('honors the net filter', () => {
    expect(tracksAtPoint(fixture(), { x: -1, y: 0 }, 'F.Cu', 'OTHER')).toEqual([]);
  });
  it('matches within epsilon but not beyond', () => {
    expect(tracksAtPoint(fixture(), { x: -1.005, y: 0 }, 'F.Cu')).toHaveLength(1);
    expect(tracksAtPoint(fixture(), { x: -1.02, y: 0 }, 'F.Cu')).toHaveLength(0);
  });
});

describe('tracksAtPad', () => {
  it('finds the line track touching R1.1', () => {
    const hits = tracksAtPad(fixture(), 'R1', '1');
    expect(hits).toEqual([{ trackId: 'tLine', end: 'start', layer: 'F.Cu' }]);
  });
  it('returns nothing for a pad with no tracks', () => {
    expect(tracksAtPad(fixture(), 'R1', '2')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run test/tracks-at.test.ts`
Expected: FAIL — `tracksAtPoint`/`tracksAtPad` are not exported.

- [ ] **Step 3: Write the implementation**

In `packages/engine/src/connectivity.ts`, add after `padAnchor` (after line 52):

```ts
/**
 * Line-track endpoints coincident with `p` on `layer`, within EPSILON_MM.
 * Arc segments are excluded (Phase 1 rubber-band reshapes lines only).
 * Optionally filtered to one net.
 */
export function tracksAtPoint(
  b: Board,
  p: Point,
  layer: LayerId,
  net?: string,
): { trackId: string; end: 'start' | 'end' }[] {
  const out: { trackId: string; end: 'start' | 'end' }[] = [];
  for (const t of b.tracks) {
    if (t.layer !== layer) continue;
    if (net !== undefined && t.net !== net) continue;
    if (t.seg.type !== 'line') continue;
    if (dist(t.seg.start, p) <= EPSILON_MM) out.push({ trackId: t.id, end: 'start' });
    else if (dist(t.seg.end, p) <= EPSILON_MM) out.push({ trackId: t.id, end: 'end' });
  }
  return out;
}

/**
 * Line-track endpoints touching a component's pad — its world anchor, on each
 * copper layer the pad occupies. Built on padWorld + padCopperLayers +
 * tracksAtPoint. Filtered to the pad's net when the pad belongs to one.
 */
export function tracksAtPad(
  b: Board,
  refdes: string,
  padNumber: string,
): { trackId: string; end: 'start' | 'end'; layer: LayerId }[] {
  const comp = b.components.find((c) => c.refdes === refdes);
  if (!comp) return [];
  const pad = comp.footprint.pads.find((p) => p.number === padNumber);
  if (!pad) return [];
  const at = padWorld(comp, pad).at;
  const net = b.nets.find((n) => n.pins.includes(`${refdes}.${padNumber}`))?.name;
  const layers = padCopperLayers(pad, comp.side, copperLayersOf(b));
  const out: { trackId: string; end: 'start' | 'end'; layer: LayerId }[] = [];
  for (const layer of layers) {
    for (const hit of tracksAtPoint(b, at, layer, net)) {
      out.push({ ...hit, layer });
    }
  }
  return out;
}
```

In `packages/engine/src/index.ts`, ensure `tracksAtPoint` and `tracksAtPad` are exported (they ride the existing `export * from './connectivity.js'` if present; if the file uses named re-exports, add them).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/engine && npx vitest run test/tracks-at.test.ts`
Expected: PASS — all 6 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/connectivity.ts packages/engine/src/index.ts packages/engine/test/tracks-at.test.ts
git commit -m "engine: tracksAtPoint/tracksAtPad — line-track endpoints touching a point/pad"
```

---

### Task 2: 45° path primitive — `route45`

**Files:**
- Create: `packages/engine/src/reroute.ts`
- Modify: `packages/engine/src/index.ts` (export `route45`)
- Test: `packages/engine/test/route45.test.ts` (create)

**Interfaces:**
- Consumes: `Point`, `PathSeg` from `./types.js`.
- Produces: `route45(from: Point, to: Point, opts?: { diagFirst?: boolean }): PathSeg[]` — a ≤2-segment 45° line path. Empty array if `from`≈`to`.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/test/route45.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { route45 } from '../src/reroute.js';

const L = (x0: number, y0: number, x1: number, y1: number) =>
  ({ type: 'line', start: { x: x0, y: y0 }, end: { x: x1, y: y1 } });

describe('route45', () => {
  it('is empty for a degenerate move', () => {
    expect(route45({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([]);
  });
  it('is one segment for a horizontal move', () => {
    expect(route45({ x: 0, y: 0 }, { x: 5, y: 0 })).toEqual([L(0, 0, 5, 0)]);
  });
  it('is one segment for a vertical move', () => {
    expect(route45({ x: 0, y: 0 }, { x: 0, y: -3 })).toEqual([L(0, 0, 0, -3)]);
  });
  it('is one segment for an exact diagonal', () => {
    expect(route45({ x: 0, y: 0 }, { x: 4, y: 4 })).toEqual([L(0, 0, 4, 4)]);
  });
  it('diag-first elbow: wider-than-tall goes diagonal then horizontal', () => {
    // dx=5, dy=2 -> diagonal covers 2, then horizontal covers 3
    expect(route45({ x: 0, y: 0 }, { x: 5, y: 2 }, { diagFirst: true })).toEqual([
      L(0, 0, 2, 2), L(2, 2, 5, 2),
    ]);
  });
  it('axis-first elbow: wider-than-tall goes horizontal then diagonal', () => {
    // dx=5, dy=2 -> horizontal covers 3, then diagonal covers 2
    expect(route45({ x: 0, y: 0 }, { x: 5, y: 2 }, { diagFirst: false })).toEqual([
      L(0, 0, 3, 0), L(3, 0, 5, 2),
    ]);
  });
  it('handles negative directions (taller-than-wide, diag-first)', () => {
    // dx=-2, dy=-5 -> diagonal covers 2, then vertical covers 3
    expect(route45({ x: 0, y: 0 }, { x: -2, y: -5 }, { diagFirst: true })).toEqual([
      L(0, 0, -2, -2), L(-2, -2, -2, -5),
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run test/route45.test.ts`
Expected: FAIL — `reroute.js` module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/engine/src/reroute.ts`:

```ts
/**
 * 45°/octilinear rubber-band geometry for interactive drag (push-and-shove
 * Phase 1). Pure and DOM-free so it runs both in the engine op layer and live
 * in the UI during a drag. Lines only — arc segments are left untouched.
 */

import type { Point, PathSeg, Board, Track } from './types.js';
import { tracksAtPoint } from './connectivity.js';

const line = (start: Point, end: Point): PathSeg => ({ type: 'line', start, end });
const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

/**
 * A ≤2-segment 45° line path from `from` to `to`:
 *  - from≈to           -> [] (caller drops the zero-length track)
 *  - axis-aligned/exact diagonal -> one segment
 *  - otherwise         -> an elbow (diagonal leg + axis leg). `diagFirst`
 *    (default true) puts the 45° leg adjacent to `from`.
 */
export function route45(from: Point, to: Point, opts?: { diagFirst?: boolean }): PathSeg[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return [];
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (dx === 0 || dy === 0 || adx === ady) return [line(from, to)];

  const sx = sign(dx);
  const sy = sign(dy);
  const diagLen = Math.min(adx, ady);
  const diagFirst = opts?.diagFirst ?? true;

  let corner: Point;
  if (diagFirst) {
    corner = { x: from.x + sx * diagLen, y: from.y + sy * diagLen };
  } else if (adx > ady) {
    corner = { x: from.x + sx * (adx - ady), y: from.y }; // horizontal leg first
  } else {
    corner = { x: from.x, y: from.y + sy * (ady - adx) }; // vertical leg first
  }
  return [line(from, corner), line(corner, to)];
}
```

(The `Board`/`Track`/`tracksAtPoint` imports are used by Task 3 in the same file; add them now so Task 3 only appends functions.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/engine && npx vitest run test/route45.test.ts`
Expected: PASS — all 7 cases. (If tsc complains about unused `Board`/`Track`/`tracksAtPoint`, that resolves in Task 3; to keep this commit clean, add the Task 3 functions before building, or temporarily import only `Point`/`PathSeg` here and add the rest in Task 3.)

Export `route45` from `packages/engine/src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/reroute.ts packages/engine/src/index.ts packages/engine/test/route45.test.ts
git commit -m "engine: route45 — <=2-segment 45deg path primitive"
```

---

### Task 3: Reshape helpers — `rubberBandReshape` + `dragSegmentReshape`

**Files:**
- Modify: `packages/engine/src/reroute.ts`
- Modify: `packages/engine/src/index.ts` (export both)
- Test: `packages/engine/test/reshape.test.ts` (create)

**Interfaces:**
- Consumes: `route45`, `tracksAtPoint` (Task 1), `Board`, `Track`, `Point`.
- Produces:
  - `rubberBandReshape(b: Board, moves: { trackId: string; end: 'start' | 'end'; newAt: Point }[]): { removeIds: string[]; add: Omit<Track, 'id'>[] }`
  - `dragSegmentReshape(b: Board, trackId: string, delta: Point): { removeIds: string[]; add: Omit<Track, 'id'>[] }`

**Behavior:** For each affected **line** track, keep the un-moved endpoint(s) fixed, move the moved endpoint(s) to `newAt`, and re-solve the whole segment via `route45`. A track whose *both* ends move (group move / dragged segment neighbors) is solved once from new-start to new-end. Arc tracks are skipped (left in place). A degenerate result (route45 returns `[]`) removes the track and adds nothing.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/test/reshape.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rubberBandReshape, dragSegmentReshape } from '../src/reroute.js';
import type { Board } from '../src/types.js';

// Two line tracks on F.Cu forming an L: A(0,0)->(0,5) and (0,5)->(5,5). Net N.
function board(): Board {
  return {
    name: 't', copperLayers: 2, rules: 'jlcpcb-2l', outline: [], components: [],
    nets: [{ name: 'N', class: 'default', pins: [] }],
    netClasses: [{ name: 'default', trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }],
    tracks: [
      { id: 'a', layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 5 } } },
      { id: 'b', layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'line', start: { x: 0, y: 5 }, end: { x: 5, y: 5 } } },
    ],
    vias: [], zones: [], keepouts: [], holes: [], silk: [], dimensions: [],
  } as unknown as Board;
}

describe('rubberBandReshape', () => {
  it('moves one endpoint and re-solves that track on 45deg, keeping the far vertex', () => {
    // Move track a's start (0,0) -> (2,0). Far vertex (0,5) stays.
    const r = rubberBandReshape(board(), [{ trackId: 'a', end: 'start', newAt: { x: 2, y: 0 } }]);
    expect(r.removeIds).toEqual(['a']);
    // route45((0,5)->(2,0)) elbow: dx=2, dy=-5, diag-first -> (0,5)->(2,3)->(2,0)
    expect(r.add.map((t) => t.seg)).toEqual([
      { type: 'line', start: { x: 0, y: 5 }, end: { x: 2, y: 3 } },
      { type: 'line', start: { x: 2, y: 3 }, end: { x: 2, y: 0 } },
    ]);
    expect(r.add.every((t) => t.net === 'N' && t.layer === 'F.Cu' && t.width === 0.25)).toBe(true);
  });

  it('skips arc tracks', () => {
    const b = board();
    (b.tracks[0].seg as { type: string }).type = 'arc';
    const r = rubberBandReshape(b, [{ trackId: 'a', end: 'start', newAt: { x: 2, y: 0 } }]);
    expect(r.removeIds).toEqual([]);
    expect(r.add).toEqual([]);
  });

  it('drops a track whose reshape is degenerate', () => {
    // Move a.start to its own far vertex (0,5): zero-length -> removed, nothing added.
    const r = rubberBandReshape(board(), [{ trackId: 'a', end: 'start', newAt: { x: 0, y: 5 } }]);
    expect(r.removeIds).toEqual(['a']);
    expect(r.add).toEqual([]);
  });
});

describe('dragSegmentReshape', () => {
  it('translates the dragged segment and re-solves the neighbor at the shared vertex', () => {
    // Drag track b by (0,+2): b becomes (0,7)->(5,7); neighbor a's end (0,5) follows to (0,7).
    const r = dragSegmentReshape(board(), 'b', { x: 0, y: 2 });
    expect(new Set(r.removeIds)).toEqual(new Set(['a', 'b']));
    const segs = r.add.map((t) => t.seg);
    // dragged b translated:
    expect(segs).toContainEqual({ type: 'line', start: { x: 0, y: 7 }, end: { x: 5, y: 7 } });
    // neighbor a re-solved (0,0)->(0,7) stays vertical (one segment):
    expect(segs).toContainEqual({ type: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 7 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run test/reshape.test.ts`
Expected: FAIL — `rubberBandReshape`/`dragSegmentReshape` not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/engine/src/reroute.ts`:

```ts
const add = (p: Point, d: Point): Point => ({ x: p.x + d.x, y: p.y + d.y });

/**
 * Reshape the line tracks named in `moves` so each moved endpoint follows to
 * its `newAt`, re-solving the whole segment on 45° via route45 (far endpoint
 * fixed). Moves are grouped by track, so a segment whose BOTH ends move is
 * solved once from new-start to new-end. Arc tracks are skipped; a degenerate
 * (zero-length) result removes the track and adds nothing.
 */
export function rubberBandReshape(
  b: Board,
  moves: { trackId: string; end: 'start' | 'end'; newAt: Point }[],
): { removeIds: string[]; add: Omit<Track, 'id'>[] } {
  const byTrack = new Map<string, { start?: Point; end?: Point }>();
  for (const m of moves) {
    const e = byTrack.get(m.trackId) ?? {};
    e[m.end] = m.newAt;
    byTrack.set(m.trackId, e);
  }
  const removeIds: string[] = [];
  const added: Omit<Track, 'id'>[] = [];
  for (const [trackId, ends] of byTrack) {
    const t = b.tracks.find((x) => x.id === trackId);
    if (!t || t.seg.type !== 'line') continue; // missing or arc -> skip
    const from = ends.start ?? t.seg.start;
    const to = ends.end ?? t.seg.end;
    removeIds.push(t.id);
    for (const seg of route45(from, to)) {
      added.push({ layer: t.layer, width: t.width, net: t.net, seg });
    }
  }
  return { removeIds, add: added };
}

/**
 * Translate one line track by `delta` and re-solve the neighbor line segments
 * at each of its (pre-move) endpoints so they stay attached, on 45°. Returns
 * the atomic edit (the dragged track is replaced by its translated self, plus
 * the neighbor reshapes). Arc neighbors are left in place.
 */
export function dragSegmentReshape(
  b: Board,
  trackId: string,
  delta: Point,
): { removeIds: string[]; add: Omit<Track, 'id'>[] } {
  const t = b.tracks.find((x) => x.id === trackId);
  if (!t || t.seg.type !== 'line') return { removeIds: [], add: [] };
  const a = t.seg.start;
  const bEnd = t.seg.end;
  const aNew = add(a, delta);
  const bNew = add(bEnd, delta);

  const moves: { trackId: string; end: 'start' | 'end'; newAt: Point }[] = [];
  for (const hit of tracksAtPoint(b, a, t.layer, t.net)) {
    if (hit.trackId !== trackId) moves.push({ ...hit, newAt: aNew });
  }
  for (const hit of tracksAtPoint(b, bEnd, t.layer, t.net)) {
    if (hit.trackId !== trackId) moves.push({ ...hit, newAt: bNew });
  }
  const res = rubberBandReshape(b, moves);
  res.removeIds.push(t.id);
  res.add.push({ layer: t.layer, width: t.width, net: t.net, seg: line(aNew, bNew) });
  return res;
}
```

Export `rubberBandReshape` and `dragSegmentReshape` from `packages/engine/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/engine && npx vitest run test/reshape.test.ts`
Expected: PASS — all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/reroute.ts packages/engine/src/index.ts packages/engine/test/reshape.test.ts
git commit -m "engine: rubberBandReshape/dragSegmentReshape — 45deg attach reshape"
```

---

### Task 4: Ops — `reshapeTracks` + `transaction`

**Files:**
- Modify: `packages/engine/src/ops.ts`
- Test: `packages/engine/test/ops-reshape-transaction.test.ts` (create)

**Interfaces:**
- Consumes: existing `applyOp`, `copperLayersOf`, the `Op` union, `Track`.
- Produces two new `Op` variants:
  - `{ op: 'reshapeTracks'; remove: string[]; add: Omit<Track, 'id'>[] }`
  - `{ op: 'transaction'; ops: Op[] }`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/test/ops-reshape-transaction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyOp } from '../src/ops.js';
import type { Board, Track } from '../src/types.js';

function board(): Board {
  return {
    name: 't', copperLayers: 2, rules: 'jlcpcb-2l', outline: [],
    components: [{
      refdes: 'R1', lcsc: '', side: 'top', at: { x: 0, y: 0 }, rotation: 0,
      footprint: { name: 'r', pads: [{ number: '1', at: { x: 0, y: 0 }, size: { x: 0.6, y: 0.6 }, shape: 'rect', layers: ['F.Cu'], rotation: 0 }], courtyard: [], silk: [], holes: [] },
      fields: {},
    }],
    nets: [{ name: 'N', class: 'default', pins: ['R1.1'] }],
    netClasses: [{ name: 'default', trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }],
    tracks: [{ id: 'old', layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 5 } } }],
    vias: [], zones: [], keepouts: [], holes: [], silk: [], dimensions: [],
  } as unknown as Board;
}
const newTrack: Omit<Track, 'id'> = { layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 3, y: 3 } } };

describe('reshapeTracks op', () => {
  it('removes listed ids and adds new tracks with fresh ids', () => {
    const r = applyOp(board(), { op: 'reshapeTracks', remove: ['old'], add: [newTrack] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.board.tracks.some((t) => t.id === 'old')).toBe(false);
    expect(r.board.tracks).toHaveLength(1);
    expect(r.createdIds).toHaveLength(1);
    expect(r.board.tracks[0].seg).toEqual(newTrack.seg);
  });
  it('rejects an unknown net', () => {
    const r = applyOp(board(), { op: 'reshapeTracks', remove: [], add: [{ ...newTrack, net: 'ZZ' }] });
    expect(r.ok).toBe(false);
  });
  it('rejects an invalid layer and changes nothing', () => {
    const r = applyOp(board(), { op: 'reshapeTracks', remove: ['old'], add: [{ ...newTrack, layer: 'In1.Cu' }] });
    expect(r.ok).toBe(false);
  });
});

describe('transaction op', () => {
  it('applies sub-ops in order as one result', () => {
    const r = applyOp(board(), { op: 'transaction', ops: [
      { op: 'moveComponent', refdes: 'R1', at: { x: 1, y: 1 } },
      { op: 'reshapeTracks', remove: ['old'], add: [newTrack] },
    ] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.board.components[0].at).toEqual({ x: 1, y: 1 });
    expect(r.board.tracks.some((t) => t.id === 'old')).toBe(false);
    expect(r.createdIds).toHaveLength(1);
  });
  it('is atomic: a failing sub-op yields an error and no partial board', () => {
    const r = applyOp(board(), { op: 'transaction', ops: [
      { op: 'moveComponent', refdes: 'R1', at: { x: 9, y: 9 } },
      { op: 'reshapeTracks', remove: [], add: [{ ...newTrack, net: 'ZZ' }] }, // fails
    ] });
    expect(r.ok).toBe(false);
  });
  it('does not mutate the input board', () => {
    const b = board();
    applyOp(b, { op: 'transaction', ops: [{ op: 'moveComponent', refdes: 'R1', at: { x: 4, y: 4 } }] });
    expect(b.components[0].at).toEqual({ x: 0, y: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run test/ops-reshape-transaction.test.ts`
Expected: FAIL — the two ops aren't in the union / no handler.

- [ ] **Step 3: Add the op types**

In `packages/engine/src/ops.ts`, add to the `Op` union (after line 61, near the other track ops):

```ts
  | { op: 'reshapeTracks'; remove: string[]; add: Omit<Track, 'id'>[] }
  | { op: 'transaction'; ops: Op[] }
```

- [ ] **Step 4: Add the handlers**

In `applyOp`'s switch (place after the `addTracks` case, ops.ts:434), add:

```ts
    case 'reshapeTracks': {
      const validLayers = copperLayersOf(board);
      for (const t of op.add) {
        if (!board.nets.some((n) => n.name === t.net)) {
          return err(`Unknown net "${t.net}"`);
        }
        if (!validLayers.includes(t.layer)) {
          return err(`Layer "${t.layer}" is not valid for a ${board.copperLayers}-layer board`);
        }
      }
      const removeSet = new Set(op.remove);
      board.tracks = board.tracks.filter((t) => !removeSet.has(t.id));
      for (const t of op.add) {
        const id = globalThis.crypto.randomUUID();
        board.tracks.push({ id, ...t });
        createdIds.push(id);
      }
      return ok(board, createdIds);
    }

    case 'transaction': {
      // Snapshot-based undo makes this atomic for free: applyOp is pure and the
      // document only commits on ok, so returning an error leaves the live doc
      // untouched. Thread each sub-op through applyOp; one document.apply() =>
      // one undo step for the whole transaction.
      let cur: Board = board;
      for (const sub of op.ops) {
        const r = applyOp(cur, sub);
        if (!r.ok) return r;
        cur = r.board;
        createdIds.push(...r.createdIds);
      }
      return ok(cur, createdIds);
    }
```

(`Track` is already imported in ops.ts:13. `applyOp` is the function being defined — recursive self-call is fine.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/engine && npx vitest run test/ops-reshape-transaction.test.ts`
Expected: PASS — all 6 cases.

- [ ] **Step 6: Build + full engine suite**

Run: `cd packages/engine && npx tsc -p . --noEmit && npx vitest run`
Expected: PASS — no type errors (Tasks 1-3 exports resolve), all engine tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/ops.ts packages/engine/test/ops-reshape-transaction.test.ts
git commit -m "engine: reshapeTracks + transaction ops (snapshot-atomic, one undo step)"
```

---

### Task 5: MCP `move_component` rubber-bands connected traces

**Files:**
- Modify: `packages/server/src/mcp.ts` (the `move_component` tool, ~mcp.ts:572-596)
- Test: `packages/server/test/move-component-rubberband.test.ts` (create; follow the existing server test harness pattern — locate a sibling test in `packages/server/test/` for the doc/tool setup)

**Interfaces:**
- Consumes: `tracksAtPad`, `rubberBandReshape` (engine), `padWorld`/`padAnchor`, the existing `applyOp(ctx, op)` server helper, `structuredClone`.
- Produces: `move_component` applies `transaction([ moveComponent, reshapeTracks ])` when connected line tracks exist (else the plain `moveComponent`, unchanged).

**Approach:** Attached track endpoints are found on the **pre-move** board; their new anchor is the pad position **after** the move. Compute the post-move component by cloning the board and applying the move, read each connected pad's new `padWorld().at`, then build `rubberBandReshape` moves pairing each pre-move `tracksAtPad` hit with its pad's new anchor.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/move-component-rubberband.test.ts`. Model the doc/tool setup on an existing server test (e.g. whichever test constructs a `Doc` and calls tools). The behavioral assertions:

```ts
// Pseudocode-precise: adapt the harness to the existing server test style.
// Board: R1 (pad "1" at world (0,0)) on net N; one line track (0,0)->(0,5) on F.Cu.
// Act: move_component R1 to (3,0).
// Assert:
//   - after the move, tracksAtPad(board,'R1','1') still returns a hit (the trace
//     followed the pad — island connectivity preserved), and
//   - the reshaped track(s) are all 45deg (each line seg has dx==0 || dy==0 || |dx|==|dy|), and
//   - a single undo restores BOTH the component position AND the original track.
```

Write concrete assertions using the real harness: call the tool, read `doc.board`, assert `tracksAtPad` non-empty and the reshaped segs are octilinear, then `doc.undo()` and assert `board.components[0].at` is back to `(0,0)` and the original track id/geometry is restored.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run test/move-component-rubberband.test.ts`
Expected: FAIL — move currently sends a bare `moveComponent`, so the track detaches (tracksAtPad empty after move) and undo restores only position.

- [ ] **Step 3: Implement**

In `packages/server/src/mcp.ts`, add imports (top of file, with the other engine imports):

```ts
import { tracksAtPad, rubberBandReshape, padWorld } from '@flamingo/engine';
```

In the `move_component` tool handler, replace the final `applyOp(ctx, { op: 'moveComponent', ... })` with logic that builds a transaction:

```ts
      const moveOp = { op: 'moveComponent' as const, refdes, at, rotation, side };
      const board = ctx.doc.board;
      const comp = board.components.find((c) => c.refdes === refdes);
      // Gather connected line-track endpoints BEFORE the move.
      const hits = comp ? comp.footprint.pads.flatMap((pad) =>
        tracksAtPad(board, refdes, pad.number).map((h) => ({ ...h, padNumber: pad.number }))) : [];
      if (comp && hits.length > 0) {
        // Post-move pad anchors: clone + apply the move, read padWorld().at.
        const after = structuredClone(board);
        const ac = after.components.find((c) => c.refdes === refdes)!;
        if (at !== undefined) ac.at = at;
        if (rotation !== undefined) ac.rotation = rotation;
        if (side !== undefined) ac.side = side;
        const newAnchor = (padNumber: string): { x: number; y: number } => {
          const pad = ac.footprint.pads.find((p) => p.number === padNumber)!;
          return padWorld(ac, pad).at;
        };
        const moves = hits.map((h) => ({ trackId: h.trackId, end: h.end, newAt: newAnchor(h.padNumber) }));
        const { removeIds, add } = rubberBandReshape(board, moves);
        if (removeIds.length > 0 || add.length > 0) {
          return applyOp(ctx, { op: 'transaction', ops: [moveOp, { op: 'reshapeTracks', remove: removeIds, add }] });
        }
      }
      return applyOp(ctx, moveOp);
```

Adapt names (`ctx.doc.board`, `applyOp(ctx, op)`) to the actual server helpers used elsewhere in mcp.ts — match the surrounding tools' pattern exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx vitest run test/move-component-rubberband.test.ts`
Expected: PASS — trace follows the pad; reshaped segs are 45°; single undo restores both.

- [ ] **Step 5: Build + full server suite**

Run: `cd packages/server && npx tsc -p . --noEmit && npx vitest run`
Expected: PASS — no type errors, all server tests green (existing move_component tests unaffected when a component has no connected tracks).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/mcp.ts packages/server/test/move-component-rubberband.test.ts
git commit -m "mcp: move_component rubber-bands connected traces (transaction; parity with UI)"
```

---

### Task 6: UI — component drag rubber-bands connected traces

**Files:**
- Modify: `packages/ui/src/tools/select.ts` (drop handler ~207-220, `drawOverlay` ~340-352)

**Interfaces:**
- Consumes: `tracksAtPad`, `rubberBandReshape`, `padWorld` from `@flamingo/engine`; the existing `dragComps`, `dragDelta`, `ctx.sendOp`, `Op` type.
- Produces: on a component drop, a single `transaction([ moveComponents, reshapeTracks ])` (or `moveComponent` when no traces are attached); a live ghost of the reshaped traces during the drag.

**Note:** No unit test — the UI suite is node-env (no DOM). Verify by build + manual QA (Task 8). The geometry it calls is already unit-tested (Tasks 1-3).

- [ ] **Step 1: Add a shared helper to compute the drop transaction**

In `select.ts`, add a module-level pure function (near `itemDropOp`, ~line 59). It computes the moves + reshape for the current drag delta and returns the op to send:

```ts
import { tracksAtPad, rubberBandReshape, padWorld } from '@flamingo/engine';
import type { Board } from '@flamingo/engine';

/** Build the drop op for a component drag: a transaction that moves the
 *  component(s) AND rubber-bands their connected line traces, or a bare move
 *  when nothing is attached. Pure given the pre-drag board + drag delta. */
export function componentDropOp(
  board: Board,
  drag: { refdes: string; startAt: Point }[],
  delta: Point,
): Op {
  const moves = drag.map((d) => ({ refdes: d.refdes, at: { x: d.startAt.x + delta.x, y: d.startAt.y + delta.y } }));
  const moved = new Set(moves.map((m) => m.refdes));
  // Post-move anchors from a shadow board.
  const shadow: Board = structuredClone(board);
  for (const m of moves) {
    const c = shadow.components.find((x) => x.refdes === m.refdes);
    if (c) c.at = m.at;
  }
  const reshapeMoves: { trackId: string; end: 'start' | 'end'; newAt: Point }[] = [];
  for (const refdes of moved) {
    const c = shadow.components.find((x) => x.refdes === refdes);
    if (!c) continue;
    for (const pad of c.footprint.pads) {
      const newAt = padWorld(c, pad).at;
      for (const h of tracksAtPad(board, refdes, pad.number)) {
        reshapeMoves.push({ trackId: h.trackId, end: h.end, newAt });
      }
    }
  }
  const { removeIds, add } = rubberBandReshape(board, reshapeMoves);
  const moveOp: Op = moves.length === 1
    ? { op: 'moveComponent', refdes: moves[0].refdes, at: moves[0].at }
    : { op: 'moveComponents', moves };
  if (removeIds.length === 0 && add.length === 0) return moveOp;
  return { op: 'transaction', ops: [moveOp, { op: 'reshapeTracks', remove: removeIds, add }] };
}
```

- [ ] **Step 2: Use it in the drop handler**

In `onPointerUp`, replace the component-drop block (select.ts:207-220) body that sends the move op with:

```ts
      if (dragComps.length > 0 && dragDelta && moved) {
        ctx.sendOp(componentDropOp(board, dragComps, dragDelta));
        if (dragGrabRefdes) ctx.setState({ selection: { kind: 'component', refdes: dragGrabRefdes } });
        reset();
        return;
      }
```

- [ ] **Step 3: Draw the reshaped-trace ghost**

In `drawOverlay`, in the `dragComps` branch (after the pad/courtyard ghost loop, ~line 352), add a ghost of the reshaped traces so the preview matches what will commit:

```ts
      // Ghost the rubber-banded traces (same geometry the drop will commit).
      const dropOp = componentDropOp(state.board, dragComps, dragDelta);
      const reshape = dropOp.op === 'transaction'
        ? dropOp.ops.find((o): o is Extract<Op, { op: 'reshapeTracks' }> => o.op === 'reshapeTracks')
        : undefined;
      for (const t of reshape?.add ?? []) {
        if (t.seg.type !== 'line') continue;
        strokeOverlayPolygon(ctx2d, view, [t.seg.start, t.seg.end], SELECT_COLOR, 1.5, false);
      }
```

(If `strokeOverlayPolygon`'s signature differs for open polylines, use the existing 2-point stroke helper the file already uses; match its call shape.)

- [ ] **Step 4: Build + full UI suite**

Run: `npm run build` (repo root)
Then: `cd packages/ui && npx vitest run`
Expected: PASS — tsc + vite clean; all UI tests green (no behavioral unit tests here, but compile + regression must hold).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/tools/select.ts
git commit -m "ui: component drag rubber-bands connected traces (live ghost + transaction on drop)"
```

---

### Task 7: UI — draggable traces

**Files:**
- Modify: `packages/ui/src/tools/select.ts`

**Interfaces:**
- Consumes: `dragSegmentReshape` (engine), existing `hitEditTarget` (returns `{kind:'track', id, net}`), the drag-state fields, `ctx.sendOp`.
- Produces: dragging a line track commits `reshapeTracks` on drop; a live ghost during the drag. Arc tracks fall through to plain select.

**Note:** No unit test (node-env DOM limitation); build + manual QA (Task 8). `dragSegmentReshape` is unit-tested (Task 3).

- [ ] **Step 1: Arm a track drag on pointer-down**

Add a module drag-state field near `dragComps` (e.g. `let dragTrackId: string | null = null;` and reuse `dragStartWorld`/`dragDelta`). In `onPointerDown`, add a branch after the component branch (select.ts:159-168), before the silk/hole branch:

```ts
      } else if (hit && hit.kind === 'track') {
        const t = state.board.tracks.find((x) => x.id === hit.id);
        if (t && t.seg.type === 'line') {
          dragTrackId = hit.id;
          dragStartWorld = ev.world;
          dragDelta = { x: 0, y: 0 };
        }
        // arc tracks: fall through to click-select in onPointerUp
```

Ensure `reset()` clears `dragTrackId = null`.

- [ ] **Step 2: Commit the reshape on drop**

In `onPointerUp`, add a block (after the component-drop block, before the silk/hole block):

```ts
      if (dragTrackId && dragDelta && moved) {
        const { removeIds, add } = dragSegmentReshape(board, dragTrackId, dragDelta);
        if (removeIds.length > 0 || add.length > 0) {
          ctx.sendOp({ op: 'reshapeTracks', remove: removeIds, add });
        }
        reset();
        return;
      }
```

- [ ] **Step 3: Ghost the dragged trace + neighbors**

In `drawOverlay`, add a branch (near the `dragComps` branch) when `dragTrackId` is set:

```ts
      if (dragTrackId) {
        const { add } = dragSegmentReshape(state.board, dragTrackId, dragDelta);
        for (const t of add) {
          if (t.seg.type !== 'line') continue;
          strokeOverlayPolygon(ctx2d, view, [t.seg.start, t.seg.end], SELECT_COLOR, 1.5, false);
        }
        return;
      }
```

- [ ] **Step 4: Build + full UI suite**

Run: `npm run build` (repo root); then `cd packages/ui && npx vitest run`
Expected: PASS — tsc + vite clean, all UI tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/tools/select.ts
git commit -m "ui: draggable traces (drag a line segment, neighbors follow on 45deg)"
```

---

### Task 8: Manual verification + full suite

**Files:** none (verification only)

- [ ] **Step 1: Full build + all tests**

Run: `npm run build && npm test`
Expected: PASS — every package's tsc + the full vitest suite green (including the new engine + server tests).

- [ ] **Step 2: Manual QA on a real board**

```bash
node packages/server/dist/cli.js serve boards/eink-cell/eink-cell.flamingo
```
Open `http://localhost:4242`. On a routed board:
- Drag a component with connected traces → the attached trace ends follow the pads, stay 45°, and the preview matches the committed result. Undo restores component + traces in one step.
- Drag a line trace segment → it moves and its neighbor segments follow to stay connected, on 45°. Undo restores.
- Confirm overlaps are left in place (no shove) and DRC flags them (run DRC).
- Via `move_component` over MCP (or note it for a follow-up): moving a part keeps its traces attached.

- [ ] **Step 3: Record any manual-QA findings** in the branch notes for the final review (browser-only behaviors the node suite can't cover).

---

## Self-Review

**Spec coverage:**
- "which tracks touch this pad" query → Task 1 (`tracksAtPoint`/`tracksAtPad`). ✓
- 45° stretch primitive → Task 2 (`route45`). ✓
- Rubber-band (component move) + trace-drag reshape → Task 3 (`rubberBandReshape`/`dragSegmentReshape`). ✓
- `transaction` (atomic, one undo) + `reshapeTracks` ops → Task 4. ✓
- Snapshot-based undo (not compound inverse — spec deferred the mechanism) → Task 4 handler + comment. ✓
- MCP parity (move_component rubber-bands; anti-drift) → Task 5. ✓
- UI component-drag rubber-band ghost + commit → Task 6. ✓
- UI trace drag → Task 7. ✓
- Lines only / arcs skipped → Tasks 1,3 (filters) + tests. ✓
- Degenerate move drops the track → Task 2 (`route45` empty) + Task 3 test. ✓
- Manual QA for DOM behavior → Task 8. ✓

**Placeholder scan:** Task 5's test is described against the real server harness rather than pinned to exact API names (the server test setup wasn't read); the implementer must mirror a sibling server test's doc/tool construction. This is a deliberate "match the existing pattern" instruction, not a blank — behavior and assertions are concrete. No TBD/TODO elsewhere.

**Type consistency:** `{ trackId, end, newAt }` move shape is identical across Tasks 3, 5, 6. Reshape return `{ removeIds: string[]; add: Omit<Track,'id'>[] }` is identical across Tasks 3-7. `route45` signature `(from,to,opts?)` matches Tasks 2-3. Op shapes (`reshapeTracks`/`transaction`) match between Task 4 definition and Tasks 5-7 construction. `componentDropOp(board, drag, delta)` consistent between Task 6 Steps 1-3.

**Scope:** One coherent plan; each task ends with an independently testable/committable deliverable. Engine tasks (1-4) are pure TDD; server (5) is TDD against the real harness; UI (6-7) is build + manual (node-env DOM limit), with all their geometry already unit-tested upstream.
