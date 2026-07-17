/**
 * DRC check: drill diameter minimum, applied to vias, drilled (through-hole)
 * pads, and mounting holes alike.
 */
import type { Board } from '../../types.js';
import { padWorld } from '../../geometry.js';
import { DRC_EPSILON } from '../rules.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

export function check(b: Board, rules: RuleSet): DrcViolation[] {
  const violations: DrcViolation[] = [];

  for (const v of b.vias) {
    if (v.drill < rules.minDrill - DRC_EPSILON) {
      violations.push({
        rule: 'drill',
        message: `Via ${v.id} (net "${v.net}") drill ${v.drill.toFixed(2)}mm is below minimum ${rules.minDrill.toFixed(2)}mm`,
        at: v.at,
        items: [v.id],
      });
    }
  }

  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      if (!pad.drill) continue;
      if (pad.drill.diameter < rules.minDrill - DRC_EPSILON) {
        const ref = `${c.refdes}.${pad.number}`;
        violations.push({
          rule: 'drill',
          message: `Pad ${ref} drill ${pad.drill.diameter.toFixed(2)}mm is below minimum ${rules.minDrill.toFixed(2)}mm`,
          at: padWorld(c, pad).at,
          items: [ref],
        });
      }
    }
  }

  for (const h of b.holes) {
    if (h.drill < rules.minDrill - DRC_EPSILON) {
      violations.push({
        rule: 'drill',
        message: `Mounting hole ${h.id} drill ${h.drill.toFixed(2)}mm is below minimum ${rules.minDrill.toFixed(2)}mm`,
        at: h.at,
        items: [h.id],
      });
    }
  }

  return violations;
}
