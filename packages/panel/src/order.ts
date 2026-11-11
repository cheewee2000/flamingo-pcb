/**
 * Flamingo Panel - from a panel to an order.
 *
 * Works out what ordering a given panel means: how many panels to fabricate
 * and assemble so that every design's needed quantity is met, which assembly
 * service can take it, what each design yields, and what it costs.
 */

import { assemblyFit, targetLayers } from './check.js';
import type { AssemblyType, PanelLimits } from './config.js';
import type { CostBreakdown, OrderConfig, OrderPart, OrderPiece } from './cost.js';
import { computeCost } from './cost.js';
import type { FeeTable } from './fees.js';
import { stepAtLeast } from './fees.js';
import type { PanelGeometry } from './geometry.js';
import type { ResolvedSources } from './resolved.js';
import type { PartLine } from './source.js';
import type { Panel } from './types.js';

/** What an order delivers of one design. */
export interface Received {
  key: string;
  name: string;
  needed: number;
  assembled: number;
  bare: number;
  /** Assembled boards beyond the needed quantity. */
  overage: number;
  /** Needed boards the order does not deliver. */
  shortfall: number;
}

export interface PieceCount {
  key: string;
  /** Instances of this design in one piece. */
  total: number;
  /** Of those, how many are assembled. */
  populated: number;
}

/** Merge the parts of every populated board in a piece into one list, by LCSC id. */
export function pieceParts(counts: PieceCount[], sources: ResolvedSources): OrderPart[] {
  const byLcsc = new Map<string, OrderPart>();
  for (const c of counts) {
    if (c.populated === 0) continue;
    const parts: PartLine[] = sources.find((s) => s.key === c.key)?.geometry?.parts ?? [];
    for (const p of parts) {
      const line = byLcsc.get(p.lcsc);
      if (line) {
        line.perPiece += p.count * c.populated;
        // One part, one truth: a price or basic flag known anywhere applies everywhere.
        if (line.unitPrice === undefined && p.unitPrice !== undefined) line.unitPrice = p.unitPrice;
        if (line.jlc === undefined && p.jlc !== undefined) line.jlc = p.jlc;
        line.basic = line.basic || p.basic;
      } else {
        byLcsc.set(p.lcsc, {
          lcsc: p.lcsc,
          basic: p.basic,
          perPiece: p.count * c.populated,
          smtJoints: p.smtJoints,
          thtJoints: p.thtJoints,
          value: p.value,
          ...(p.unitPrice !== undefined ? { unitPrice: p.unitPrice } : {}),
          ...(p.jlc !== undefined ? { jlc: p.jlc } : {}),
        });
      }
    }
  }
  return [...byLcsc.values()].sort((a, b) => a.lcsc.localeCompare(b.lcsc, undefined, { numeric: true }));
}

/** 2 when any populated board in the piece has parts on its bottom side. */
export function pieceSides(counts: PieceCount[], sources: ResolvedSources): 1 | 2 {
  return counts.some((c) => c.populated > 0 && sources.find((s) => s.key === c.key)?.geometry?.hasBottomParts)
    ? 2
    : 1;
}

export interface Eligibility {
  eligible: boolean;
  /** Why not, when not. */
  reason?: string;
}

/** Parts of the list that only Standard PCBA places, by JLCPCB's parts library. */
export function standardOnlyParts(parts: readonly OrderPart[]): OrderPart[] {
  return parts.filter((p) => p.jlc?.standardOnly === true);
}

/** Whether an assembly service can take this piece, with these parts, in this quantity. */
export function assemblyEligibility(
  type: AssemblyType,
  piece: OrderPiece,
  sides: 1 | 2,
  qty: number,
  hasRails: boolean,
  limits: PanelLimits,
  fees: FeeTable,
  parts: readonly OrderPart[] = [],
): Eligibility {
  const l = limits.assembly[type];
  const name = type === 'economic' ? 'Economic' : 'Standard';
  if (type === 'economic') {
    const only = standardOnlyParts(parts);
    if (only.length > 0) {
      const named = only.slice(0, 3).map((p) => p.lcsc);
      const more = only.length > 3 ? ` and ${only.length - 3} more` : '';
      return {
        eligible: false,
        reason: `Economic PCBA cannot place ${named.join(', ')}${more}: Standard only in JLCPCB's parts library`,
      };
    }
  }
  const panelized = piece.boards > 1 && piece.separation !== 'none' && piece.separation !== 'silk-divider';
  const fit = assemblyFit(piece.width, piece.height, panelized, limits)[type];
  if (!fit.fits) return { eligible: false, reason: `${name} PCBA: ${fit.reason}` };
  if (!l.layers.value.includes(piece.layers)) {
    return { eligible: false, reason: `${name} PCBA does not take ${piece.layers}-layer boards` };
  }
  if (sides > l.sides.value) {
    return { eligible: false, reason: `${name} PCBA places one side only` };
  }
  if (panelized && piece.separation !== 'none' && !l.separations.value.includes(piece.separation)) {
    return {
      eligible: false,
      reason: `${name} PCBA takes panels separated by ${l.separations.value.join(' or ')}, not ${piece.separation}`,
    };
  }
  if (panelized && l.railsRequired.value && !hasRails) {
    return { eligible: false, reason: `${name} PCBA needs edge rails and fiducials on a panel` };
  }
  const steps = fees.assembly[type].qtySteps.value;
  const lo = Math.max(l.quantity.value.min, steps.length > 0 ? Math.min(...steps) : 0);
  const hi = Math.min(l.quantity.value.max, steps.length > 0 ? Math.max(...steps) : Infinity);
  if (qty < lo || qty > hi) {
    return { eligible: false, reason: `${name} PCBA assembles ${lo} to ${hi} pieces per order` };
  }
  return { eligible: true };
}

export interface PricedOrder {
  order: OrderConfig;
  cost: CostBreakdown;
  /** Assembly services that could not take the order, and why. */
  rejected: string[];
}

/**
 * Price an order of `pcbQty` pieces, `asmQty` of them assembled, with whichever
 * eligible assembly service is cheaper. With no parts to place it is a
 * bare-board order. Returns null when parts need placing and no service can.
 */
export function priceOrder(
  label: string,
  piece: OrderPiece,
  pcbQty: number,
  asmQty: number,
  parts: OrderPart[],
  sides: 1 | 2,
  hasRails: boolean,
  limits: PanelLimits,
  fees: FeeTable,
): PricedOrder | { order: null; rejected: string[] } {
  if (parts.length === 0 || asmQty === 0) {
    const order: OrderConfig = { label, piece, pcbQty };
    return { order, cost: computeCost(order, fees), rejected: [] };
  }
  const rejected: string[] = [];
  let best: PricedOrder | null = null;
  for (const type of ['economic', 'standard'] as const) {
    const e = assemblyEligibility(type, piece, sides, asmQty, hasRails, limits, fees, parts);
    if (!e.eligible) {
      rejected.push(e.reason!);
      continue;
    }
    const order: OrderConfig = { label, piece, pcbQty, assembly: { type, qty: asmQty, sides, parts } };
    const cost = computeCost(order, fees);
    if (best === null || cost.total < best.cost.total) best = { order, cost, rejected };
  }
  if (best === null) return { order: null, rejected };
  best.rejected = rejected;
  return best;
}

/**
 * Smallest quantities that meet every target: `asm` pieces to assemble and
 * `pcb` pieces to fabricate. `targets` maps a design to the assembled boards
 * wanted; designs without parts are met by bare boards.
 */
export function quantitiesFor(
  counts: PieceCount[],
  targets: Map<string, number>,
  hasParts: (key: string) => boolean,
  fees: FeeTable,
): { pcb: number; asm: number } | { error: string } {
  let asmNeed = 0;
  let pcbNeed = 1;
  for (const c of counts) {
    const want = targets.get(c.key) ?? 0;
    if (want === 0) continue;
    if (hasParts(c.key)) {
      if (c.populated === 0) return { error: `no populated ${c.key} instance to meet the ${want} needed` };
      asmNeed = Math.max(asmNeed, Math.ceil(want / c.populated));
    } else {
      if (c.total === 0) return { error: `no ${c.key} instance to meet the ${want} needed` };
      pcbNeed = Math.max(pcbNeed, Math.ceil(want / c.total));
    }
  }
  const anyPopulated = counts.some((c) => c.populated > 0 && hasParts(c.key));
  let asm = 0;
  if (anyPopulated) {
    // Either service's steps will do here; the service is chosen by price later.
    const steps = [...new Set([...fees.assembly.economic.qtySteps.value, ...fees.assembly.standard.qtySteps.value])];
    const step = stepAtLeast(steps, Math.max(asmNeed, 1));
    if (step === null) return { error: `${asmNeed} pieces to assemble is more than JLCPCB's order form offers` };
    asm = step;
  }
  const pcb = stepAtLeast(fees.pcb.qtySteps.value, Math.max(pcbNeed, asm));
  if (pcb === null) return { error: `${Math.max(pcbNeed, asm)} pieces is more than JLCPCB's order form offers` };
  return { pcb, asm };
}

/** What `pcbQty` pieces, `asmQty` of them assembled, deliver of each design. */
export function receivedFor(
  panel: Pick<Panel, 'sources'>,
  counts: PieceCount[],
  pcbQty: number,
  asmQty: number,
  hasParts: (key: string) => boolean,
): Received[] {
  return panel.sources.map((s) => {
    const c = counts.find((x) => x.key === s.key) ?? { key: s.key, total: 0, populated: 0 };
    // A design without parts is complete as a bare board.
    const assembled = hasParts(s.key) ? c.populated * asmQty : c.total * pcbQty;
    const bare = hasParts(s.key) ? c.total * pcbQty - assembled : 0;
    return {
      key: s.key,
      name: s.name,
      needed: s.needed,
      assembled,
      bare,
      overage: Math.max(0, assembled - s.needed),
      shortfall: Math.max(0, s.needed - assembled),
    };
  });
}

export function countInstances(panel: Pick<Panel, 'sources' | 'instances'>): PieceCount[] {
  return panel.sources.map((s) => ({
    key: s.key,
    total: panel.instances.filter((i) => i.source === s.key).length,
    populated: panel.instances.filter((i) => i.source === s.key && i.populate).length,
  }));
}

/** Different designs JLCPCB would count on this panel. */
export function designsCharged(panel: Pick<Panel, 'instances' | 'settings'>, limits: PanelLimits): number {
  const designs = new Set(panel.instances.map((i) => i.source)).size;
  if (panel.settings.separation === 'silk-divider' && designs <= limits.silkDivider.freeDesigns.value) return 1;
  return Math.max(1, designs);
}

export interface PanelQuote {
  /** null when the panel cannot be ordered as it stands; `problems` says why. */
  order: OrderConfig | null;
  cost: CostBreakdown | null;
  received: Received[];
  problems: string[];
  notes: string[];
}

/**
 * The order the panel as it stands amounts to: enough panels to meet every
 * design's needed quantity, priced with the cheaper assembly service that can
 * take it.
 */
export function quotePanel(
  panel: Panel,
  sources: ResolvedSources,
  geometry: PanelGeometry,
  limits: PanelLimits,
  fees: FeeTable,
): PanelQuote {
  const counts = countInstances(panel);
  const hasParts = (key: string): boolean => (sources.find((s) => s.key === key)?.geometry?.parts.length ?? 0) > 0;
  const none = (problem: string): PanelQuote => ({
    order: null,
    cost: null,
    received: receivedFor(panel, counts, 0, 0, hasParts),
    problems: [problem],
    notes: [],
  });

  if (!geometry.frame || geometry.instances.length === 0) return none('The panel has no instances.');
  const layers = targetLayers(panel, sources);
  if (layers === null) {
    return none('The boards have different layer counts: promote the panel or split it before it can be priced.');
  }

  const targets = new Map(panel.sources.map((s) => [s.key, s.needed]));
  const problems: string[] = [];
  const notes: string[] = [];

  // A design that is needed but absent does not stop the quote: the panel is
  // priced for what it holds and the shortfall is reported.
  const present = counts.filter((c) => (hasParts(c.key) ? c.populated > 0 : c.total > 0));
  for (const c of counts) {
    const want = targets.get(c.key) ?? 0;
    if (want > 0 && !present.includes(c)) {
      problems.push(
        c.total === 0
          ? `${c.key}: ${want} needed, none on the panel`
          : `${c.key}: ${want} needed, but every instance on the panel is bare`,
      );
    }
  }
  const q = quantitiesFor(present, targets, hasParts, fees);
  if ('error' in q) return none(q.error);

  const piece: OrderPiece = {
    width: geometry.frame.width,
    height: geometry.frame.height,
    layers,
    boards: geometry.instances.length,
    designs: designsCharged(panel, limits),
    separation: geometry.instances.length > 1 ? panel.settings.separation : 'none',
  };
  const parts = pieceParts(counts, sources);
  const sides = pieceSides(counts, sources);
  const hasRails = geometry.rails.length > 0 && geometry.fiducials.length > 0;
  const priced = priceOrder(panel.name, piece, q.pcb, q.asm, parts, sides, hasRails, limits, fees);
  if (priced.order === null) {
    return {
      order: null,
      cost: null,
      received: receivedFor(panel, counts, q.pcb, 0, hasParts),
      problems: [...problems, 'No assembly service can take this panel.', ...priced.rejected],
      notes,
    };
  }
  notes.push(...priced.rejected.map((r) => `Not available: ${r}`));
  return {
    order: priced.order,
    cost: priced.cost,
    received: receivedFor(panel, counts, q.pcb, q.asm, hasParts),
    problems: [...problems, ...priced.cost.problems],
    notes: [...notes, ...priced.cost.notes],
  };
}
