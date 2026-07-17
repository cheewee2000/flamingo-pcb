/**
 * DRC check: net-to-net copper clearance.
 *
 * Pairwise different-net copper items on the same layer; distance is the
 * polygon-to-polygon minimum boundary distance (polyPolyDistance). Required
 * clearance is max(ruleset floor, either item's net-class clearance). A
 * cheap bbox prefilter (expanded by the required clearance) skips the exact
 * polygon math for pairs that can't possibly violate.
 */
import type { Board, Point } from '../../types.js';
import { bboxOf, polyPolyDistance } from '../../geometry.js';
import type { RuleSet } from '../rules.js';
import type { CopperItem, DrcViolation } from '../types.js';

function netClearance(b: Board, net: string): number {
  if (!net) return 0;
  const n = b.nets.find((x) => x.name === net);
  if (!n) return 0;
  const cls = b.netClasses.find((c) => c.name === n.class);
  return cls ? cls.clearance : 0;
}

function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-18) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Approximate representative point for a violation: midpoint of the closest vertex/edge pair found. */
function closestApproach(a: Point[], b: Point[]): Point {
  let best = Infinity;
  let at = a[0];
  for (const pa of a) {
    for (let j = 0; j < b.length; j++) {
      const cp = closestPointOnSegment(pa, b[j], b[(j + 1) % b.length]);
      const d = Math.hypot(pa.x - cp.x, pa.y - cp.y);
      if (d < best) {
        best = d;
        at = { x: (pa.x + cp.x) / 2, y: (pa.y + cp.y) / 2 };
      }
    }
  }
  for (const pb of b) {
    for (let i = 0; i < a.length; i++) {
      const cp = closestPointOnSegment(pb, a[i], a[(i + 1) % a.length]);
      const d = Math.hypot(pb.x - cp.x, pb.y - cp.y);
      if (d < best) {
        best = d;
        at = { x: (pb.x + cp.x) / 2, y: (pb.y + cp.y) / 2 };
      }
    }
  }
  return at;
}

export function check(b: Board, rules: RuleSet, items: CopperItem[]): DrcViolation[] {
  const violations: DrcViolation[] = [];
  const withBbox = items.map((it) => ({ it, bbox: bboxOf(it.polygon) }));

  for (let i = 0; i < withBbox.length; i++) {
    for (let j = i + 1; j < withBbox.length; j++) {
      const a = withBbox[i];
      const c = withBbox[j];
      if (a.it.layer !== c.it.layer) continue;
      if (a.it.net === c.it.net) continue; // same-net (or both unassigned) — not a clearance violation

      const required = Math.max(rules.minClearance, netClearance(b, a.it.net), netClearance(b, c.it.net));

      if (
        a.bbox.minX - required > c.bbox.maxX ||
        c.bbox.minX - required > a.bbox.maxX ||
        a.bbox.minY - required > c.bbox.maxY ||
        c.bbox.minY - required > a.bbox.maxY
      ) {
        continue; // bbox prefilter: can't possibly be closer than `required`
      }

      const d = polyPolyDistance(a.it.polygon, c.it.polygon);
      if (d < required) {
        violations.push({
          rule: 'clearance',
          message:
            `${a.it.kind} ${a.it.ref} (net "${a.it.net}") and ${c.it.kind} ${c.it.ref} ` +
            `(net "${c.it.net}") on ${a.it.layer}: clearance ${d.toFixed(2)}mm is below required ${required.toFixed(2)}mm`,
          at: closestApproach(a.it.polygon, c.it.polygon),
          items: [a.it.ref, c.it.ref],
        });
      }
    }
  }

  return violations;
}
