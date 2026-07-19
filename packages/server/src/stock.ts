/**
 * Stock check for DRC: verifies every placed part against JLCPCB's assembly
 * parts library. Lives in the server (not the engine) because it needs the
 * network — the engine's runDRC stays pure/synchronous.
 *
 * Findings come in two grades:
 *  - violations (`stock-out`): the library can't cover even ONE board. These
 *    gate export_fab exactly like geometry violations (waivable via waiveDrc).
 *  - advisories (`stock-low`, `stock-unknown`): informational only — printed
 *    in reports but never blocking, so a flaky network or an unlisted part
 *    can't brick an export.
 *
 * Disable entirely with FLAMINGO_STOCK_CHECK=off.
 */

import type { Board, DrcViolation } from '@flamingo/engine';
import type { JlcStock } from '@flamingo/parts';

export type StockLookup = (lcsc: string) => Promise<JlcStock>;

export interface StockReport {
  violations: DrcViolation[];
  advisories: DrcViolation[];
}

export interface CheckStockOpts {
  /** Warn when stock covers fewer than this many boards (default 100). */
  lowStockBoards?: number;
}

const DEFAULT_LOW_STOCK_BOARDS = 100;
const LOOKUP_CONCURRENCY = 6;

export function stockCheckEnabled(): boolean {
  return process.env.FLAMINGO_STOCK_CHECK !== 'off';
}

const LCSC_ID = /^C\d+$/i;

export async function checkStock(
  board: Board,
  lookup: StockLookup,
  opts: CheckStockOpts = {},
): Promise<StockReport> {
  const lowStockBoards = opts.lowStockBoards ?? DEFAULT_LOW_STOCK_BOARDS;

  // Group placed components by LCSC id (skip TPs and anything without one).
  const byLcsc = new Map<string, { refdes: string[]; at: { x: number; y: number } }>();
  for (const c of board.components) {
    if (!LCSC_ID.test(c.lcsc)) continue;
    const entry = byLcsc.get(c.lcsc);
    if (entry) entry.refdes.push(c.refdes);
    else byLcsc.set(c.lcsc, { refdes: [c.refdes], at: { x: c.at.x, y: c.at.y } });
  }

  const report: StockReport = { violations: [], advisories: [] };
  const entries = [...byLcsc.entries()];

  async function checkOne([lcsc, { refdes, at }]: (typeof entries)[number]): Promise<void> {
    const qty = refdes.length;
    let stock: JlcStock;
    try {
      stock = await lookup(lcsc);
    } catch (err) {
      report.advisories.push({
        rule: 'stock-unknown',
        message: `${lcsc}: stock lookup failed (${err instanceof Error ? err.message : String(err)})`,
        at,
        items: refdes,
      });
      return;
    }
    const mpn = stock.mpn ? ` (${stock.mpn})` : '';
    if (stock.stock === null) {
      report.advisories.push({
        rule: 'stock-unknown',
        message: `${lcsc}: not in the JLCPCB parts library`,
        at,
        items: refdes,
      });
    } else if (stock.stock < qty) {
      report.violations.push({
        rule: 'stock-out',
        message: `${lcsc}${mpn}: JLCPCB stock ${stock.stock} < ${qty} needed per board`,
        at,
        items: refdes,
      });
    } else if (stock.stock < qty * lowStockBoards) {
      const boards = Math.floor(stock.stock / qty);
      report.advisories.push({
        rule: 'stock-low',
        message: `${lcsc}${mpn}: JLCPCB stock ${stock.stock} builds only ${boards} board(s) at ${qty}/board`,
        at,
        items: refdes,
      });
    }
  }

  // Bounded concurrency: chew through the unique-part list a few at a time.
  let next = 0;
  const workers = Array.from({ length: Math.min(LOOKUP_CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      await checkOne(entry);
    }
  });
  await Promise.all(workers);

  // Deterministic report order regardless of lookup completion order.
  const byFirstRef = (a: DrcViolation, b: DrcViolation) =>
    (a.items[0] ?? '').localeCompare(b.items[0] ?? '', undefined, { numeric: true });
  report.violations.sort(byFirstRef);
  report.advisories.sort(byFirstRef);
  return report;
}
