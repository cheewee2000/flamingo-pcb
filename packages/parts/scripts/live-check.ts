/**
 * Live smoke check (NOT part of `npm test` — hits the network).
 *
 *   npm run build -w @flamingo/parts   # then:
 *   node --experimental-strip-types packages/parts/scripts/live-check.ts
 *   # or (no build needed): npx tsx packages/parts/scripts/live-check.ts
 *
 * Verifies searchParts and fetchPart against the live EasyEDA/LCSC endpoints.
 * Uses a throwaway cache dir so it always exercises the network path.
 * Imports the compiled dist so it runs under node --experimental-strip-types
 * (which does not rewrite ".js" specifiers to their ".ts" sources).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchParts } from '../dist/search.js';
import { fetchPart } from '../dist/fetch.js';

process.env.FLAMINGO_CACHE_DIR = mkdtempSync(join(tmpdir(), 'flamingo-live-'));

async function main(): Promise<void> {
  console.log('== searchParts("10k 0603") ==');
  const generic = await searchParts('10k 0603', { limit: 5 });
  console.log(`  ${generic.length} results; basic=${generic.filter((p) => p.basic).length}`);
  for (const p of generic) {
    console.log(`   ${p.lcsc}  ${p.basic ? 'BASIC' : 'ext  '}  ${p.package}  ${p.mpn}`);
  }

  console.log('== searchParts("0603WAF1002T5E") (surfaces a Basic part) ==');
  const byMpn = await searchParts('0603WAF1002T5E', { limit: 3 });
  for (const p of byMpn) {
    console.log(`   ${p.lcsc}  ${p.basic ? 'BASIC' : 'ext  '}  ${p.package}  ${p.mpn}`);
  }

  console.log('== fetchPart("C25804") ==');
  const { footprint, info } = await fetchPart('C25804');
  console.log(`   name=${footprint.name} pads=${footprint.pads.length} silk=${footprint.silk.length} courtyard=${footprint.courtyard.length}`);
  console.log(`   info: mpn=${info.mpn} mfr=${info.mfr} basic=${info.basic} stock=${info.stock} datasheet=${info.datasheet ? 'yes' : 'no'}`);
  const p1 = footprint.pads.find((p) => p.number === '1');
  console.log(`   pad1 at=(${p1?.at.x.toFixed(4)}, ${p1?.at.y.toFixed(4)}) size=${p1?.size.w.toFixed(4)}x${p1?.size.h.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
