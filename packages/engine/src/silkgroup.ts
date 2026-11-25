/**
 * Flamingo Engine - silk groups (editable silkscreen graphics).
 *
 * A SilkGroup stores its artwork in a local frame and is placed by a single
 * transform (see types.ts). Everything that draws, checks, or exports silk
 * reads groups through this module so the transform is defined once:
 *
 *  - `silkGroupWorld` / `allSilkLines` / `allSilkTexts` / `allSilkFills`
 *    flatten groups into world-space primitives next to the loose
 *    `board.silk` / `board.silkLines` items.
 *  - `fillShapes` turns an even-odd ring set into outer-with-holes shapes in
 *    nesting order, the form Gerber regions, STEP prisms and three.js shapes
 *    all need.
 *  - The gesture helpers (`moveSilkGroup`, `scaleSilkGroupFromCorner`,
 *    `rotateSilkGroup`) are pure, so the 2D canvas and the 3D viewer drive
 *    exactly the same edits.
 */

import type { Board, Point, SilkGroup, SilkGroupLine, SilkGroupText, SilkLine, SilkText } from './types.js';
import { pointInPolygon } from './geometry.js';

/** Text box width per character, as a fraction of height (stroke-font advance). */
export const SILK_TEXT_ADVANCE = 0.9;

type Layer = 'F.Silk' | 'B.Silk';

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Local -> world point under the group's transform. */
export function silkGroupToWorld(g: Pick<SilkGroup, 'at' | 'rotation' | 'scale' | 'mirror'>, p: Point): Point {
  const x = (g.mirror ? -p.x : p.x) * g.scale;
  const y = p.y * g.scale;
  const c = Math.cos(rad(g.rotation));
  const s = Math.sin(rad(g.rotation));
  return { x: g.at.x + x * c - y * s, y: g.at.y + x * s + y * c };
}

/** World -> local point (inverse of silkGroupToWorld). */
export function silkGroupToLocal(g: Pick<SilkGroup, 'at' | 'rotation' | 'scale' | 'mirror'>, p: Point): Point {
  const dx = p.x - g.at.x;
  const dy = p.y - g.at.y;
  const c = Math.cos(rad(g.rotation));
  const s = Math.sin(rad(g.rotation));
  const x = (dx * c + dy * s) / g.scale;
  const y = (-dx * s + dy * c) / g.scale;
  return { x: g.mirror ? -x : x, y };
}

/** World rotation (deg CCW) of an item with local rotation `deg`. */
export function silkGroupRotation(g: Pick<SilkGroup, 'rotation' | 'mirror'>, deg: number): number {
  return g.rotation + (g.mirror ? -deg : deg);
}

/** World-space primitives of one group. Ids are `<groupId>#l<i>` / `#t<i>` / `#f<i>`. */
export function silkGroupWorld(g: SilkGroup): {
  lines: SilkLine[];
  texts: SilkText[];
  fills: { id: string; layer: Layer; rings: Point[][] }[];
} {
  return {
    lines: g.lines.map((l, i) => ({
      id: `${g.id}#l${i}`,
      layer: g.layer,
      start: silkGroupToWorld(g, l.start),
      end: silkGroupToWorld(g, l.end),
      width: l.width * g.scale,
    })),
    texts: g.texts.map((t, i) => ({
      id: `${g.id}#t${i}`,
      layer: g.layer,
      at: silkGroupToWorld(g, t.at),
      text: t.text,
      height: t.height * g.scale,
      rotation: silkGroupRotation(g, t.rotation),
    })),
    fills: g.fills.map((rings, i) => ({
      id: `${g.id}#f${i}`,
      layer: g.layer,
      rings: rings.map((r) => r.map((p) => silkGroupToWorld(g, p))),
    })),
  };
}

/** Loose silk lines plus every group's lines, world space. */
export function allSilkLines(b: Board): SilkLine[] {
  const out = [...(b.silkLines ?? [])];
  for (const g of b.silkGroups ?? []) out.push(...silkGroupWorld(g).lines);
  return out;
}

/** Loose silk texts plus every group's texts, world space. */
export function allSilkTexts(b: Board): SilkText[] {
  const out = [...(b.silk ?? [])];
  for (const g of b.silkGroups ?? []) out.push(...silkGroupWorld(g).texts);
  return out;
}

/** Every group's filled shapes, world space (loose fills don't exist). */
export function allSilkFills(b: Board): { id: string; layer: Layer; rings: Point[][] }[] {
  const out: { id: string; layer: Layer; rings: Point[][] }[] = [];
  for (const g of b.silkGroups ?? []) out.push(...silkGroupWorld(g).fills);
  return out;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Corners (CCW from min,min) of a text's box, centred on `at`. */
export function silkTextCorners(at: Point, height: number, rotationDeg: number, text: string): Point[] {
  const hw = (Math.max(1, text.length) * SILK_TEXT_ADVANCE * height) / 2;
  const hh = height / 2;
  const c = Math.cos(rad(rotationDeg));
  const s = Math.sin(rad(rotationDeg));
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => ({ x: at.x + x * c - y * s, y: at.y + x * s + y * c }));
}

/** Local-frame bounding box of everything in the group (line widths included). */
export function silkGroupLocalBounds(g: Pick<SilkGroup, 'fills' | 'lines' | 'texts'>): Box {
  const b: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (p: Point, r = 0): void => {
    b.minX = Math.min(b.minX, p.x - r);
    b.minY = Math.min(b.minY, p.y - r);
    b.maxX = Math.max(b.maxX, p.x + r);
    b.maxY = Math.max(b.maxY, p.y + r);
  };
  for (const shape of g.fills) for (const ring of shape) for (const p of ring) grow(p);
  for (const l of g.lines) {
    grow(l.start, l.width / 2);
    grow(l.end, l.width / 2);
  }
  for (const t of g.texts) for (const p of silkTextCorners(t.at, t.height, t.rotation, t.text)) grow(p);
  if (!Number.isFinite(b.minX)) return { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 };
  return b;
}

/** World corners of the group's local bounding box (in local CCW order: min-min, max-min, max-max, min-max). */
export function silkGroupCorners(g: SilkGroup): Point[] {
  const b = silkGroupLocalBounds(g);
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ].map((p) => silkGroupToWorld(g, p));
}

/** World size (mm) of the group's bounding box along its own axes. */
export function silkGroupSize(g: SilkGroup): { width: number; height: number } {
  const b = silkGroupLocalBounds(g);
  return { width: (b.maxX - b.minX) * g.scale, height: (b.maxY - b.minY) * g.scale };
}

/** World centre of the group's bounding box. */
export function silkGroupCenter(g: SilkGroup): Point {
  const b = silkGroupLocalBounds(g);
  return silkGroupToWorld(g, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
}

/** True when `p` (world) lies inside the group's (rotated) bounding box, grown by `tol` mm. */
export function silkGroupContains(g: SilkGroup, p: Point, tol = 0): boolean {
  const local = silkGroupToLocal(g, p);
  const b = silkGroupLocalBounds(g);
  const t = tol / g.scale;
  return local.x >= b.minX - t && local.x <= b.maxX + t && local.y >= b.minY - t && local.y <= b.maxY + t;
}

// ---------------------------------------------------------------------------
// Even-odd fills -> outer-with-holes shapes
// ---------------------------------------------------------------------------

function ringArea(r: Point[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q = r[(i + 1) % r.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** A ring's representative interior-ish point for containment tests: a vertex
 * nudged off the edge would be more robust, but rings in one even-odd set
 * never touch, so any vertex works. */
function probe(r: Point[]): Point {
  return r[0]!;
}

export interface FillShape {
  /** CCW outer ring. */
  outer: Point[];
  /** CW hole rings directly inside `outer`. */
  holes: Point[][];
  /** Nesting depth of `outer` (0 = outermost; islands inside holes are 2, 4, …). */
  depth: number;
}

/**
 * Interpret a ring set with the even-odd rule: a ring at even nesting depth
 * is solid, one at odd depth is a hole in the nearest enclosing solid ring.
 * Returns shapes ordered by depth (outermost first), outers CCW and holes CW.
 * Degenerate rings (< 3 points or ~zero area) are dropped.
 */
export function fillShapes(rings: Point[][]): FillShape[] {
  const rs = rings.filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > 1e-9);
  const area = rs.map((r) => Math.abs(ringArea(r)));
  const depth = rs.map((r, i) => {
    let d = 0;
    for (let j = 0; j < rs.length; j++) {
      if (j !== i && area[j]! > area[i]! && pointInPolygon(probe(r), rs[j]!)) d++;
    }
    return d;
  });
  const shapes: (FillShape & { idx: number })[] = [];
  for (let i = 0; i < rs.length; i++) {
    if (depth[i]! % 2 !== 0) continue;
    const r = rs[i]!;
    shapes.push({ idx: i, outer: ringArea(r) > 0 ? r : [...r].reverse(), holes: [], depth: depth[i]! });
  }
  for (let i = 0; i < rs.length; i++) {
    if (depth[i]! % 2 === 0) continue;
    // Parent: the smallest solid ring that contains this hole.
    let parent: (typeof shapes)[number] | undefined;
    for (const s of shapes) {
      if (s.depth !== depth[i]! - 1) continue;
      if (!pointInPolygon(probe(rs[i]!), rs[s.idx]!)) continue;
      if (!parent || area[s.idx]! < area[parent.idx]!) parent = s;
    }
    if (!parent) continue;
    const r = rs[i]!;
    parent.holes.push(ringArea(r) < 0 ? r : [...r].reverse());
  }
  shapes.sort((a, b) => a.depth - b.depth);
  return shapes.map(({ outer, holes, depth: d }) => ({ outer, holes, depth: d }));
}

// ---------------------------------------------------------------------------
// Gesture maths (shared by the 2D select tool and the 3D viewer)
// ---------------------------------------------------------------------------

type Transform = Pick<SilkGroup, 'at' | 'rotation' | 'scale' | 'mirror'>;

/** The group translated by `delta`. */
export function moveSilkGroup(g: SilkGroup, delta: Point): Transform {
  return { at: { x: g.at.x + delta.x, y: g.at.y + delta.y }, rotation: g.rotation, scale: g.scale, mirror: g.mirror };
}

/** Smallest scale a resize gesture may reach (keeps the transform invertible). */
export const MIN_SILK_GROUP_SCALE = 1e-3;

/**
 * Uniform resize from bounding-box corner `corner` (0..3, silkGroupCorners
 * order) dragged to world point `p`; the opposite corner stays put. Aspect
 * ratio is locked: the new scale is the projection of `p` onto the box
 * diagonal through the anchored corner.
 */
export function scaleSilkGroupFromCorner(g: SilkGroup, corner: number, p: Point): Transform {
  const corners = silkGroupCorners(g);
  const anchor = corners[(corner + 2) % 4]!;
  const grabbed = corners[corner % 4]!;
  const dx = grabbed.x - anchor.x;
  const dy = grabbed.y - anchor.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { at: g.at, rotation: g.rotation, scale: g.scale, mirror: g.mirror };
  const t = ((p.x - anchor.x) * dx + (p.y - anchor.y) * dy) / len2;
  const scale = Math.max(MIN_SILK_GROUP_SCALE, g.scale * t);
  return keepPointFixed(g, anchor, { rotation: g.rotation, scale, mirror: g.mirror });
}

/** Group with its rotation/scale/mirror replaced, translated so world point `fixed` doesn't move. */
function keepPointFixed(g: SilkGroup, fixed: Point, next: Omit<Transform, 'at'>): Transform {
  const local = silkGroupToLocal(g, fixed);
  const moved = silkGroupToWorld({ ...next, at: { x: 0, y: 0 } }, local);
  return { at: { x: fixed.x - moved.x, y: fixed.y - moved.y }, ...next };
}

/** Rotation about the bounding-box centre so the ray centre->`from` turns to centre->`to`. Snaps to `snapDeg` when given. */
export function rotateSilkGroup(g: SilkGroup, from: Point, to: Point, snapDeg?: number): Transform {
  const c = silkGroupCenter(g);
  const a0 = Math.atan2(from.y - c.y, from.x - c.x);
  const a1 = Math.atan2(to.y - c.y, to.x - c.x);
  let rotation = g.rotation + ((a1 - a0) * 180) / Math.PI;
  if (snapDeg && snapDeg > 0) rotation = Math.round(rotation / snapDeg) * snapDeg;
  rotation = ((rotation % 360) + 360) % 360;
  return keepPointFixed(g, c, { rotation, scale: g.scale, mirror: g.mirror });
}

/** Group with a new uniform scale, keeping its bounding-box centre fixed. */
export function rescaleSilkGroupAboutCenter(g: SilkGroup, scale: number): Transform {
  return keepPointFixed(g, silkGroupCenter(g), {
    rotation: g.rotation,
    scale: Math.max(MIN_SILK_GROUP_SCALE, scale),
    mirror: g.mirror,
  });
}

/** Group with an absolute rotation (deg CCW), turned about its bounding-box centre. */
export function setSilkGroupRotation(g: SilkGroup, rotation: number): Transform {
  const r = ((rotation % 360) + 360) % 360;
  return keepPointFixed(g, silkGroupCenter(g), { rotation: r, scale: g.scale, mirror: g.mirror });
}

/** Group translated so its bounding-box centre lands on `center`. */
export function centerSilkGroupAt(g: SilkGroup, center: Point): Transform {
  return moveSilkGroup(g, { x: center.x - silkGroupCenter(g).x, y: center.y - silkGroupCenter(g).y });
}

/** Group mirrored (or un-mirrored) about its bounding-box centre. */
export function setSilkGroupMirror(g: SilkGroup, mirror: boolean): Transform {
  return keepPointFixed(g, silkGroupCenter(g), { rotation: g.rotation, scale: g.scale, mirror });
}

/** Rotation handle position: `offset` mm beyond the middle of the box's local top edge. */
export function silkGroupRotateHandle(g: SilkGroup, offset: number): Point {
  const b = silkGroupLocalBounds(g);
  const top = silkGroupToWorld(g, { x: (b.minX + b.maxX) / 2, y: b.maxY });
  const c = silkGroupCenter(g);
  const dx = top.x - c.x;
  const dy = top.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: top.x + (dx / len) * offset, y: top.y + (dy / len) * offset };
}

// ---------------------------------------------------------------------------
// Grouping / ungrouping
// ---------------------------------------------------------------------------

/** Contents of a group expressed in world space, ready to re-group or explode. */
export interface WorldSilkContents {
  fills: Point[][][];
  lines: Omit<SilkLine, 'id' | 'layer'>[];
  texts: Omit<SilkText, 'id' | 'layer'>[];
}

/** Build group contents in a local frame whose origin is the contents' world bbox centre. */
export function localizeSilkContents(w: WorldSilkContents): { at: Point } & Pick<SilkGroup, 'fills' | 'lines' | 'texts'> {
  const proto = {
    fills: w.fills,
    lines: w.lines.map((l) => ({ start: l.start, end: l.end, width: l.width })),
    texts: w.texts.map((t) => ({ text: t.text, at: t.at, height: t.height, rotation: t.rotation })),
  };
  const b = silkGroupLocalBounds(proto);
  const at = { x: round((b.minX + b.maxX) / 2), y: round((b.minY + b.maxY) / 2) };
  const sub = (p: Point): Point => ({ x: round(p.x - at.x), y: round(p.y - at.y) });
  return {
    at,
    fills: proto.fills.map((s) => s.map((r) => r.map(sub))),
    lines: proto.lines.map((l): SilkGroupLine => ({ start: sub(l.start), end: sub(l.end), width: l.width })),
    texts: proto.texts.map((t): SilkGroupText => ({ ...t, at: sub(t.at) })),
  };
}

/** A group's contents in world space (transform baked in). */
export function silkGroupWorldContents(g: SilkGroup): WorldSilkContents {
  const w = silkGroupWorld(g);
  return {
    fills: w.fills.map((f) => f.rings),
    lines: w.lines.map(({ start, end, width }) => ({ start, end, width })),
    texts: w.texts.map(({ at, text, height, rotation }) => ({ at, text, height, rotation })),
  };
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
