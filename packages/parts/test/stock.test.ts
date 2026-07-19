import { describe, expect, it } from 'vitest';
import { fetchJlcStock, clearStockCache } from '../src/stock.js';

/** Build a JLC search-API response body around the given component list. */
function jlcResponse(list: unknown[]): unknown {
  return { code: 200, data: { componentPageInfo: { total: list.length, list } } };
}

function fetchImplReturning(body: unknown, calls?: { count: number }): typeof fetch {
  return (async () => {
    if (calls) calls.count++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('fetchJlcStock', () => {
  it('returns stock and basic/extended flag for an exact componentCode match', async () => {
    clearStockCache();
    const body = jlcResponse([
      {
        componentCode: 'C21190',
        stockCount: 186830,
        componentLibraryType: 'base',
        componentModelEn: '0603WAF1001T5E',
      },
    ]);
    const info = await fetchJlcStock('C21190', { fetchImpl: fetchImplReturning(body) });
    expect(info).toEqual({
      lcsc: 'C21190',
      stock: 186830,
      basic: true,
      mpn: '0603WAF1001T5E',
    });
  });

  it('picks the exact code among multiple keyword hits', async () => {
    clearStockCache();
    const body = jlcResponse([
      { componentCode: 'C17790', stockCount: 5, componentLibraryType: 'expand' },
      { componentCode: 'C1779', stockCount: 2750289, componentLibraryType: 'base' },
    ]);
    const info = await fetchJlcStock('C1779', { fetchImpl: fetchImplReturning(body) });
    expect(info.stock).toBe(2750289);
    expect(info.basic).toBe(true);
  });

  it('returns stock null when the part is not in the JLC library', async () => {
    clearStockCache();
    const info = await fetchJlcStock('C999999999', {
      fetchImpl: fetchImplReturning(jlcResponse([])),
    });
    expect(info).toEqual({ lcsc: 'C999999999', stock: null, basic: false });
  });

  it('caches results so a second lookup within the TTL does not refetch', async () => {
    clearStockCache();
    const calls = { count: 0 };
    const fetchImpl = fetchImplReturning(
      jlcResponse([{ componentCode: 'C5673', stockCount: 100, componentLibraryType: 'expand' }]),
      calls,
    );
    await fetchJlcStock('C5673', { fetchImpl });
    await fetchJlcStock('C5673', { fetchImpl });
    expect(calls.count).toBe(1);
  });

  it('propagates HTTP failures as errors', async () => {
    clearStockCache();
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(fetchJlcStock('C21190', { fetchImpl })).rejects.toThrow(/503/);
  });
});
