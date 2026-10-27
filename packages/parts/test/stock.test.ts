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
      standardOnly: false,
      mpn: '0603WAF1001T5E',
    });
  });

  it('reads the price tiers, the attrition and the Standard-only flag', async () => {
    clearStockCache();
    const body = jlcResponse([
      {
        componentCode: 'C41413180',
        stockCount: 158824,
        componentLibraryType: 'expand',
        componentProductType: 2,
        lossNumber: 8,
        leastPatchNumber: 10,
        componentPrices: [
          { startNumber: 600, endNumber: 3999, productPrice: 0.0223 },
          { startNumber: 1, endNumber: 199, productPrice: 0.0344 },
          { startNumber: 200, endNumber: 599, productPrice: 0.0267 },
          { startNumber: 4000, endNumber: -1, productPrice: 0.0212 },
          { startNumber: 'x', productPrice: 1 },
        ],
      },
    ]);
    const info = await fetchJlcStock('C41413180', { fetchImpl: fetchImplReturning(body) });
    expect(info.standardOnly).toBe(true);
    expect(info.attrition).toEqual({ loss: 8, minimum: 10 });
    expect(info.prices).toEqual([
      { from: 1, to: 199, price: 0.0344 },
      { from: 200, to: 599, price: 0.0267 },
      { from: 600, to: 3999, price: 0.0223 },
      { from: 4000, to: null, price: 0.0212 },
    ]);
  });

  it('leaves prices and attrition out when the library gives none', async () => {
    clearStockCache();
    const body = jlcResponse([{ componentCode: 'C473006', stockCount: 0, componentLibraryType: 'expand', componentProductType: 0, componentPrices: [] }]);
    const info = await fetchJlcStock('C473006', { fetchImpl: fetchImplReturning(body) });
    expect(info).toEqual({ lcsc: 'C473006', stock: 0, basic: false, standardOnly: false });
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
    expect(info).toEqual({ lcsc: 'C999999999', stock: null, basic: false, standardOnly: false });
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
