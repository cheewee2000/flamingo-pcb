/** DRC check: via annular ring, (diameter - drill) / 2, against the ruleset minimum. */
import type { Board } from '../../types.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

export function check(b: Board, rules: RuleSet): DrcViolation[] {
  const violations: DrcViolation[] = [];
  for (const v of b.vias) {
    const annular = (v.diameter - v.drill) / 2;
    if (annular < rules.minAnnular) {
      violations.push({
        rule: 'via-annular',
        message: `Via ${v.id} (net "${v.net}") annular ring ${annular.toFixed(2)}mm is below minimum ${rules.minAnnular.toFixed(2)}mm`,
        at: v.at,
        items: [v.id],
      });
    }
  }
  return violations;
}
