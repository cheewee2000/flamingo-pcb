import { describe, expect, it } from 'vitest';
import { newBoard } from '@flamingo/engine';
import type { Board, ComponentInst, Footprint } from '@flamingo/engine';
import type { JlcStock } from '@flamingo/parts';
import { checkStock } from '../src/stock.js';

const FP: Footprint = { name: 'R0603', lcsc: '', pads: [], silk: [], courtyard: [] };

function boardWith(parts: Array<{ refdes: string; lcsc: string }>): Board {
  const b = newBoard('stocktest', 2);
  for (const p of parts) {
    b.components.push({
      refdes: p.refdes,
      lcsc: p.lcsc,
      at: { x: 1, y: 2 },
      rotation: 0,
      side: 'top',
      footprint: FP,
      fields: {},
    } as ComponentInst);
  }
  return b;
}

/** fetchStock stub: map of lcsc -> stock units (null = not in JLC library). */
function stubLookup(
  stocks: Record<string, number | null>,
  calls: string[] = [],
): (lcsc: string) => Promise<JlcStock> {
  return async (lcsc) => {
    calls.push(lcsc);
    if (!(lcsc in stocks)) throw new Error(`unexpected lookup ${lcsc}`);
    return { lcsc, stock: stocks[lcsc], basic: false, mpn: 'MPN-' + lcsc };
  };
}

describe('checkStock', () => {
  it('flags stock-out when JLC stock cannot cover one board', async () => {
    const board = boardWith(
      Array.from({ length: 10 }, (_, i) => ({ refdes: `C${i + 1}`, lcsc: 'C307533' })),
    );
    const report = await checkStock(board, stubLookup({ C307533: 5 }));
    expect(report.violations).toHaveLength(1);
    const v = report.violations[0];
    expect(v.rule).toBe('stock-out');
    expect(v.message).toContain('C307533');
    expect(v.message).toContain('5');
    expect(v.message).toContain('10');
    expect(v.items).toContain('C1');
    expect(v.items).toContain('C10');
    expect(report.advisories).toHaveLength(0);
  });

  it('flags stock-low as a non-gating advisory when stock covers fewer than 100 boards', async () => {
    const board = boardWith([
      { refdes: 'H1', lcsc: 'C54803357' },
      { refdes: 'H2', lcsc: 'C54803357' },
    ]);
    const report = await checkStock(board, stubLookup({ C54803357: 150 }));
    expect(report.violations).toHaveLength(0);
    expect(report.advisories).toHaveLength(1);
    expect(report.advisories[0].rule).toBe('stock-low');
    expect(report.advisories[0].message).toContain('C54803357');
    expect(report.advisories[0].items).toEqual(['H1', 'H2']);
  });

  it('reports nothing for healthily stocked parts', async () => {
    const board = boardWith([{ refdes: 'R1', lcsc: 'C21190' }]);
    const report = await checkStock(board, stubLookup({ C21190: 186830 }));
    expect(report.violations).toHaveLength(0);
    expect(report.advisories).toHaveLength(0);
  });

  it('reports parts missing from the JLC library as a stock-unknown advisory', async () => {
    const board = boardWith([{ refdes: 'U1', lcsc: 'C99999999' }]);
    const report = await checkStock(board, stubLookup({ C99999999: null }));
    expect(report.violations).toHaveLength(0);
    expect(report.advisories).toHaveLength(1);
    expect(report.advisories[0].rule).toBe('stock-unknown');
  });

  it('degrades lookup failures to a stock-unknown advisory instead of a violation', async () => {
    const board = boardWith([{ refdes: 'U1', lcsc: 'C1234' }]);
    const report = await checkStock(board, async () => {
      throw new Error('network down');
    });
    expect(report.violations).toHaveLength(0);
    expect(report.advisories).toHaveLength(1);
    expect(report.advisories[0].rule).toBe('stock-unknown');
    expect(report.advisories[0].message).toContain('network down');
  });

  it('skips components without an LCSC id and queries each part only once', async () => {
    const board = boardWith([
      { refdes: 'TP1', lcsc: '' },
      { refdes: 'R1', lcsc: 'C21190' },
      { refdes: 'R2', lcsc: 'C21190' },
    ]);
    const calls: string[] = [];
    const report = await checkStock(board, stubLookup({ C21190: 999999 }, calls));
    expect(calls).toEqual(['C21190']);
    expect(report.violations).toHaveLength(0);
    expect(report.advisories).toHaveLength(0);
  });

  it('honors a custom low-stock threshold', async () => {
    const board = boardWith([{ refdes: 'R1', lcsc: 'C21190' }]);
    const report = await checkStock(board, stubLookup({ C21190: 5000 }), {
      lowStockBoards: 10000,
    });
    expect(report.advisories).toHaveLength(1);
    expect(report.advisories[0].rule).toBe('stock-low');
  });
});
