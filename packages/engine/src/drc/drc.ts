/**
 * Flamingo Engine - DRC Orchestrator
 * Units: mm
 */

import type { Board, ComponentInst, LayerId, Pad } from '../types.js';
import { copperLayersOf } from '../layers.js';
import { expandTrack, padOutline } from '../geometry.js';
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

/**
 * The physical copper layer(s) a pad occupies in world space, honoring the
 * bottom-side flip (mirrors connectivity.ts's private padLayers — kept in
 * sync manually since that helper isn't exported).
 */
function padPhysicalLayers(b: Board, comp: ComponentInst, pad: Pad): LayerId[] {
  if (pad.layer === 'through') return copperLayersOf(b);
  const physicalSide: 'top' | 'bottom' =
    comp.side === 'bottom' ? (pad.layer === 'top' ? 'bottom' : 'top') : pad.layer;
  return [physicalSide === 'top' ? 'F.Cu' : 'B.Cu'];
}

function netOfPin(b: Board, pinRef: string): string {
  const net = b.nets.find((n) => n.pins.includes(pinRef));
  return net ? net.name : '';
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

  for (const t of b.tracks) {
    items.push({ kind: 'track', net: t.net, ref: t.id, polygon: expandTrack(t), layer: t.layer });
  }

  for (const v of b.vias) {
    for (const layer of copperLayersOf(b)) {
      items.push({ kind: 'via', net: v.net, ref: v.id, polygon: circlePolygon(v.at, v.diameter / 2), layer });
    }
  }

  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      const layers = padPhysicalLayers(b, c, pad);
      const polygon = padOutline(c, pad);
      const ref = `${c.refdes}.${pad.number}`;
      const net = netOfPin(b, ref);
      for (const layer of layers) {
        items.push({ kind: 'pad', net, ref, polygon, layer });
      }
    }
  }

  for (const z of b.zones) {
    const polys = z.fill && z.fill.length > 0 ? z.fill : [z.polygon];
    for (const polygon of polys) {
      items.push({ kind: 'zone', net: z.net, ref: z.id, polygon, layer: z.layer });
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
