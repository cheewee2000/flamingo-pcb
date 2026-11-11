/**
 * Flamingo Engine - Zone (copper pour) filling
 * Units: mm, y-up.
 *
 * `fillZone` computes the filled copper of a zone as the zone polygon MINUS a
 * clearance buffer around every *other-net* copper item on the zone's layer,
 * MINUS a clearance buffer around every copper keepout (keepout.copper ===
 * true) affecting the zone's layer, intersected with the board outline inset
 * by the zone clearance. Via-only keepouts (keepout.copper === false) are
 * not subtracted -- they constrain via placement, not copper pours.
 *
 * Winding-encoding of the result (documented, relied on by the SVG renderer and
 * the Gerber writer): `fill` is a flat list of rings. A ring with POSITIVE
 * signed area (CCW, y-up) is a solid outer boundary; a ring with NEGATIVE
 * signed area (CW) is a hole cut out of the outer that immediately precedes it.
 * polygon-clipping returns each result polygon as [outer, ...holes]; we push the
 * outer first (re-oriented CCW) then its holes (re-oriented CW), so a hole always
 * follows the outer it belongs to. Consumers can therefore either use even-odd
 * fill (SVG) or emit each outer as an LPD region and each following hole as an
 * LPC region (Gerber).
 *
 * Polygon offset ("buffer") for pads/holes is a Minkowski sum of the polygon
 * with a disk, built as the union of the polygon with a rectangle straddling
 * each edge plus a disk at each vertex (round joins). This is exact for convex
 * shapes and safe (never under-fills) for concave ones, though a concave vertex
 * gets a rounded rather than a mitred outer corner -- adequate for the convex
 * pad shapes we buffer here.
 *
 * Thermal reliefs are DEFERRED for rev 1: same-net pads/tracks/vias are not
 * subtracted, so the pour makes a solid connection to its net. zone.thermal is
 * currently unused. This is acceptable because our target fab (JLCPCB) reflow
 * handles solid copper connections on hobby-class boards; thermal spokes are a
 * manufacturability nicety we can add later without changing this contract.
 */

import polygonClipping from 'polygon-clipping';
import ClipperLib from 'clipper-lib';
import type { MultiPolygon, Polygon, Ring, Pair } from 'polygon-clipping';
import type { Board, Point, Zone } from './types.js';
import { bboxOf, expandTrack, padOutline, outlineToPolygon, isSlot, holeSlotCenterline, capsulePolygon, allHoles } from './geometry.js';
import { copperLayersOf, padCopperLayers } from './layers.js';

// ---------------------------------------------------------------------------
// Ring / geometry helpers
// ---------------------------------------------------------------------------

function toRing(pts: Point[]): Ring {
  return pts.map((p): Pair => [p.x, p.y]);
}

/** polygon-clipping rings are closed (last == first); drop the duplicate. */
function fromRing(r: Ring): Point[] {
  const pts = r.map(([x, y]): Point => ({ x, y }));
  const n = pts.length;
  if (n > 1 && pts[0].x === pts[n - 1].x && pts[0].y === pts[n - 1].y) pts.pop();
  return pts;
}

function signedArea(pts: Point[]): number {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Return `pts` oriented CCW if `ccw`, else CW. */
function orient(pts: Point[], ccw: boolean): Point[] {
  const isCcw = signedArea(pts) > 0;
  return isCcw === ccw ? pts : pts.slice().reverse();
}

function disk(center: Point, r: number, segments = 24): Point[] {
  // Circumscribed tessellation: vertices at r/cos(pi/n) so the polygon
  // CONTAINS the true circle. An inscribed polygon's edges dip inside the
  // circle by the sagitta, so a clearance-buffered obstacle under-covers and
  // the pour can encroach the true clearance distance by a few microns.
  // Every disk in this file buffers an obstacle or insets the outline, where
  // over-covering errs toward under-fill -- the safe direction.
  const R = r / Math.cos(Math.PI / segments);
  const pts: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push({ x: center.x + R * Math.cos(a), y: center.y + R * Math.sin(a) });
  }
  return pts;
}

/**
 * The set of rectangles + vertex disks whose union with the source polygon is
 * the polygon dilated by `delta` (Minkowski sum with a disk of radius delta).
 */
function edgeCapsules(pts: Point[], delta: number): Polygon[] {
  const out: Polygon[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-12;
    const nx = (-dy / len) * delta;
    const ny = (dx / len) * delta;
    const rect: Point[] = [
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ];
    out.push([toRing(rect)]);
    out.push([toRing(disk(a, delta, 16))]);
  }
  return out;
}

/**
 * Snap every coordinate of a MultiPolygon to a grid, then drop the
 * degeneracies snapping creates: consecutive duplicate vertices (distinct
 * raw vertices that landed on the same grid point become zero-length
 * segments, a documented sweepline killer) and rings left with fewer than 3
 * distinct vertices. A polygon whose OUTER ring collapses is dropped whole
 * (holes without an outer are meaningless); a collapsed hole is dropped
 * alone. Applied to every clip input up front to keep polygon-clipping's
 * sweepline off its degenerate near-coincident-vertex paths (see robustClip).
 */
function snapMulti(m: MultiPolygon, grid: number): MultiPolygon {
  const s = (n: number): number => {
    const v = Math.round(n / grid) * grid;
    return v === 0 ? 0 : v; // fold -0 (from rounding tiny negatives) to +0
  };
  const out: MultiPolygon = [];
  for (const poly of m) {
    const rings: Ring[] = [];
    let outerCollapsed = false;
    for (let ri = 0; ri < poly.length; ri++) {
      const snapped: Pair[] = [];
      for (const [x, y] of poly[ri]) {
        const p: Pair = [s(x), s(y)];
        const prev = snapped[snapped.length - 1];
        if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
        snapped.push(p);
      }
      // Rings can arrive closed (clip outputs) -- drop a closing duplicate.
      while (
        snapped.length > 1 &&
        snapped[0][0] === snapped[snapped.length - 1][0] &&
        snapped[0][1] === snapped[snapped.length - 1][1]
      ) {
        snapped.pop();
      }
      if (snapped.length < 3) {
        if (ri === 0) outerCollapsed = true;
        continue;
      }
      rings.push(snapped);
    }
    if (!outerCollapsed && rings.length > 0) out.push(rings);
  }
  return out;
}

type ClipOp = 'difference' | 'union' | 'intersection';

function runClip(op: ClipOp, geoms: MultiPolygon[]): MultiPolygon {
  const [first, ...rest] = geoms;
  switch (op) {
    case 'difference':
      return polygonClipping.difference(first, ...rest);
    case 'union':
      return polygonClipping.union(first, ...rest);
    case 'intersection':
      return polygonClipping.intersection(first, ...rest);
  }
}

/**
 * `polygonClipping.{difference,union,intersection}`, hardened against the
 * SweepLine failures the library throws on near-coincident, high-precision
 * vertices — exactly what a real autorouter emits (45-degree track corners at
 * sub-micron precision, or the ~2µm segments freerouting output can produce).
 *
 * ALL inputs are snapped to a 10µm grid BEFORE the first attempt. Snapping is
 * imperceptible for a copper pour (JLCPCB tolerance is far coarser) and it is
 * what makes real routed boards tractable: sub-micron vertices don't just make
 * the sweepline throw, they make it *churn* — on a real 66×126mm board the
 * exact-first difference burned 3.3s before throwing and 3.4s total per fill,
 * vs ~10ms snapped (measured 2026-07-18, eink-cell). On-grid inputs (every
 * hand-authored fixture) snap to themselves, so exact inputs are unaffected.
 * Escalates to a coarser 20µm grid if 10µm still trips the clipper.
 *
 * If every attempt still throws, we degrade rather than propagate the
 * exception (which would abort the whole fill and block fab export) -- each
 * op has a documented, safe last resort:
 *   - difference: subtract the subtrahends one at a time; one that still
 *     throws at every grid is replaced by its bounding box (over-carve: the
 *     pour backs off, never encroaches), and only if even the bbox subtract
 *     throws is it skipped -- at which point export_fab's filled-board DRC
 *     catches the unobstructed fill as a clearance violation and refuses
 *     the export, so the failure surfaces loudly instead of producing a bad
 *     board.
 *   - union: return the inputs concatenated as separate polygons of one
 *     MultiPolygon, SNAPPED (raw operands carry the float-noise
 *     micro-segments that made the union throw, and would make every later
 *     clip involving them throw too -- observed: an unclippable pad
 *     obstacle whose skip poured GND copper over the pad). Overlapping
 *     members are fine for the consumers here: polygon-clipping treats an
 *     overlapping subtrahend multipolygon with union semantics, and the
 *     outline-band consumer only tests against it.
 *   - intersection: return `geoms[0]` (the first operand), i.e. the larger,
 *     unconstrained area. Conservative in the same direction as the
 *     difference fallback -- downstream DRC still gates the result.
 */
/** Worst-case vertex movement from robustClip's grid snap (0.01mm grid, rounded up). */
const SNAP_MARGIN = 0.01;

function robustClip(op: ClipOp, ...geoms: MultiPolygon[]): MultiPolygon {
  for (const grid of [0.01, 0.02]) {
    try {
      return runClip(
        op,
        geoms.map((g) => snapMulti(g, grid)),
      );
    } catch {
      // escalate to the coarser grid
    }
  }
  switch (op) {
    case 'difference': {
      // A single degenerate operand (e.g. two buffered obstacles exactly
      // tangent) throws on every grid; returning geoms[0] wholesale would
      // silently yield an UNCARVED pour. Subtract subtrahends one at a
      // time instead. A subtrahend that STILL throws at every grid is
      // replaced by its bounding box: over-carving is the safe direction
      // for an obstacle (the pour backs off), whereas skipping it pours
      // copper straight over the obstacle -- observed on a real board as
      // GND fill covering a testpoint pad (DRC clearance 0.00mm).
      let acc = geoms[0];
      let idx = 0;
      for (const g of geoms.slice(1)) {
        idx++;
        let done = false;
        for (const grid of [0.01, 0.02]) {
          try {
            acc = runClip('difference', [snapMulti(acc, grid), snapMulti(g, grid)]);
            done = true;
            break;
          } catch {
            // escalate, then substitute the bbox
          }
        }
        if (!done) {
          const bb = multiBBox(g);
          if (bb) {
            try {
              acc = runClip('difference', [snapMulti(acc, 0.02), snapMulti([bb], 0.02)]);
              done = true;
            } catch {
              // truly stuck: skip this subtrahend, DRC still gates the result
            }
          }
        }
      }
      return acc;
    }
    case 'union':
      // Concatenated-not-merged is fine for the obstacle/band consumers here,
      // but concatenate the SNAPPED inputs: the raw operands carry the very
      // float-noise micro-segments that made the union throw, and passing
      // them downstream makes every later clip involving them throw too.
      return geoms.flatMap((g) => snapMulti(g, 0.01));
    case 'intersection':
      return geoms[0];
  }
}

/** Axis-aligned bounding box of a MultiPolygon as a single rectangle polygon. */
function multiBBox(m: MultiPolygon): Polygon | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of m)
    for (const ring of poly)
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  if (minX > maxX || minY > maxY) return null;
  return [
    [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ],
  ];
}

/** Dilate a polygon outward by `delta` (round joins). Returns a MultiPolygon. */
export function bufferPolygon(pts: Point[], delta: number): MultiPolygon {
  if (delta <= 1e-12) return [[toRing(pts)]];
  const caps = edgeCapsules(pts, delta);
  return robustClip('union', [[toRing(pts)]], ...caps.map((c): MultiPolygon => [c]));
}

// ---------------------------------------------------------------------------
// Pad net resolution
// ---------------------------------------------------------------------------

function netOfPin(b: Board, pinRef: string): string {
  const net = b.nets.find((n) => n.pins.includes(pinRef));
  return net ? net.name : '';
}

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

/** Clipper works in integers: 1e5/mm = 10nm resolution, well inside its 32-bit fast path. */
const CLIPPER_SCALE = 1e5;

function clipperPath(pts: Point[]): ClipperLib.Path {
  const S = CLIPPER_SCALE;
  return pts.map((p) => ({ X: Math.round(p.x * S), Y: Math.round(p.y * S) }));
}

/** PolyTree -> MultiPolygon, closing each ring (polygon-clipping convention). */
function fromPolyTree(tree: ClipperLib.PolyTree): MultiPolygon {
  const S = CLIPPER_SCALE;
  const ring = (path: ClipperLib.Path): Ring => {
    const pts = path.map((q): Pair => [q.X / S, q.Y / S]);
    if (pts.length > 0) pts.push(pts[0]);
    return pts;
  };
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map((ex): Polygon => [ring(ex.outer), ...ex.holes.map(ring)]);
}

/**
 * `base` minus the union of `obstacles`, in one Clipper pass. polygon-clipping's
 * sweep line is O(n^2)-ish in operand count and took 100-200s on a routed
 * board with ~6-9k tracks (measured 2026-10-08); Clipper does the same job in
 * well under a second and never throws on near-coincident vertices. Clip rings
 * are re-oriented (outer positive, holes negative) so NonZero filling unions
 * overlapping obstacles instead of cancelling opposite-wound ones.
 */
function clipperDifference(base: MultiPolygon, obstacles: MultiPolygon[]): MultiPolygon {
  const c = new ClipperLib.Clipper();
  for (const poly of base) c.AddPaths(poly.map((r) => clipperPath(fromRing(r))), ClipperLib.PolyType.ptSubject, true);
  for (const o of obstacles) {
    for (const poly of o) {
      poly.forEach((r, ri) => {
        const path = clipperPath(fromRing(r));
        if (path.length < 3) return;
        if (ClipperLib.Clipper.Orientation(path) !== (ri === 0)) path.reverse();
        c.AddPath(path, ClipperLib.PolyType.ptClip, true);
      });
    }
  }
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftNonZero);
  return fromPolyTree(tree);
}

/**
 * Morphological opening (erode then dilate by `r`, round joins), clipped back
 * to `m` so it can only remove copper: drops every neck and sliver narrower
 * than 2r -- copper the fab can't etch reliably, which lifts and shorts --
 * and leaves wider copper as-is. Area filtering alone keeps a 0.07 x 20mm
 * strip between two tracks.
 *
 * Width is judged on the copper the fab actually sees: the pour UNION the
 * same-net copper it merges with (`sameNet`). Pour lying on a same-net pad is
 * often a thin strip between the neighbours' knockouts, but pad + strip is
 * solid copper -- opening the pour alone would cut fine-pitch pads off.
 */
function openBy(m: MultiPolygon, r: number, sameNet: Point[][]): MultiPolygon {
  if (r <= 1e-9 || m.length === 0) return m;
  const S = CLIPPER_SCALE;
  const toPath = clipperPath;
  const paths: ClipperLib.Paths = m.flatMap((poly) => poly.map((ring) => toPath(fromRing(ring))));
  const merged: ClipperLib.Paths = [];
  const u = new ClipperLib.Clipper();
  u.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  u.AddPaths(sameNet.map(toPath), ClipperLib.PolyType.ptClip, true);
  u.Execute(ClipperLib.ClipType.ctUnion, merged, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftNonZero);
  const offset = (src: ClipperLib.Paths, delta: number): ClipperLib.Paths => {
    const co = new ClipperLib.ClipperOffset(2, 0.01 * S); // 10µm arc tolerance: result is clipped to `m` anyway
    co.AddPaths(src, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const out: ClipperLib.Paths = [];
    co.Execute(out, delta * S);
    return out;
  };
  const opened = offset(offset(merged, -r), r);
  const c = new ClipperLib.Clipper();
  c.AddPaths(opened, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(paths, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctIntersection, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftEvenOdd);
  return fromPolyTree(tree);
}

/**
 * Compute the filled copper rings of `zone` against board `b`. See the file
 * header for the winding-encoding of the returned rings.
 */
export function fillZone(b: Board, zone: Zone): Point[][] {
  // robustClip snaps vertices to a 0.01mm grid (up to ~7µm of movement), so
  // carve with that much extra clearance or the fill can land under the rule.
  const clr = zone.clearance + SNAP_MARGIN;
  const zonePoly: Polygon = [toRing(zone.polygon)];

  // Base region: zone polygon, intersected with the outline inset by clearance.
  let base: MultiPolygon = [zonePoly];
  if (b.outline.length > 0) {
    const outlinePts = outlineToPolygon(b.outline);
    const caps = edgeCapsules(outlinePts, clr);
    const band = robustClip('union', ...caps.map((c): MultiPolygon => [c]));
    const inset = robustClip('difference', [[toRing(outlinePts)]], band);
    base = robustClip('intersection', [zonePoly], inset);
  }
  if (base.length === 0) return [];

  // Bbox prefilter: an obstacle can only carve the fill if its clearance-
  // expanded shape reaches the zone polygon, so anything whose raw bbox lies
  // outside the zone bbox grown by clearance is skipped before we pay for
  // bufferPolygon (a full clip union) or add operands to the difference clip.
  const zb = bboxOf(zone.polygon);
  const reach = {
    minX: zb.minX - clr,
    minY: zb.minY - clr,
    maxX: zb.maxX + clr,
    maxY: zb.maxY + clr,
  };
  const nearZone = (pts: Point[]): boolean => {
    const o = bboxOf(pts);
    return o.minX <= reach.maxX && o.maxX >= reach.minX && o.minY <= reach.maxY && o.maxY >= reach.minY;
  };

  // Obstacles: every other-net copper item on this layer, clearance-expanded.
  const obstacles: MultiPolygon[] = [];

  for (const t of b.tracks) {
    if (t.layer !== zone.layer || t.net === zone.net) continue;
    // Expand the capsule by widening the track by 2*clearance (cheap + exact).
    const cap = expandTrack({ ...t, width: t.width + 2 * clr });
    if (nearZone(cap)) obstacles.push([[toRing(cap)]]);
  }

  for (const v of b.vias) {
    if (v.net === zone.net) continue; // vias span every copper layer
    const d = disk(v.at, v.diameter / 2 + clr);
    if (nearZone(d)) obstacles.push([[toRing(d)]]);
  }

  const cu = copperLayersOf(b);
  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      if (!padCopperLayers(pad, c.side, cu).includes(zone.layer)) continue;
      const net = netOfPin(b, `${c.refdes}.${pad.number}`);
      if (net === zone.net) continue;
      const outline = padOutline(c, pad);
      if (nearZone(outline)) obstacles.push(bufferPolygon(outline, clr));
    }
  }

  // Copper keepouts are a hard exclusion (no associated net to compare
  // against) affecting this layer. Buffer by clr like every
  // other obstacle above for conservative, consistent behavior -- a pour
  // shouldn't hug a keepout boundary any closer than it hugs a track.
  // Via-only keepouts (keepout.copper === false, keepout.pour !== true) don't
  // clip copper pours. Pour-only keepouts (keepout.pour === true) DO clip the
  // pour here even though they don't flag tracks/pads in DRC or block routing.
  for (const k of b.keepouts) {
    if (!k.keepout.copper && !k.keepout.pour) continue;
    if (k.layers !== 'all' && !k.layers.includes(zone.layer)) continue;
    if (nearZone(k.polygon)) obstacles.push(bufferPolygon(k.polygon, clr));
  }

  // Other-net zones on this layer that are SMALLER than this one are carved
  // out, clearance-buffered: an island plane nested in a bigger plane (an
  // EasyEDA solid FILL inside a POUR, a KiCad higher-priority zone) must not
  // be poured over, or the gerbers short the two nets while each zone's own
  // fill looks fine. ponytail: smaller-outline-wins is the whole priority
  // model; equal-area overlaps are left for DRC's zone-zone clearance check.
  const ownArea = Math.abs(signedArea(zone.polygon));
  for (const z of b.zones) {
    if (z.id === zone.id || z.layer !== zone.layer || z.net === zone.net) continue;
    if (Math.abs(signedArea(z.polygon)) >= ownArea) continue;
    if (nearZone(z.polygon)) obstacles.push(bufferPolygon(z.polygon, clr));
  }

  // Every hole is an obstacle on every layer. Holes carry no net, so a pour
  // touching a plated annulus would bond it to whatever else touches it (a
  // VCC pour on F.Cu + GND pour on B.Cu over one plated hole = short), and a
  // pour over an NPTH is drilled away. Slots clear their capsule, round holes
  // a (circumscribed) disk.
  for (const h of allHoles(b)) {
    const r = h.padDiameter / 2;
    let shape: MultiPolygon;
    if (isSlot(h)) {
      const { start, end } = holeSlotCenterline(h);
      shape = bufferPolygon(capsulePolygon(start, end, r), clr);
    } else {
      shape = [[toRing(disk(h.at, r + clr))]];
    }
    if (nearZone(shape[0][0].map(([x, y]) => ({ x, y })))) obstacles.push(shape);
  }

  const carved: MultiPolygon = obstacles.length > 0 ? clipperDifference(base, obstacles) : base;

  // Same-net copper on this layer merges with the pour (see openBy).
  const sameNet: Point[][] = [];
  for (const t of b.tracks) {
    if (t.layer === zone.layer && t.net === zone.net && nearZone(expandTrack(t))) sameNet.push(expandTrack(t));
  }
  for (const v of b.vias) if (v.net === zone.net) sameNet.push(disk(v.at, v.diameter / 2));
  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      if (!padCopperLayers(pad, c.side, cu).includes(zone.layer)) continue;
      if (netOfPin(b, `${c.refdes}.${pad.number}`) !== zone.net) continue;
      const outline = padOutline(c, pad);
      if (nearZone(outline)) sameNet.push(outline);
    }
  }
  const filled = openBy(carved, zone.minWidth / 2, sameNet);

  // Emit rings, dropping islands whose net copper area < minWidth^2.
  const minArea = zone.minWidth * zone.minWidth;
  const rings: Point[][] = [];
  for (const poly of filled) {
    if (poly.length === 0) continue;
    const outer = fromRing(poly[0]);
    if (outer.length < 3) continue;
    const holes = poly.slice(1).map(fromRing).filter((h) => h.length >= 3);
    const netArea =
      Math.abs(signedArea(outer)) - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    if (netArea < minArea) continue;
    rings.push(orient(outer, true));
    for (const h of holes) rings.push(orient(h, false));
  }
  return rings;
}

/**
 * Identity-keyed memo for fillAllZones. Safe because boards are handled
 * immutably everywhere that matters: applyOp structuredClone()s the board on
 * every op, so any content change yields a new object (= a cache miss), and
 * callers treat the returned filled copy as read-only.
 */
const fillCache = new WeakMap<Board, Board>();

/**
 * Return a copy of `b` with every zone's `fill` populated by `fillZone`.
 * `onZone`, if given, is called after each zone with how many are filled
 * (once, with the total, when the memo already holds the answer).
 */
export function fillAllZones(b: Board, onZone?: (done: number, total: number) => void): Board {
  const hit = fillCache.get(b);
  if (hit) {
    onZone?.(b.zones.length, b.zones.length);
    return hit;
  }
  const filled = {
    ...b,
    zones: b.zones.map((z, i) => {
      const fz = { ...z, fill: fillZone(b, z) };
      onZone?.(i + 1, b.zones.length);
      return fz;
    }),
  };
  fillCache.set(b, filled);
  return filled;
}
