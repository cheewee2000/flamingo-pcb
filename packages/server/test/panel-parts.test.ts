import { describe, expect, it } from 'vitest';
import type { JlcStock } from '@flamingo/parts';
import { jlcPartOf, partLookupFrom } from '../src/panel/parts.js';

const LED: JlcStock = {
  lcsc: 'C41413180',
  stock: 158824,
  basic: false,
  standardOnly: true,
  prices: [{ from: 1, to: null, price: 0.0344 }],
  attrition: { loss: 8, minimum: 10 },
};

describe('partLookupFrom', () => {
  it("takes JLCPCB's library first and leaves the EasyEDA price alone", async () => {
    let easyeda = 0;
    const lookup = partLookupFrom({
      fetchStock: async () => LED,
      fetchPart: async () => {
        easyeda++;
        return { info: { price: 9 } };
      },
    });
    expect(await lookup('C41413180')).toEqual({
      jlc: { basic: false, standardOnly: true, prices: LED.prices, attrition: LED.attrition },
    });
    expect(easyeda).toBe(0);
  });

  it('falls back to the EasyEDA price when the library has none, and to nothing when neither knows', async () => {
    const lookup = partLookupFrom({
      fetchStock: async (lcsc) => ({ lcsc, stock: null, basic: false, standardOnly: false }),
      fetchPart: async (lcsc) => ({ info: { price: lcsc === 'C1' ? 0.5 : undefined } }),
    });
    expect(await lookup('C1')).toEqual({ unitPrice: 0.5 });
    expect(await lookup('C2')).toBeUndefined();
  });

  it('keeps what one source knows when the other fails', async () => {
    const jlcDown = partLookupFrom({
      fetchStock: async () => {
        throw new Error('503');
      },
      fetchPart: async () => ({ info: { price: 0.25 } }),
    });
    expect(await jlcDown('C1')).toEqual({ unitPrice: 0.25 });
    const listedNoPrice = partLookupFrom({
      fetchStock: async (lcsc) => ({ lcsc, stock: 5, basic: true, standardOnly: false }),
      fetchPart: async () => {
        throw new Error('offline');
      },
    });
    expect(await listedNoPrice('C1')).toEqual({ jlc: { basic: true, standardOnly: false } });
  });

  it('jlcPartOf is nothing for a part the library does not list', () => {
    expect(jlcPartOf({ lcsc: 'C9', stock: null, basic: false, standardOnly: false })).toBeUndefined();
  });
});
