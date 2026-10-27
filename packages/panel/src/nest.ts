/**
 * Flamingo Panel - nesting boards of any shape at any angle.
 *
 * The plain packer in layout.ts grows every board into a rectangle and packs
 * rectangles. That wastes the space a pentagon or an L-shaped board leaves
 * around itself, and it can only turn boards by quarter turns. This module
 * does the same bottom-left packing with the real outline:
 *
 *  - `nestOption` grows a turned outline by the clearance each of its edges
 *    needs (the board side an edge faces decides: a blocked side grows more),
 *    so that grown shapes may touch, exactly as grown rectangles may;
 *  - `packNest` drops each shape, largest first, at the lowest and then
 *    leftmost spot in a strip where it overlaps nothing, scanning a grid and
 *    refining the hit, trying every allowed rotation.
 *
 * Overlap tests are the hot path, so they are plain segment and containment
 * tests on the grown rings, not polygon-clipping.
 */

import polygonClipping from 'polygon-clipping';
import type { Point } from '@flamingo/engine';
import { pointInPolygon } from '@flamingo/engine';
import { ccw, edgesOf, normalizeRotation, rotatePoint, sideFacing, sideNormals } from './poly.js';
import type { EdgeInfo } from './source.js';
import { boxOf } from './transform.js';
import type { Box, Side } from './types.js';
import { SIDES } from './types.js';

const EPS = 1e-6;
/** A mitred corner longer than this many times its growth is bevelled with an arc instead. */
const MITER_LIMIT = 1.5;
/** Arc steps for a bevelled corner, degrees. */
const FAN_STEP = 30;

/**
 * How far each side of an instance grows. Grown shapes may touch, so two
 * growths add up to the gap between two boards:
 *  - a plain edge grows by half the spacing, giving the spacing between two;
 *  - a blocked edge grows by its clearance less the half spacing a plain
 *    neighbour brings, giving exactly its clearance;
 *  - an edge with an overhanging part grows by at least the overhang plus half
 *    the margin, so that two such edges facing each other keep the margin
 *    between the parts, not merely between a part and a board.
 */
export function growth(edges: Record<Side, EdgeInfo>, spacing: number, overhangMargin: number): Record<Side, number> {
  const g = {} as Record<Side, number>;
  for (const s of SIDES) {
    const e = edges[s];
    const margin = Math.max(spacing, e.clearance);
    g[s] = Math.max(0, margin - spacing / 2, e.overhang > 0 ? e.overhang + overhangMargin / 2 : 0);
  }
  return g;
}

export interface NestOption {
  rotation: number;
  /** Grown outline rings, moved so their bounding box starts at (0, 0). */
  rings: Point[][];
  w: number;
  h: number;
  /** From the grown box's corner to the instance's `at` (its outline box corner). */
  dx: number;
  dy: number;
  /** Shape signature: two options with the same key pack identically. */
  key: string;
}

type Ring = [number, number][];

function toRing(pts: Point[]): Ring {
  return pts.map((p): [number, number] => [p.x, p.y]);
}

function fromRing(ring: Ring): Point[] {
  const pts = ring.map(([x, y]) => ({ x, y }));
  // polygon-clipping repeats the first point at the end.
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (pts.length > 1 && Math.abs(first.x - last.x) < EPS && Math.abs(first.y - last.y) < EPS) pts.pop();
  return pts;
}

function add(a: Point, b: Point, k = 1): Point {
  return { x: a.x + b.x * k, y: a.y + b.y * k };
}

/** Intersection of the lines p + t*u and q + s*v, or null when parallel. */
function lineMeet(p: Point, u: Point, q: Point, v: Point): Point | null {
  const den = u.x * v.y - u.y * v.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / den;
  return add(p, u, t);
}

/**
 * The outline turned by `rotation`, grown outward by `grow[side]` along every
 * edge that faces `side`. Corners are mitred like a grown rectangle's, or
 * rounded when the mitre would spike. Outward is decided per edge, so an
 * L-shaped board grows correctly; the pieces are unioned with polygon-clipping
 * once per option, which is cheap enough.
 */
export function growOutline(outline: Point[], rotation: number, grow: Record<Side, number>): Point[][] {
  const turned = ccw(outline.map((p) => rotatePoint(p, rotation)));
  const normals = sideNormals(rotation);
  const edges = edgesOf(turned);
  if (edges.length < 3) return [turned];
  const g = edges.map((e) => grow[sideFacing(e.normal, normals)]);
  const pieces: Ring[][] = [[toRing(turned)]];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const gi = g[i]!;
    if (gi > EPS) {
      pieces.push([toRing([e.start, e.end, add(e.end, e.normal, gi), add(e.start, e.normal, gi)])]);
    }
    // Corner between this edge and the next, at e.end.
    const f = edges[(i + 1) % edges.length]!;
    const gf = g[(i + 1) % edges.length]!;
    if (gi <= EPS && gf <= EPS) continue;
    const turn = e.dir.x * f.dir.y - e.dir.y * f.dir.x; // > 0: convex corner (CCW ring)
    if (turn <= EPS) continue; // concave or straight: the two quads already overlap
    const v = e.end;
    const a = add(v, e.normal, gi);
    const b = add(v, f.normal, gf);
    const m = lineMeet(a, e.dir, b, f.dir);
    const limit = MITER_LIMIT * Math.max(gi, gf);
    if (m && Math.hypot(m.x - v.x, m.y - v.y) <= limit + EPS) {
      pieces.push([toRing([v, a, m, b])]);
    } else {
      // Sharp corner: a fan of radius max(gi, gf), pushed out so its chords clear the arc.
      const r = Math.max(gi, gf);
      const a0 = Math.atan2(e.normal.y, e.normal.x);
      let span = Math.atan2(f.normal.y, f.normal.x) - a0;
      while (span < 0) span += 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(span / ((FAN_STEP * Math.PI) / 180)));
      const rr = r / Math.cos(span / steps / 2);
      const fan: Point[] = [v];
      for (let k = 0; k <= steps; k++) {
        const ang = a0 + (span * k) / steps;
        fan.push({ x: v.x + rr * Math.cos(ang), y: v.y + rr * Math.sin(ang) });
      }
      pieces.push([toRing(fan)]);
    }
  }
  try {
    const [first, ...rest] = pieces;
    const merged = polygonClipping.union(first!, ...rest);
    // Outer rings only: a hole in a grown shape is space nothing could use anyway.
    return merged.map((poly) => fromRing(poly[0]!)).filter((r) => r.length >= 3);
  } catch {
    // Degenerate input: fall back to the turned box grown per side, which is always safe.
    const box = boxOf(turned);
    const gN = Math.max(grow.N, 0);
    const gE = Math.max(grow.E, 0);
    const gS = Math.max(grow.S, 0);
    const gW = Math.max(grow.W, 0);
    const m = Math.max(gN, gE, gS, gW);
    return [
      [
        { x: box.minX - m, y: box.minY - m },
        { x: box.maxX + m, y: box.minY - m },
        { x: box.maxX + m, y: box.maxY + m },
        { x: box.minX - m, y: box.maxY + m },
      ],
    ];
  }
}

/** One way of placing a board: turned by `rotation`, grown by what its edges need. */
export function nestOption(
  outline: Point[],
  edges: Record<Side, EdgeInfo>,
  rotation: number,
  spacing: number,
  overhangMargin: number,
): NestOption {
  const r = normalizeRotation(rotation);
  const grown = growOutline(outline, r, growth(edges, spacing, overhangMargin));
  const gb = boxOf(grown.flat());
  const ob = boxOf(outline.map((p) => rotatePoint(p, r)));
  const rings = grown.map((ring) => ring.map((p) => ({ x: p.x - gb.minX, y: p.y - gb.minY })));
  const key = rings
    .map((ring) => ring.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).sort().join(';'))
    .sort()
    .join('|');
  return {
    rotation: r,
    rings,
    w: gb.maxX - gb.minX,
    h: gb.maxY - gb.minY,
    dx: ob.minX - gb.minX,
    dy: ob.minY - gb.minY,
    key,
  };
}

// ---------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Proper crossing of two segments. Touching at an endpoint or along a line does not count. */
function segmentsCross(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** A point just inside a ring: the midpoint of its longest edge, nudged inward. */
function insidePoint(ring: Point[]): Point {
  const edges = edgesOf(ring);
  let best = edges[0]!;
  for (const e of edges) if (e.length > best.length) best = e;
  const mid = { x: (best.start.x + best.end.x) / 2, y: (best.start.y + best.end.y) / 2 };
  return add(mid, best.normal, -1e-3);
}

export interface Shape {
  rings: Point[][];
  bbox: Box;
}

/** Do two shapes overlap with positive area? Touching is allowed. */
export function shapesOverlap(a: Shape, b: Shape): boolean {
  if (a.bbox.minX >= b.bbox.maxX - EPS || b.bbox.minX >= a.bbox.maxX - EPS) return false;
  if (a.bbox.minY >= b.bbox.maxY - EPS || b.bbox.minY >= a.bbox.maxY - EPS) return false;
  for (const ra of a.rings) {
    for (const rb of b.rings) {
      for (let i = 0; i < ra.length; i++) {
        const p1 = ra[i]!;
        const p2 = ra[(i + 1) % ra.length]!;
        for (let j = 0; j < rb.length; j++) {
          if (segmentsCross(p1, p2, rb[j]!, rb[(j + 1) % rb.length]!)) return true;
        }
      }
      if (pointInPolygon(insidePoint(ra), rb) || pointInPolygon(insidePoint(rb), ra)) return true;
    }
  }
  return false;
}

function shapeAt(option: NestOption, x: number, y: number): Shape {
  return {
    rings: option.rings.map((ring) => ring.map((p) => ({ x: p.x + x, y: p.y + y }))),
    bbox: { minX: x, minY: y, maxX: x + option.w, maxY: y + option.h },
  };
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

export interface NestItem {
  id: string;
  options: NestOption[];
}

export interface Nested {
  id: string;
  option: NestOption;
  /** Grown box corner. */
  x: number;
  y: number;
}

/** Grid step for the drop search, from the shapes' size. */
function gridStep(items: Array<{ options: NestOption[] }>): number {
  let smallest = Infinity;
  for (const it of items) for (const o of it.options) smallest = Math.min(smallest, o.w, o.h);
  if (!Number.isFinite(smallest)) return 1;
  return Math.min(1.5, Math.max(0.5, smallest / 20));
}

/**
 * Slide a shape down, then left, and again, until it rests: a drop on the
 * grid stops short of the shapes under it and to its left by up to a step,
 * and a slope lets a shape that slid left fall further.
 */
function settle(option: NestOption, x: number, y: number, x0: number, y0: number, step: number, placed: Shape[]): { x: number; y: number } {
  const free = (px: number, py: number): boolean => clear(shapeAt(option, px, py), placed);
  const slide = (from: number, floor: number, at: (v: number) => boolean): number => {
    let hi = from;
    let lo = Math.max(floor, from - step);
    if (at(lo)) return lo;
    for (let k = 0; k < 7 && hi - lo > 1e-3; k++) {
      const mid = (lo + hi) / 2;
      if (at(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  for (let round = 0; round < 4; round++) {
    const ny = slide(y, y0, (v) => free(x, v));
    const nx = slide(x, x0, (v) => free(v, ny));
    const moved = Math.abs(ny - y) > 1e-3 || Math.abs(nx - x) > 1e-3;
    y = ny;
    x = nx;
    if (!moved) break;
  }
  return { x, y };
}

/**
 * Is a shape at (x, y) a better drop than `best`? Lower top first, so a shape
 * nested into a valley beats one sitting on the floor, then lower, then
 * further left.
 */
function lower(x: number, y: number, option: NestOption, best: { x: number; y: number; option: NestOption }): boolean {
  const top = y + option.h;
  const bestTop = best.y + best.option.h;
  if (top < bestTop - EPS) return true;
  if (top > bestTop + EPS) return false;
  if (y < best.y - EPS) return true;
  if (y > best.y + EPS) return false;
  return x < best.x - EPS;
}

function clear(shape: Shape, placed: Shape[]): boolean {
  for (const p of placed) if (shapesOverlap(shape, p)) return false;
  return true;
}

/**
 * Bottom-left drop of `items` into a strip `width` wide starting at (x0, y0),
 * around `obstacles`. Each item takes the lowest, then leftmost, spot any of
 * its options fits; the hit is refined off the grid so shapes end up touching.
 */
/** Where one option could rest, from the lowest top up. */
export interface Drop {
  x: number;
  y: number;
  option: NestOption;
}

/**
 * Every settled resting place of `option` in the strip, one per grid column,
 * lowest top first. The first is where `packNest` would drop it; the rest are
 * what a repair tries when the first leaves a board without tabs.
 */
export function drops(
  options: NestOption[],
  placed: Shape[],
  x0: number,
  y0: number,
  width: number,
  step: number,
): Drop[] {
  const out: Drop[] = [];
  const ceiling = Math.max(y0, ...placed.map((p) => p.bbox.maxY));
  for (const option of options) {
    if (option.w > width + EPS) continue;
    const xMax = x0 + width - option.w;
    for (let x = x0; x <= xMax + EPS; x += step) {
      const cx = Math.min(x, xMax);
      let hit = -1;
      for (let y = y0; y <= ceiling + EPS; y += step) {
        if (clear(shapeAt(option, cx, y), placed)) {
          hit = y;
          break;
        }
      }
      if (hit < 0) hit = ceiling;
      if (!clear(shapeAt(option, cx, hit), placed)) {
        if (cx >= xMax) break;
        continue;
      }
      const settled = settle(option, cx, hit, x0, y0, step, placed);
      out.push({ x: settled.x, y: settled.y, option });
      if (cx >= xMax) break;
    }
  }
  return out.sort((a, b) => a.y + a.option.h - (b.y + b.option.h) || a.y - b.y || a.x - b.x);
}

/**
 * Bottom-left drop of `items` into a strip `width` wide starting at (x0, y0),
 * around `obstacles`. Each item takes the spot with the lowest top, then the
 * lowest, then the leftmost, that any of its options fits; the hit is refined
 * off the grid so shapes end up touching.
 */
export function packNest(items: NestItem[], obstacles: Shape[], x0: number, y0: number, width: number): Nested[] | null {
  const placed: Shape[] = [...obstacles];
  const out: Nested[] = [];
  const step = gridStep(items);
  for (const item of items) {
    const best = firstDrop(item.options, placed, x0, y0, width, step);
    if (best === null) return null;
    placed.push(shapeAt(best.option, best.x, best.y));
    out.push({ id: item.id, option: best.option, x: best.x, y: best.y });
  }
  return out;
}

/** The drop `packNest` takes: as `drops()[0]`, but without settling every column. */
function firstDrop(options: NestOption[], placed: Shape[], x0: number, y0: number, width: number, step: number): Drop | null {
  let best: Drop | null = null;
  const ceiling = Math.max(y0, ...placed.map((p) => p.bbox.maxY));
  for (const option of options) {
    if (option.w > width + EPS) continue;
    const xMax = x0 + width - option.w;
    for (let x = x0; x <= xMax + EPS; x += step) {
      const cx = Math.min(x, xMax);
      let hit = -1;
      for (let y = y0; y <= ceiling + EPS; y += step) {
        // Nothing above the best top so far can beat it.
        if (best && y + option.h > best.y + best.option.h + EPS) break;
        if (clear(shapeAt(option, cx, y), placed)) {
          hit = y;
          break;
        }
      }
      if (hit < 0) {
        if (best && ceiling + option.h + EPS > best.y + best.option.h) continue;
        hit = ceiling;
        if (!clear(shapeAt(option, cx, hit), placed)) continue;
      }
      const settled = settle(option, cx, hit, x0, y0, step, placed);
      if (best === null || lower(settled.x, settled.y, option, best)) best = { x: settled.x, y: settled.y, option };
      if (cx >= xMax) break;
    }
  }
  return best;
}

export { gridStep };

/** The grown shape of an instance already on the panel, as an obstacle. */
export function obstacleShape(outline: Point[], edges: Record<Side, EdgeInfo>, rotation: number, at: Point, spacing: number, overhangMargin: number): Shape {
  const o = nestOption(outline, edges, rotation, spacing, overhangMargin);
  return shapeAt(o, at.x - o.dx, at.y - o.dy);
}

/** Keep one option per distinct shape, in the order given. */
export function dedupeOptions(options: NestOption[]): NestOption[] {
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)));
}
