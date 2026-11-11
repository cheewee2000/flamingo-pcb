/**
 * Flamingo Panel - scenario optimizer.
 *
 * Given the boards and how many of each are needed, enumerate a small,
 * discrete set of ways to order them and price each one:
 *
 *   separate      every design as its own single-board order
 *   own-panels    every design on a panel of its own
 *   merged        all designs on one mouse-bite panel (different-designs fee),
 *                 or a V-cut panel when the panel is set to V-cut
 *   silk-divider  all designs inside one rectangular outline, divided by
 *                 silkscreen lines (one design as far as JLCPCB is concerned)
 *   split         one panel per layer count, when the boards differ in layers
 *
 * Merged and silk-divider scenarios come in one variant per useful panel
 * count (2 panels of 3 boards, 5 panels of 1, ...). Boards with different
 * layer counts can only share a panel promoted to the highest count; `split`
 * is the alternative.
 *
 * Nothing here talks to JLCPCB. Every price comes from the fee table.
 */

import { checkPanel } from './check.js';
import type { PanelLimits } from './config.js';
import type { CostLine, OrderPiece } from './cost.js';
import type { FeeTable } from './fees.js';
import { stepAtLeast } from './fees.js';
import { computeGeometry } from './geometry.js';
import type { PanelGeometry } from './geometry.js';
import { arrange } from './layout.js';
import type { ArrangeResult } from './layout.js';
import { applyPanelOp } from './ops.js';
import type { PanelOp, SettingsPatch } from './ops.js';
import type { PieceCount, PricedOrder, Received } from './order.js';
import { designsCharged, pieceParts, pieceSides, priceOrder } from './order.js';
import { newPanel } from './panel.js';
import type { ResolvedSources } from './resolved.js';
import type { Panel, PanelInstance, PanelSettings, PanelSource, Separation } from './types.js';

export type Objective = 'total' | 'per-board' | 'overage';

export const OBJECTIVES: readonly Objective[] = ['total', 'per-board', 'overage'];

export type ScenarioKind = 'separate' | 'own-panels' | 'merged' | 'silk-divider' | 'split';

export interface ScenarioLayout {
  instances: PanelInstance[];
  /** Settings that differ from the panel's: separation, rails, layer count. */
  settings: SettingsPatch;
  width: number;
  height: number;
}

export interface ScenarioOrder {
  label: string;
  /** Design keys in this order. */
  designs: string[];
  /** One piece is a panel (true) or a single board (false). */
  panel: boolean;
  priced: PricedOrder;
  /** Boards of each design in one piece. */
  counts: PieceCount[];
  layout: ScenarioLayout | null;
  /**
   * One piece of this order as a shape: the panel, or for an order of single
   * boards the board on its own. What a client draws to show the order.
   */
  plate: PanelGeometry;
}

export interface ScenarioLine extends CostLine {
  /** Label of the order the line belongs to. */
  order: string;
}

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  title: string;
  /** One sentence on what gets ordered. */
  summary: string;
  orders: ScenarioOrder[];
  total: number;
  /** Total over the needed boards the order delivers. */
  costPerNeededBoard: number;
  received: Received[];
  lines: ScenarioLine[];
  /** Rests on at least one unverified number. */
  estimate: boolean;
  /** Layer count the panel was promoted to, when it was. */
  promotedTo?: 2 | 4 | 6;
  warnings: string[];
  /** The panel to load onto the plate: the first panel among the orders. */
  layout: ScenarioLayout | null;
}

export interface RejectedScenario {
  id: string;
  title: string;
  reason: string;
}

export interface QuoteResult {
  objective: Objective;
  /** Ranked best first. */
  scenarios: Scenario[];
  rejected: RejectedScenario[];
  /** Milliseconds spent enumerating and pricing. */
  elapsedMs: number;
}

export interface QuoteRequest {
  name: string;
  /** Designs and quantities. Designs with nothing needed are ignored. */
  sources: PanelSource[];
  resolved: ResolvedSources;
  /** Settings panels are built with (rails, spacing, tabs). */
  settings: PanelSettings;
  limits: PanelLimits;
  fees: FeeTable;
  objective?: Objective;
}

/** At most this many panel counts are tried per family. */
const MAX_PANEL_COUNTS = 6;

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

interface Ctx {
  req: QuoteRequest;
  wanted: PanelSource[];
  hasParts: (key: string) => boolean;
  rejected: RejectedScenario[];
}

function received(ctx: Ctx, orders: ScenarioOrder[]): Received[] {
  return ctx.wanted.map((s) => {
    let assembled = 0;
    let bare = 0;
    for (const o of orders) {
      const c = o.counts.find((x) => x.key === s.key);
      if (!c) continue;
      const pcb = o.priced.order.pcbQty;
      const asm = o.priced.order.assembly?.qty ?? 0;
      if (ctx.hasParts(s.key)) {
        assembled += c.populated * asm;
        bare += c.total * pcb - c.populated * asm;
      } else {
        assembled += c.total * pcb; // nothing to place: a bare board is a finished board
      }
    }
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

/** Panel counts worth trying: steps up to the first at which every design needs one board per panel. */
function panelCounts(targets: number[], steps: number[]): number[] {
  const sorted = [...new Set(steps)].sort((a, b) => a - b);
  const out: number[] = [];
  let last = '';
  for (const p of sorted) {
    const perPanel = targets.map((t) => Math.ceil(t / p));
    const key = perPanel.join(',');
    if (key !== last) out.push(p);
    last = key;
    if (perPanel.every((n) => n <= 1) || out.length >= MAX_PANEL_COUNTS) break;
  }
  return out;
}

interface PanelPlan {
  designs: PanelSource[];
  /** Boards of each design per panel. */
  counts: PieceCount[];
  separation: Separation;
  /** Layer count to build at; `auto` when the designs agree. */
  layers: 'auto' | 2 | 4 | 6;
  pcbQty: number;
  asmQty: number;
  label: string;
}

function settingsFor(
  base: PanelSettings,
  plan: Pick<PanelPlan, 'separation' | 'layers'>,
  limits: PanelLimits,
): SettingsPatch {
  if (plan.separation === 'silk-divider') {
    return {
      separation: 'silk-divider',
      rails: { top: 0, bottom: 0, left: 0, right: 0 },
      fiducials: { enabled: false },
      toolingHoles: { enabled: false },
      copperLayers: plan.layers,
    };
  }
  // A mouse-bite or V-cut panel needs something to hold its boards: give it
  // top and bottom rails of the recommended width if the panel's settings have none.
  const noRails = base.rails.top + base.rails.bottom + base.rails.left + base.rails.right === 0;
  return {
    separation: plan.separation,
    rails: noRails ? { top: limits.rails.width.value, bottom: limits.rails.width.value, left: 0, right: 0 } : { ...base.rails },
    fiducials: { enabled: true },
    toolingHoles: { enabled: true },
    copperLayers: plan.layers,
  };
}

/**
 * The same panel is packed again and again: every quantity asks for the same
 * few layouts (so many of each board per panel), and nesting outlines is
 * slow. Layouts are kept by what they depend on, newest last.
 */
const packings = new Map<string, ArrangeResult>();
const PACKINGS_KEPT = 400;

function arrangeCached(panel: Panel, resolved: ResolvedSources, limits: PanelLimits): ArrangeResult {
  const key = JSON.stringify([
    panel.settings,
    panel.instances.map((i) => [i.source, i.rotation, i.populate]),
    resolved.map((r) => [r.key, r.hash]),
  ]);
  const hit = packings.get(key);
  if (hit) return hit;
  const result = arrange(panel, resolved, limits);
  if (packings.size >= PACKINGS_KEPT) packings.delete(packings.keys().next().value!);
  packings.set(key, result);
  return result;
}

/** Build, arrange, check and price one panel. Returns the reason when it cannot be done. */
function planPanel(ctx: Ctx, plan: PanelPlan): ScenarioOrder | string {
  const { req } = ctx;
  const patch = settingsFor(req.settings, plan, req.limits);
  const ops: PanelOp[] = [{ op: 'setSettings', settings: patch }];
  for (const s of plan.designs) {
    ops.push({
      op: 'addSource',
      source: { key: s.key, path: s.path, hash: s.hash, name: s.name, needed: s.needed },
    });
  }
  for (const c of plan.counts) {
    for (let i = 0; i < c.total; i++) {
      ops.push({ op: 'addInstance', source: c.key, populate: i < c.populated });
    }
  }
  let panel: Panel = newPanel(req.name, req.settings);
  for (const op of ops) {
    const r = applyPanelOp(panel, op);
    if (!r.ok) return r.error;
    panel = r.panel;
  }

  const resolved = req.resolved.filter((r) => plan.designs.some((d) => d.key === r.key));
  const unresolved = resolved.find((r) => !r.geometry);
  if (unresolved) return `${unresolved.key}: ${unresolved.error ?? 'not resolved'}`;

  const packed = arrangeCached(panel, resolved, req.limits);
  if (!packed.ok) return packed.reason;
  const placed = applyPanelOp(panel, { op: 'placeInstances', placements: packed.placements });
  if (!placed.ok) return placed.error;
  panel = placed.panel;

  const geometry = computeGeometry(panel, resolved);
  const errors = checkPanel(panel, resolved, req.limits, geometry).filter(
    (i) => i.severity === 'error' && i.code !== 'source-missing',
  );
  if (errors.length > 0) return errors[0]!.message;
  if (!geometry.frame) return 'nothing to place';

  const layers = plan.layers === 'auto' ? resolved[0]!.geometry!.copperLayers : plan.layers;
  const piece: OrderPiece = {
    width: geometry.frame.width,
    height: geometry.frame.height,
    layers,
    boards: geometry.instances.length,
    designs: designsCharged(panel, req.limits),
    separation: geometry.instances.length > 1 ? plan.separation : 'none',
  };
  const priced = priceOrder(
    plan.label,
    piece,
    plan.pcbQty,
    plan.asmQty,
    pieceParts(plan.counts, resolved),
    pieceSides(plan.counts, resolved),
    geometry.rails.length > 0 && geometry.fiducials.length > 0,
    req.limits,
    req.fees,
  );
  if (priced.order === null) return `no assembly service can take it (${priced.rejected.join('; ')})`;
  if (priced.cost.problems.length > 0) return priced.cost.problems[0]!;

  return {
    label: plan.label,
    designs: plan.designs.map((d) => d.key),
    panel: true,
    priced,
    counts: plan.counts,
    layout: {
      instances: panel.instances,
      settings: patch,
      width: geometry.frame.width,
      height: geometry.frame.height,
    },
    plate: geometry,
  };
}

/** A board on its own, as the shape of one piece: no rails, no tabs, nothing around it. */
function singleBoardPlate(ctx: Ctx, s: PanelSource, populate: boolean): PanelGeometry {
  const { req } = ctx;
  const panel: Panel = {
    ...newPanel(s.name, req.settings),
    sources: [s],
    instances: [{ id: `${s.key}1`, source: s.key, at: { x: 0, y: 0 }, rotation: 0, pinned: false, populate }],
  };
  panel.settings.rails = { top: 0, bottom: 0, left: 0, right: 0 };
  panel.settings.fiducials.enabled = false;
  panel.settings.toolingHoles.enabled = false;
  return computeGeometry(panel, req.resolved);
}

/** One design as a single-board order. */
function planSingle(ctx: Ctx, s: PanelSource, target: number): ScenarioOrder | string {
  const { req } = ctx;
  const g = req.resolved.find((r) => r.key === s.key)?.geometry;
  if (!g) return `${s.key}: ${req.resolved.find((r) => r.key === s.key)?.error ?? 'not resolved'}`;
  const counts: PieceCount[] = [{ key: s.key, total: 1, populated: ctx.hasParts(s.key) ? 1 : 0 }];
  let asm = 0;
  if (ctx.hasParts(s.key)) {
    const steps = [...new Set([...req.fees.assembly.economic.qtySteps.value, ...req.fees.assembly.standard.qtySteps.value])];
    const step = stepAtLeast(steps, Math.max(1, target));
    if (step === null) return `${target} boards is more than the order form offers`;
    asm = step;
  }
  const pcb = stepAtLeast(req.fees.pcb.qtySteps.value, Math.max(asm, target, 1));
  if (pcb === null) return `${target} boards is more than the order form offers`;
  const piece: OrderPiece = {
    width: g.width,
    height: g.height,
    layers: g.copperLayers,
    boards: 1,
    designs: 1,
    separation: 'none',
  };
  const priced = priceOrder(
    `${s.key} (${s.name}), single boards`,
    piece,
    pcb,
    asm,
    pieceParts(counts, req.resolved),
    pieceSides(counts, req.resolved),
    false,
    req.limits,
    req.fees,
  );
  if (priced.order === null) return `${s.key}: no assembly service can take it (${priced.rejected.join('; ')})`;
  if (priced.cost.problems.length > 0) return `${s.key}: ${priced.cost.problems[0]}`;
  return {
    label: priced.order.label,
    designs: [s.key],
    panel: false,
    priced,
    counts,
    layout: null,
    plate: singleBoardPlate(ctx, s, counts[0]!.populated > 0),
  };
}

function describeCounts(counts: PieceCount[]): string {
  return counts
    .filter((c) => c.total > 0)
    .map((c) => (c.populated === c.total ? `${c.total}x${c.key}` : `${c.total}x${c.key} (${c.populated} populated)`))
    .join(' + ');
}

function assemble(
  ctx: Ctx,
  id: string,
  kind: ScenarioKind,
  title: string,
  summary: string,
  orders: ScenarioOrder[],
  extraWarnings: string[] = [],
  promotedTo?: 2 | 4 | 6,
): Scenario {
  const lines: ScenarioLine[] = orders.flatMap((o) => o.priced.cost.lines.map((l) => ({ ...l, order: o.label })));
  const total = cents(orders.reduce((s, o) => s + o.priced.cost.total, 0));
  const got = received(ctx, orders);
  const asked = got.reduce((n, r) => n + Math.min(r.assembled, r.needed), 0);
  const warnings = [...extraWarnings];
  for (const o of orders) {
    for (const n of o.priced.cost.notes) {
      // Said once, below, for the scenario as a whole.
      if (n.startsWith('Boards divided by silkscreen lines')) continue;
      if (!warnings.includes(n)) warnings.push(n);
    }
    for (const r of o.priced.rejected) {
      const w = `Not available: ${r}`;
      if (!warnings.includes(w)) warnings.push(w);
    }
  }
  for (const r of got) {
    if (r.shortfall > 0) warnings.push(`${r.key}: ${r.shortfall} of the ${r.needed} needed are not delivered`);
    if (r.overage > 0) warnings.push(`${r.key}: ${r.overage} more assembled than asked for`);
  }
  const panels = orders.filter((o) => o.panel);
  if (panels.length > 1) {
    warnings.push(`${panels.length} panels in this scenario; loading it shows the first (${panels[0]!.designs.join(', ')}).`);
  }
  if (kind === 'silk-divider') {
    warnings.push('No routing between the boards: you cut them apart yourself along the silkscreen lines.');
  }
  if (promotedTo !== undefined) {
    warnings.push(`Boards with fewer layers are made as ${promotedTo}-layer boards.`);
  }
  return {
    id,
    kind,
    title,
    summary,
    orders,
    total,
    costPerNeededBoard: asked > 0 ? cents(total / asked) : total,
    received: got,
    lines,
    estimate: lines.some((l) => l.estimate),
    ...(promotedTo !== undefined ? { promotedTo } : {}),
    warnings,
    layout: panels[0]?.layout ?? null,
  };
}

/** Every panel plan of one family over `designs`, deduplicated. */
function panelPlans(
  ctx: Ctx,
  designs: PanelSource[],
  separation: Separation,
  layers: 'auto' | 2 | 4 | 6,
): Array<PanelPlan & { tag: string }> {
  const { fees } = ctx.req;
  const anyParts = designs.some((s) => ctx.hasParts(s.key) && s.needed > 0);
  const asmSteps = [...new Set([...fees.assembly.economic.qtySteps.value, ...fees.assembly.standard.qtySteps.value])];
  const out: Array<PanelPlan & { tag: string }> = [];
  const seen = new Set<string>();

  /** Boards of `s` per panel for `asm` panels assembled of `pcb` fabricated. */
  const perDesign = (s: PanelSource, asm: number, pcb: number): PieceCount => {
    const n = ctx.hasParts(s.key) ? Math.ceil(s.needed / asm) : Math.ceil(s.needed / pcb);
    return { key: s.key, total: n, populated: ctx.hasParts(s.key) ? n : 0 };
  };

  const targets = designs.map((s) => Math.max(s.needed, 1));
  const counts = anyParts ? panelCounts(targets, asmSteps) : panelCounts(targets, fees.pcb.qtySteps.value);
  for (const p of counts) {
    const asm = anyParts ? p : 0;
    const pcb = stepAtLeast(fees.pcb.qtySteps.value, p);
    if (pcb === null) continue;
    const perPanel = designs.map((s) => perDesign(s, Math.max(asm, 1), pcb)).filter((c) => c.total > 0);
    if (perPanel.length === 0) continue;
    const key = `${pcb}/${asm}/${perPanel.map((c) => `${c.key}:${c.total}:${c.populated}`).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      designs: designs.filter((s) => perPanel.some((c) => c.key === s.key)),
      counts: perPanel,
      separation,
      layers,
      pcbQty: pcb,
      asmQty: asm,
      label: `${describeCounts(perPanel)} per panel`,
      tag: `needed-x${p}`,
    });
  }
  return out;
}

/**
 * True when `panel` is exactly the panel `layout` describes: the same
 * instances in the same places, and every setting the layout fixes. Pinning
 * does not count; it changes nothing about what is made.
 *
 * This is how a client knows that what is on the plate is one of the computed
 * scenarios and not a panel someone arranged by hand.
 */
export function layoutMatches(panel: Pick<Panel, 'instances' | 'settings'>, layout: ScenarioLayout): boolean {
  if (panel.instances.length !== layout.instances.length) return false;
  for (const want of layout.instances) {
    const have = panel.instances.find((i) => i.id === want.id);
    if (!have) return false;
    if (have.source !== want.source || have.rotation !== want.rotation || have.populate !== want.populate) return false;
    if (Math.abs(have.at.x - want.at.x) > 0.005 || Math.abs(have.at.y - want.at.y) > 0.005) return false;
  }
  const settings = panel.settings as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(layout.settings)) {
    const mine = settings[key];
    if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        if ((mine as Record<string, unknown> | undefined)?.[k] !== v) return false;
      }
    } else if (mine !== value) {
      return false;
    }
  }
  return true;
}

function quantityText(o: ScenarioOrder): string {
  const pcb = o.priced.order.pcbQty;
  const asm = o.priced.order.assembly?.qty ?? 0;
  const what = o.panel ? 'panel' : 'board';
  return asm > 0 ? `${plural(pcb, what)}, ${asm} assembled` : `${plural(pcb, `bare ${what}`)}`;
}

function cheapest(orders: ScenarioOrder[]): ScenarioOrder | null {
  return orders.reduce<ScenarioOrder | null>(
    (best, o) => (best === null || o.priced.cost.total < best.priced.cost.total ? o : best),
    null,
  );
}

function rank(scenarios: Scenario[], objective: Objective): Scenario[] {
  const overage = (s: Scenario): number => s.received.reduce((n, r) => n + r.overage, 0);
  const key = (s: Scenario): number[] => {
    switch (objective) {
      case 'total':
        return [s.total, overage(s), s.orders.length];
      case 'per-board':
        return [s.costPerNeededBoard, s.total, s.orders.length];
      case 'overage':
        return [overage(s), s.total];
    }
  };
  return [...scenarios].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (Math.abs(ka[i]! - kb[i]!) > 1e-9) return ka[i]! - kb[i]!;
    }
    return a.id.localeCompare(b.id);
  });
}

/** Enumerate, price and rank the ways to order the boards. */
export function quoteOrder(req: QuoteRequest): QuoteResult {
  const t0 = performance.now();
  const objective = req.objective ?? 'total';
  const wanted = req.sources.filter((s) => s.needed > 0);
  const ctx: Ctx = {
    req,
    wanted,
    hasParts: (key) => (req.resolved.find((r) => r.key === key)?.geometry?.parts.length ?? 0) > 0,
    rejected: [],
  };
  const scenarios: Scenario[] = [];
  const reject = (id: string, title: string, reason: string): void => {
    ctx.rejected.push({ id, title, reason });
  };

  if (wanted.length === 0) {
    return { objective, scenarios: [], rejected: [{ id: 'none', title: 'Nothing to order', reason: 'No board has a needed quantity.' }], elapsedMs: 0 };
  }

  // A board that cannot be read cannot be priced, and an order that leaves it
  // out would not be the order that was asked for.
  const unreadable = wanted
    .map((s) => ({ s, r: req.resolved.find((x) => x.key === s.key) }))
    .filter(({ r }) => !r?.geometry);
  if (unreadable.length > 0) {
    return {
      objective,
      scenarios: [],
      rejected: unreadable.map(({ s, r }) => ({
        id: `source-${s.key}`,
        title: `Board ${s.key}`,
        reason: r?.error ?? `${s.key} (${s.path}) is not resolved`,
      })),
      elapsedMs: 0,
    };
  }

  // V-cut is never proposed, only kept: a panel set to V-cut gets V-cut
  // panels in every scenario, everything else gets mouse bites.
  const panelized: Separation = req.settings.separation === 'v-cut' ? 'v-cut' : 'mouse-bite';
  const layerOf = (s: PanelSource): number => req.resolved.find((r) => r.key === s.key)?.geometry?.copperLayers ?? 2;
  const layerCounts = [...new Set(wanted.map(layerOf))].sort((a, b) => a - b);
  const mixed = layerCounts.length > 1;
  const top = layerCounts[layerCounts.length - 1] as 2 | 4 | 6;

  // --- separate: one single-board order per design --------------------------
  {
    const title = wanted.length === 1 ? 'Single boards' : 'Separate orders, one per design';
    const orders: ScenarioOrder[] = [];
    let failed: string | null = null;
    for (const s of wanted) {
      const o = planSingle(ctx, s, Math.max(s.needed, 1));
      if (typeof o === 'string') {
        failed = o;
        break;
      }
      orders.push(o);
    }
    if (failed) reject('separate', title, failed);
    else {
      scenarios.push(
        assemble(
          ctx,
          'separate',
          'separate',
          title,
          orders.map((o) => `${o.designs[0]}: ${quantityText(o)}`).join('; '),
          orders,
        ),
      );
    }
  }

  // --- own-panels: every design on a panel of its own -----------------------
  {
    const title = wanted.length === 1 ? 'One panel of the design' : 'Each design on its own panel';
    const orders: ScenarioOrder[] = [];
    let failed: string | null = null;
    for (const s of wanted) {
      const options: ScenarioOrder[] = [];
      let why = '';
      for (const plan of panelPlans(ctx, [s], panelized, 'auto')) {
        if (plan.counts.every((c) => c.total <= 1)) continue; // that is a single board, not a panel
        const o = planPanel(ctx, { ...plan, label: `${s.key} (${s.name}), ${plan.label}` });
        if (typeof o === 'string') why = o;
        else options.push(o);
      }
      const best = cheapest(options);
      if (!best) {
        failed = why ? `${s.key}: ${why}` : `${s.key}: only ${s.needed} needed, a panel would hold a single board`;
        break;
      }
      orders.push(best);
    }
    if (failed) reject('own-panels', title, failed);
    else {
      scenarios.push(
        assemble(
          ctx,
          'own-panels',
          'own-panels',
          title,
          orders.map((o) => `${describeCounts(o.counts)} per panel, ${quantityText(o)}`).join('; '),
          orders,
        ),
      );
    }
  }

  // --- merged and silk-divider: all designs on one panel --------------------
  if (wanted.length > 1) {
    for (const separation of [panelized, 'silk-divider'] as const) {
      const kind: ScenarioKind = separation === 'silk-divider' ? 'silk-divider' : 'merged';
      const base =
        separation === 'silk-divider'
          ? 'One board, silkscreen dividers'
          : separation === 'v-cut'
            ? 'One panel, V-cut'
            : 'One panel, mouse bites';
      const promoted = mixed ? `, promoted to ${top} layers` : '';

      if (separation === 'silk-divider') {
        const { maxDesigns, minFillRatio } = req.limits.silkDivider;
        if (wanted.length > maxDesigns.value) {
          reject(kind, base, `${wanted.length} designs; JLCPCB allows ${maxDesigns.value} on one silkscreen-divided board`);
          continue;
        }
        const odd = wanted.find((s) => (req.resolved.find((r) => r.key === s.key)?.geometry?.fillRatio ?? 1) < minFillRatio.value);
        if (odd) {
          reject(kind, base, `${odd.key} is not a plain rectangle, so it cannot be cut out with straight cuts`);
          continue;
        }
      }

      for (const plan of panelPlans(ctx, wanted, separation, mixed ? top : 'auto')) {
        const id = `${kind}-${plan.tag}`;
        const o = planPanel(ctx, plan);
        const title = `${base}${promoted}`;
        if (typeof o === 'string') {
          reject(id, `${title}: ${plan.label}`, o);
          continue;
        }
        scenarios.push(
          assemble(
            ctx,
            id,
            kind,
            title,
            `${plan.label}, ${quantityText(o)}`,
            [o],
            [],
            mixed ? top : undefined,
          ),
        );
      }
    }
  }

  // --- split: one order per layer count -------------------------------------
  if (mixed) {
    const title = 'Split by layer count';
    const orders: ScenarioOrder[] = [];
    let failed: string | null = null;
    for (const layers of layerCounts) {
      const group = wanted.filter((s) => layerOf(s) === layers);
      const options: ScenarioOrder[] = [];
      let why = '';
      if (group.length === 1) {
        const single = planSingle(ctx, group[0]!, Math.max(group[0]!.needed, 1));
        if (typeof single === 'string') why = single;
        else options.push(single);
      }
      for (const plan of panelPlans(ctx, group, panelized, 'auto')) {
        if (group.length === 1 && plan.counts.every((c) => c.total <= 1)) continue;
        const o = planPanel(ctx, { ...plan, label: `${layers}-layer: ${plan.label}` });
        if (typeof o === 'string') why = o;
        else options.push(o);
      }
      const best = cheapest(options);
      if (!best) {
        failed = `${layers}-layer boards: ${why || 'no way to order them'}`;
        break;
      }
      orders.push(best);
    }
    if (failed) reject('split', title, failed);
    else {
      scenarios.push(
        assemble(
          ctx,
          'split',
          'split',
          title,
          orders.map((o) => `${o.label}, ${quantityText(o)}`).join('; '),
          orders,
        ),
      );
    }
  }

  return {
    objective,
    scenarios: rank(scenarios, objective),
    rejected: ctx.rejected,
    elapsedMs: Math.round((performance.now() - t0) * 10) / 10,
  };
}
