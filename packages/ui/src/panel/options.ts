/**
 * Panel view - the ways to order, as one list.
 *
 * The page has one question, "how do I get the boards I need", and one list
 * of answers. The answers are the scenarios the optimizer computes from the
 * need, and the panel on the plate whenever it is not one of those: a panel
 * arranged by hand is an option like any other, priced and ranked with the
 * rest.
 *
 * Exactly one option is on the plate at any time, unless the plate is empty.
 * Pure: view and quote in, list out.
 */

import type {
  CostLine,
  PanelView,
  PieceCount,
  QuoteResult,
  Received,
  Scenario,
  ScenarioKind,
  ScenarioLine,
  Separation,
} from '@flamingo/panel';
import { layoutMatches } from '@flamingo/panel';
import { SCENARIO_LABEL, SCENARIO_MEANING, loadsOntoPanel, scenarioTags } from './format.js';

/** The id of the option that is the panel as arranged by hand. */
export const OWN = 'own';

export interface OptionOrder {
  /** One piece is a panel (true) or a single board (false). */
  panel: boolean;
  counts: PieceCount[];
  made: number;
  assembled: number;
  /** More pieces are made than the need asks for, because no smaller order exists. */
  minMade: boolean;
  /** Likewise for the pieces assembled. */
  minAssembled: boolean;
}

export interface Option {
  /** A scenario id, or `own`. */
  id: string;
  /** What is fabricated, for the drawing beside the name. */
  kind: ScenarioKind;
  label: string;
  tags: string[];
  meaning: string;
  orders: OptionOrder[];
  received: Received[];
  /** null when it cannot be priced as it stands; `problem` says why. */
  total: number | null;
  perBoard: number | null;
  estimate: boolean;
  lines: Array<CostLine | ScenarioLine>;
  notes: string[];
  problem: string | null;
  /** This is the panel on the plate. */
  onPlate: boolean;
  /** This is shown on the plate in place of the panel, for comparison. */
  shown: boolean;
  /** Selecting it puts it on the plate as the panel (true) or only shows it (false). */
  loads: boolean;
}

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Needed boards the order delivers. */
export function boardsAskedFor(received: Received[]): number {
  return received.reduce((n, r) => n + Math.min(r.assembled, r.needed), 0);
}

/**
 * Whether the quantities of an order are what they are because JLCPCB takes
 * no smaller order, not because the need asks for them.
 */
export function minimumsReached(
  order: Pick<OptionOrder, 'counts' | 'made' | 'assembled'>,
  received: Received[],
  view: Pick<PanelView, 'sources' | 'minimums'>,
): { minMade: boolean; minAssembled: boolean } {
  let toAssemble = 0;
  let toMake = 0;
  for (const c of order.counts) {
    const r = received.find((x) => x.key === c.key);
    const want = r ? r.needed : 0;
    if (want === 0) continue;
    const parts = (view.sources.find((s) => s.key === c.key)?.geometry?.partLines ?? 1) > 0;
    if (parts && c.populated > 0) toAssemble = Math.max(toAssemble, Math.ceil(want / c.populated));
    else if (c.total > 0) toMake = Math.max(toMake, Math.ceil(want / c.total));
  }
  toMake = Math.max(toMake, toAssemble);
  const min = view.minimums;
  return {
    minMade: min !== undefined && order.made === min.made && toMake < order.made,
    minAssembled: min !== undefined && order.assembled === min.assembled && toAssemble < order.assembled,
  };
}

function withMinimums(o: Option, view: PanelView): Option {
  o.orders = o.orders.map((order) => ({ ...order, ...minimumsReached(order, o.received, view) }));
  return o;
}

function fromScenario(s: Scenario): Option {
  return {
    id: s.id,
    kind: s.kind,
    label: SCENARIO_LABEL[s.kind],
    tags: scenarioTags(s),
    meaning: SCENARIO_MEANING[s.kind],
    orders: s.orders.map((o) => ({
      panel: o.panel,
      counts: o.counts,
      made: o.priced.order.pcbQty,
      assembled: o.priced.order.assembly?.qty ?? 0,
      minMade: false,
      minAssembled: false,
    })),
    received: s.received,
    total: s.total,
    perBoard: s.costPerNeededBoard,
    estimate: s.estimate,
    lines: s.lines,
    notes: s.warnings,
    problem: null,
    onPlate: false,
    shown: false,
    loads: loadsOntoPanel(s),
  };
}

const SEPARATION_TAG: Record<Separation, string> = {
  'mouse-bite': 'mouse bites',
  'solid-tab': 'solid tabs',
  'silk-divider': 'silk lines',
  'v-cut': 'V-cut',
};

/** The panel on the plate, as an option. */
function ownPanel(view: PanelView): Option {
  const q = view.quote;
  const counts: PieceCount[] = view.sources
    .map((s) => ({ key: s.key, total: s.instances, populated: s.populated }))
    .filter((c) => c.total > 0);
  const errors = view.issues.filter((i) => i.severity === 'error').length;
  const asked = boardsAskedFor(q.received);
  return {
    id: OWN,
    kind: view.panel.settings.separation === 'silk-divider' ? 'silk-divider' : 'merged',
    label: 'Your panel',
    tags: [SEPARATION_TAG[view.panel.settings.separation]],
    meaning: 'A panel you arranged yourself, priced and ranked like the others.',
    orders: q.order
      ? [{ panel: q.order.piece.boards > 1, counts, made: q.order.pcbQty, assembled: q.order.assembly?.qty ?? 0, minMade: false, minAssembled: false }]
      : [{ panel: true, counts, made: 0, assembled: 0, minMade: false, minAssembled: false }],
    received: q.received,
    total: q.cost ? q.cost.total : null,
    perBoard: q.cost ? (asked > 0 ? cents(q.cost.total / asked) : q.cost.total) : null,
    estimate: q.cost?.estimate ?? false,
    lines: q.cost?.lines ?? [],
    notes: [
      ...(errors > 0 ? [`${errors} error${errors === 1 ? '' : 's'} in the checks: it cannot be exported as it is`] : []),
      ...q.problems,
      ...q.notes,
    ],
    problem: q.cost ? null : (q.problems[0] ?? 'It cannot be priced as it stands.'),
    onPlate: true,
    shown: false,
    loads: true,
  };
}

/** The scenario the panel on the plate is, if it is one. */
export function scenarioOnPlate(view: PanelView, quote: QuoteResult | null): Scenario | undefined {
  if (!quote || view.panel.instances.length === 0) return undefined;
  return quote.scenarios.find((s) => loadsOntoPanel(s) && s.layout !== null && layoutMatches(view.panel, s.layout));
}

/**
 * Every way to order, cheapest first. `preview` is the id of the scenario
 * shown on the plate for comparison, if one is.
 */
export function buildOptions(view: PanelView, quote: QuoteResult | null, preview: string | null): Option[] {
  const matched = scenarioOnPlate(view, quote);
  const options = (quote?.scenarios ?? []).map((s) => {
    const o = fromScenario(s);
    o.onPlate = s.id === matched?.id;
    o.shown = s.id === preview;
    return o;
  });
  if (!matched && view.panel.instances.length > 0) options.push(ownPanel(view));
  // Cheapest first; what cannot be priced goes last. Equal totals keep the optimizer's order.
  return options
    .map((o) => withMinimums(o, view))
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.o.total ?? Infinity) - (b.o.total ?? Infinity) || a.i - b.i)
    .map((x) => x.o);
}

/** The option the plate is showing: the one shown for comparison, else the one that is the panel. */
export function optionInView(options: Option[]): Option | undefined {
  return options.find((o) => o.shown) ?? options.find((o) => o.onPlate);
}

/** 1-based place of an option in the list. */
export function rankOf(options: Option[], id: string): number {
  return options.findIndex((o) => o.id === id) + 1;
}
