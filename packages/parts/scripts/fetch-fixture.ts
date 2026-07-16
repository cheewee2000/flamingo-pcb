/**
 * Download RAW EasyEDA API JSON for a set of LCSC parts and write them to
 * test/fixtures/<LCSC>.json. Run once to (re)generate fixtures.
 *
 *   node --experimental-strip-types packages/parts/scripts/fetch-fixture.ts
 *   # or: npx tsx packages/parts/scripts/fetch-fixture.ts C25804 C2150 ...
 *
 * Default set spans: 0603 passive, SOT-23, QFN(LQFN), an ESP32 module,
 * a USB-C receptacle (THT + slots + HOLE + polygon pads), and an LQFP with
 * a silk ARC.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_PARTS = [
  'C25804', // Uni-Royal 10k 0603 (Basic)
  'C2150', // SS8050 SOT-23-3 (Basic)
  'C2040', // RP2040 LQFN-56 (QFN family, EP + rotated pads)
  'C2913204', // ESP32-S3-WROOM-1 module (Extended)
  'C165948', // USB-C receptacle (THT drill+slot, HOLE, polygon pads)
  'C8734', // STM32F103C8T6 LQFP-48 (silk ARC)
];

const API_VERSION = '6.4.19.5';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Flamingo/0.1 (+https://cwandt.com)';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test', 'fixtures');

async function main(): Promise<void> {
  const parts = process.argv.slice(2);
  const list = parts.length > 0 ? parts : DEFAULT_PARTS;
  await mkdir(outDir, { recursive: true });
  for (const lcsc of list) {
    const url = `https://easyeda.com/api/products/${lcsc}/components?version=${API_VERSION}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { success?: boolean };
    if (!json.success) {
      console.error(`SKIP ${lcsc}: not found (HTTP ${res.status})`);
      continue;
    }
    await writeFile(join(outDir, `${lcsc}.json`), JSON.stringify(json), 'utf8');
    console.log(`OK   ${lcsc} -> test/fixtures/${lcsc}.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
