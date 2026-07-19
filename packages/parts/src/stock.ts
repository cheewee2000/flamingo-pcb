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

export interface JlcStock {
  lcsc: string;
  /** Units in JLCPCB's assembly parts library; null when the part isn't listed. */
  stock: number | null;
  /** True for JLC "Basic" library parts (no feeder-loading fee). */
  basic: boolean;
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
}

const cache = new Map<string, { at: number; value: JlcStock }>();

/** Drop all cached stock lookups (tests, or to force a fresh check). */
export function clearStockCache(): void {
  cache.clear();
}

/**
 * Look up one LCSC id in JLCPCB's parts library. Results are cached in memory
 * for `ttlMs` (default 10 min) so a run_drc followed by export_fab doesn't hit
 * the API twice per part. Network/HTTP failures throw — callers decide whether
 * that blocks anything.
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

  const value: JlcStock =
    item === undefined
      ? { lcsc, stock: null, basic: false }
      : {
          lcsc,
          stock: typeof item.stockCount === 'number' ? item.stockCount : null,
          basic: item.componentLibraryType === 'base',
          ...(item.componentModelEn ? { mpn: item.componentModelEn } : {}),
        };
  cache.set(lcsc, { at: now(), value });
  return value;
}
