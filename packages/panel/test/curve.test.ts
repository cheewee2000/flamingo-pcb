import { describe, expect, it } from 'vitest';
import { costCurve, curveKey, CURVE_QUANTITIES, ENTERED_KEPT, parsePanelCurve, priceCurve } from '../src/curve.js';
import { FEES, LIMITS, plainBoard, resolved } from './helpers.js';
import { DEFAULT_SETTINGS } from '../src/panel.js';

describe('costCurve', () => {
  const r = resolved('M', plainBoard('mini', 30, 20));
  const req = {
    name: 'p',
    sources: [{ key: 'M', path: 'mini.flamingo', hash: 'h', name: 'mini', needed: 1 }],
    resolved: [r],
    settings: DEFAULT_SETTINGS,
    limits: LIMITS,
    fees: FEES,
  };

  it('prices the cheapest way at each quantity, per board falling as the order grows', () => {
    const c = costCurve(req, [1, 5, 20, 100]);
    expect(c.points.map((p) => p.quantity)).toEqual([1, 5, 20, 100]);
    expect(c.impossible).toEqual([]);
    for (const p of c.points) {
      expect(p.total).toBeGreaterThan(0);
      expect(p.perBoard).toBeCloseTo(p.total / p.quantity, 1);
      expect(p.way.title.length).toBeGreaterThan(0);
    }
    expect(c.points[3]!.perBoard).toBeLessThan(c.points[0]!.perBoard);
    expect(c.points[3]!.total).toBeGreaterThan(c.points[0]!.total);
  });

  it('ignores the request quantities and skips bad ones', () => {
    const c = costCurve({ ...req, sources: [{ ...req.sources[0]!, needed: 7 }] }, [2, 0, 2.5, 3]);
    expect(c.points.map((p) => p.quantity)).toEqual([2, 3]);
  });

  it('is fast the second time: packings are kept', () => {
    costCurve(req);
    const t0 = performance.now();
    const c = costCurve(req);
    expect(c.points.length).toBeGreaterThan(10);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('priceCurve', () => {
  const r = resolved('M', plainBoard('mini', 30, 20));
  const req = {
    name: 'p',
    sources: [{ key: 'M', path: 'mini.flamingo', hash: 'h', name: 'mini', needed: 11 }],
    resolved: [r],
    settings: DEFAULT_SETTINGS,
    limits: LIMITS,
    fees: FEES,
  };

  it('adds the needed quantity to the curve, remembers it, and prices nothing the second time', () => {
    const first = priceCurve(req, undefined);
    expect(first.curve.points.map((p) => p.quantity)).toEqual([...CURVE_QUANTITIES, 11].sort((a, b) => a - b));
    expect(first.curve.entered).toEqual([11]);
    expect(first.curve.priced).toBe(CURVE_QUANTITIES.length + 1);
    expect(first.stored.entered).toEqual([11]);
    expect(first.stored.key).toBe(curveKey(req));

    const again = priceCurve(req, first.stored);
    expect(again.curve.priced).toBe(0);
    expect(again.curve.points).toEqual(first.curve.points);
    expect(again.stored).toBe(first.stored);
  });

  it('a later quantity joins the earlier ones; a standard one is not an entry', () => {
    const a = priceCurve(req, undefined).stored;
    const b = priceCurve({ ...req, sources: [{ ...req.sources[0]!, needed: 7 }] }, a);
    expect(b.curve.priced).toBe(1);
    expect(b.curve.entered).toEqual([7, 11]);
    expect(b.stored.entered).toEqual([11, 7]);
    const c = priceCurve({ ...req, sources: [{ ...req.sources[0]!, needed: 10 }] }, b.stored);
    expect(c.curve.priced).toBe(0);
    expect(c.stored).toBe(b.stored);
  });

  it('forgets the points when what they were priced from changes', () => {
    const a = priceCurve(req, undefined).stored;
    const changed = { ...req, settings: { ...DEFAULT_SETTINGS, spacing: 3 } };
    const b = priceCurve(changed, a);
    expect(curveKey(changed)).not.toBe(curveKey(req));
    expect(b.curve.priced).toBe(CURVE_QUANTITIES.length + 1);
    expect(b.stored.key).toBe(curveKey(changed));
    expect(b.stored.entered).toEqual([11]);
  });

  it('a one-off table is cached but not entered', () => {
    const a = priceCurve(req, undefined).stored;
    const table = priceCurve(req, a, [9, 11, 200]);
    expect(table.curve.points.map((p) => p.quantity)).toEqual([9, 11, 200]);
    expect(table.curve.priced).toBe(2);
    expect(table.stored.entered).toEqual([11]);
    expect(table.stored.points.map((p) => p.quantity)).toContain(200);
    expect(priceCurve(req, table.stored, [200]).curve.priced).toBe(0);
  });

  it('keeps at most ENTERED_KEPT entered quantities, the oldest dropped', () => {
    // Entering is remembered without pricing, so this needs no quotes.
    let stored = priceCurve(req, undefined, undefined, false).stored;
    for (let q = 101; q < 101 + ENTERED_KEPT + 2; q++) {
      stored = priceCurve({ ...req, sources: [{ ...req.sources[0]!, needed: q }] }, stored, undefined, false).stored;
    }
    expect(stored.entered).toHaveLength(ENTERED_KEPT);
    expect(stored.entered[0]).toBe(103);
    expect(stored.entered).not.toContain(11);
  });

  it('a stored curve survives a file round trip, and a damaged one is dropped', () => {
    const stored = priceCurve(req, undefined).stored;
    expect(parsePanelCurve(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(parsePanelCurve({ ...stored, points: [{ quantity: 1 }] })).toBeUndefined();
    expect(parsePanelCurve({ ...stored, objective: 'cheapest' })).toBeUndefined();
    expect(parsePanelCurve(null)).toBeUndefined();
  });
});

describe('priceCurve without pricing', () => {
  const r = resolved('M', plainBoard('mini', 30, 20));
  const req = {
    name: 'p',
    sources: [{ key: 'M', path: 'mini.flamingo', hash: 'h', name: 'mini', needed: 11 }],
    resolved: [r],
    settings: DEFAULT_SETTINGS,
    limits: LIMITS,
    fees: FEES,
  };

  it('reports what is stored and what is missing, remembering the entered quantity without pricing it', () => {
    const look = priceCurve(req, undefined, undefined, false);
    expect(look.curve.priced).toBe(0);
    expect(look.curve.points).toEqual([]);
    expect(look.curve.missing).toEqual([...CURVE_QUANTITIES, 11].sort((a, b) => a - b));
    expect(look.stored.entered).toEqual([11]);
    expect(look.stored.points).toEqual([]);

    const some = priceCurve(req, look.stored, [1, 11]);
    expect(some.curve.priced).toBe(2);
    const again = priceCurve(req, some.stored, undefined, false);
    expect(again.curve.points.map((p) => p.quantity)).toEqual([1, 11]);
    expect(again.curve.entered).toEqual([11]);
    expect(again.curve.missing).toHaveLength(CURVE_QUANTITIES.length - 1);
    expect(again.stored).toBe(some.stored);
  });
});
