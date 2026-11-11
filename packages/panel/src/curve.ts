/**
 * Flamingo Panel - cost against quantity.
 *
 * How the cheapest way to order changes with the number of boards: the
 * total and the cost per board at each of a set of quantities, each priced
 * by `quoteOrder` with every design's needed quantity set to that number.
 * Fees step (a panel holds so many boards, assembly setup is paid once), so
 * the curve shows where another few boards come almost free and where they
 * tip into another panel.
 *
 * The curve is priced at a standard set of quantities plus every quantity
 * the panel's boards have been set to, and the points are kept in the panel
 * file (`PanelCurve`) so that opening the panel again, or going back to a
 * quantity, costs nothing. Points are reused only while everything they were
 * priced from is unchanged: `curveKey` names that.
 */

import type { Objective, QuoteRequest, ScenarioKind } from './scenarios.js';
import { OBJECTIVES, quoteOrder } from './scenarios.js';

/** Quantities the curve is always priced at: dense where small orders change fastest. */
export const CURVE_QUANTITIES: readonly number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100];

/** Entered quantities remembered on the curve, oldest dropped first. */
export const ENTERED_KEPT = 48;
/** Priced points kept in the panel file. */
export const POINTS_KEPT = 200;

export interface CostPoint {
  /** Boards of each design. */
  quantity: number;
  total: number;
  perBoard: number;
  /** The cheapest way at this quantity. */
  way: { id: string; kind: ScenarioKind; title: string };
  /** Rests on at least one unverified number. */
  estimate: boolean;
}

export interface Impossible {
  quantity: number;
  reason: string;
}

export interface CostCurve {
  objective: Objective;
  designs: string[];
  points: CostPoint[];
  /** Quantities nothing could be ordered at, and why. */
  impossible: Impossible[];
  /** Quantities on the curve because the panel's boards were set to them, past or present. */
  entered: number[];
  /** Quantities on the curve that have not been priced (only when pricing was not asked for). */
  missing: number[];
  /** How many of the points were priced in this call rather than taken from the store. */
  priced: number;
  elapsedMs: number;
}

/**
 * The curve as it is kept in the panel file: a cache and the quantities the
 * user has entered. Not part of the design: ops never touch it, undo never
 * restores it, and a damaged one is dropped on load rather than refused.
 */
export interface PanelCurve {
  /** `curveKey` of what the points were priced from. They are reused only while it still matches. */
  key: string;
  objective: Objective;
  /** Quantities the panel's boards have been set to, oldest first, beyond `CURVE_QUANTITIES`. */
  entered: number[];
  /** Every quantity priced under `key`, ascending. */
  points: CostPoint[];
  impossible: Impossible[];
  /** ISO time of the last pricing. */
  pricedAt: string;
}

/** FNV-1a over a string, as 13 hex digits: a stable name for a set of inputs, not a secret. */
function fnv1a(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Everything a point depends on: which boards (by content hash), what their
 * parts cost, the panel settings, the limits and fees, the objective. The same inputs give the
 * same key across runs, so a stored curve is still good after a restart.
 */
export function curveKey(req: QuoteRequest): string {
  const designs = req.resolved.map((r) => [
    r.key,
    r.hash ?? '',
    r.geometry ? 1 : 0,
    r.error ?? '',
    // What each part costs is looked up after the board is read, so it is not in the hash.
    (r.geometry?.parts ?? []).map((p) => [p.lcsc, p.unitPrice ?? null, p.jlc ?? null]),
  ]);
  return `fnv1a:${fnv1a(JSON.stringify([designs, req.settings, req.limits, req.fees, req.objective ?? 'total']))}`;
}

function cleanQuantities(quantities: Iterable<number>): number[] {
  return [...new Set(quantities)].filter((q) => Number.isInteger(q) && q >= 1).sort((a, b) => a - b);
}

/**
 * Price every quantity in `quantities` (default `CURVE_QUANTITIES`), in
 * ascending order without repeats. The request's own quantities are
 * ignored: each point sets every design's `needed` to the point's quantity,
 * so the curve is per design. A point `known` already has (same key as the
 * request, which the caller vouches for) is taken as it is. With `price`
 * false nothing is priced: a quantity not known is listed as `missing`.
 */
export function costCurve(
  req: QuoteRequest,
  quantities: readonly number[] = CURVE_QUANTITIES,
  known?: Pick<PanelCurve, 'points' | 'impossible'>,
  price = true,
): CostCurve {
  const t0 = performance.now();
  const designs = req.sources.filter((s) => req.resolved.some((r) => r.key === s.key && r.geometry));
  const knownPoints = new Map(known?.points.map((p) => [p.quantity, p]) ?? []);
  const knownImpossible = new Map(known?.impossible.map((i) => [i.quantity, i]) ?? []);
  const points: CostPoint[] = [];
  const impossible: Impossible[] = [];
  const missing: number[] = [];
  let priced = 0;
  for (const quantity of cleanQuantities(quantities)) {
    const had = knownPoints.get(quantity);
    if (had) {
      points.push(had);
      continue;
    }
    const hadNot = knownImpossible.get(quantity);
    if (hadNot) {
      impossible.push(hadNot);
      continue;
    }
    if (!price) {
      missing.push(quantity);
      continue;
    }
    priced++;
    const q = quoteOrder({
      ...req,
      sources: designs.map((s) => ({ ...s, needed: quantity })),
    });
    const best = q.scenarios[0];
    if (!best) {
      impossible.push({ quantity, reason: q.rejected[0]?.reason ?? 'no way to order' });
      continue;
    }
    points.push({
      quantity,
      total: best.total,
      perBoard: best.costPerNeededBoard,
      way: { id: best.id, kind: best.kind, title: best.title },
      estimate: best.estimate,
    });
  }
  return {
    objective: req.objective ?? 'total',
    designs: designs.map((s) => s.key),
    points,
    impossible,
    entered: [],
    missing,
    priced,
    elapsedMs: Math.round(performance.now() - t0),
  };
}

/**
 * The curve for a panel, from and into its stored curve.
 *
 * Every design's current `needed` joins the entered quantities, which stay
 * on the curve with the standard ones. `quantities`, when given, are priced
 * instead (a one-off table) and are cached but not remembered as entered.
 * With `price` false nothing is priced: the curve has the points the store
 * already holds and names the rest `missing`, which is how a view shows what
 * it has and offers to price the rest. Returns the curve and the store to
 * keep: the same object as `stored` when nothing changed, so a caller can
 * skip a save.
 */
export function priceCurve(
  req: QuoteRequest,
  stored: PanelCurve | undefined,
  quantities?: readonly number[],
  price = true,
): { curve: CostCurve; stored: PanelCurve } {
  const objective = req.objective ?? 'total';
  const key = curveKey(req);
  const same = stored !== undefined && stored.key === key && stored.objective === objective;
  const standard = new Set(CURVE_QUANTITIES);
  const entered = same ? [...stored.entered] : [];
  for (const s of req.sources) {
    if (!Number.isInteger(s.needed) || s.needed < 1 || standard.has(s.needed) || entered.includes(s.needed)) continue;
    entered.push(s.needed);
  }
  const kept = entered.slice(Math.max(0, entered.length - ENTERED_KEPT));
  const curve = costCurve(req, quantities ?? [...CURVE_QUANTITIES, ...kept], same ? stored : undefined, price);
  curve.entered = kept.filter((q) => curve.points.some((p) => p.quantity === q)).sort((a, b) => a - b);
  if (same && curve.priced === 0 && sameList(kept, stored.entered)) return { curve, stored };

  // Merge what was just priced into the store, keeping the curve's own quantities over older one-offs.
  const shown = new Set([...CURVE_QUANTITIES, ...kept]);
  const points = mergeBy(same ? stored.points : [], curve.points, (p) => p.quantity);
  const impossible = mergeBy(same ? stored.impossible : [], curve.impossible, (i) => i.quantity);
  const trimmed = points.length > POINTS_KEPT ? trimTo(points, POINTS_KEPT, shown) : points;
  return {
    curve,
    stored: {
      key,
      objective,
      entered: kept,
      points: trimmed,
      impossible,
      pricedAt: curve.priced > 0 || !same ? new Date().toISOString() : stored.pricedAt,
    },
  };
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** `older` with `newer` laid over it by key, ascending by key. */
function mergeBy<T>(older: readonly T[], newer: readonly T[], keyOf: (t: T) => number): T[] {
  const byKey = new Map<number, T>();
  for (const t of older) byKey.set(keyOf(t), t);
  for (const t of newer) byKey.set(keyOf(t), t);
  return [...byKey.values()].sort((a, b) => keyOf(a) - keyOf(b));
}

/** Drop one-off points first (never a shown one), then the largest. */
function trimTo(points: CostPoint[], max: number, shown: Set<number>): CostPoint[] {
  const keep = points.filter((p) => shown.has(p.quantity));
  const rest = points.filter((p) => !shown.has(p.quantity));
  return [...keep, ...rest.slice(0, Math.max(0, max - keep.length))].sort((a, b) => a.quantity - b.quantity);
}

/** A stored curve read from a file: the shape checked, or `undefined` if it is not one. */
export function parsePanelCurve(raw: unknown): PanelCurve | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || !(OBJECTIVES as readonly unknown[]).includes(r.objective)) return undefined;
  if (!Array.isArray(r.entered) || !Array.isArray(r.points) || !Array.isArray(r.impossible)) return undefined;
  if (typeof r.pricedAt !== 'string') return undefined;
  const entered = r.entered.filter((q): q is number => Number.isInteger(q) && (q as number) >= 1);
  const points: CostPoint[] = [];
  for (const p of r.points as unknown[]) {
    if (typeof p !== 'object' || p === null) return undefined;
    const { quantity, total, perBoard, way, estimate } = p as Record<string, unknown>;
    if (!Number.isInteger(quantity) || typeof total !== 'number' || typeof perBoard !== 'number') return undefined;
    if (typeof way !== 'object' || way === null) return undefined;
    const w = way as Record<string, unknown>;
    if (typeof w.id !== 'string' || typeof w.kind !== 'string' || typeof w.title !== 'string') return undefined;
    points.push({
      quantity: quantity as number,
      total,
      perBoard,
      way: { id: w.id, kind: w.kind as ScenarioKind, title: w.title },
      estimate: estimate === true,
    });
  }
  const impossible: Impossible[] = [];
  for (const i of r.impossible as unknown[]) {
    if (typeof i !== 'object' || i === null) return undefined;
    const { quantity, reason } = i as Record<string, unknown>;
    if (!Number.isInteger(quantity) || typeof reason !== 'string') return undefined;
    impossible.push({ quantity: quantity as number, reason });
  }
  return {
    key: r.key,
    objective: r.objective as Objective,
    entered,
    points: points.sort((a, b) => a.quantity - b.quantity),
    impossible,
    pricedAt: r.pricedAt,
  };
}
