/**
 * searchParts: keyword search over LCSC/EasyEDA components.
 *
 * VERIFIED WITH curl (2026-07):
 *  - PRIMARY  POST https://easyeda.com/api/components/search  -> 200 OK.
 *    Form fields: type=3, doctype[]=2, wd=<query>, pageSize=<n>.
 *    Results live at result.lists.lcsc[]; each item carries
 *    dataStr.head.c_para (Manufacturer / Manufacturer Part / package /
 *    "JLCPCB Part Class") and lcsc.number.
 *  - FALLBACK GET https://wmsc.lcsc.com/ftps/wm/search/global-search  -> 403
 *    Forbidden from this environment (Akamai). Kept behind the primary as a
 *    last resort in case the EasyEDA endpoint changes.
 *
 * FINDING: the EasyEDA search is keyword/relevance-ranked on MPN + manufacturer,
 * NOT parametric. A generic query like "10k 0603" returns 0 JLCPCB Basic parts
 * even at pageSize 100; Basic parts surface only for MPN-ish queries (e.g.
 * "0603WAF1002T5E" -> C25804, Basic). Documented for callers.
 */

import { deriveInfo, type PartInfo } from './easyeda-parse.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Flamingo/0.1 (+https://cwandt.com)';
const TIMEOUT_MS = 15_000;
const SEARCH_URL = 'https://easyeda.com/api/components/search';
const FALLBACK_URL = 'https://wmsc.lcsc.com/ftps/wm/search/global-search';

export interface SearchOpts {
  limit?: number;
  inStock?: boolean;
}

function toPartInfo(partial: Partial<PartInfo>): PartInfo {
  return {
    lcsc: partial.lcsc ?? '',
    mfr: partial.mfr ?? '',
    mpn: partial.mpn ?? '',
    description: partial.description ?? '',
    package: partial.package ?? '',
    basic: partial.basic ?? false,
    ...(partial.stock !== undefined ? { stock: partial.stock } : {}),
    ...(partial.price !== undefined ? { price: partial.price } : {}),
    ...(partial.datasheet !== undefined ? { datasheet: partial.datasheet } : {}),
  };
}

async function searchEasyeda(query: string, pageSize: number): Promise<PartInfo[]> {
  const body = new URLSearchParams();
  body.append('type', '3');
  body.append('doctype[]', '2');
  body.append('wd', query);
  body.append('pageSize', String(pageSize));

  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`searchParts: HTTP ${res.status}`);
  const json = (await res.json()) as {
    success?: boolean;
    result?: { lists?: { lcsc?: unknown[] } };
  };
  const list = json.result?.lists?.lcsc ?? [];
  return list
    .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
    .map((it) => toPartInfo(deriveInfo(it as Parameters<typeof deriveInfo>[0])))
    .filter((p) => p.lcsc.length > 0);
}

/** LCSC global-search fallback (currently 403 from most hosts). */
async function searchLcsc(query: string): Promise<PartInfo[]> {
  const url = `${FALLBACK_URL}?keyword=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`searchParts fallback: HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: { productSearchResultVO?: { productList?: Array<Record<string, unknown>> } };
  };
  const list = json.result?.productSearchResultVO?.productList ?? [];
  return list.map((p) =>
    toPartInfo({
      lcsc: String(p['productCode'] ?? ''),
      mpn: String(p['productModel'] ?? ''),
      mfr: String((p['brandNameEn'] as string) ?? ''),
      package: String((p['encapStandard'] as string) ?? ''),
      description: String((p['productIntroEn'] as string) ?? ''),
      basic: false,
    }),
  );
}

/**
 * Search for parts by keyword. Tries the EasyEDA endpoint first, falling back
 * to LCSC global-search if it fails. `inStock` filters out parts with a known
 * zero stock (search hits usually lack stock data, so unknown-stock parts are
 * kept).
 */
export async function searchParts(
  query: string,
  opts: SearchOpts = {},
): Promise<PartInfo[]> {
  const limit = opts.limit ?? 25;
  const pageSize = Math.min(Math.max(limit, 1), 100);

  let results: PartInfo[];
  try {
    results = await searchEasyeda(query, pageSize);
  } catch {
    results = await searchLcsc(query);
  }

  if (opts.inStock) {
    results = results.filter((p) => p.stock === undefined || p.stock > 0);
  }
  return results.slice(0, limit);
}
