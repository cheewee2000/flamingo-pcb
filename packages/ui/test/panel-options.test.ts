import { describe, it, expect } from 'vitest';
import type { PanelView, QuoteResult, Received, Scenario } from '@flamingo/panel';
import { OWN, boardsAskedFor, buildOptions, minimumsReached, optionInView, rankOf, scenarioOnPlate } from '../src/panel/options.js';

const instance = (id: string, source: string, x: number, populate = true) => ({
  id,
  source,
  at: { x, y: 5 },
  rotation: 0 as const,
  pinned: false,
  populate,
});

const got = (key: string, needed: number, assembled: number, bare = 0): Received =>
  ({ key, needed, assembled, bare }) as Received;

/** One panel of S and M, the way the optimizer would lay it out. */
const LAYOUT = {
  instances: [instance('S1', 'S', 5), instance('M1', 'M', 30)],
  settings: { separation: 'mouse-bite' },
  width: 60,
  height: 40,
};

function scenario(id: string, kind: Scenario['kind'], total: number, loads: boolean): Scenario {
  const order = (panel: boolean) => ({
    label: id,
    designs: ['S', 'M'],
    panel,
    priced: { order: { pcbQty: 5, assembly: { qty: 2 } } },
    counts: [
      { key: 'S', total: 1, populated: 1 },
      { key: 'M', total: 1, populated: 1 },
    ],
    layout: loads ? LAYOUT : null,
    plate: {},
  });
  return {
    id,
    kind,
    title: id,
    summary: '',
    orders: loads ? [order(true)] : [order(false), order(false)],
    total,
    costPerNeededBoard: total / 4,
    received: [got('S', 2, 2), got('M', 2, 2)],
    lines: [],
    estimate: true,
    warnings: [],
    layout: loads ? LAYOUT : null,
  } as unknown as Scenario;
}

function quote(...scenarios: Scenario[]): QuoteResult {
  return { objective: 'total', scenarios, rejected: [], elapsedMs: 1 };
}

function view(instances: ReturnType<typeof instance>[], cost: number | null = 50): PanelView {
  const count = (key: string, populated = false): number =>
    instances.filter((i) => i.source === key && (!populated || i.populate)).length;
  return {
    panel: { name: 'combo', sources: [{ key: 'S' }, { key: 'M' }], instances, settings: { separation: 'mouse-bite' } },
    sources: ['S', 'M'].map((key) => ({ key, instances: count(key), populated: count(key, true), needed: 2 })),
    issues: [],
    minimums: { made: 5, assembled: 2, verified: false },
    quote:
      cost === null
        ? { order: null, cost: null, received: [], problems: ['S is needed but is not on the panel'], notes: [] }
        : {
            order: { pcbQty: 5, piece: { boards: instances.length }, assembly: { qty: 2 } },
            cost: { total: cost, estimate: true, lines: [] },
            received: [got('S', 2, 4), got('M', 2, 2)],
            problems: [],
            notes: [],
          },
    revision: 1,
  } as unknown as PanelView;
}

describe('panel view: ways to order', () => {
  const merged = scenario('merged', 'merged', 40, true);
  const separate = scenario('separate', 'separate', 60, false);

  it('lists only the computed ways while the plate is empty', () => {
    const list = buildOptions(view([]), quote(merged, separate), null);
    expect(list.map((o) => o.id)).toEqual(['merged', 'separate']);
    expect(list.some((o) => o.onPlate)).toBe(false);
    expect(optionInView(list)).toBeUndefined();
  });

  it('knows the panel on the plate when it is one of the computed ways', () => {
    const v = view(LAYOUT.instances);
    expect(scenarioOnPlate(v, quote(merged, separate))?.id).toBe('merged');
    const list = buildOptions(v, quote(merged, separate), null);
    expect(list.map((o) => [o.id, o.onPlate])).toEqual([
      ['merged', true],
      ['separate', false],
    ]);
    expect(optionInView(list)?.id).toBe('merged');
  });

  it('adds a panel arranged by hand to the list, ranked by its price', () => {
    const own = view([...LAYOUT.instances, instance('S2', 'S', 55)], 50);
    const list = buildOptions(own, quote(merged, separate), null);
    expect(list.map((o) => o.id)).toEqual(['merged', OWN, 'separate']);
    expect(rankOf(list, OWN)).toBe(2);
    const mine = list[1]!;
    expect(mine.label).toBe('Your panel');
    expect(mine.onPlate).toBe(true);
    expect(mine.total).toBe(50);
    // 4 S come, 2 were asked for; 2 M come, 2 were asked for.
    expect(mine.perBoard).toBe(12.5);
    expect(mine.orders).toEqual([
      {
        panel: true,
        counts: [
          { key: 'S', total: 2, populated: 2 },
          { key: 'M', total: 1, populated: 1 },
        ],
        made: 5,
        assembled: 2,
        minMade: true,
        minAssembled: false,
      },
    ]);
  });

  it('puts a panel that cannot be priced last, and says why', () => {
    const list = buildOptions(view([instance('M1', 'M', 5)], null), quote(merged, separate), null);
    expect(list.map((o) => o.id)).toEqual(['merged', 'separate', OWN]);
    expect(list[2]!.total).toBeNull();
    expect(list[2]!.problem).toBe('S is needed but is not on the panel');
  });

  it('a moved instance makes the panel your own', () => {
    const moved = view([instance('S1', 'S', 5), instance('M1', 'M', 31)]);
    expect(scenarioOnPlate(moved, quote(merged))).toBeUndefined();
    expect(buildOptions(moved, quote(merged), null).map((o) => o.id)).toContain(OWN);
  });

  it('what is shown for comparison is in view, the panel stays on the plate', () => {
    const list = buildOptions(view(LAYOUT.instances), quote(merged, separate), 'separate');
    expect(optionInView(list)?.id).toBe('separate');
    expect(list.find((o) => o.onPlate)?.id).toBe('merged');
    expect(list.find((o) => o.shown)?.loads).toBe(false);
  });

  it('lists the panel on its own while the ways are being worked out', () => {
    const list = buildOptions(view(LAYOUT.instances), null, null);
    expect(list.map((o) => o.id)).toEqual([OWN]);
  });

  it('says when a quantity is the smallest order there is', () => {
    const v = view([]);
    const one = [{ key: 'S', total: 1, populated: 1 }];
    // 1 needed: 2 are assembled and 5 made because nothing smaller can be ordered.
    expect(minimumsReached({ counts: one, made: 5, assembled: 2 }, [got('S', 1, 2, 3)], v)).toEqual({ minMade: true, minAssembled: true });
    // 2 needed: 2 assembled is the need; 5 made is still the minimum.
    expect(minimumsReached({ counts: one, made: 5, assembled: 2 }, [got('S', 2, 2, 3)], v)).toEqual({ minMade: true, minAssembled: false });
    // 5 needed: both are the need.
    expect(minimumsReached({ counts: one, made: 5, assembled: 5 }, [got('S', 5, 5)], v)).toEqual({ minMade: false, minAssembled: false });
    // 3 on a panel, 6 needed: 2 panels assembled is what the need asks for.
    const three = [{ key: 'S', total: 3, populated: 3 }];
    expect(minimumsReached({ counts: three, made: 5, assembled: 2 }, [got('S', 6, 6, 9)], v)).toEqual({ minMade: true, minAssembled: false });
    // More than the minimum is never the minimum.
    expect(minimumsReached({ counts: one, made: 10, assembled: 10 }, [got('S', 7, 10)], v)).toEqual({ minMade: false, minAssembled: false });
  });

  it('counts the boards that were asked for', () => {
    expect(boardsAskedFor([got('S', 2, 4), got('M', 2, 2)])).toBe(4);
    // Bare boards are not counted.
    expect(boardsAskedFor([got('S', 2, 2, 3)])).toBe(2);
    expect(boardsAskedFor([got('S', 2, 1)])).toBe(1);
  });
});
