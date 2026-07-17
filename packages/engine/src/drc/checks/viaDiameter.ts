/** DRC check: via pad diameter against the ruleset minimum. */
import type { Board } from '../../types.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

export function check(b: Board, rules: RuleSet): DrcViolation[] {
  const violations: DrcViolation[] = [];
  for (const v of b.vias) {
    if (v.diameter < rules.minViaDiameter) {
      violations.push({
        rule: 'via-diameter',
        message: `Via ${v.id} (net "${v.net}") diameter ${v.diameter.toFixed(2)}mm is below minimum ${rules.minViaDiameter.toFixed(2)}mm`,
        at: v.at,
        items: [v.id],
      });
    }
  }
  return violations;
}
