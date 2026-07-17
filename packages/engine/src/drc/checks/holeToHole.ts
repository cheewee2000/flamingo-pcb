/**
 * DRC check: hole-to-hole spacing — a manufacturing/drilling constraint on
 * every pair of drilled features (vias, through-hole pads, mounting holes),
 * independent of net (even two same-net vias need physical separation).
 * Each feature is a capsule: a drill centerline segment (a point for round
 * holes, the slot centerline for milled slots) swept by its drill radius.
 * Gap = segment-to-segment distance - (d1+d2)/2, where d1/d2 are drill diameters.
 */
import type { Board, PathSeg, Point } from '../../types.js';
import { padWorld, segSegDistance, holeSlotCenterline } from '../../geometry.js';
import { DRC_EPSILON } from '../rules.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

interface Drilled {
  ref: string;
  start: Point;
  end: Point;
  d: number;
}

function seg(dr: Drilled): PathSeg {
  return { type: 'line', start: dr.start, end: dr.end };
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function check(b: Board, rules: RuleSet): DrcViolation[] {
  const drilled: Drilled[] = [];

  for (const v of b.vias) drilled.push({ ref: v.id, start: v.at, end: v.at, d: v.drill });

  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      if (!pad.drill) continue;
      const at = padWorld(c, pad).at;
      drilled.push({ ref: `${c.refdes}.${pad.number}`, start: at, end: at, d: pad.drill.diameter });
    }
  }

  for (const h of b.holes) {
    const { start, end } = holeSlotCenterline(h);
    drilled.push({ ref: h.id, start, end, d: h.drill });
  }

  const violations: DrcViolation[] = [];
  for (let i = 0; i < drilled.length; i++) {
    for (let j = i + 1; j < drilled.length; j++) {
      const a = drilled[i];
      const c = drilled[j];
      const gap = segSegDistance(seg(a), seg(c)) - (a.d + c.d) / 2;
      if (gap < rules.holeToHole - DRC_EPSILON) {
        violations.push({
          rule: 'hole-to-hole',
          message: `${a.ref} and ${c.ref} hole edge-to-edge spacing ${gap.toFixed(2)}mm is below minimum ${rules.holeToHole.toFixed(2)}mm`,
          at: mid(mid(a.start, a.end), mid(c.start, c.end)),
          items: [a.ref, c.ref],
        });
      }
    }
  }

  return violations;
}
