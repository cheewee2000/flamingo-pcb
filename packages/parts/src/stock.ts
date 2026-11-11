/**
 * JLCPCB assembly-stock lookup. Flamingo exports fab files for JLCPCB, so the
 * stock that matters for a build is jlcpcb.com's parts library — not LCSC
 * retail and not the (often stale or absent) EasyEDA `lcsc.stock` field.
 */

const JLC_SEARCH_URL =
  'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';
const USER_AGENT = 'Mozilla/5.0 Flamingo/0.1 (+https://cwandt.com)';
const TIMEOUT_MS = 15_000;
const TTL_MS = 10 * 60_000;

/** One step of JLCPCB's assembly price for a part: `price` USD each from `from` units up to `to` (null: no upper bound). */
export interface JlcPriceTier {
  from: number;
  to: number | null;
  price: number;
}

export interface JlcStock {
  lcsc: string;
  /** Units in JLCPCB's assembly parts library; null when the part isn't listed. */
  stock: number | null;
  /** True for JLC "Basic" library parts (no feeder-loading fee). */
  basic: boolean;
  /**
   * Only Standard PCBA can place the part ("PCBA Type: Standard Only" on its
   * jlcpcb.com page): Economic PCBA refuses it. Read from `componentProductType`
   * (2 = Standard only, 0 = Economic and Standard), the field that page is
   * rendered from; it is not documented, so a part whose page says otherwise
   * is worth a bug report. False when the part is not listed.
   */
  standardOnly: boolean;
  /** JLCPCB's assembly price by quantity, ascending; absent when the part is not listed. */
  prices?: JlcPriceTier[];
  /**
   * JLCPCB's attrition for the part: `loss` spare units added to every order
   * line and `minimum` units billed at least. Absent when not listed.
   */
  attrition?: { loss: number; minimum: number };
  mpn?: string;
}

export interface FetchStockOpts {
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}

interface JlcListItem {
  componentCode?: string;
  stockCount?: number;
  componentLibraryType?: string;
  componentModelEn?: string;
  componentProductType?: number;
  componentPrices?: Array<{ startNumber?: number; endNumber?: number; productPrice?: number }>;
  /** Spare units JLCPCB adds to each order line. */
  lossNumber?: number;
  /** Least units billed for one line. */
  leastPatchNumber?: number;
}

const STANDARD_ONLY_PRODUCT_TYPE = 2;

function priceTiers(raw: JlcListItem['componentPrices']): JlcPriceTier[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tiers: JlcPriceTier[] = [];
  for (const t of raw) {
    if (typeof t.startNumber !== 'number' || typeof t.productPrice !== 'number' || !(t.productPrice >= 0)) continue;
    const to = typeof t.endNumber === 'number' && t.endNumber >= t.startNumber ? t.endNumber : null;
    tiers.push({ from: Math.max(1, t.startNumber), to, price: t.productPrice });
  }
  tiers.sort((a, b) => a.from - b.from);
  return tiers.length > 0 ? tiers : undefined;
}

function attritionOf(item: JlcListItem): { loss: number; minimum: number } | undefined {
  const { lossNumber: loss, leastPatchNumber: minimum } = item;
  if (!Number.isInteger(loss) || !Number.isInteger(minimum) || loss! < 0 || minimum! < 0) return undefined;
  return { loss: loss!, minimum: minimum! };
}

const cache = new Map<string, { at: number; value: JlcStock }>();

/** Drop all cached stock lookups (tests, or to force a fresh check). */
export function clearStockCache(): void {
  cache.clear();
}

/**
 * Look up one LCSC id in JLCPCB's parts library: stock, basic/extended, the
 * assembly price tiers, attrition, and whether only Standard PCBA places it.
 * Results are cached in memory for `ttlMs` (default 10 min) so a run_drc
 * followed by export_fab doesn't hit the API twice per part. Network/HTTP
 * failures throw — callers decide whether that blocks anything.
 */
export async function fetchJlcStock(lcsc: string, opts: FetchStockOpts = {}): Promise<JlcStock> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? TTL_MS;
  const hit = cache.get(lcsc);
  if (hit && now() - hit.at < ttl) return hit.value;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(JLC_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    body: JSON.stringify({ currentPage: 1, pageSize: 5, keyword: lcsc }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`fetchJlcStock(${lcsc}): HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { componentPageInfo?: { list?: JlcListItem[] } };
  };
  const list = json.data?.componentPageInfo?.list ?? [];
  const item = list.find((it) => it.componentCode === lcsc);

  const prices = item === undefined ? undefined : priceTiers(item.componentPrices);
  const attrition = item === undefined ? undefined : attritionOf(item);
  const value: JlcStock =
    item === undefined
      ? { lcsc, stock: null, basic: false, standardOnly: false }
      : {
          lcsc,
          stock: typeof item.stockCount === 'number' ? item.stockCount : null,
          basic: item.componentLibraryType === 'base',
          standardOnly: item.componentProductType === STANDARD_ONLY_PRODUCT_TYPE,
          ...(prices ? { prices } : {}),
          ...(attrition ? { attrition } : {}),
          ...(item.componentModelEn ? { mpn: item.componentModelEn } : {}),
        };
  cache.set(lcsc, { at: now(), value });
  return value;
}
