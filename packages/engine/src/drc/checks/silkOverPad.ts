/**
 * DRC check: silkscreen over exposed copper pad. Silk on top of an exposed
 * pad (SMD or through-hole annular ring) can prevent a good solder joint.
 *
 * Approximations (documented, not exact stroke geometry):
 *  - line/arc silk items are approximated by a rectangle stroking the
 *    start->end chord at the item's width (arcs are NOT tessellated along
 *    their curve — only their endpoints are used).
 *  - circle silk items are approximated by a filled disk of radius +
 *    width/2 (conservative: may over-flag a hollow ring's center, never
 *    under-flags).
 *  - text (both footprint SilkItem 'text' and board-level SilkText) is
 *    approximated by its bounding rect: w = 0.6 * height * text.length,
 *    h = height, centered at `at` and rotated by `rotation`.
 *  - each component's auto-generated refdes label is checked at the shared
 *    placement from labels.ts (componentLabelRect), the same box the
 *    renderers and Gerber legend use.
 */
import type { Board, ComponentInst, Point, SilkItem, SilkLine, SilkText } from '../../types.js';
import { add, componentTransformPoints, polyIntersects, rotate } from '../../geometry.js';
import { componentLabelRect } from '../../labels.js';
import { circlePolygon } from '../util.js';
import type { RuleSet } from '../rules.js';
import type { CopperItem, DrcViolation } from '../types.js';

interface SilkShape {
  poly: Point[];
  side: 'top' | 'bottom';
  ref: string;
}

function lineStrokeRect(start: Point, end: Point, halfWidth: number): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1e-9;
  const nx = (-dy / len) * halfWidth;
  const ny = (dx / len) * halfWidth;
  return [
    { x: start.x + nx, y: start.y + ny },
    { x: end.x + nx, y: end.y + ny },
    { x: end.x - nx, y: end.y - ny },
    { x: start.x - nx, y: start.y - ny },
  ];
}

function textRectLocal(at: Point, rotationDeg: number, text: string, height: number): Point[] {
  const w = 0.6 * height * text.length;
  const h = height;
  const corners: Point[] = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
  return corners.map((p) => add(rotate(p, rotationDeg), at));
}

function footprintSilkShapes(b: Board, c: ComponentInst): SilkShape[] {
  const side = c.side;
  const shapes: SilkShape[] = [];
  for (const item of c.footprint.silk) {
    shapes.push(...footprintSilkItemShape(c, item, side));
  }
  // Auto-generated refdes label: its world-space box comes from the shared
  // board-aware placement helper (labels.ts), so DRC checks the label exactly
  // where the renderers and the Gerber legend draw it.
  shapes.push({ poly: componentLabelRect(b, c), side, ref: c.refdes });
  return shapes;
}

function footprintSilkItemShape(c: ComponentInst, item: SilkItem, side: 'top' | 'bottom'): SilkShape[] {
  switch (item.kind) {
    case 'line':
    case 'arc': {
      const [s, e] = componentTransformPoints(c, [item.start, item.end]);
      return [{ poly: lineStrokeRect(s, e, item.width / 2), side, ref: c.refdes }];
    }
    case 'circle': {
      const [center] = componentTransformPoints(c, [item.center]);
      return [{ poly: circlePolygon(center, item.radius + item.width / 2), side, ref: c.refdes }];
    }
    case 'text': {
      const localRect = textRectLocal(item.at, item.rotation, item.text, item.height);
      return [{ poly: componentTransformPoints(c, localRect), side, ref: c.refdes }];
    }
  }
}

function boardSilkTextShape(st: SilkText): SilkShape {
  const poly = textRectLocal(st.at, st.rotation, st.text, st.height);
  return { poly, side: st.layer === 'F.Silk' ? 'top' : 'bottom', ref: st.id };
}

function boardSilkLineShape(line: SilkLine): SilkShape {
  const poly = lineStrokeRect(line.start, line.end, line.width / 2);
  return { poly, side: line.layer === 'F.Silk' ? 'top' : 'bottom', ref: line.id };
}

function buildSilkShapes(b: Board): SilkShape[] {
  const shapes: SilkShape[] = [];
  for (const c of b.components) shapes.push(...footprintSilkShapes(b, c));
  for (const st of b.silk) shapes.push(boardSilkTextShape(st));
  for (const line of b.silkLines) shapes.push(boardSilkLineShape(line));
  return shapes;
}

function centroid(poly: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

export function check(b: Board, rules: RuleSet, items: CopperItem[]): DrcViolation[] {
  const shapes = buildSilkShapes(b);
  const padItems = items.filter((i) => i.kind === 'pad' && (i.layer === 'F.Cu' || i.layer === 'B.Cu'));

  const violations: DrcViolation[] = [];
  for (const shape of shapes) {
    for (const pad of padItems) {
      const padSide: 'top' | 'bottom' = pad.layer === 'F.Cu' ? 'top' : 'bottom';
      if (padSide !== shape.side) continue;
      if (polyIntersects(shape.poly, pad.polygon)) {
        violations.push({
          rule: 'silk-over-pad',
          message: `Silkscreen (${shape.ref}) overlaps pad ${pad.ref} (net "${pad.net}") on ${pad.layer}`,
          at: centroid(pad.polygon),
          items: [shape.ref, pad.ref],
        });
      }
    }
  }
  return violations;
}
