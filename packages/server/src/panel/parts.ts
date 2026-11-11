/**
 * What the panel's cost model learns about a part from outside the board
 * file: JLCPCB's parts library first (price tiers, attrition, basic or
 * extended, Standard only), the EasyEDA part data's price as a fallback.
 */

import type { JlcPart } from '@flamingo/panel';
import type { JlcStock, PartInfo as EasyEdaPartInfo } from '@flamingo/parts';

export interface PartInfo {
  /** USD each from the EasyEDA/LCSC data; used when `jlc` has no prices. */
  unitPrice?: number;
  /** JLCPCB's parts-library data; absent when the part is not listed there or the lookup failed. */
  jlc?: JlcPart;
}

/** Part lookup, injected so tests need no network. Returns undefined when nothing is known. */
export type PartLookup = (lcsc: string) => Promise<PartInfo | undefined>;

export interface PartSources {
  /** JLCPCB's parts library (`fetchJlcStock`). */
  fetchStock: (lcsc: string) => Promise<JlcStock>;
  /** EasyEDA part data (`fetchPart`); only its price is used. */
  fetchPart: (lcsc: string) => Promise<{ info: Pick<EasyEdaPartInfo, 'price'> }>;
}

/** A JLCPCB parts-library entry as the cost model wants it, or undefined when the part is not listed. */
export function jlcPartOf(stock: JlcStock): JlcPart | undefined {
  if (stock.stock === null && !stock.prices && !stock.attrition) return undefined;
  return {
    basic: stock.basic,
    standardOnly: stock.standardOnly,
    ...(stock.prices ? { prices: stock.prices } : {}),
    ...(stock.attrition ? { attrition: stock.attrition } : {}),
  };
}

/**
 * The lookup the servers use: JLCPCB's parts library, and the EasyEDA price
 * only when that gives no price. Either source failing is not an error here;
 * what the other knows is returned, or undefined.
 */
export function partLookupFrom(sources: PartSources): PartLookup {
  return async (lcsc) => {
    let jlc: JlcPart | undefined;
    try {
      jlc = jlcPartOf(await sources.fetchStock(lcsc));
    } catch {
      jlc = undefined;
    }
    let unitPrice: number | undefined;
    if (!jlc?.prices) {
      try {
        const price = (await sources.fetchPart(lcsc)).info.price;
        if (typeof price === 'number' && Number.isFinite(price)) unitPrice = price;
      } catch {
        unitPrice = undefined;
      }
    }
    if (!jlc && unitPrice === undefined) return undefined;
    return { ...(unitPrice !== undefined ? { unitPrice } : {}), ...(jlc ? { jlc } : {}) };
  };
}
