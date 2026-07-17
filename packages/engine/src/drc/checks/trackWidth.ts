/**
 * DRC check: track width. Only the ruleset minimum is a DRC floor — a net
 * class's trackWidth is a routing preference, not a manufacturability
 * minimum, so it is intentionally not checked here.
 */
import type { Board } from '../../types.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

export function check(b: Board, rules: RuleSet): DrcViolation[] {
  const violations: DrcViolation[] = [];
  for (const t of b.tracks) {
    if (t.width < rules.minTrackWidth) {
      violations.push({
        rule: 'track-width',
        message: `Track ${t.id} (net "${t.net}") width ${t.width.toFixed(2)}mm is below minimum ${rules.minTrackWidth.toFixed(2)}mm`,
        at: { x: (t.seg.start.x + t.seg.end.x) / 2, y: (t.seg.start.y + t.seg.end.y) / 2 },
        items: [t.id],
      });
    }
  }
  return violations;
}
