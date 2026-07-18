/**
 * Flamingo Engine - track widening ("taper") pass.
 *
 * Tracks routed thinner than their net class's trackWidth (fine-pitch pad
 * escapes, congested corridors) are widened back to class width wherever the
 * widened copper still clears everything else. A segment that can't widen
 * whole is bisected recursively, so only the sub-span that actually needs to
 * stay thin keeps the escape width — the neck-down happens right at the pad
 * or obstruction, and the rest of the run gets full class width.
 *
 * Clearance model mirrors the DRC clearance check: required distance to a
 * different-net copper item is max(ruleset floor, either net's class
 * clearance), with a small safety margin so the result never sits exactly on
 * the DRC threshold. Zones are ignored (fills recompute their own clearance
 * around tracks at export); copper keepouts and the board edge are honored.
 * Split pieces share endpoints exactly, so point-based connectivity is
 * preserved.
 */

import type { Board, PathSeg, Point, Track } from './types.js';
import {
  bboxOf,
  expandTrack,
  outlineToPolygon,
  polyIntersects,
  polyPolyDistance,
  segSegDistance,
} from './geometry.js';
import { RULESETS } from './drc/rules.js';
import { buildCopperItems } from './drc/drc.js';

/** Don't bisect spans shorter than this — a sub-mm neck is already as local as it needs to be. */
const MIN_SPLIT_MM = 0.8;
/** Safety margin (mm) over the required clearance so widened copper never lands exactly on the DRC threshold. */
const MARGIN_MM = 0.005;

export interface WidenResult {
  /** Tracks that gained width over at least part of their length. */
  tracksWidened: number;
  /** Extra segments created by bisection (0 when every widened track widened whole). */
  splits: number;
  /** Ids of all replacement track pieces (both widened and kept-thin). */
  createdIds: string[];
}

interface Obstacle {
  net: string;
  layer: string;
  polygon: { x: number; y: number }[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  clearance: number;
  ref: string;
}

/** Minimum distance between two closed polygon *boundaries* (containment is NOT zero, unlike polyPolyDistance). */
function boundaryDistance(a: Point[], b: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const segA: PathSeg = { type: 'line', start: a[i], end: a[(i + 1) % a.length] };
    for (let j = 0; j < b.length; j++) {
      const segB: PathSeg = { type: 'line', start: b[j], end: b[(j + 1) % b.length] };
      const d = segSegDistance(segA, segB);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Widen `board`'s under-width tracks toward their class width, in place.
 * `nets` limits which nets are candidates (their tracks); every other item on
 * the board is still an obstacle. Arc tracks are left untouched.
 */
export function widenTracks(board: Board, nets?: string[]): WidenResult {
  const rules = RULESETS[board.rules];
  const netFilter = nets && nets.length > 0 ? new Set(nets) : null;

  const classByNet = new Map<string, { trackWidth: number; clearance: number }>();
  for (const n of board.nets) {
    const cls = board.netClasses.find((c) => c.name === n.class) ?? board.netClasses[0];
    classByNet.set(n.name, {
      trackWidth: cls?.trackWidth ?? 0.25,
      clearance: cls?.clearance ?? rules.minClearance,
    });
  }
  const clearanceOf = (net: string): number => classByNet.get(net)?.clearance ?? 0;

  // Every copper item except zones is an obstacle (same-net items are skipped
  // per candidate at compare time). Kept as a live list: replacement pieces
  // are swapped in so later candidates see earlier widenings.
  const obstacles: Obstacle[] = buildCopperItems(board)
    .filter((it) => it.kind !== 'zone')
    .map((it) => ({
      net: it.net,
      layer: it.layer,
      polygon: it.polygon,
      bbox: bboxOf(it.polygon),
      clearance: clearanceOf(it.net),
      ref: it.ref,
    }));

  // No outline yet (fresh board) => no edge to keep clear of.
  const outlinePoly = board.outline.length > 0 ? outlineToPolygon(board.outline) : null;
  const copperKeepouts = board.keepouts.filter((k) => k.keepout.copper);

  function spanClear(t: Track, a: { x: number; y: number }, b: { x: number; y: number }, width: number): boolean {
    const poly = expandTrack({ ...t, seg: { type: 'line', start: a, end: b }, width });
    const bbox = bboxOf(poly);
    const ownClearance = clearanceOf(t.net);

    for (const ob of obstacles) {
      if (ob.net === t.net || ob.layer !== t.layer) continue;
      const required = Math.max(rules.minClearance, ownClearance, ob.clearance) + MARGIN_MM;
      if (
        bbox.minX - required > ob.bbox.maxX ||
        bbox.maxX + required < ob.bbox.minX ||
        bbox.minY - required > ob.bbox.maxY ||
        bbox.maxY + required < ob.bbox.minY
      ) {
        continue;
      }
      if (polyPolyDistance(poly, ob.polygon) < required) return false;
    }

    for (const k of copperKeepouts) {
      if (k.layers !== 'all' && !k.layers.includes(t.layer)) continue;
      if (polyIntersects(poly, k.polygon)) return false;
    }

    // Board edge: polyPolyDistance treats containment as 0, so measure
    // boundary-to-boundary like the copper-to-edge DRC check does.
    if (outlinePoly && boundaryDistance(poly, outlinePoly) < rules.copperToEdge + MARGIN_MM) {
      return false;
    }

    return true;
  }

  const result: WidenResult = { tracksWidened: 0, splits: 0, createdIds: [] };

  // Snapshot: board.tracks mutates as pieces are swapped in.
  for (const t of [...board.tracks]) {
    if (netFilter && !netFilter.has(t.net)) continue;
    if (t.seg.type !== 'line') continue;
    const target = classByNet.get(t.net)?.trackWidth ?? t.width;
    if (target <= t.width + 1e-6) continue;

    type Span = { a: { x: number; y: number }; b: { x: number; y: number }; width: number };
    function widenSpan(a: Span['a'], b: Span['b']): Span[] {
      if (spanClear(t, a, b, target)) return [{ a, b, width: target }];
      if (Math.hypot(b.x - a.x, b.y - a.y) <= MIN_SPLIT_MM) return [{ a, b, width: t.width }];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return [...widenSpan(a, mid), ...widenSpan(mid, b)];
    }

    const spans = widenSpan(t.seg.start, t.seg.end);
    // Merge adjacent spans that ended up the same width.
    const merged: Span[] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && last.width === s.width) last.b = s.b;
      else merged.push({ ...s });
    }
    if (merged.length === 1 && merged[0].width === t.width) continue; // nothing gained

    const pieces: Track[] = merged.map((s) => ({
      id: globalThis.crypto.randomUUID(),
      layer: t.layer,
      width: s.width,
      net: t.net,
      seg: { type: 'line', start: s.a, end: s.b },
    }));

    const idx = board.tracks.indexOf(t);
    board.tracks.splice(idx, 1, ...pieces);
    result.tracksWidened += 1;
    result.splits += pieces.length - 1;
    result.createdIds.push(...pieces.map((p) => p.id));

    // Swap the obstacle geometry so later candidates respect the new widths.
    for (let i = obstacles.length - 1; i >= 0; i--) {
      if (obstacles[i].ref === t.id) obstacles.splice(i, 1);
    }
    for (const p of pieces) {
      const poly = expandTrack(p);
      obstacles.push({
        net: p.net,
        layer: p.layer,
        polygon: poly,
        bbox: bboxOf(poly),
        clearance: clearanceOf(p.net),
        ref: p.id,
      });
    }
  }

  return result;
}
