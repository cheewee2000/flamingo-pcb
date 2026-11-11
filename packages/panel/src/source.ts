/**
 * Flamingo Panel - what a panel needs to know about one source board.
 *
 * `resolveSourceGeometry` reduces a Board to its outline, bounding box, the
 * state of its four edges and its bill of parts. Everything downstream (checks,
 * packing, tabs, cost) works from this summary and never re-reads the board.
 *
 * Edges are the four sides of the outline's bounding box. An edge is blocked
 * when it cannot carry a tab or sit next to a neighbour at the normal spacing:
 *  - a component's courtyard (or, failing that, its pads) reaches past the
 *    outline there, as an edge-mounted USB-C connector does, or
 *  - a keepout reaches the edge, as an antenna region does.
 * Blocking is per edge, not per stretch of edge: one connector blocks the whole
 * side it overhangs. That is coarser than strictly necessary and always safe.
 */

import type { JlcPart } from './cost.js';
import type { Board, ComponentInst, Point } from '@flamingo/engine';
import { componentTransformPoints, isAssembled, outlineToPolygon, padOutline, pointInPolygon } from '@flamingo/engine';
import type { PanelLimits } from './config.js';
import { boxOf } from './transform.js';
import type { Box, Side } from './types.js';

export interface EdgeInfo {
  blocked: boolean;
  /** Human-readable causes, e.g. `J1 overhangs 1.45 mm`, `keepout reaches the edge`. */
  reasons: string[];
  /** How far parts reach past this edge, mm (0 when nothing does). */
  overhang: number;
  /** Clearance this edge demands from anything facing it, mm (0 = the panel spacing is enough). */
  clearance: number;
}

export interface Overhang {
  refdes: string;
  side: Side;
  depth: number;
  /** The offending courtyard or pad polygon, board coordinates. */
  polygon: Point[];
}

export interface EdgeKeepout {
  id: string;
  sides: Side[];
  polygon: Point[];
}

/** One line of a board's bill of parts, as the cost model wants it. */
export interface PartLine {
  lcsc: string;
  /** JLCPCB basic part (no feeder-loading fee on Economic assembly). */
  basic: boolean;
  /** How many of this part one board carries. */
  count: number;
  /** Surface-mount solder joints per part. */
  smtJoints: number;
  /** Through-hole solder joints per part. */
  thtJoints: number;
  sides: Array<'top' | 'bottom'>;
  value: string;
  package: string;
  refdes: string[];
  /** Unit price in USD when known (the server fills it in from the parts cache). */
  unitPrice?: number;
  /** What JLCPCB's parts library says about the part (the server fills it in); absent when not looked up or not listed. */
  jlc?: JlcPart;
}

export interface SourceGeometry {
  name: string;
  copperLayers: 2 | 4 | 6;
  rules: Board['rules'];
  /** Outline polygon, board coordinates (arcs tessellated). */
  outline: Point[];
  bbox: Box;
  width: number;
  height: number;
  /** Outline area over bounding-box area: 1 for a plain rectangle. */
  fillRatio: number;
  edges: Record<Side, EdgeInfo>;
  overhangs: Overhang[];
  edgeKeepouts: EdgeKeepout[];
  parts: PartLine[];
  componentCount: number;
  hasBottomParts: boolean;
}

const EPS = 0.01;
const LCSC_ID = /^C\d+$/i;

function polygonArea(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Courtyard polygons in board space; pads stand in when a footprint has no courtyard. */
function componentExtent(c: ComponentInst): Point[][] {
  const courtyard = c.footprint.courtyard.filter((p) => p.length >= 3);
  if (courtyard.length > 0) return courtyard.map((p) => componentTransformPoints(c, p));
  return c.footprint.pads.map((pad) => padOutline(c, pad));
}

function nearestSide(p: Point, bbox: Box): Side {
  const d: Array<[Side, number]> = [
    ['N', Math.abs(bbox.maxY - p.y)],
    ['E', Math.abs(bbox.maxX - p.x)],
    ['S', Math.abs(p.y - bbox.minY)],
    ['W', Math.abs(p.x - bbox.minX)],
  ];
  d.sort((a, b) => a[1] - b[1]);
  return d[0]![0];
}

function collectParts(board: Board): PartLine[] {
  const byLcsc = new Map<string, PartLine>();
  for (const c of board.components) {
    if (!isAssembled(c)) continue; // test points, mechanical items, do-not-place parts: nothing to place
    let line = byLcsc.get(c.lcsc);
    if (!line) {
      const tht = c.footprint.pads.filter((p) => p.layer === 'through' && p.drill?.plated !== false).length;
      const smt = c.footprint.pads.filter((p) => p.layer !== 'through').length;
      line = {
        lcsc: c.lcsc,
        basic: c.fields.basic === true,
        count: 0,
        smtJoints: smt,
        thtJoints: tht,
        sides: [],
        value: c.fields.value || c.fields.description || c.lcsc,
        package: c.fields.package || c.footprint.name,
        refdes: [],
      };
      byLcsc.set(c.lcsc, line);
    }
    line.count++;
    line.refdes.push(c.refdes);
    if (!line.sides.includes(c.side)) line.sides.push(c.side);
  }
  return [...byLcsc.values()];
}

/**
 * Summarize `board` for panelization. Throws when the board has no usable
 * outline: without one there is nothing to place.
 */
export function resolveSourceGeometry(board: Board, limits: PanelLimits): SourceGeometry {
  if (board.outline.length === 0) {
    throw new Error(`board "${board.name}" has no outline`);
  }
  const outline = outlineToPolygon(board.outline);
  if (outline.length < 3) throw new Error(`board "${board.name}" has a degenerate outline`);
  const bbox = boxOf(outline);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;

  const { overhangMargin, keepoutClearance, keepoutEdgeTolerance } = limits.blockedEdges;

  const edges: Record<Side, EdgeInfo> = {
    N: { blocked: false, reasons: [], overhang: 0, clearance: 0 },
    E: { blocked: false, reasons: [], overhang: 0, clearance: 0 },
    S: { blocked: false, reasons: [], overhang: 0, clearance: 0 },
    W: { blocked: false, reasons: [], overhang: 0, clearance: 0 },
  };
  const block = (side: Side, reason: string, overhang: number, clearance: number): void => {
    const e = edges[side];
    e.blocked = true;
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
    e.overhang = Math.max(e.overhang, overhang);
    e.clearance = Math.max(e.clearance, clearance);
  };

  const overhangs: Overhang[] = [];
  for (const c of board.components) {
    for (const poly of componentExtent(c)) {
      const pb = boxOf(poly);
      const depth: Record<Side, number> = {
        N: pb.maxY - bbox.maxY,
        E: pb.maxX - bbox.maxX,
        S: bbox.minY - pb.minY,
        W: bbox.minX - pb.minX,
      };
      let beyondBox = false;
      for (const side of ['N', 'E', 'S', 'W'] as const) {
        if (depth[side] > EPS) {
          beyondBox = true;
          overhangs.push({ refdes: c.refdes, side, depth: depth[side], polygon: poly });
          block(side, `${c.refdes} overhangs ${fmt(depth[side])} mm`, depth[side], depth[side] + overhangMargin.value);
        }
      }
      if (beyondBox) continue;
      // Inside the bounding box but outside a non-rectangular outline (a notch,
      // a cut corner): the part still overhangs the board there.
      const outside = poly.filter(
        (p) => insideBox(p, bbox, EPS) && !pointInPolygon(p, outline) && !onBoundary(p, outline),
      );
      // Which side a notch belongs to is a judgement call, so every side
      // nearest to a stray corner is blocked.
      for (const side of new Set(outside.map((p) => nearestSide(p, bbox)))) {
        overhangs.push({ refdes: c.refdes, side, depth: 0, polygon: poly });
        block(side, `${c.refdes} overhangs the outline`, 0, overhangMargin.value);
      }
    }
  }

  const edgeKeepouts: EdgeKeepout[] = [];
  for (const k of board.keepouts) {
    if (k.polygon.length < 3) continue;
    const kb = boxOf(k.polygon);
    const tol = keepoutEdgeTolerance.value;
    const sides: Side[] = [];
    if (kb.maxY >= bbox.maxY - tol) sides.push('N');
    if (kb.maxX >= bbox.maxX - tol) sides.push('E');
    if (kb.minY <= bbox.minY + tol) sides.push('S');
    if (kb.minX <= bbox.minX + tol) sides.push('W');
    if (sides.length === 0) continue;
    edgeKeepouts.push({ id: k.id, sides, polygon: k.polygon });
    for (const side of sides) block(side, 'keepout reaches the edge', 0, keepoutClearance.value);
  }

  return {
    name: board.name,
    copperLayers: board.copperLayers,
    rules: board.rules,
    outline,
    bbox,
    width,
    height,
    fillRatio: width > 0 && height > 0 ? polygonArea(outline) / (width * height) : 0,
    edges,
    overhangs,
    edgeKeepouts,
    parts: collectParts(board),
    componentCount: board.components.length,
    hasBottomParts: board.components.some((c) => c.side === 'bottom' && isAssembled(c)),
  };
}

function insideBox(p: Point, b: Box, eps: number): boolean {
  return p.x >= b.minX - eps && p.x <= b.maxX + eps && p.y >= b.minY - eps && p.y <= b.maxY + eps;
}

/** True when `p` lies on the polygon boundary (ray casting is undecided there). */
function onBoundary(p: Point, poly: Point[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) < EPS) return true;
  }
  return false;
}
