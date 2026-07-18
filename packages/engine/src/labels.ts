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
 *  - With board context (`componentLabelPlacement(board, c)`), the FIRST
 *    candidate whose label box overlaps no copper pad on the label's silk
 *    side wins (own pads included; cheap conservative bbox-vs-bbox tests).
 *    If every candidate collides, fall back to the first candidate — DRC's
 *    silk-over-pad check will then flag it honestly.
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
import { bboxOf, componentTransformPoints, padOutline } from './geometry.js';
import { copperLayersOf, padCopperLayers } from './layers.js';

/** Refdes label text height in mm (unchanged project-wide convention). */
export const COMPONENT_LABEL_HEIGHT_MM = 1.0;
/** Gap between the component body box and the label box, in mm. */
export const COMPONENT_LABEL_GAP_MM = 0.3;
/** Per-character advance as a fraction of text height (strokefont.ts ADVANCE). */
export const COMPONENT_LABEL_CHAR_ADVANCE = 0.9;
/** Body boxes taller than this ratio (h > ratio * w) count as portrait. */
const PORTRAIT_RATIO = 1.5;

export type ComponentLabelPosition = 'below' | 'right' | 'left' | 'above';

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
): ComponentLabelPlacement {
  const gap = COMPONENT_LABEL_GAP_MM;
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
  }
  return { at, rotation: 0, height, width, position };
}

/** Candidate positions in preference order (see module header). */
function candidateOrder(c: ComponentInst, box: BBox): ComponentLabelPosition[] {
  const portrait = box.maxY - box.minY > PORTRAIT_RATIO * (box.maxX - box.minX);
  const readRight: ComponentLabelPosition = c.side === 'bottom' ? 'left' : 'right';
  const readLeft: ComponentLabelPosition = c.side === 'bottom' ? 'right' : 'left';
  return portrait ? [readRight, readLeft, 'below', 'above'] : ['below', readRight, readLeft, 'above'];
}

/**
 * Conservative world-space obstacle boxes: every copper pad (any component,
 * own pads included) with copper on the given silk side. Each pad becomes a
 * rotation-proof square of half-diagonal radius around its world center.
 */
function padObstacleBBoxes(board: Board, side: 'top' | 'bottom'): BBox[] {
  const layer = side === 'top' ? 'F.Cu' : 'B.Cu';
  const copper = copperLayersOf(board);
  const boxes: BBox[] = [];
  for (const cc of board.components) {
    for (const pad of cc.footprint.pads) {
      if (!padCopperLayers(pad, cc.side, copper).includes(layer)) continue;
      const [ctr] = componentTransformPoints(cc, [pad.at]);
      const half = Math.hypot(pad.size.w, pad.size.h) / 2;
      boxes.push({ minX: ctr.x - half, minY: ctr.y - half, maxX: ctr.x + half, maxY: ctr.y + half });
    }
  }
  return boxes;
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

  const height = COMPONENT_LABEL_HEIGHT_MM;
  const width = Math.max(1, c.refdes.length) * COMPONENT_LABEL_CHAR_ADVANCE * height;
  const box = componentBodyBBox(c);
  const order = candidateOrder(c, box);

  if (!board) return placementAt(box, order[0], width, height);

  const obstacles = padObstacleBBoxes(board, c.side);
  for (const position of order) {
    const candidate = placementAt(box, position, width, height);
    const rect = labelBBox(candidate);
    if (!obstacles.some((o) => bboxOverlaps(rect, o))) return candidate;
  }
  // Every candidate collides: fall back to the geometric default and let
  // DRC's silk-over-pad check flag it honestly.
  return placementAt(box, order[0], width, height);
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
