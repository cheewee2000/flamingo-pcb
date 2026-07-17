/**
 * DRC checks: 'missing-outline' (no outline, or outlineToPolygon can't close
 * it) and 'outside-outline' (a component pad polygon not fully inside the
 * outline).
 */
import type { Board, Point } from '../../types.js';
import { outlineToPolygon, padOutline, padWorld, pointInPolygon } from '../../geometry.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

export function check(b: Board, rules: RuleSet): DrcViolation[] {
  const violations: DrcViolation[] = [];

  if (b.outline.length === 0) {
    violations.push({
      rule: 'missing-outline',
      message: 'Board has no outline defined',
      at: { x: 0, y: 0 },
      items: [],
    });
    return violations;
  }

  let poly: Point[];
  try {
    poly = outlineToPolygon(b.outline);
  } catch (e) {
    violations.push({
      rule: 'missing-outline',
      message: `Board outline does not close: ${e instanceof Error ? e.message : String(e)}`,
      at: { x: 0, y: 0 },
      items: [],
    });
    return violations;
  }

  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      const corners = padOutline(c, pad);
      const outside = corners.some((p) => !pointInPolygon(p, poly));
      if (outside) {
        const ref = `${c.refdes}.${pad.number}`;
        violations.push({
          rule: 'outside-outline',
          message: `Pad ${ref} lies outside the board outline`,
          at: padWorld(c, pad).at,
          items: [ref],
        });
      }
    }
  }

  return violations;
}
