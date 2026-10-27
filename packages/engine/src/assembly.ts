/**
 * Which parts JLCPCB assembles.
 */

import type { ComponentInst } from './types.js';

const LCSC_ID = /^C\d+$/i;

/**
 * Whether JLCPCB assembles this part: it has an LCSC number and is not
 * marked do-not-place. Everything else stays out of the BOM, CPL and stock check.
 */
export function isAssembled(c: ComponentInst): boolean {
  return LCSC_ID.test(c.lcsc) && c.fields.dnp !== true;
}
