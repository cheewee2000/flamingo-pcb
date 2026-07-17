/**
 * Flamingo Engine - Geometry
 * Units: mm
 * Coordinate system: y-up
 * Angles: degrees, counter-clockwise (CCW)
 *
 * Bottom-side convention (locked project-wide): for components with
 * side==='bottom', a pad's local position (and any shape geometry defined
 * relative to the footprint origin) is mirrored across the component's
 * local Y axis (x -> -x) BEFORE the component's rotation+translation are
 * applied. The pad's own rotation is negated by this mirror as a natural
 * consequence of mirroring the whole shape. `padWorld` and `padOutline`
 * both implement this rule; keep them in sync.
 */

import polygonClipping from 'polygon-clipping';
import type { Point, PathSeg, Pad, ComponentInst, Track, Board } from './types.js';

const CHORD_ERROR_MM = 0.05;
const MIN_CIRCLE_SEGMENTS = 16;

// ---------------------------------------------------------------------------
// Basic vector ops
// ---------------------------------------------------------------------------

/** Rotate a point about the origin by `deg` degrees, CCW, y-up. */
export function rotate(p: Point, deg: number): Point {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

/** Add two points/vectors. */
export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

/** Euclidean distance between two points. */
export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// ---------------------------------------------------------------------------
// Tessellation
// ---------------------------------------------------------------------------

/**
 * Number of steps needed to approximate a circular arc of `sweepAngle`
 * radians at radius `r` with chord error <= CHORD_ERROR_MM, with a floor
 * ensuring a full circle gets at least MIN_CIRCLE_SEGMENTS segments.
 */
function stepsForChordError(r: number, sweepAngle: number): number {
  const angleCapFromMinCircle = (2 * Math.PI) / MIN_CIRCLE_SEGMENTS;
  let angleStep = angleCapFromMinCircle;
  if (r > 1e-9) {
    const cosHalf = 1 - CHORD_ERROR_MM / r;
    const clamped = Math.max(-1, Math.min(1, cosHalf));
    const chordAngle = 2 * Math.acos(clamped);
    angleStep = Math.min(angleCapFromMinCircle, chordAngle);
  }
  return Math.max(1, Math.ceil(Math.abs(sweepAngle) / angleStep));
}

/** Tessellate a full circle into >=16 points (chord-error bound applied). */
function tessellateCircle(center: Point, radius: number): Point[] {
  const n = stepsForChordError(radius, 2 * Math.PI);
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return pts;
}

/**
 * Points on an arc from `angleFrom`, sweeping *clockwise* (decreasing angle)
 * by `sweep` radians (sweep >= 0). Returns n+1 points including both ends.
 */
function capArc(center: Point, r: number, angleFrom: number, sweep: number): Point[] {
  const n = stepsForChordError(r, sweep);
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = angleFrom - sweep * t;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

/** Tessellate an arc PathSeg into a polyline from start to end (inclusive). */
function tessellateArc(seg: Extract<PathSeg, { type: 'arc' }>): Point[] {
  const { start, end, center, cw } = seg;
  const r = dist(center, start);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const twoPi = 2 * Math.PI;
  let sweep: number;
  if (!cw) {
    sweep = (((a1 - a0) % twoPi) + twoPi) % twoPi;
  } else {
    sweep = (((a0 - a1) % twoPi) + twoPi) % twoPi;
  }
  if (sweep < 1e-12) sweep = twoPi; // coincident start/end => full circle
  const n = stepsForChordError(r, sweep);
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = !cw ? a0 + sweep * t : a0 - sweep * t;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

/** Tessellate any PathSeg into a polyline from start to end (inclusive). */
function tessellateSeg(seg: PathSeg): Point[] {
  if (seg.type === 'line') return [seg.start, seg.end];
  return tessellateArc(seg);
}

// ---------------------------------------------------------------------------
// Point/segment distance
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function pointToLineSegDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-18) return dist(p, a);
  const t = clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq);
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Closest distance between two line segments (Ericson, RTCD 5.1.9). */
function segToSegDistance(p1: Point, p2: Point, p3: Point, p4: Point): number {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const rx = p1.x - p3.x;
  const ry = p1.y - p3.y;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  const EPS = 1e-12;

  let s: number;
  let t: number;

  if (a <= EPS && e <= EPS) {
    return dist(p1, p3);
  }
  if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }

  const c1 = { x: p1.x + d1x * s, y: p1.y + d1y * s };
  const c2 = { x: p3.x + d2x * t, y: p3.y + d2y * t };
  return dist(c1, c2);
}

/** Distance from a point to a PathSeg (arcs approximated by tessellated polyline). */
export function pointSegDistance(p: Point, s: PathSeg): number {
  const pts = tessellateSeg(s);
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pointToLineSegDistance(p, pts[i], pts[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/** Distance between two PathSegs (arcs approximated by tessellated polyline). */
export function segSegDistance(a: PathSeg, b: PathSeg): number {
  const ptsA = tessellateSeg(a);
  const ptsB = tessellateSeg(b);
  let min = Infinity;
  for (let i = 0; i < ptsA.length - 1; i++) {
    for (let j = 0; j < ptsB.length - 1; j++) {
      const d = segToSegDistance(ptsA[i], ptsA[i + 1], ptsB[j], ptsB[j + 1]);
      if (d < min) min = d;
    }
  }
  return min;
}

// ---------------------------------------------------------------------------
// Component / pad transforms
// ---------------------------------------------------------------------------

/**
 * Apply the component's placement transform to a list of local points:
 * mirror x (if side==='bottom'), then rotate by c.rotation, then translate
 * by c.at. This is the single source of truth for the bottom-side mirror
 * convention; padWorld and padOutline both route through it.
 */
export function componentTransformPoints(c: ComponentInst, pts: Point[]): Point[] {
  const mirror = c.side === 'bottom';
  return pts.map((pt) => {
    const mirrored = mirror ? { x: -pt.x, y: pt.y } : pt;
    const rotated = rotate(mirrored, c.rotation);
    return add(rotated, c.at);
  });
}

/** World-space rotation (deg CCW) of a footprint-local angle, honoring the mirror rule. */
export function componentTransformRotation(c: ComponentInst, localRotationDeg: number): number {
  const mirror = c.side === 'bottom';
  return (mirror ? -localRotationDeg : localRotationDeg) + c.rotation;
}

/** World-space position + rotation of a pad (component transform ∘ pad transform). */
export function padWorld(c: ComponentInst, pad: Pad): { at: Point; rotation: number } {
  const [at] = componentTransformPoints(c, [pad.at]);
  const mirror = c.side === 'bottom';
  const rotation = (mirror ? -pad.rotation : pad.rotation) + c.rotation;
  return { at, rotation };
}

/** Stadium/oval shape (capsule) centered at the origin, unrotated. */
function ovalShapeAtOrigin(w: number, h: number): Point[] {
  const hw = Math.min(w, h) / 2;
  const long = Math.max(w, h) - Math.min(w, h);
  if (long < 1e-9) return tessellateCircle({ x: 0, y: 0 }, hw);
  const centerline =
    w >= h
      ? [{ x: -long / 2, y: 0 }, { x: long / 2, y: 0 }]
      : [{ x: 0, y: -long / 2 }, { x: 0, y: long / 2 }];
  return strokeCapsule(centerline, hw);
}

/** Pad shape polygon centered at the origin, unrotated (before pad.rotation / pad.at / component transform). */
function padShapeAtOrigin(pad: Pad): Point[] {
  switch (pad.shape) {
    case 'rect':
      return [
        { x: -pad.size.w / 2, y: -pad.size.h / 2 },
        { x: pad.size.w / 2, y: -pad.size.h / 2 },
        { x: pad.size.w / 2, y: pad.size.h / 2 },
        { x: -pad.size.w / 2, y: pad.size.h / 2 },
      ];
    case 'circle':
      return tessellateCircle({ x: 0, y: 0 }, pad.size.w / 2);
    case 'oval':
      return ovalShapeAtOrigin(pad.size.w, pad.size.h);
    case 'polygon':
      if (!pad.polygon) {
        throw new Error(`Pad ${pad.number}: shape 'polygon' requires a polygon array`);
      }
      return pad.polygon;
  }
}

/** Pad outline in footprint-local coordinates (pad.rotation + pad.at applied, no component transform, no mirror). */
function padLocalOutline(pad: Pad): Point[] {
  const shape = padShapeAtOrigin(pad);
  return shape.map((pt) => add(rotate(pt, pad.rotation), pad.at));
}

/** World-space pad outline polygon (rect/oval/circle/polygon tessellated). */
export function padOutline(c: ComponentInst, pad: Pad): Point[] {
  return componentTransformPoints(c, padLocalOutline(pad));
}

// ---------------------------------------------------------------------------
// Outlines / bounding boxes
// ---------------------------------------------------------------------------

/** Convert an ordered, closed loop of PathSegs into a polygon (arcs tessellated). */
export function outlineToPolygon(outline: PathSeg[]): Point[] {
  const n = outline.length;
  if (n === 0) throw new Error('outlineToPolygon: outline is empty');
  const TOL = 0.01;
  for (let i = 0; i < n; i++) {
    const seg = outline[i];
    const next = outline[(i + 1) % n];
    if (dist(seg.end, next.start) > TOL) {
      throw new Error(
        `outlineToPolygon: gap between segment ${i} end (${seg.end.x}, ${seg.end.y}) and segment ${
          (i + 1) % n
        } start (${next.start.x}, ${next.start.y}) exceeds ${TOL}mm`,
      );
    }
  }
  const pts: Point[] = [];
  for (const seg of outline) {
    const tess = tessellateSeg(seg);
    pts.push(...tess.slice(0, -1));
  }
  return pts;
}

/** Axis-aligned bounding box of a set of points. */
export function bboxOf(pts: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (pts.length === 0) throw new Error('bboxOf: point list is empty');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Board bounding box: outline if present, else the bbox of all board content. */
export function boardBBox(b: Board): { minX: number; minY: number; maxX: number; maxY: number } {
  if (b.outline.length > 0) {
    return bboxOf(outlineToPolygon(b.outline));
  }

  const pts: Point[] = [];
  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      pts.push(...padOutline(c, pad));
    }
  }
  for (const t of b.tracks) {
    pts.push(...expandTrack(t));
  }
  for (const v of b.vias) {
    pts.push({ x: v.at.x - v.diameter / 2, y: v.at.y - v.diameter / 2 });
    pts.push({ x: v.at.x + v.diameter / 2, y: v.at.y + v.diameter / 2 });
  }
  for (const z of b.zones) {
    pts.push(...z.polygon);
  }
  for (const k of b.keepouts) {
    pts.push(...k.polygon);
  }
  for (const h of b.holes) {
    pts.push({ x: h.at.x - h.padDiameter / 2, y: h.at.y - h.padDiameter / 2 });
    pts.push({ x: h.at.x + h.padDiameter / 2, y: h.at.y + h.padDiameter / 2 });
  }
  for (const s of b.silk) {
    pts.push(s.at);
  }

  if (pts.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return bboxOf(pts);
}

// ---------------------------------------------------------------------------
// Polygon boolean / containment
// ---------------------------------------------------------------------------

function toRing(pts: Point[]): [number, number][] {
  return pts.map((p): [number, number] => [p.x, p.y]);
}

function ringArea(ring: [number, number][]): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Do polygons a and b overlap with positive intersection area? */
export function polyIntersects(a: Point[], b: Point[]): boolean {
  const result = polygonClipping.intersection([toRing(a)], [toRing(b)]);
  let area = 0;
  for (const polygon of result) {
    for (let i = 0; i < polygon.length; i++) {
      const ringA = ringArea(polygon[i]);
      area += i === 0 ? ringA : -ringA;
    }
  }
  return area > 1e-9;
}

/** Min edge-to-edge distance between two closed polygon boundaries (ignores containment/overlap). */
function edgeToEdgeDistance(a: Point[], b: Point[]): number {
  let min = Infinity;
  const na = a.length;
  const nb = b.length;
  for (let i = 0; i < na; i++) {
    const segA: PathSeg = { type: 'line', start: a[i], end: a[(i + 1) % na] };
    for (let j = 0; j < nb; j++) {
      const segB: PathSeg = { type: 'line', start: b[j], end: b[(j + 1) % nb] };
      const d = segSegDistance(segA, segB);
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * Minimum distance between the boundaries of two closed polygons.
 * Returns 0 when they overlap (positive intersection area, per
 * `polyIntersects`) or merely touch; otherwise the true edge-to-edge gap,
 * computed via all edge-pair segment distances (segSegDistance on synthetic
 * line PathSegs, so it shares the tested closest-point math).
 */
export function polyPolyDistance(a: Point[], b: Point[]): number {
  if (a.length === 0 || b.length === 0) {
    throw new Error('polyPolyDistance: polygon must have at least one point');
  }
  if (polyIntersects(a, b)) return 0;
  return edgeToEdgeDistance(a, b);
}

/**
 * A polygon-with-holes: a solid `outer` ring minus each of `holes`. Used to
 * represent a filled copper zone whose winding-encoded fill has been decoded
 * (see zonefill.ts) so that hole rings (knockouts around other-net copper) are
 * treated as absence-of-copper, not as solid islands.
 */
export interface PolyGroup {
  outer: Point[];
  holes: Point[][];
}

/** Does simple polygon `item` overlap the solid region (outer minus holes) of `group` with positive area? */
export function polyGroupIntersects(item: Point[], group: PolyGroup): boolean {
  const clip: [number, number][][] = [toRing(group.outer), ...group.holes.map(toRing)];
  const result = polygonClipping.intersection([toRing(item)], clip);
  let area = 0;
  for (const polygon of result) {
    for (let i = 0; i < polygon.length; i++) {
      const a = ringArea(polygon[i]);
      area += i === 0 ? a : -a;
    }
  }
  return area > 1e-9;
}

/**
 * Distance from a simple polygon `item` to a polygon-with-holes `group`.
 * Returns 0 when `item` overlaps the solid region (outer minus holes);
 * otherwise the minimum boundary distance to ANY ring — outer or hole — so an
 * item sitting inside a hole reports its distance to that hole's boundary
 * (real copper edge), NOT 0. An item outside the outer reports its distance to
 * the outer.
 */
export function polyGroupDistance(item: Point[], group: PolyGroup): number {
  if (item.length === 0 || group.outer.length === 0) {
    throw new Error('polyGroupDistance: polygon must have at least one point');
  }
  if (polyGroupIntersects(item, group)) return 0;
  let min = edgeToEdgeDistance(item, group.outer);
  for (const hole of group.holes) {
    const d = edgeToEdgeDistance(item, hole);
    if (d < min) min = d;
  }
  return min;
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Track stroking
// ---------------------------------------------------------------------------

function segNormal(p0: Point, p1: Point): Point {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1e-12;
  return { x: -dy / len, y: dx / len };
}

/** Stroke a centerline polyline into a capsule-ish polygon (rounded ends, mitered interior joins). */
function strokeCapsule(pts: Point[], hw: number): Point[] {
  const n = pts.length;
  if (n < 2) throw new Error('strokeCapsule: centerline needs at least 2 points');

  const segNormals: Point[] = [];
  for (let i = 0; i < n - 1; i++) segNormals.push(segNormal(pts[i], pts[i + 1]));

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < n; i++) {
    let nrm: Point;
    if (i === 0) {
      nrm = segNormals[0];
    } else if (i === n - 1) {
      nrm = segNormals[n - 2];
    } else {
      const na = segNormals[i - 1];
      const nb = segNormals[i];
      let mx = na.x + nb.x;
      let my = na.y + nb.y;
      const mlen = Math.hypot(mx, my);
      if (mlen < 1e-9) {
        nrm = na;
      } else {
        mx /= mlen;
        my /= mlen;
        const d = mx * na.x + my * na.y;
        const scale = d > 1e-6 ? 1 / d : 1;
        nrm = { x: mx * scale, y: my * scale };
      }
    }
    left.push({ x: pts[i].x + nrm.x * hw, y: pts[i].y + nrm.y * hw });
    right.push({ x: pts[i].x - nrm.x * hw, y: pts[i].y - nrm.y * hw });
  }

  const lastDir = Math.atan2(pts[n - 1].y - pts[n - 2].y, pts[n - 1].x - pts[n - 2].x);
  const firstDir = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
  const endCap = capArc(pts[n - 1], hw, lastDir + Math.PI / 2, Math.PI);
  const startCap = capArc(pts[0], hw, firstDir - Math.PI / 2, Math.PI);

  const polygon: Point[] = [];
  polygon.push(...left);
  polygon.push(...endCap.slice(1)); // drop dup of left[n-1]; ends at right[n-1]
  for (let i = n - 2; i >= 0; i--) polygon.push(right[i]);
  polygon.push(...startCap.slice(1, -1)); // drop dup of right[0] and left[0]

  return polygon.reverse(); // CW-derived winding -> CCW
}

/** Stroke a track's segment (with width) into a capsule polygon (arcs tessellated first). */
export function expandTrack(t: Track): Point[] {
  const centerline = tessellateSeg(t.seg);
  return strokeCapsule(centerline, t.width / 2);
}
