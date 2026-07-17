/**
 * DRC check: hole-to-hole spacing — a manufacturing/drilling constraint on
 * every pair of drilled features (vias, through-hole pads, mounting holes),
 * independent of net (even two same-net vias need physical separation).
 * Gap = center distance - (d1+d2)/2, where d1/d2 are drill diameters.
 */
import type { Board, Point } from '../../types.js';
import { dist, padWorld } from '../../geometry.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

interface Drilled {
  ref: string;
  at: Point;
  d: number;
}

export function check(b: Board, rules: RuleSet): DrcViolation[] {
  const drilled: Drilled[] = [];

  for (const v of b.vias) drilled.push({ ref: v.id, at: v.at, d: v.drill });

  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      if (!pad.drill) continue;
      drilled.push({ ref: `${c.refdes}.${pad.number}`, at: padWorld(c, pad).at, d: pad.drill.diameter });
    }
  }

  for (const h of b.holes) drilled.push({ ref: h.id, at: h.at, d: h.drill });

  const violations: DrcViolation[] = [];
  for (let i = 0; i < drilled.length; i++) {
    for (let j = i + 1; j < drilled.length; j++) {
      const a = drilled[i];
      const c = drilled[j];
      const gap = dist(a.at, c.at) - (a.d + c.d) / 2;
      if (gap < rules.holeToHole) {
        violations.push({
          rule: 'hole-to-hole',
          message: `${a.ref} and ${c.ref} hole edge-to-edge spacing ${gap.toFixed(2)}mm is below minimum ${rules.holeToHole.toFixed(2)}mm`,
          at: { x: (a.at.x + c.at.x) / 2, y: (a.at.y + c.at.y) / 2 },
          items: [a.ref, c.ref],
        });
      }
    }
  }

  return violations;
}
