/**
 * Flamingo Panel - panel geometry.
 *
 * `computeGeometry` turns a panel plus its resolved sources into everything
 * that has a shape: each instance in panel space, the frame and rails around
 * them, the tabs and mouse-bite holes between them (or the V-cut score lines
 * along their shared edges), fiducials, tooling holes, and the profile that
 * gets routed. The canvas, the checks, the SVG render and
 * the fab merge all read this one structure.
 *
 * The frame is derived, never stored: it wraps the instances wherever they
 * are, leaving each side's required clearance plus the rail. Moving a board
 * outward grows the panel.
 */

import polygonClipping from 'polygon-clipping';
import type { Point } from '@flamingo/engine';
import { polyIntersects } from '@flamingo/engine';
import { ccw, dot, edgesOf, sideFacing, sideNormals, straightRuns, type Edge } from './poly.js';
import type { ResolvedSources } from './resolved.js';
import type { EdgeInfo } from './source.js';
import {
  applyTransformAll,
  boxCorners,
  boxOf,
  instanceTransform,
  rotateSide,
  type Transform,
} from './transform.js';
import type { Box, Panel, PanelSettings, Side } from './types.js';
import { SIDES } from './types.js';

const EPS = 0.01;
/** Tabs keep this far from the end of the straight stretch they sit on. */
const TAB_CORNER_MARGIN = 1;
/** Two tabs on one edge are at least this far apart. */
const TAB_MIN_GAP = 2;
/** Tabs and rails overlap what they join by this much so the union is one piece. */
const WELD = 0.01;
/** Most mouse-bite holes in one row of a tab; the defaults give five. */
const MAX_TAB_HOLES = 200;

export interface PlacedOverhang {
  refdes: string;
  side: Side;
  depth: number;
  polygon: Point[];
}

export interface PlacedInstance {
  id: string;
  source: string;
  populate: boolean;
  pinned: boolean;
  transform: Transform;
  /** Bounding box of the outline, panel mm. */
  bbox: Box;
  /** Outline polygon, panel mm. */
  outline: Point[];
  /** Edge state keyed by the panel side each edge now faces. */
  edges: Record<Side, EdgeInfo>;
  /** Clearance each side needs from whatever faces it: the spacing, or more on a blocked edge. */
  margins: Record<Side, number>;
  /**
   * Outward unit normal of each board side in panel space. `edges` and
   * `margins` are keyed by the nearest panel side; this says where each side
   * really points once the board is turned by an angle off the axes.
   */
  sideNormals: Record<Side, Point>;
  overhangs: PlacedOverhang[];
  /** Board-edge keepouts, panel mm. */
  keepouts: Point[][];
}

export interface UnplacedInstance {
  id: string;
  source: string;
  reason: string;
}

export type RailSide = 'top' | 'bottom' | 'left' | 'right';

export interface Rail {
  side: RailSide;
  box: Box;
}

export interface Frame {
  /** Inner edge of the rails (or the content itself on a side without a rail). */
  inner: Box;
  /** The panel outline. */
  outer: Box;
  width: number;
  height: number;
}

export interface Tab {
  /** Instance id, or `rail:<side>`, at each end. `a` is always an instance. */
  a: string;
  b: string;
  /**
   * Side of instance `a` the tab leaves from, as a key of its `edges` (the
   * panel side that board side faces most nearly).
   */
  side: Side;
  /** Tab centre along the edge, and the gap it bridges. */
  center: Point;
  length: number;
  polygon: Point[];
  /** Mouse-bite hole centres (empty for solid tabs). */
  holes: Point[];
  /** Unit vector across the gap, from `a` toward `b`. */
  normal: Point;
  /** Unit vector along the edge the tab sits on. */
  along: Point;
}

export interface Fiducial {
  at: Point;
  side: 'top' | 'bottom';
  copperDiameter: number;
  maskDiameter: number;
}

export interface ToolingHole {
  at: Point;
  diameter: number;
}

/**
 * One V-cut score line. JLCPCB scores straight through the whole panel, so a
 * line always runs from one edge of the frame to the other.
 */
export interface ScoreLine {
  /** `h` runs along x at y = level; `v` runs along y at x = level. */
  axis: 'h' | 'v';
  level: number;
  start: Point;
  end: Point;
  /** Instances with an edge on this line. */
  instances: string[];
}

export interface PanelGeometry {
  instances: PlacedInstance[];
  unplaced: UnplacedInstance[];
  /** null when nothing could be placed. */
  frame: Frame | null;
  rails: Rail[];
  tabs: Tab[];
  fiducials: Fiducial[];
  toolingHoles: ToolingHole[];
  /** Why fiducials or tooling holes that were asked for could not be placed. */
  featureNotes: string[];
  /**
   * Closed contours of the panel's material: what the router cuts along. One
   * outer ring per solid piece, plus a ring for every routed opening.
   */
  profile: Point[][];
  /** Silkscreen divider lines (silk-divider panels only), as polylines. */
  dividers: Point[][];
  /** V-cut score lines (v-cut panels only). */
  scores: ScoreLine[];
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/** Spacing that applies between boards: none on a silk-divider or V-cut panel, where boards abut. */
export function effectiveSpacing(settings: PanelSettings): number {
  return settings.separation === 'silk-divider' || settings.separation === 'v-cut' ? 0 : settings.spacing;
}

/** Whether boards are held by tabs across a routed gap. */
export function usesTabs(settings: PanelSettings): boolean {
  return settings.separation === 'mouse-bite' || settings.separation === 'solid-tab';
}

export function placeInstances(
  panel: Panel,
  sources: ResolvedSources,
): { instances: PlacedInstance[]; unplaced: UnplacedInstance[] } {
  const spacing = effectiveSpacing(panel.settings);
  const instances: PlacedInstance[] = [];
  const unplaced: UnplacedInstance[] = [];

  for (const inst of panel.instances) {
    const src = sources.find((s) => s.key === inst.source);
    if (!src || !src.geometry) {
      unplaced.push({
        id: inst.id,
        source: inst.source,
        reason: src?.error ?? `source "${inst.source}" is not resolved`,
      });
      continue;
    }
    const g = src.geometry;
    const transform = instanceTransform(g.outline, inst.at, inst.rotation);
    const outline = applyTransformAll(transform, g.outline);

    const edges = {} as Record<Side, EdgeInfo>;
    const margins = {} as Record<Side, number>;
    for (const boardSide of SIDES) {
      const panelSide = rotateSide(boardSide, inst.rotation);
      const e = g.edges[boardSide];
      edges[panelSide] = e;
      margins[panelSide] = Math.max(spacing, e.clearance);
    }

    instances.push({
      id: inst.id,
      source: inst.source,
      populate: inst.populate,
      pinned: inst.pinned,
      transform,
      bbox: boxOf(outline),
      outline,
      edges,
      margins,
      sideNormals: sideNormals(inst.rotation),
      overhangs: g.overhangs.map((o) => ({
        refdes: o.refdes,
        side: rotateSide(o.side, inst.rotation),
        depth: o.depth,
        polygon: applyTransformAll(transform, o.polygon),
      })),
      keepouts: g.edgeKeepouts.map((k) => applyTransformAll(transform, k.polygon)),
    });
  }
  return { instances, unplaced };
}

// ---------------------------------------------------------------------------
// Frame and rails
// ---------------------------------------------------------------------------

/**
 * The frame that wraps `instances`. A side with a rail stands off from the
 * boards by each board's margin on that side; a side without one runs along
 * the outermost board edge.
 */
export function computeFrame(settings: PanelSettings, instances: PlacedInstance[]): Frame | null {
  if (instances.length === 0) return null;
  const { rails } = settings;
  const ext = (side: Side, hasRail: boolean): number => {
    let v = side === 'N' || side === 'E' ? -Infinity : Infinity;
    for (const i of instances) {
      const m = hasRail ? i.margins[side] : 0;
      if (side === 'N') v = Math.max(v, i.bbox.maxY + m);
      else if (side === 'E') v = Math.max(v, i.bbox.maxX + m);
      else if (side === 'S') v = Math.min(v, i.bbox.minY - m);
      else v = Math.min(v, i.bbox.minX - m);
    }
    return v;
  };
  const inner: Box = {
    minX: ext('W', rails.left > 0),
    maxX: ext('E', rails.right > 0),
    minY: ext('S', rails.bottom > 0),
    maxY: ext('N', rails.top > 0),
  };
  const outer: Box = {
    minX: inner.minX - rails.left,
    maxX: inner.maxX + rails.right,
    minY: inner.minY - rails.bottom,
    maxY: inner.maxY + rails.top,
  };
  return { inner, outer, width: outer.maxX - outer.minX, height: outer.maxY - outer.minY };
}

function computeRails(settings: PanelSettings, frame: Frame): Rail[] {
  const { rails } = settings;
  const { inner, outer } = frame;
  const out: Rail[] = [];
  // Top and bottom rails run the full width; side rails fit between them.
  if (rails.bottom > 0) out.push({ side: 'bottom', box: { minX: outer.minX, maxX: outer.maxX, minY: outer.minY, maxY: inner.minY } });
  if (rails.top > 0) out.push({ side: 'top', box: { minX: outer.minX, maxX: outer.maxX, minY: inner.maxY, maxY: outer.maxY } });
  if (rails.left > 0) out.push({ side: 'left', box: { minX: outer.minX, maxX: inner.minX, minY: inner.minY, maxY: inner.maxY } });
  if (rails.right > 0) out.push({ side: 'right', box: { minX: inner.maxX, maxX: outer.maxX, minY: inner.minY, maxY: inner.maxY } });
  return out;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type Interval = [number, number];

/** Stretches of `outline` that run along `side` of its bounding box, as intervals on the other axis. */
export function edgeSpans(outline: Point[], bbox: Box, side: Side): Interval[] {
  const horizontal = side === 'N' || side === 'S';
  const level = side === 'N' ? bbox.maxY : side === 'S' ? bbox.minY : side === 'E' ? bbox.maxX : bbox.minX;
  const spans: Interval[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const [a0, b0] = horizontal ? [a.y, b.y] : [a.x, b.x];
    if (Math.abs(a0 - level) > EPS || Math.abs(b0 - level) > EPS) continue;
    const [a1, b1] = horizontal ? [a.x, b.x] : [a.y, b.y];
    if (Math.abs(a1 - b1) < EPS) continue;
    spans.push([Math.min(a1, b1), Math.max(a1, b1)]);
  }
  return mergeIntervals(spans);
}

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((p, q) => p[0] - q[0]);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + EPS) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  let cur = a;
  for (const q of b) {
    const next: Interval[] = [];
    for (const p of cur) {
      if (q[1] <= p[0] + EPS || q[0] >= p[1] - EPS) {
        next.push(p);
        continue;
      }
      if (q[0] - p[0] > EPS) next.push([p[0], q[0]]);
      if (p[1] - q[1] > EPS) next.push([q[1], p[1]]);
    }
    cur = next;
  }
  return cur;
}

/** Where tabs go along a free stretch of length `hi - lo`. */
export function tabCentres(lo: number, hi: number, width: number, pitch: number): number[] {
  const len = hi - lo;
  if (len < width - EPS) return [];
  const usable = len - 2 * TAB_CORNER_MARGIN;
  if (usable < width) return [(lo + hi) / 2];
  // Capped at what fits, so a tiny pitch cannot make the loop below run for ever.
  let n = Math.min(Math.max(1, Math.ceil(len / pitch)), Math.max(1, Math.floor(usable / width)) + 1);
  // One tab in the middle of an edge lets the board rock: give it two as soon
  // as two fit, clear of the corners and with a gap between them.
  if (n === 1 && len >= 2 * width + 2 * TAB_CORNER_MARGIN + TAB_MIN_GAP - EPS) n = 2;
  while (n > 1 && usable / n < width) n--;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(lo + (len * (i + 0.5)) / n);
  return out;
}

const RAIL_ID = (r: Rail): string => `rail:${r.side}`;

/** Normals within this many degrees of opposite count as facing edges a tab can join. */
const TAB_ANGLE_TOL = 2;
const FACING_COS = Math.cos((TAB_ANGLE_TOL * Math.PI) / 180);

/**
 * The key of `inst.edges` / `inst.margins` for the board side that faces
 * `dir`: the side whose outward normal points most nearly along it, named by
 * the panel side it is nearest.
 */
export function sideToward(inst: PlacedInstance, dir: Point): Side {
  return rotateSide(sideFacing(dir, inst.sideNormals), inst.transform.rotation);
}

/** Something a tab can join or must not cross: a board, or a rail. */
interface Solid {
  id: string;
  poly: Point[];
  box: Box;
  inst?: PlacedInstance;
  /** Straight runs of the outline, outward normals. */
  runs: Edge[];
}

/** `d` or its reverse, whichever points right (or up, when vertical). */
function canonicalDir(d: Point): Point {
  return d.x > 1e-9 || (Math.abs(d.x) <= 1e-9 && d.y > 0) ? d : { x: -d.x, y: -d.y };
}

/** Each pair of boards is tabbed once, from the board whose edge faces up (or right). */
function facesUpOrRight(n: Point): boolean {
  return n.y > 1e-9 || (Math.abs(n.y) <= 1e-9 && n.x > 0);
}

function boxGap(a: Box, b: Box): number {
  return Math.max(b.minX - a.maxX, a.minX - b.maxX, b.minY - a.maxY, a.minY - b.maxY);
}

/**
 * The stretch, along `t`, of `poly` that lies strictly between level `vMin`
 * and `vMax` measured along `n` (offset by `level`): what of it stands in the
 * gap a tab would cross. Its hull, so a solid that dips in twice hides the
 * whole stretch between.
 */
function shadowOf(poly: Point[], t: Point, n: Point, level: number, vMin: number, vMax: number): Interval | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i]!;
    const p1 = poly[(i + 1) % poly.length]!;
    const v0 = dot(p0, n) - level;
    const v1 = dot(p1, n) - level;
    const u0 = dot(p0, t);
    const u1 = dot(p1, t);
    let s0 = 0;
    let s1 = 1;
    if (Math.abs(v1 - v0) < 1e-12) {
      if (v0 <= vMin || v0 >= vMax) continue;
    } else {
      const sa = (vMin - v0) / (v1 - v0);
      const sb = (vMax - v0) / (v1 - v0);
      s0 = Math.max(0, Math.min(sa, sb));
      s1 = Math.min(1, Math.max(sa, sb));
      if (s0 > s1) continue;
    }
    for (const s of [s0, s1]) {
      const u = u0 + (u1 - u0) * s;
      if (u < lo) lo = u;
      if (u > hi) hi = u;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * Tabs from edge `e` of board `a` across the gap to edge `f` of `b`, which
 * faces it. Works in the frame of `e`: `u` along the edge, `v` outward from it.
 */
function tabsAcross(
  settings: PanelSettings,
  a: PlacedInstance,
  e: Edge,
  b: Solid,
  f: Edge,
  solids: Solid[],
): Tab[] {
  const ts = settings.tabs;
  const n = e.normal;
  const t = canonicalDir(e.dir);
  const level = dot(e.start, n);
  const ue = [dot(e.start, t), dot(e.end, t)];
  const uf = [dot(f.start, t), dot(f.end, t)] as const;
  const vf = [dot(f.start, n) - level, dot(f.end, n) - level] as const;
  const lo = Math.max(Math.min(...ue), Math.min(...uf));
  const hi = Math.min(Math.max(...ue), Math.max(...uf));
  if (hi - lo < ts.width - EPS) return [];

  // Exactly parallel edges give one gap; a slight tilt is followed along the edge.
  const gapAt = (u: number): number =>
    Math.abs(uf[1] - uf[0]) < 1e-12 ? (vf[0] + vf[1]) / 2 : vf[0] + ((u - uf[0]) * (vf[1] - vf[0])) / (uf[1] - uf[0]);
  const gMin = Math.min(gapAt(lo), gapAt(hi));
  const gMax = Math.max(gapAt(lo), gapAt(hi));
  if (gMin < EPS) return []; // touching (or behind): nothing to bridge
  if (gMax > ts.maxLength + EPS) return [];

  // `blocked` promises no tabs on that side, at either end.
  const side = sideToward(a, n);
  if (a.edges[side].blocked) return [];
  if (b.inst) {
    const back = { x: -n.x, y: -n.y };
    if (b.inst.edges[sideToward(b.inst, f.normal)].blocked || b.inst.edges[sideToward(b.inst, back)].blocked) return [];
  }

  // Whatever stands in the gap (another board, a rail, or a notch of either
  // end's own outline) hides the stretch of edge behind it.
  const shadows: Interval[] = [];
  for (const s of solids) {
    const sh = shadowOf(s.poly, t, n, level, EPS, gMin - EPS);
    if (sh) shadows.push(sh);
  }
  const free = subtractIntervals([[lo, hi]], shadows);

  const at = (u: number, v: number): Point => ({ x: t.x * u + n.x * (level + v), y: t.y * u + n.y * (level + v) });
  const withHoles = settings.separation === 'mouse-bite';
  const others = solids.filter((s) => s.id !== a.id && s.id !== b.id);
  const out: Tab[] = [];
  for (const [flo, fhi] of free) {
    for (const c of tabCentres(flo, fhi, ts.width, ts.pitch)) {
      const u0 = c - ts.width / 2;
      const u1 = c + ts.width / 2;
      const near = -WELD;
      const far = Math.max(gapAt(u0), gapAt(u1)) + WELD;
      const polygon = ccw([at(u0, near), at(u1, near), at(u1, far), at(u0, far)]);
      // Last line of defence: a tab never cuts into a third solid.
      if (others.some((s) => boxGap(s.box, boxOf(polygon)) < 0 && polyIntersects(polygon, s.poly))) continue;
      const gap = gapAt(c);
      const holes: Point[] = [];
      if (withHoles) {
        const d = ts.holeDiameter;
        // Capped: a zero or tiny holePitch must not ask for endless holes.
        const count = Math.min(MAX_TAB_HOLES, Math.max(1, Math.floor((ts.width - d) / ts.holePitch + 1e-9) + 1));
        const off = d * (0.5 - ts.holeOverlap);
        const rows: Array<(u: number) => number> = [() => off];
        if (b.inst) rows.push((u) => gapAt(u) - off);
        for (const row of rows) {
          for (let j = 0; j < count; j++) {
            const u = c + (j - (count - 1) / 2) * ts.holePitch;
            holes.push(at(u, row(u)));
          }
        }
      }
      out.push({ a: a.id, b: b.id, side, center: at(c, gap / 2), length: gap, polygon, holes, normal: n, along: t });
    }
  }
  return out;
}

/**
 * Tabs between every pair of facing, (anti)parallel straight edges less than
 * `tabs.maxLength` apart: board to board, and board to rail. Boards at any
 * angle, any shape; a board turned by a multiple of 90 degrees gets the tabs
 * it always had.
 */
function computeTabs(settings: PanelSettings, instances: PlacedInstance[], rails: Rail[]): Tab[] {
  if (!usesTabs(settings)) return [];
  const solids: Solid[] = [
    ...instances.map((i) => ({ id: i.id, poly: i.outline, box: i.bbox, inst: i, runs: straightRuns(i.outline) })),
    ...rails.map((r) => {
      const poly = boxCorners(r.box);
      return { id: RAIL_ID(r), poly, box: r.box, runs: edgesOf(poly) };
    }),
  ];
  const found: Tab[] = [];
  for (let i = 0; i < instances.length; i++) {
    const p = solids[i]!;
    for (let j = i + 1; j < solids.length; j++) {
      const q = solids[j]!;
      if (boxGap(p.box, q.box) > settings.tabs.maxLength + EPS) continue;
      for (const e of p.runs) {
        if (e.length < settings.tabs.width - EPS) continue;
        for (const f of q.runs) {
          if (f.length < settings.tabs.width - EPS) continue;
          if (dot(e.normal, f.normal) > -FACING_COS) continue;
          // A rail is always the far end; between boards, the one facing up or right is `a`.
          const fromP = !q.inst || facesUpOrRight(e.normal);
          const tabs = fromP ? tabsAcross(settings, p.inst!, e, q, f, solids) : tabsAcross(settings, q.inst!, f, p, e, solids);
          found.push(...tabs);
        }
      }
    }
  }
  // In board order, then by side, nearest first, along the edge.
  const index = new Map(instances.map((inst, k) => [inst.id, k]));
  const along = (tab: Tab): number => dot(tab.center, tab.along);
  return found.sort(
    (x, y) =>
      index.get(x.a)! - index.get(y.a)! ||
      SIDES.indexOf(x.side) - SIDES.indexOf(y.side) ||
      x.length - y.length ||
      along(x) - along(y),
  );
}

// ---------------------------------------------------------------------------
// Fiducials and tooling holes
// ---------------------------------------------------------------------------

function computeRailFeatures(
  settings: PanelSettings,
  frame: Frame,
  rails: Rail[],
  needBottomFiducials: boolean,
): { fiducials: Fiducial[]; toolingHoles: ToolingHole[]; notes: string[] } {
  const fiducials: Fiducial[] = [];
  const toolingHoles: ToolingHole[] = [];
  const notes: string[] = [];
  const { fiducials: fs, toolingHoles: th } = settings;
  if (!fs.enabled && !th.enabled) return { fiducials, toolingHoles, notes };

  const bottom = rails.find((r) => r.side === 'bottom');
  const top = rails.find((r) => r.side === 'top');
  const left = rails.find((r) => r.side === 'left');
  const right = rails.find((r) => r.side === 'right');
  const { outer } = frame;

  // A pair of opposite rails carries the features; horizontal rails win.
  type Slot = { rail: Rail; width: number; place: (along: number, fromEdge: number) => Point; length: number };
  const slots: Slot[] = [];
  const horiz = (rail: Rail, isTop: boolean): Slot => ({
    rail,
    width: rail.box.maxY - rail.box.minY,
    length: outer.maxX - outer.minX,
    place: (along, fromEdge) => ({
      x: outer.minX + along,
      y: isTop ? outer.maxY - fromEdge : outer.minY + fromEdge,
    }),
  });
  const vert = (rail: Rail, isRight: boolean): Slot => ({
    rail,
    width: rail.box.maxX - rail.box.minX,
    length: outer.maxY - outer.minY,
    place: (along, fromEdge) => ({
      x: isRight ? outer.maxX - fromEdge : outer.minX + fromEdge,
      y: outer.minY + along,
    }),
  });
  if (bottom || top) {
    if (bottom) slots.push(horiz(bottom, false));
    if (top) slots.push(horiz(top, true));
  } else {
    if (left) slots.push(vert(left, false));
    if (right) slots.push(vert(right, true));
  }

  if (slots.length === 0) {
    if (fs.enabled) notes.push('no rails: fiducials were not placed');
    if (th.enabled) notes.push('no rails: tooling holes were not placed');
    return { fiducials, toolingHoles, notes };
  }

  if (th.enabled) {
    for (const s of slots) {
      if (s.width < th.diameter + 1) {
        notes.push(`${s.rail.side} rail (${s.width} mm) is too narrow for ${th.diameter} mm tooling holes`);
        continue;
      }
      const ends = s.length >= 2 * th.cornerOffset + 2 * th.diameter ? [th.cornerOffset, s.length - th.cornerOffset] : [s.length / 2];
      for (const along of ends) toolingHoles.push({ at: s.place(along, s.width / 2), diameter: th.diameter });
    }
  }

  if (fs.enabled) {
    const sides: Array<'top' | 'bottom'> = needBottomFiducials ? ['top', 'bottom'] : ['top'];
    // Three marks, not four: the missing corner makes the pattern unambiguous.
    const spots: Array<{ slot: Slot; along: number }> = [];
    slots.forEach((s, i) => {
      if (s.width < fs.edgeDistance + fs.maskDiameter / 2) {
        notes.push(
          `${s.rail.side} rail (${s.width} mm) is too narrow for fiducials ${fs.edgeDistance} mm from the edge`,
        );
        return;
      }
      const room = s.length >= 2 * fs.cornerOffset + 2 * fs.maskDiameter;
      if (!room) {
        spots.push({ slot: s, along: s.length / 2 });
        return;
      }
      spots.push({ slot: s, along: fs.cornerOffset });
      if (i === 0) spots.push({ slot: s, along: s.length - fs.cornerOffset });
    });
    for (const { slot, along } of spots) {
      const at = slot.place(along, fs.edgeDistance);
      // Never on top of a tooling hole.
      const clash = toolingHoles.some((h) => Math.hypot(h.at.x - at.x, h.at.y - at.y) < h.diameter / 2 + fs.maskDiameter / 2 + 0.5);
      if (clash) {
        notes.push(`fiducial at (${at.x.toFixed(2)}, ${at.y.toFixed(2)}) would collide with a tooling hole and was left out`);
        continue;
      }
      for (const side of sides) {
        fiducials.push({ at, side, copperDiameter: fs.copperDiameter, maskDiameter: fs.maskDiameter });
      }
    }
    const marks = new Set(fiducials.map((f) => `${f.at.x},${f.at.y}`)).size;
    if (marks > 0 && marks < 3) notes.push(`only ${marks} fiducial position(s) fit; assembly wants 3`);
  }

  return { fiducials, toolingHoles, notes };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

type Ring = [number, number][];

function toRing(pts: Point[]): Ring {
  return pts.map((p): [number, number] => [p.x, p.y]);
}

function fromRing(ring: Ring): Point[] {
  const pts = ring.map(([x, y]): Point => ({ x, y }));
  const n = pts.length;
  if (n > 1 && pts[0]!.x === pts[n - 1]!.x && pts[0]!.y === pts[n - 1]!.y) pts.pop();
  return pts;
}

function expandBox(b: Box, by: number): Box {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

function computeProfile(
  settings: PanelSettings,
  frame: Frame,
  instances: PlacedInstance[],
  rails: Rail[],
  tabs: Tab[],
): Point[][] {
  // Nothing is routed inside a silk-divider or V-cut panel: one outer ring.
  if (settings.separation === 'silk-divider' || settings.separation === 'v-cut') return [boxCorners(frame.outer)];
  const polys: Ring[][] = [];
  for (const i of instances) polys.push([toRing(i.outline)]);
  for (const t of tabs) polys.push([toRing(t.polygon)]);
  // Rails overlap each other at the corners by WELD so the frame is one ring.
  for (const r of rails) {
    const grown = expandBox(r.box, WELD);
    const clipped: Box = {
      minX: Math.max(grown.minX, frame.outer.minX),
      minY: Math.max(grown.minY, frame.outer.minY),
      maxX: Math.min(grown.maxX, frame.outer.maxX),
      maxY: Math.min(grown.maxY, frame.outer.maxY),
    };
    polys.push([toRing(boxCorners(clipped))]);
  }
  if (polys.length === 0) return [];
  const [first, ...rest] = polys;
  const merged = polygonClipping.union(first!, ...rest);
  const rings: Point[][] = [];
  for (const poly of merged) for (const ring of poly) rings.push(fromRing(ring));
  return rings;
}

// ---------------------------------------------------------------------------
// V-cut score lines
// ---------------------------------------------------------------------------

/**
 * One score line at every level where a board edge lies inside the panel:
 * board against board, or board against rail. Levels on the panel's own edge
 * need no score. Every line spans the whole frame, as JLCPCB requires; the
 * checks report a line that would cut through a board.
 */
function computeScores(frame: Frame, instances: PlacedInstance[]): ScoreLine[] {
  const { outer } = frame;
  const out: ScoreLine[] = [];
  for (const axis of ['h', 'v'] as const) {
    const levels: Array<{ level: number; instances: string[] }> = [];
    const [lo, hi] = axis === 'h' ? [outer.minY, outer.maxY] : [outer.minX, outer.maxX];
    for (const i of instances) {
      const ends = axis === 'h' ? [i.bbox.minY, i.bbox.maxY] : [i.bbox.minX, i.bbox.maxX];
      for (const v of ends) {
        if (v <= lo + EPS || v >= hi - EPS) continue;
        const hit = levels.find((l) => Math.abs(l.level - v) <= EPS);
        if (!hit) levels.push({ level: v, instances: [i.id] });
        else if (!hit.instances.includes(i.id)) hit.instances.push(i.id);
      }
    }
    levels.sort((a, b) => a.level - b.level);
    for (const l of levels) {
      out.push({
        axis,
        level: l.level,
        start: axis === 'h' ? { x: outer.minX, y: l.level } : { x: l.level, y: outer.minY },
        end: axis === 'h' ? { x: outer.maxX, y: l.level } : { x: l.level, y: outer.maxY },
        instances: l.instances,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function computeGeometry(panel: Panel, sources: ResolvedSources): PanelGeometry {
  const { instances, unplaced } = placeInstances(panel, sources);
  const frame = computeFrame(panel.settings, instances);
  if (!frame) {
    return {
      instances,
      unplaced,
      frame: null,
      rails: [],
      tabs: [],
      fiducials: [],
      toolingHoles: [],
      featureNotes: [],
      profile: [],
      dividers: [],
      scores: [],
    };
  }
  const rails = computeRails(panel.settings, frame);
  const tabs = computeTabs(panel.settings, instances, rails);
  const needBottom = instances.some((i) => {
    if (!i.populate) return false;
    return sources.find((s) => s.key === i.source)?.geometry?.hasBottomParts === true;
  });
  const features = computeRailFeatures(panel.settings, frame, rails, needBottom);
  const dividers: Point[][] = [];
  if (panel.settings.separation === 'silk-divider') {
    for (const i of instances) dividers.push([...i.outline, i.outline[0]!]);
    for (const r of rails) {
      const c = boxCorners(r.box);
      dividers.push([...c, c[0]!]);
    }
  }
  return {
    instances,
    unplaced,
    frame,
    rails,
    tabs,
    fiducials: features.fiducials,
    toolingHoles: features.toolingHoles,
    featureNotes: features.notes,
    profile: computeProfile(panel.settings, frame, instances, rails, tabs),
    dividers,
    scores: panel.settings.separation === 'v-cut' ? computeScores(frame, instances) : [],
  };
}

/** Number of tabs attached to each instance. */
export function tabCounts(geometry: PanelGeometry): Map<string, number> {
  const counts = new Map<string, number>();
  for (const i of geometry.instances) counts.set(i.id, 0);
  for (const t of geometry.tabs) {
    counts.set(t.a, (counts.get(t.a) ?? 0) + 1);
    if (counts.has(t.b)) counts.set(t.b, (counts.get(t.b) ?? 0) + 1);
  }
  return counts;
}
