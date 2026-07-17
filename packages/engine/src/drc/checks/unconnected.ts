/** DRC check: nets with more than one connected island (isFullyRouted). */
import type { Board, Point } from '../../types.js';
import { isFullyRouted, ratsnest } from '../../connectivity.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

export function check(b: Board, rules: RuleSet): DrcViolation[] {
  const violations: DrcViolation[] = [];
  const unrouted = isFullyRouted(b);
  if (unrouted.length === 0) return violations;

  const lines = ratsnest(b);
  for (const u of unrouted) {
    const line = lines.find((l) => l.net === u.net);
    const at: Point = line ? line.from : { x: 0, y: 0 };
    violations.push({
      rule: 'unconnected-net',
      message: `Net "${u.net}" has ${u.unconnected} unconnected island(s)`,
      at,
      items: [u.net],
    });
  }
  return violations;
}
