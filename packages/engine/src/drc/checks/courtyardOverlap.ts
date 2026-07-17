/**
 * DRC check: courtyard overlap between components placed on the same side.
 * Components with an empty courtyard (no polygons defined) are skipped.
 */
import type { Board, ComponentInst, Point } from '../../types.js';
import { componentTransformPoints, polyIntersects } from '../../geometry.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

function centroid(poly: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

interface WithCourtyard {
  c: ComponentInst;
  polys: Point[][];
}

export function check(b: Board, rules: RuleSet): DrcViolation[] {
  const withCourtyard: WithCourtyard[] = b.components
    .map((c) => ({
      c,
      polys: c.footprint.courtyard.filter((p) => p.length > 0).map((p) => componentTransformPoints(c, p)),
    }))
    .filter((x) => x.polys.length > 0);

  const violations: DrcViolation[] = [];
  for (let i = 0; i < withCourtyard.length; i++) {
    for (let j = i + 1; j < withCourtyard.length; j++) {
      const a = withCourtyard[i];
      const bItem = withCourtyard[j];
      if (a.c.side !== bItem.c.side) continue;
      let overlapping = false;
      let at: Point | undefined;
      for (const pa of a.polys) {
        for (const pb of bItem.polys) {
          if (polyIntersects(pa, pb)) {
            overlapping = true;
            at = centroid(pa);
            break;
          }
        }
        if (overlapping) break;
      }
      if (overlapping) {
        violations.push({
          rule: 'courtyard-overlap',
          message: `Courtyards of ${a.c.refdes} and ${bItem.c.refdes} (${a.c.side}) overlap`,
          at: at!,
          items: [a.c.refdes, bItem.c.refdes],
        });
      }
    }
  }

  return violations;
}
