/**
 * Flamingo Engine - DRC Orchestrator
 * Units: mm
 */

import type { Board, Point } from '../types.js';
import { copperLayersOf, padCopperLayers } from '../layers.js';
import { expandTrack, padOutline } from '../geometry.js';
import type { PolyGroup } from '../geometry.js';
import { RULESETS } from './rules.js';
import type { RuleSet } from './rules.js';
import type { CopperItem, DrcViolation } from './types.js';
import { circlePolygon } from './util.js';

import { check as clearanceCheck } from './checks/clearance.js';
import { check as trackWidthCheck } from './checks/trackWidth.js';
import { check as drillCheck } from './checks/drill.js';
import { check as viaAnnularCheck } from './checks/viaAnnular.js';
import { check as viaDiameterCheck } from './checks/viaDiameter.js';
import { check as copperToEdgeCheck } from './checks/copperToEdge.js';
import { check as keepoutCheck } from './checks/keepout.js';
import { check as holeToHoleCheck } from './checks/holeToHole.js';
import { check as courtyardOverlapCheck } from './checks/courtyardOverlap.js';
import { check as silkOverPadCheck } from './checks/silkOverPad.js';
import { check as unconnectedCheck } from './checks/unconnected.js';
import { check as outlineCheck } from './checks/outline.js';

export type { RuleSet } from './rules.js';
export { RULESETS } from './rules.js';
export type { DrcViolation, CopperItem } from './types.js';

export { circlePolygon } from './util.js';

function netOfPin(b: Board, pinRef: string): string {
  const net = b.nets.find((n) => n.pins.includes(pinRef));
  return net ? net.name : '';
}

/** Signed area of a ring (CCW positive, y-up). */
function ringSignedArea(pts: Point[]): number {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * Decode a zone's winding-encoded fill (see zonefill.ts) into polygons-with-
 * holes. A CCW ring (signedArea > 0) opens a new solid group; a CW ring
 * (signedArea < 0) is a hole of the most recently opened group — matching the
 * documented "outer, then its holes" ordering. Defensive: a hole appearing
 * before any outer, or a degenerate ring, is skipped rather than trusted.
 */
export function groupFillRings(fill: Point[][]): PolyGroup[] {
  const groups: PolyGroup[] = [];
  for (const ring of fill) {
    if (ring.length < 3) continue; // degenerate
    const area = ringSignedArea(ring);
    if (area > 0) {
      groups.push({ outer: ring, holes: [] });
    } else if (area < 0) {
      if (groups.length === 0) continue; // hole before any outer — contract violation, skip
      groups[groups.length - 1].holes.push(ring);
    }
  }
  return groups;
}

/**
 * Build the per-layer copper item list once per DRC run: tracks, vias
 * (replicated across every copper layer), pads (replicated across every
 * copper layer they physically occupy), and zones (fill islands if present,
 * else the raw outline polygon). Checks that need copper geometry consume
 * this instead of recomputing pad outlines / track strokes themselves.
 */
export function buildCopperItems(b: Board): CopperItem[] {
  const items: CopperItem[] = [];
  const cu = copperLayersOf(b);

  for (const t of b.tracks) {
    items.push({ kind: 'track', net: t.net, ref: t.id, polygon: expandTrack(t), layer: t.layer });
  }

  for (const v of b.vias) {
    for (const layer of cu) {
      items.push({ kind: 'via', net: v.net, ref: v.id, polygon: circlePolygon(v.at, v.diameter / 2), layer });
    }
  }

  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      const layers = padCopperLayers(pad, c.side, cu);
      const polygon = padOutline(c, pad);
      const ref = `${c.refdes}.${pad.number}`;
      const net = netOfPin(b, ref);
      for (const layer of layers) {
        items.push({ kind: 'pad', net, ref, polygon, layer });
      }
    }
  }

  for (const z of b.zones) {
    if (z.fill && z.fill.length > 0) {
      // Winding-encoded fill: decode into outer+holes so hole rings (knockouts
      // around other-net copper) are treated as absence-of-copper, not solid.
      for (const group of groupFillRings(z.fill)) {
        items.push({ kind: 'zone', net: z.net, ref: z.id, polygon: group.outer, layer: z.layer, group });
      }
    } else {
      // Unfilled zone: fall back to the raw outline polygon (no holes).
      items.push({ kind: 'zone', net: z.net, ref: z.id, polygon: z.polygon, layer: z.layer });
    }
  }

  return items;
}

export type CheckFn = (b: Board, rules: RuleSet, items: CopperItem[]) => DrcViolation[];

const CHECKS: CheckFn[] = [
  clearanceCheck,
  trackWidthCheck,
  drillCheck,
  viaAnnularCheck,
  viaDiameterCheck,
  copperToEdgeCheck,
  keepoutCheck,
  holeToHoleCheck,
  courtyardOverlapCheck,
  silkOverPadCheck,
  unconnectedCheck,
  outlineCheck,
];

/** Run every DRC check against `b` and concatenate their violations. */
export function runDRC(b: Board): DrcViolation[] {
  const rules = RULESETS[b.rules];
  const items = buildCopperItems(b);
  const violations: DrcViolation[] = [];
  for (const check of CHECKS) {
    violations.push(...check(b, rules, items));
  }
  return violations;
}
