/**
 * Flamingo Engine - component silk label placement (single source of truth).
 *
 * Every consumer that draws or reasons about the auto-generated component
 * refdes silk label — the engine SVG renderer, the UI canvas renderer, the
 * Gerber legend export, and the DRC silk-over-pad check — MUST route through
 * `componentLabelPlacement` / `componentLabelRect` so they always agree on
 * where the label sits.
 *
 * Placement rule:
 *  - Compute the component's world-space body bounding box (courtyard rings,
 *    pad outlines, and footprint silk extents, all through the component
 *    transform).
 *  - Candidate positions, tried in order (first candidate is the pure
 *    geometric default):
 *      landscape/squarish: below, reading-right, reading-left, above
 *      portrait (box height > 1.5x width): reading-right, reading-left,
 *        below, above
 *    "reading-right" is the world-space RIGHT for top-side parts and the
 *    world-space LEFT for bottom-side parts, so the label reads to the right
 *    of the part when the board is viewed from that part's own side (the
 *    fab/bottom view x-mirror swaps left and right).
 *  - below/above are horizontally centered with a small gap; right/left are
 *    vertically centered with the same gap.
 *  - With board context (`componentLabelPlacement(board, c)`), a whole-board
 *    greedy solve scores every candidate against three collision classes and
 *    picks the least-bad one (ties broken by candidate preference order):
 *      1. Any part of the label rect falling outside the board outline.
 *      2. Overlap with ANY component's body box (courtyard rings, or pad
 *         outlines when there is no courtyard — every component, not just the
 *         label's own).
 *      3. Overlap with another component's already-placed label rect.
 *    Components are processed in refdes order; each chosen rect is recorded so
 *    later labels dodge earlier ones. The per-board solve is memoized on board
 *    object identity, so the per-component API stays cheap and deterministic.
 *    Candidates are the four sides at three increasing gaps; if every
 *    candidate collides the least-bad still wins (never throws) and DRC's
 *    silk-over-pad check flags any residual overlap honestly.
 *  - Without board context (`componentLabelPlacement(c)`), the first
 *    candidate is used unconditionally (pure geometry; used by tests and as
 *    the collision fallback).
 *  - The label itself stays upright (world rotation 0) and text height is
 *    unchanged (1.0 mm); only the anchor moved off the component body.
 *    Bottom-side glyph mirroring remains each consumer's existing convention
 *    (mirror about the anchor's center), which this placement is invariant
 *    to because the anchor is the text's center.
 *
 * Approximations: arc silk extents use only their endpoints; label width
 * uses the stroke-font advance (0.9 x height per character — the widest of
 * the consumer fonts, so the box is conservative for the fabbed legend);
 * collision-avoidance pad boxes are rotation-proof squares of half-diagonal
 * radius (conservative, never under-avoids).
 */

import type { Board, ComponentInst, Point } from './types.js';
import { bboxOf, componentTransformPoints, padOutline, outlineToPolygon, pointInPolygon } from './geometry.js';

/** Refdes label text height in mm (unchanged project-wide convention). */
export const COMPONENT_LABEL_HEIGHT_MM = 1.0;
/** Gap between the component body box and the label box, in mm. */
export const COMPONENT_LABEL_GAP_MM = 0.3;
/** Per-character advance as a fraction of text height (strokefont.ts ADVANCE). */
export const COMPONENT_LABEL_CHAR_ADVANCE = 0.9;
/** Body boxes taller than this ratio (h > ratio * w) count as portrait. */
const PORTRAIT_RATIO = 1.5;

export type ComponentLabelPosition =
  | 'below'
  | 'right'
  | 'left'
  | 'above'
  // Corner candidates: board-aware solve only, for parts boxed in on all four
  // sides (dense clusters where every side candidate hits a neighbour).
  | 'below-right'
  | 'below-left'
  | 'above-right'
  | 'above-left';

export interface ComponentLabelPlacement {
  /** World-space CENTER of the label text (both axes). */
  at: Point;
  /** World rotation in degrees CCW. Always 0 — labels stay upright. */
  rotation: number;
  /** Text height in mm. */
  height: number;
  /** Approximate label width in mm (stroke-font advance x refdes length). */
  width: number;
  /** Which side of the body box the label sits on. */
  position: ComponentLabelPosition;
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * World-space axis-aligned bounding box of a component's body: courtyard
 * rings, pad outlines, and footprint silk extents (line/arc endpoints,
 * circle center ± radius+width/2, text anchor). Falls back to the component
 * origin for an empty footprint.
 */
export function componentBodyBBox(c: ComponentInst): BBox {
  const pts: Point[] = [];
  for (const ring of c.footprint.courtyard) {
    pts.push(...componentTransformPoints(c, ring));
  }
  for (const pad of c.footprint.pads) {
    pts.push(...padOutline(c, pad));
  }
  for (const item of c.footprint.silk) {
    switch (item.kind) {
      case 'line':
      case 'arc': {
        const [s, e] = componentTransformPoints(c, [item.start, item.end]);
        pts.push(s, e);
        break;
      }
      case 'circle': {
        const [ctr] = componentTransformPoints(c, [item.center]);
        const r = item.radius + item.width / 2;
        pts.push({ x: ctr.x - r, y: ctr.y - r }, { x: ctr.x + r, y: ctr.y + r });
        break;
      }
      case 'text': {
        pts.push(...componentTransformPoints(c, [item.at]));
        break;
      }
    }
  }
  if (pts.length === 0) pts.push(c.at);
  return bboxOf(pts);
}

/** The placement for one named candidate position around `box`. */
function placementAt(
  box: BBox,
  position: ComponentLabelPosition,
  width: number,
  height: number,
  gap: number = COMPONENT_LABEL_GAP_MM,
): ComponentLabelPlacement {
  let at: Point;
  switch (position) {
    case 'below':
      at = { x: (box.minX + box.maxX) / 2, y: box.minY - gap - height / 2 };
      break;
    case 'above':
      at = { x: (box.minX + box.maxX) / 2, y: box.maxY + gap + height / 2 };
      break;
    case 'right':
      at = { x: box.maxX + gap + width / 2, y: (box.minY + box.maxY) / 2 };
      break;
    case 'left':
      at = { x: box.minX - gap - width / 2, y: (box.minY + box.maxY) / 2 };
      break;
    case 'below-right':
      at = { x: box.maxX + gap + width / 2, y: box.minY - gap - height / 2 };
      break;
    case 'below-left':
      at = { x: box.minX - gap - width / 2, y: box.minY - gap - height / 2 };
      break;
    case 'above-right':
      at = { x: box.maxX + gap + width / 2, y: box.maxY + gap + height / 2 };
      break;
    case 'above-left':
      at = { x: box.minX - gap - width / 2, y: box.maxY + gap + height / 2 };
      break;
  }
  return { at, rotation: 0, height, width, position };
}

/** Corner candidates, tried after the four sides in the board-aware solve. */
const CORNER_POSITIONS: ComponentLabelPosition[] = ['below-right', 'below-left', 'above-right', 'above-left'];

/** Candidate positions in preference order (see module header). */
function candidateOrder(c: ComponentInst, box: BBox): ComponentLabelPosition[] {
  const portrait = box.maxY - box.minY > PORTRAIT_RATIO * (box.maxX - box.minX);
  const readRight: ComponentLabelPosition = c.side === 'bottom' ? 'left' : 'right';
  const readLeft: ComponentLabelPosition = c.side === 'bottom' ? 'right' : 'left';
  return portrait ? [readRight, readLeft, 'below', 'above'] : ['below', readRight, readLeft, 'above'];
}

/**
 * World-space axis-aligned body box of a component used as a label obstacle:
 * courtyard rings through the component transform, or pad outlines when the
 * footprint has no courtyard (mirrors viewer3d's `componentBox`). Returns null
 * for a footprint with no courtyard and no pads.
 */
function componentObstacleBox(c: ComponentInst): BBox | null {
  const pts: Point[] = [];
  for (const ring of c.footprint.courtyard) pts.push(...componentTransformPoints(c, ring));
  // Pads always count: EasyEDA courtyards are often drawn tight to the BODY,
  // with pads poking past them — and DRC's silk-over-pad checks real pad
  // polygons, so the label must clear the union of both.
  for (const pad of c.footprint.pads) pts.push(...padOutline(c, pad));
  if (pts.length === 0) return null;
  return bboxOf(pts);
}

function bboxOverlaps(a: BBox, b: BBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function labelBBox(p: ComponentLabelPlacement): BBox {
  return {
    minX: p.at.x - p.width / 2,
    minY: p.at.y - p.height / 2,
    maxX: p.at.x + p.width / 2,
    maxY: p.at.y + p.height / 2,
  };
}

/** Extra gap increments (added to the base gap) tried for each side. */
const CANDIDATE_EXTRA_GAPS = [0, 0.35, 0.75, 1.5, 2.5, 3.5];

/**
 * Scoring margin around the label rect (mm): the stroke font's line width
 * extends past the glyph-cell rect, so candidates that merely graze an
 * obstacle must still be penalized or labels visually touch their neighbours.
 */
const SCORE_PAD = 0.1;

function inflate(r: BBox, m: number): BBox {
  return { minX: r.minX - m, minY: r.minY - m, maxX: r.maxX + m, maxY: r.maxY + m };
}

/** Cost weights, ordered so outline containment dominates body overlap, which
 * dominates label-label overlap. Position preference is the tie-break. */
const W_OUTLINE = 1000;
const W_COMPONENT = 30;
const W_LABEL = 12;

/** Sample points of a rect (4 corners + 4 edge midpoints) for the outline test. */
function rectSamplePoints(r: BBox): Point[] {
  const midX = (r.minX + r.maxX) / 2;
  const midY = (r.minY + r.maxY) / 2;
  return [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
    { x: midX, y: r.minY },
    { x: midX, y: r.maxY },
    { x: r.minX, y: midY },
    { x: r.maxX, y: midY },
  ];
}

/** Obstacle context shared across a whole-board label solve. */
interface SolveContext {
  outlinePoly: Point[] | null;
  /** Body box + owning refdes for every component with a body. */
  bodies: { refdes: string; box: BBox }[];
}

function buildSolveContext(board: Board): SolveContext {
  let outlinePoly: Point[] | null = null;
  if (board.outline.length > 0) {
    try {
      outlinePoly = outlineToPolygon(board.outline);
    } catch {
      outlinePoly = null; // malformed outline: skip containment scoring
    }
  }
  const bodies: { refdes: string; box: BBox }[] = [];
  for (const cc of board.components) {
    const box = componentObstacleBox(cc);
    if (box) bodies.push({ refdes: cc.refdes, box });
  }
  return { outlinePoly, bodies };
}

/**
 * Cost of placing `c`'s label at `rect`, given the board obstacles and the
 * label rects already committed by earlier components in the solve. Lower is
 * better; 0 means fully inside the outline and clear of all bodies and labels.
 */
function candidateCost(
  rect: BBox,
  ownRefdes: string,
  ctx: SolveContext,
  placedLabels: BBox[],
): number {
  let cost = 0;
  if (ctx.outlinePoly) {
    let outside = 0;
    for (const p of rectSamplePoints(rect)) if (!pointInPolygon(p, ctx.outlinePoly)) outside++;
    cost += W_OUTLINE * outside;
  }
  for (const body of ctx.bodies) {
    if (body.refdes === ownRefdes) continue; // never penalize the label's own body
    if (bboxOverlaps(rect, body.box)) cost += W_COMPONENT;
  }
  for (const lab of placedLabels) if (bboxOverlaps(rect, lab)) cost += W_LABEL;
  return cost;
}

/**
 * Choose the least-bad placement for one component against the board obstacles
 * and the labels already placed. Candidates are the four sides at increasing
 * gaps, in the geometric preference order; the lowest-cost candidate wins with
 * ties broken toward the more-preferred candidate (earlier in iteration).
 */
function solveOne(
  c: ComponentInst,
  ctx: SolveContext,
  placedLabels: BBox[],
): { placement: ComponentLabelPlacement; cost: number } {
  const height = COMPONENT_LABEL_HEIGHT_MM;
  const width = Math.max(1, c.refdes.length) * COMPONENT_LABEL_CHAR_ADVANCE * height;
  const box = componentBodyBBox(c);
  const order = candidateOrder(c, box);

  let best: ComponentLabelPlacement | undefined;
  let bestCost = Infinity;
  for (const extra of CANDIDATE_EXTRA_GAPS) {
    for (const position of [...order, ...CORNER_POSITIONS]) {
      const candidate = placementAt(box, position, width, height, COMPONENT_LABEL_GAP_MM + extra);
      const cost = candidateCost(inflate(labelBBox(candidate), SCORE_PAD), c.refdes, ctx, placedLabels);
      if (cost < bestCost) {
        best = candidate;
        bestCost = cost;
        if (bestCost === 0) return { placement: best, cost: 0 }; // can't do better
      }
    }
  }
  return { placement: best!, cost: bestCost };
}

/** Cache of the whole-board solve, keyed by board object identity. Boards are
 * immutable snapshots (ops produce new objects), so identity is a safe key. */
const solveCache = new WeakMap<Board, Map<string, ComponentLabelPlacement>>();

/** Whole-board greedy label solve, memoized per board object. */
function solveBoard(board: Board): Map<string, ComponentLabelPlacement> {
  const cached = solveCache.get(board);
  if (cached) return cached;

  const ctx = buildSolveContext(board);
  const ordered = [...board.components].sort((a, b) =>
    a.refdes < b.refdes ? -1 : a.refdes > b.refdes ? 1 : 0,
  );
  const result = new Map<string, ComponentLabelPlacement>();
  for (const c of ordered) {
    const placedLabels = [...result.values()].map(labelBBox);
    result.set(c.refdes, solveOne(c, ctx, placedLabels).placement);
  }

  // Refinement sweeps: the greedy pass places early labels blind to later
  // ones, so an early component can squat on a boxed-in neighbour's only free
  // corridor. Re-place each label against everyone ELSE's final rect and keep
  // strict improvements; repeat until stable (bounded).
  for (let sweep = 0; sweep < 3; sweep++) {
    let improved = false;
    for (const c of ordered) {
      const others = ordered.filter((o) => o.refdes !== c.refdes).map((o) => labelBBox(result.get(o.refdes)!));
      const current = result.get(c.refdes)!;
      const currentCost = candidateCost(inflate(labelBBox(current), SCORE_PAD), c.refdes, ctx, others);
      if (currentCost === 0) continue;
      const fresh = solveOne(c, ctx, others);
      if (fresh.cost < currentCost) {
        result.set(c.refdes, fresh.placement);
        improved = true;
      }
    }
    if (!improved) break;
  }
  solveCache.set(board, result);
  return result;
}

/**
 * Where the component's refdes silk label goes. See module header for the
 * placement rule. Deterministic: depends only on the component instance and
 * (when given) the board's pad set.
 *
 * `componentLabelPlacement(c)` — pure geometric default (first candidate).
 * `componentLabelPlacement(board, c)` — first collision-free candidate,
 * falling back to the geometric default when all candidates collide.
 */
export function componentLabelPlacement(c: ComponentInst): ComponentLabelPlacement;
export function componentLabelPlacement(board: Board, c: ComponentInst): ComponentLabelPlacement;
export function componentLabelPlacement(
  boardOrComp: Board | ComponentInst,
  maybeComp?: ComponentInst,
): ComponentLabelPlacement {
  const c = maybeComp ?? (boardOrComp as ComponentInst);
  const board = maybeComp ? (boardOrComp as Board) : undefined;

  if (!board) {
    const height = COMPONENT_LABEL_HEIGHT_MM;
    const width = Math.max(1, c.refdes.length) * COMPONENT_LABEL_CHAR_ADVANCE * height;
    const box = componentBodyBBox(c);
    const order = candidateOrder(c, box);
    return placementAt(box, order[0], width, height);
  }

  // Board-aware: use the memoized whole-board solve so every consumer agrees
  // and labels dodge each other. A component not present on the board (looked
  // up by a stale refdes) falls back to a one-off solve against the board's
  // obstacles with no committed labels.
  const solved = solveBoard(board).get(c.refdes);
  if (solved) return solved;
  return solveOne(c, buildSolveContext(board), []).placement;
}

/**
 * World-space rectangle (4 corners, CCW) that the refdes label occupies —
 * the box DRC's silk-over-pad check tests against pads. Axis-aligned because
 * the label's world rotation is always 0. Pass the board so the rect uses
 * the same collision-aware placement the renderers use.
 */
export function componentLabelRect(c: ComponentInst): Point[];
export function componentLabelRect(board: Board, c: ComponentInst): Point[];
export function componentLabelRect(boardOrComp: Board | ComponentInst, maybeComp?: ComponentInst): Point[] {
  const p = maybeComp
    ? componentLabelPlacement(boardOrComp as Board, maybeComp)
    : componentLabelPlacement(boardOrComp as ComponentInst);
  const hw = p.width / 2;
  const hh = p.height / 2;
  return [
    { x: p.at.x - hw, y: p.at.y - hh },
    { x: p.at.x + hw, y: p.at.y - hh },
    { x: p.at.x + hw, y: p.at.y + hh },
    { x: p.at.x - hw, y: p.at.y + hh },
  ];
}
