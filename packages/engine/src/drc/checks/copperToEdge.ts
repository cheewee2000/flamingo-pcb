/**
 * DRC check: copper-to-edge clearance — minimum distance from any copper
 * item's boundary to the board outline's boundary. Skipped entirely when
 * there's no outline (or it doesn't close) — that's the 'missing-outline'
 * check's job (see outline.ts).
 */
import type { Board, PathSeg, Point } from '../../types.js';
import { outlineToPolygon, segSegDistance } from '../../geometry.js';
import type { RuleSet } from '../rules.js';
import type { CopperItem, DrcViolation } from '../types.js';

/** Minimum distance between two closed polygon *boundaries* (ignores containment/overlap, unlike polyPolyDistance). */
function boundaryDistance(a: Point[], b: Point[]): { d: number; at: Point } {
  let best = Infinity;
  let at = a[0];
  const na = a.length;
  const nb = b.length;
  for (let i = 0; i < na; i++) {
    const segA: PathSeg = { type: 'line', start: a[i], end: a[(i + 1) % na] };
    for (let j = 0; j < nb; j++) {
      const segB: PathSeg = { type: 'line', start: b[j], end: b[(j + 1) % nb] };
      const d = segSegDistance(segA, segB);
      if (d < best) {
        best = d;
        at = { x: (segA.start.x + segB.start.x) / 2, y: (segA.start.y + segB.start.y) / 2 };
      }
    }
  }
  return { d: best, at };
}

export function check(b: Board, rules: RuleSet, items: CopperItem[]): DrcViolation[] {
  if (b.outline.length === 0) return [];
  let outlinePoly: Point[];
  try {
    outlinePoly = outlineToPolygon(b.outline);
  } catch {
    return []; // reported by the 'missing-outline' check instead
  }

  const violations: DrcViolation[] = [];
  for (const item of items) {
    const { d, at } = boundaryDistance(item.polygon, outlinePoly);
    if (d < rules.copperToEdge) {
      violations.push({
        rule: 'copper-to-edge',
        message: `${item.kind} ${item.ref} (net "${item.net}") on ${item.layer} is ${d.toFixed(2)}mm from the board edge, minimum is ${rules.copperToEdge.toFixed(2)}mm`,
        at,
        items: [item.ref],
      });
    }
  }
  return violations;
}
