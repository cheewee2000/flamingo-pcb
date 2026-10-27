/**
 * Flamingo Panel - polygon helpers shared by the geometry, the checks and the
 * packer, for boards turned by any angle.
 *
 * A board's four sides (N/E/S/W of its own bounding box) still carry the
 * blocked-edge information; once the board is turned, each side is a
 * direction in panel space rather than an axis. These helpers map outline
 * edges and closest-approach directions back to those sides.
 */

import type { Point } from '@flamingo/engine';
import type { Side } from './types.js';
import { SIDES } from './types.js';

const EPS = 1e-9;

/** Degrees brought into [0, 360), with float noise removed. */
export function normalizeRotation(deg: number): number {
  let r = deg % 360;
  if (r < 0) r += 360;
  r = Math.round(r * 1e6) / 1e6;
  return r >= 360 ? 0 : r;
}

/** Turn `p` CCW by `deg` about the origin. Multiples of 90 are exact. */
export function rotatePoint(p: Point, deg: number): Point {
  const r = normalizeRotation(deg);
  switch (r) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: -p.y, y: p.x };
    case 180:
      return { x: -p.x, y: -p.y };
    case 270:
      return { x: p.y, y: -p.x };
  }
  const a = (r * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Outward unit normal of each board side, in board space. */
export const SIDE_NORMAL: Record<Side, Point> = {
  N: { x: 0, y: 1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: -1 },
  W: { x: -1, y: 0 },
};

/** Outward unit normal of each board side once the board is turned by `deg`. */
export function sideNormals(deg: number): Record<Side, Point> {
  const out = {} as Record<Side, Point>;
  for (const s of SIDES) out[s] = rotatePoint(SIDE_NORMAL[s], deg);
  return out;
}

/** The side whose outward normal points most nearly along `dir`. */
export function sideFacing(dir: Point, normals: Record<Side, Point>): Side {
  let best: Side = 'N';
  let bestDot = -Infinity;
  for (const s of SIDES) {
    const d = dir.x * normals[s].x + dir.y * normals[s].y;
    if (d > bestDot) {
      bestDot = d;
      best = s;
    }
  }
  return best;
}

/** Twice the signed area: positive for a counter-clockwise ring. */
export function signedArea2(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

/** The ring in counter-clockwise order (a copy when it had to be reversed). */
export function ccw(poly: Point[]): Point[] {
  return signedArea2(poly) < 0 ? [...poly].reverse() : poly;
}

export interface Edge {
  start: Point;
  end: Point;
  /** Unit vector from start to end. */
  dir: Point;
  /** Outward unit normal. */
  normal: Point;
  length: number;
}

/** The edges of a ring with their outward normals (zero-length edges dropped). */
export function edgesOf(poly: Point[]): Edge[] {
  const ring = ccw(poly);
  const out: Edge[] = [];
  for (let i = 0; i < ring.length; i++) {
    const start = ring[i]!;
    const end = ring[(i + 1) % ring.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < EPS) continue;
    const dir = { x: dx / length, y: dy / length };
    // CCW ring: outward is to the right of the direction of travel.
    out.push({ start, end, dir, normal: { x: dir.y, y: -dir.x }, length });
  }
  return out;
}

export function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

/** Closest points of two segments, and the distance between them. */
export function closestSegmentPoints(
  a0: Point,
  a1: Point,
  b0: Point,
  b1: Point,
): { d: number; pa: Point; pb: Point } {
  // Parametric closest approach (Ericson, Real-Time Collision Detection 5.1.9).
  const d1 = { x: a1.x - a0.x, y: a1.y - a0.y };
  const d2 = { x: b1.x - b0.x, y: b1.y - b0.y };
  const r = { x: a0.x - b0.x, y: a0.y - b0.y };
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  if (a <= EPS && e <= EPS) {
    // Both degenerate.
  } else if (a <= EPS) {
    t = clamp(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= EPS) {
      s = clamp(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  const pa = { x: a0.x + d1.x * s, y: a0.y + d1.y * s };
  const pb = { x: b0.x + d2.x * t, y: b0.y + d2.y * t };
  return { d: Math.hypot(pa.x - pb.x, pa.y - pb.y), pa, pb };
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Closest points of two rings' boundaries. Zero when they touch or cross;
 * does not detect one ring inside the other (use `polyIntersects` for that).
 */
export function closestPoints(a: Point[], b: Point[]): { d: number; pa: Point; pb: Point } {
  let best = { d: Infinity, pa: a[0]!, pb: b[0]! };
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i]!;
    const a1 = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const r = closestSegmentPoints(a0, a1, b[j]!, b[(j + 1) % b.length]!);
      if (r.d < best.d) best = r;
      if (best.d <= EPS) return best;
    }
  }
  return best;
}

/**
 * The edges of a ring with consecutive collinear edges merged into one
 * straight run, so a side split by extra vertices still reads as one edge.
 * Arcs tessellated into short chords stay as they are.
 */
export function straightRuns(poly: Point[]): Edge[] {
  const es = edgesOf(poly);
  const n = es.length;
  if (n < 2) return es;
  const same = (p: Edge, q: Edge): boolean => dot(p.dir, q.dir) > 1 - 1e-9;
  // Start at a real corner so a run is never split across the ring's seam.
  const k = es.findIndex((e, i) => !same(es[(i - 1 + n) % n]!, e));
  if (k < 0) return es;
  const out: Edge[] = [];
  for (let m = 0; m < n; m++) {
    const e = es[(k + m) % n]!;
    const last = out[out.length - 1];
    if (last && same(last, e)) {
      const length = Math.hypot(e.end.x - last.start.x, e.end.y - last.start.y);
      out[out.length - 1] = { ...last, end: e.end, length };
    } else {
      out.push(e);
    }
  }
  return out;
}

/** Whether `p` lies on segment a-b, within `tol`. */
export function onSegment(p: Point, a: Point, b: Point, tol = 1e-6): boolean {
  return closestSegmentPoints(p, p, a, b).d <= tol;
}
