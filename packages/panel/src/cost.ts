/**
 * Flamingo Panel - cost model.
 *
 * `computeCost(order, fees)` is a pure function from one order and the fee
 * table to an itemized cost. It holds no prices of its own and does no I/O, so
 * it can run on every edit.
 *
 * An order is what JLCPCB calls one: a quantity of identical pieces (a piece is
 * a single board or one panel), optionally assembled. Every line says whether
 * it rests on an unverified number; if any line does, so does the total.
 *
 * Not modelled: shipping, tax, duties, coupons, surface finish and colour
 * upcharges, and lead-time options.
 */

import type { AssemblyType, Sourced } from './config.js';
import type { AttritionRule, FeeTable } from './fees.js';
import type { Separation } from './types.js';

/** One step of JLCPCB's assembly price for a part: `price` USD each from `from` units up to `to` (null: no upper bound). */
export interface PriceTier {
  from: number;
  to: number | null;
  price: number;
}

/**
 * What JLCPCB's parts library says about a part, as the cost model uses it.
 * These are JLCPCB's own numbers for the part on the day they were looked
 * up, not estimates: the price tiers it bills assembly parts at, the spares
 * it adds and the least it bills, and whether only Standard PCBA places it.
 */
export interface JlcPart {
  basic: boolean;
  /** Economic PCBA cannot place the part. */
  standardOnly: boolean;
  /** Ascending by `from`. */
  prices?: PriceTier[];
  attrition?: { loss: number; minimum: number };
}

export const JLC_PARTS_LIBRARY = 'https://jlcpcb.com/parts';

export interface OrderPart {
  lcsc: string;
  /** JLCPCB basic part. */
  basic: boolean;
  /** How many of this part one piece carries. */
  perPiece: number;
  /** Surface-mount joints per part. */
  smtJoints: number;
  /** Through-hole joints per part. */
  thtJoints: number;
  /** USD each, from the EasyEDA part data; used when `jlc` has no prices. Absent = unknown: the line is listed at 0 and flagged. */
  unitPrice?: number;
  /** JLCPCB's parts-library data for the part, when it was looked up and is listed. */
  jlc?: JlcPart;
  value?: string;
}

export interface OrderPiece {
  /** Size of one piece, mm. */
  width: number;
  height: number;
  layers: 2 | 4 | 6;
  /** Boards in one piece (1 for a single board). */
  boards: number;
  /** Different designs JLCPCB would count in one piece. */
  designs: number;
  /** How the boards in a piece are held together; `none` for a single board. */
  separation: 'none' | Separation;
}

export interface OrderAssembly {
  type: AssemblyType;
  /** Pieces to assemble; at most the ordered quantity. */
  qty: number;
  sides: 1 | 2;
  parts: OrderPart[];
}

export interface OrderConfig {
  label: string;
  piece: OrderPiece;
  /** Pieces to fabricate. */
  pcbQty: number;
  assembly?: OrderAssembly;
}

export type CostCode =
  | 'pcb'
  | 'pcb-designs'
  | 'pcb-deburr'
  | 'asm-setup'
  | 'asm-stencil'
  | 'asm-smt'
  | 'asm-tht'
  | 'asm-hand-labor'
  | 'asm-loading'
  | 'asm-panel'
  | 'asm-large'
  | 'part';

export interface CostLine {
  code: CostCode;
  label: string;
  /** USD, rounded to the cent. */
  amount: number;
  /** Rests on at least one unverified number. */
  estimate: boolean;
  /** Where the numbers behind this line come from. */
  sources: string[];
  detail?: string;
}

export interface CostBreakdown {
  label: string;
  currency: string;
  lines: CostLine[];
  total: number;
  /** true when any line is an estimate. */
  estimate: boolean;
  /** Reasons the order cannot be placed as configured. A total is still computed. */
  problems: string[];
  /** Things to know that are not problems. */
  notes: string[];
}

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

function mm(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** A line's estimate flag and sources, from the fee entries it used. */
function basis(...entries: Array<Sourced<unknown>>): { estimate: boolean; sources: string[] } {
  return {
    estimate: entries.some((e) => !e.verified),
    sources: [...new Set(entries.map((e) => e.source))],
  };
}

function layerKey(layers: number): '2' | '4' | '6' {
  return String(layers) as '2' | '4' | '6';
}

/** Bare-board price of `qty` pieces, before any surcharge. */
export function boardPrice(
  piece: Pick<OrderPiece, 'width' | 'height' | 'layers'>,
  qty: number,
  fees: FeeTable,
): { amount: number; detail: string; used: Array<Sourced<unknown>> } {
  const key = layerKey(piece.layers);
  const { promo, engineeringFee, areaRate } = fees.pcb;
  const max = promo.maxSize.value;
  const long = Math.max(piece.width, piece.height);
  const short = Math.min(piece.width, piece.height);
  const fitsPromo = long <= Math.max(max.width, max.height) + 1e-6 && short <= Math.min(max.width, max.height) + 1e-6;

  const areaM2 = (piece.width * piece.height * qty) / 1e6;
  const tiers = areaRate[key].value;
  const tier = tiers.find((t) => t.upToM2 === null || areaM2 <= t.upToM2) ?? tiers[tiers.length - 1]!;
  const byArea = engineeringFee[key].value + areaM2 * tier.perM2;

  if (fitsPromo) {
    const offer = promo.prices[key].value.find((p) => p.qty === qty);
    // The offer is a floor price, never a penalty.
    if (offer && offer.price <= byArea) {
      return {
        amount: offer.price,
        detail: `special offer for boards up to ${max.width} x ${max.height} mm`,
        used: [promo.maxSize, promo.prices[key]],
      };
    }
  }
  return {
    amount: byArea,
    detail: `${engineeringFee[key].value.toFixed(2)} + ${areaM2.toFixed(4)} m2 x ${tier.perM2.toFixed(2)}/m2`,
    used: [engineeringFee[key], areaRate[key]],
  };
}

/** Quantity billed for one part line, given the quantity actually placed. */
export function billedQuantity(
  used: number,
  joints: number,
  rules: AttritionRule[],
): { qty: number; extra: number; minimum: number; kind: string } {
  const rule = rules.find((r) => r.maxJoints === null || joints <= r.maxJoints) ?? rules[rules.length - 1];
  if (!rule) return { qty: used, extra: 0, minimum: 0, kind: 'no rule' };
  return { qty: Math.max(rule.minimum, used + rule.extra), extra: rule.extra, minimum: rule.minimum, kind: rule.kind };
}

/** JLCPCB's price each for `qty` units of a part, from its tiers; undefined with no tiers. */
export function tierPrice(tiers: readonly PriceTier[] | undefined, qty: number): number | undefined {
  if (!tiers || tiers.length === 0) return undefined;
  let price: number | undefined;
  for (const t of tiers) {
    if (qty >= t.from) price = t.price;
  }
  return price ?? tiers[0]!.price;
}

export function computeCost(order: OrderConfig, fees: FeeTable): CostBreakdown {
  const lines: CostLine[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const { piece, pcbQty } = order;

  if (!(pcbQty > 0)) problems.push('the order quantity must be at least 1');
  const pcbSteps = fees.pcb.qtySteps.value;
  if (pcbSteps.length > 0 && !pcbSteps.includes(pcbQty)) {
    notes.push(`${pcbQty} is not one of the order quantities JLCPCB offers (${pcbSteps.slice(0, 6).join(', ')}, ...)`);
  }

  // --- bare boards ---------------------------------------------------------
  const what = piece.boards > 1 ? 'panels' : 'boards';
  const board = boardPrice(piece, pcbQty, fees);
  lines.push({
    code: 'pcb',
    label: `${pcbQty} ${what}, ${mm(piece.width)} x ${mm(piece.height)} mm, ${piece.layers}-layer`,
    amount: cents(board.amount),
    detail: board.detail,
    // No bare-board price is published outside the quote calculator.
    ...basis(...board.used),
  });

  const dd = fees.pcb.differentDesigns;
  if (piece.designs > 1) {
    if (piece.designs > dd.maxDesigns.value) {
      problems.push(`${piece.designs} different designs in one file; JLCPCB allows ${dd.maxDesigns.value}`);
    }
    lines.push({
      code: 'pcb-designs',
      label: `Different designs: ${piece.designs} in one file`,
      amount: cents((piece.designs - 1) * dd.perExtraDesign.value),
      detail: `${piece.designs - 1} extra x ${dd.perExtraDesign.value.toFixed(2)}`,
      ...basis(dd.perExtraDesign),
    });
  } else if (piece.separation === 'silk-divider' && piece.boards > 1) {
    notes.push('Boards divided by silkscreen lines only count as one design; you cut them apart yourself.');
  }

  const shortSide = Math.min(piece.width, piece.height);
  const deburr = [...fees.pcb.smallBoardDeburring.value]
    .sort((a, b) => a.underMm - b.underMm)
    .find((d) => shortSide < d.underMm);
  if (deburr) {
    lines.push({
      code: 'pcb-deburr',
      label: `Small-board deburring (a side under ${deburr.underMm} mm)`,
      amount: cents(deburr.perPiece * pcbQty),
      detail: `${pcbQty} x ${deburr.perPiece.toFixed(2)}`,
      ...basis(fees.pcb.smallBoardDeburring),
    });
  }

  // --- assembly ------------------------------------------------------------
  const asm = order.assembly;
  if (asm && asm.parts.length > 0) {
    const f = fees.assembly[asm.type];
    const name = asm.type === 'economic' ? 'Economic' : 'Standard';
    const sideKey = asm.sides === 2 ? 'double' : 'single';

    if (asm.qty > pcbQty) {
      problems.push(`${asm.qty} ${what} to assemble, but only ${pcbQty} ordered`);
    }
    const steps = f.qtySteps.value;
    if (steps.length > 0) {
      const lo = Math.min(...steps);
      const hi = Math.max(...steps);
      if (asm.qty < lo || asm.qty > hi) {
        problems.push(`${name} PCBA assembles ${lo} to ${hi} pieces per order; ${asm.qty} asked for`);
      } else if (!steps.includes(asm.qty)) {
        notes.push(`${asm.qty} is not one of the assembly quantities JLCPCB offers`);
      }
    }

    const setup = f.setupFee.value[sideKey];
    const stencil = f.stencil.value[sideKey];
    if (setup === null || stencil === null) {
      problems.push(`${name} PCBA places one side only; this order has parts on both`);
    }
    lines.push({
      code: 'asm-setup',
      label: `${name} PCBA setup${asm.sides === 2 ? ', both sides' : ''}`,
      amount: cents(setup ?? f.setupFee.value.single),
      ...basis(f.setupFee),
    });
    lines.push({
      code: 'asm-stencil',
      label: `Stencil${asm.sides === 2 ? ', both sides' : ''}`,
      amount: cents(stencil ?? f.stencil.value.single),
      ...basis(f.stencil),
    });

    const smtJoints = asm.parts.reduce((n, p) => n + p.smtJoints * p.perPiece, 0) * asm.qty;
    if (smtJoints > 0) {
      const tiers = f.smtJoint.value;
      const tier = tiers.find((t) => smtJoints <= t.upTo) ?? tiers[tiers.length - 1]!;
      lines.push({
        code: 'asm-smt',
        label: `SMT joints: ${smtJoints}`,
        amount: cents(smtJoints * tier.price),
        detail: `${smtJoints} x ${tier.price}`,
        ...basis(f.smtJoint),
      });
    }

    const thtJoints = asm.parts.reduce((n, p) => n + p.thtJoints * p.perPiece, 0) * asm.qty;
    if (thtJoints > 0) {
      lines.push({
        code: 'asm-tht',
        label: `Through-hole joints: ${thtJoints}`,
        amount: cents(thtJoints * fees.assembly.manualJoint.value),
        detail: `${thtJoints} x ${fees.assembly.manualJoint.value}`,
        ...basis(fees.assembly.manualJoint),
      });
      lines.push({
        code: 'asm-hand-labor',
        label: 'Hand-soldering labour',
        amount: cents(fees.assembly.handSolderLabor.value),
        ...basis(fees.assembly.handSolderLabor),
      });
      notes.push(
        'Through-hole joints are counted from plated through-hole pads, including the mounting legs of surface-mount connectors. JLCPCB may not charge those as hand-soldered.',
      );
    }

    const basic = asm.parts.filter((p) => p.basic).length;
    const extended = asm.parts.length - basic;
    const loading = basic * f.feederLoading.value.basic + extended * f.feederLoading.value.extended;
    if (loading > 0) {
      const bits: string[] = [];
      if (extended > 0) bits.push(`${extended} extended x ${f.feederLoading.value.extended.toFixed(2)}`);
      if (basic > 0 && f.feederLoading.value.basic > 0) bits.push(`${basic} basic x ${f.feederLoading.value.basic.toFixed(2)}`);
      lines.push({
        code: 'asm-loading',
        label: `Feeder loading (${extended} extended, ${basic} basic)`,
        amount: cents(loading),
        detail: bits.join(' + '),
        ...basis(f.feederLoading),
      });
    }

    const panelized = piece.boards > 1 && piece.separation !== 'none' && piece.separation !== 'silk-divider';
    if (panelized) {
      lines.push({
        code: 'asm-panel',
        label: 'Panel fee',
        amount: cents(fees.assembly.panelFee.value),
        ...basis(fees.assembly.panelFee),
      });
    }

    const areaCm2 = (piece.width * piece.height) / 100;
    if (areaCm2 > fees.assembly.largePcb.value.overCm2) {
      lines.push({
        code: 'asm-large',
        label: `Large board (over ${fees.assembly.largePcb.value.overCm2} cm2)`,
        amount: cents(fees.assembly.largePcb.value.fee),
        ...basis(fees.assembly.largePcb),
      });
    }

    // --- parts -------------------------------------------------------------
    const rules = fees.parts.attrition.value;
    const unknown: string[] = [];
    for (const p of asm.parts) {
      const used = p.perPiece * asm.qty;
      const name2 = p.value ? `${p.lcsc} ${p.value}` : p.lcsc;
      // JLCPCB's own attrition for the part when known, the fee table's classes when not.
      const attrition = p.jlc?.attrition;
      const billed = attrition
        ? {
            qty: Math.max(attrition.minimum, used + attrition.loss),
            kind: `JLCPCB: +${attrition.loss} spare, at least ${attrition.minimum}`,
            fromLibrary: true,
          }
        : { ...billedQuantity(used, p.smtJoints + p.thtJoints, rules), fromLibrary: false };
      const attritionSource = billed.fromLibrary ? JLC_PARTS_LIBRARY : fees.parts.attrition.source;
      const jlcPrice = tierPrice(p.jlc?.prices, billed.qty);
      if (jlcPrice !== undefined) {
        lines.push({
          code: 'part',
          label: `${name2} x ${billed.qty}`,
          amount: cents(billed.qty * jlcPrice),
          // JLCPCB's assembly price for the part, read from its parts library.
          estimate: !billed.fromLibrary,
          sources: [...new Set([JLC_PARTS_LIBRARY, attritionSource])],
          detail: `${used} used, billed ${billed.qty} (${billed.kind}) x ${jlcPrice.toFixed(4)} JLCPCB`,
        });
        continue;
      }
      if (p.unitPrice === undefined) {
        unknown.push(p.lcsc);
        lines.push({
          code: 'part',
          label: `${name2} x ${billed.qty}`,
          amount: 0,
          estimate: true,
          sources: [attritionSource],
          detail: `${used} used + spares; unit price unknown, not in the total`,
        });
        continue;
      }
      lines.push({
        code: 'part',
        label: `${name2} x ${billed.qty}`,
        amount: cents(billed.qty * p.unitPrice),
        // Prices come from the EasyEDA part data, not JLCPCB's assembly quote.
        estimate: true,
        sources: [attritionSource, 'EasyEDA/LCSC part data'],
        detail: `${used} used, billed ${billed.qty} (${billed.kind}) x ${p.unitPrice.toFixed(4)}`,
      });
    }
    if (unknown.length > 0) {
      notes.push(`No price for ${unknown.join(', ')}: ${unknown.length === 1 ? 'it is' : 'they are'} left out of the total.`);
    }
  }

  const total = cents(lines.reduce((s, l) => s + l.amount, 0));
  return {
    label: order.label,
    currency: fees.currency,
    lines,
    total,
    estimate: lines.some((l) => l.estimate),
    problems,
    notes,
  };
}
