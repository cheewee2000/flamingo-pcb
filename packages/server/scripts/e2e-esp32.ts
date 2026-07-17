#!/usr/bin/env node
/**
 * Task 16 — end-to-end reference board.
 *
 * Proves the whole Flamingo promise through the PUBLIC MCP tool surface only
 * (no direct Doc access): starts the real server on an ephemeral port with a
 * fresh Doc + temp project dir, connects an MCP SDK client over Streamable
 * HTTP, then drives new_board -> outline -> real LCSC parts -> place ->
 * connect -> net class -> zones -> holes -> silk -> autoroute (real
 * freerouting) -> DRC (must be clean) -> export_fab, and finally validates the
 * JLCPCB fileset (unzip + tracespace-parse every gerber, BOM has every LCSC
 * id, CPL has one row per component).
 *
 * Uses the REAL parts API (live EasyEDA/LCSC network) and the REAL freerouting
 * runner (java + ~/.flamingo/freerouting.jar). Run:
 *
 *     npx tsx packages/server/scripts/e2e-esp32.ts
 *
 * Exits 0 on success, 1 on any failure. Routing a real board takes a minute
 * or two; the script is timeout-tolerant.
 */

import { mkdir, copyFile, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { createParser, GERBER, DRILL, UNIMPLEMENTED } from '@tracespace/parser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { newBoard } from '@flamingo/engine';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';

const here = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(here, '..', '..', '..', '.superpowers', 'sdd', 'e2e');
const DOCS_IMG_DIR = join(here, '..', '..', '..', 'docs', 'images');

// ---------------------------------------------------------------------------
// Real parts (verified live via parts_get before wiring — see task-16 report).
// ---------------------------------------------------------------------------

const PART = {
  esp32: 'C2913204', // ESP32-S3-WROOM-1-N8R2 module (49 pads, 1..41; 41 = GND EP)
  usbc: 'C165948', // TYPE-C-31-M-12 USB-C 16-pin
  ldo: 'C6186', // AMS1117-3.3 SOT-223 (1=GND,2=VOUT,3=VIN,4=VOUT tab)
  r10k: 'C25804', // 10k 0603
  c10u: 'C15850', // 10uF 0805
  c100n: 'C605211', // 100nF 0603 (in stock; C14663 is out of stock)
} as const;

// Placements: mm, y-up, outline bottom-left at (0,0), board 40x30. Chosen so
// no two courtyards overlap and every pad clears the rounded outline and the
// four corner mounting holes (see task-16 report for the geometry rationale).
interface Place {
  refdes: string;
  lcsc: string;
  x: number;
  y: number;
  value?: string;
}
// The ESP32 module's courtyard is asymmetric — the antenna keep-out extends
// ~16mm above the module origin — so it's placed low-right with the antenna
// pointing at the top edge, and everything else lives in the left column. The
// USB-C connector's courtyard extends ~5mm below its origin (the shell), so J1
// and U2 are given a wide vertical gap to keep courtyards/silk clear.
const PLACEMENTS: Place[] = [
  { refdes: 'U1', lcsc: PART.esp32, x: 25, y: 12, value: 'ESP32-S3-WROOM-1' },
  { refdes: 'J1', lcsc: PART.usbc, x: 8, y: 22, value: 'USB-C' },
  { refdes: 'U2', lcsc: PART.ldo, x: 8, y: 12, value: 'AMS1117-3.3' },
  // VBUS-side passives + pull-ups: left/bottom, keeping a clean routing
  // channel between them and the module's left pad column.
  { refdes: 'C1', lcsc: PART.c10u, x: 6.5, y: 6.5, value: '10uF' }, // VBUS bulk
  { refdes: 'C4', lcsc: PART.c100n, x: 10, y: 6.5, value: '100nF' }, // VBUS HF
  { refdes: 'R1', lcsc: PART.r10k, x: 6.5, y: 3, value: '10k' }, // EN pullup
  { refdes: 'R2', lcsc: PART.r10k, x: 10, y: 3, value: '10k' }, // IO0 pullup
  // 3V3 decoupling in the free right-hand column, next to the module.
  { refdes: 'C2', lcsc: PART.c100n, x: 37, y: 10, value: '100nF' }, // 3V3 HF
  { refdes: 'C3', lcsc: PART.c10u, x: 37, y: 17, value: '10uF' }, // 3V3 bulk
];

// Nets (electrical intent is best-effort; the point is pipeline truth).
const NETS: Record<string, string[]> = {
  VBUS: ['J1.B4A9', 'J1.A4B9', 'U2.3', 'C1.1', 'C4.1'],
  '3V3': ['U2.2', 'U2.4', 'U1.2', 'C3.1', 'C2.1', 'R1.2', 'R2.2'],
  GND: [
    'J1.A1B12', 'J1.B1A12', 'J1.1', 'J1.2', 'J1.3', 'J1.4',
    'U2.1', 'U1.1', 'U1.40', 'U1.41', 'C1.2', 'C4.2', 'C3.2', 'C2.2',
  ],
  USB_DP: ['J1.A6', 'U1.14'], // D+ -> IO20
  USB_DN: ['J1.A7', 'U1.13'], // D- -> IO19
  EN: ['U1.3', 'R1.1'],
  IO0: ['U1.27', 'R2.1'],
};

// ---------------------------------------------------------------------------
// Tiny assertion + step helpers
// ---------------------------------------------------------------------------

let stepNo = 0;
function step(label: string): void {
  stepNo++;
  console.log(`\n[${stepNo}] ${label}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function textOf(r: CallToolResult): string {
  return (r.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('\n');
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const projectDir = await mkdtemp(join(tmpdir(), 'flamingo-e2e-'));
  const fabDir = join(projectDir, 'fab');
  const boardFile = join(projectDir, 'esp32-breakout.flamingo');

  const doc = new Doc(newBoard('bootstrap', 2));
  let started: StartedServer | undefined;
  let client: Client | undefined;
  const summary: Array<[string, string]> = [];

  try {
    // Real partsApi + real freerouting runner (defaults — no mocks injected).
    started = await startServer(doc, 0, { projectDir });
    const base = `http://localhost:${started.port}`;
    client = new Client({ name: 'flamingo-e2e', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    console.log(`Server on ${base}, project dir ${projectDir}`);

    // Local call wrapper (client is definitely assigned above).
    const cli = client;
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const r = (await cli.callTool({ name, arguments: args })) as CallToolResult;
      const text = textOf(r);
      if (r.isError) throw new Error(`tool "${name}" failed: ${text}`);
      return text;
    };

    // --- board + outline ---------------------------------------------------
    step('new_board esp32-breakout (2 layers)');
    console.log('  ' + (await call('new_board', { name: 'esp32-breakout', copperLayers: 2 })));
    step('set_board_outline rect 40x30 r2');
    console.log('  ' + (await call('set_board_outline', { shape: 'rect', width: 40, height: 30, cornerRadius: 2 })));

    // --- verify + place real parts ----------------------------------------
    step('parts_search sanity (ESP32-S3-WROOM-1)');
    const searchText = await call('parts_search', { query: 'ESP32-S3-WROOM-1', limit: 5 });
    console.log('  ' + searchText.split('\n')[0]);

    const uniqueLcsc = [...new Set(PLACEMENTS.map((p) => p.lcsc))];
    step(`parts_get verify ${uniqueLcsc.length} unique parts`);
    for (const lcsc of uniqueLcsc) {
      const info = await call('parts_get', { lcsc });
      const head = info.split('\n')[0];
      const pads = info.split('\n').filter((l) => l.trim().startsWith('pad ')).length;
      assert(pads > 0, `part ${lcsc} parsed 0 pads`);
      console.log(`  ${head}  [${pads} pads]`);
    }

    step(`place ${PLACEMENTS.length} components`);
    for (const p of PLACEMENTS) {
      const out = await call('place_component', {
        lcsc: p.lcsc,
        refdes: p.refdes,
        x: p.x,
        y: p.y,
        value: p.value,
      });
      console.log('  ' + out);
    }

    // --- connectivity ------------------------------------------------------
    step(`connect_pins for ${Object.keys(NETS).length} nets`);
    for (const [net, pins] of Object.entries(NETS)) {
      await call('connect_pins', { net, pins });
      console.log(`  ${net}: ${pins.length} pins`);
    }

    step('create_net_class power + signal, assign nets');
    // The USB-C connector's adjacent different-net pads sit ~0.2mm apart, so a
    // 0.2mm design clearance flags them as inherent-to-footprint violations.
    // 0.15mm clears them and still comfortably exceeds JLCPCB's 0.127mm
    // 2-layer copper-clearance floor.
    await call('create_net_class', {
      name: 'power',
      trackWidth: 0.5,
      clearance: 0.15,
      viaDrill: 0.3,
      viaDiameter: 0.6,
    });
    await call('create_net_class', {
      name: 'signal',
      trackWidth: 0.25,
      clearance: 0.15,
      viaDrill: 0.3,
      viaDiameter: 0.6,
    });
    for (const net of ['VBUS', '3V3', 'GND']) await call('assign_net_class', { net, class: 'power' });
    for (const net of ['USB_DP', 'USB_DN', 'EN', 'IO0']) await call('assign_net_class', { net, class: 'signal' });
    console.log('  power -> VBUS/3V3/GND, signal -> USB_DP/USB_DN/EN/IO0');

    // --- zones, holes, silk ------------------------------------------------
    step('add_zone GND on F.Cu + B.Cu (2mm inset)');
    const zonePoly = [
      { x: 2, y: 2 },
      { x: 38, y: 2 },
      { x: 38, y: 28 },
      { x: 2, y: 28 },
    ];
    for (const layer of ['F.Cu', 'B.Cu']) {
      await call('add_zone', {
        layer,
        net: 'GND',
        polygon: zonePoly,
        clearance: 0.3,
        minWidth: 0.25,
        thermalGap: 0.3,
        thermalSpokeWidth: 0.4,
      });
    }
    console.log('  GND zones added on both copper layers');

    step('add_mounting_hole 4x M2 at corners');
    for (const [hx, hy] of [[3, 3], [37, 3], [3, 27], [37, 27]] as const) {
      await call('add_mounting_hole', { x: hx, y: hy, drill: 2.2, padDiameter: 4, plated: true });
    }
    console.log('  4 mounting holes placed');

    step('add_silk_text label');
    // Bottom-centre, clear of every pad (module pads start at y~2.7) and the
    // corner mounting holes.
    await call('add_silk_text', { layer: 'F.Silk', x: 20, y: 1.5, text: 'esp32-breakout v0.1.0', height: 1.2 });

    // --- pre-route screenshot ---------------------------------------------
    await mkdir(E2E_DIR, { recursive: true });
    step('screenshot before-route.png');
    await saveScreenshot(cli, join(E2E_DIR, 'before-route.png'));

    console.log('\n' + (await call('get_board_state')));

    // --- route + DRC-gated export (iterate up to 3 attempts) --------------
    //
    // The DRC gate is `export_fab` WITHOUT waiveDrc: it fills the copper
    // zones (fillAllZones) and runs the full ruleset on that filled board,
    // refusing to write files on any violation — exactly the board that gets
    // fabricated. (The standalone run_drc tool inspects the *unfilled* board,
    // where a GND pour's raw outline overlaps every non-GND pad, so it always
    // reports zone-clearance noise; we surface its non-zone findings for the
    // log but gate on the authoritative filled-board export.)
    let exported = false;
    let lastReport = '';
    for (let attempt = 1; attempt <= 3 && !exported; attempt++) {
      step(`autoroute (attempt ${attempt}/3, passes 20)`);
      const routeOut = await call('autoroute', { passes: 20 });
      console.log('  ' + routeOut);

      const liveDrc = await call('run_drc');
      const nonZone = liveDrc
        .split('\n')
        .filter((l) => l.startsWith('[') && !/ zone /.test(l));
      console.log(`  run_drc (unfilled): ${nonZone.length} non-zone finding(s)` +
        (nonZone.length ? '\n' + nonZone.map((l) => '    ' + l).join('\n') : ''));

      step(`export_fab (DRC gate, attempt ${attempt}/3)`);
      const exp = (await cli.callTool({ name: 'export_fab', arguments: { outDir: fabDir } })) as CallToolResult;
      if (!exp.isError) {
        exported = true;
        console.log('  ' + textOf(exp).split('\n')[0]);
        console.log('  DRC-clean on the filled board (export not waived).');
        break;
      }
      lastReport = textOf(exp);
      console.log('  export refused — filled-board DRC violations:\n' +
        lastReport.split('\n').map((l) => '    ' + l).join('\n'));
      if (attempt < 3) await call('unroute'); // fresh re-route next attempt
    }
    assert(exported, `export_fab (DRC gate) failed after 3 attempts:\n${lastReport}`);
    summary.push(['DRC gate', 'clean filled board (export not waived)']);

    step('screenshot after-route.png');
    // showDrc:false — the board is clean once its GND zones are filled (which
    // export just proved); the live board's unfilled-zone markers would only
    // clutter the reference render.
    await saveScreenshot(cli, join(E2E_DIR, 'after-route.png'), { showDrc: false });

    step('validate fab fileset');
    for (const f of ['gerbers.zip', 'bom.csv', 'cpl.csv']) {
      const st = await stat(join(fabDir, f));
      assert(st.isFile() && st.size > 0, `${f} missing or empty`);
    }
    console.log('  gerbers.zip, bom.csv, cpl.csv all present');

    // Unzip + tracespace-parse every gerber/drill file.
    const zip = new AdmZip(join(fabDir, 'gerbers.zip'));
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    assert(entries.length > 0, 'gerbers.zip is empty');
    let gerberCount = 0;
    let drillCount = 0;
    for (const e of entries) {
      const content = e.getData().toString('utf8');
      const parser = createParser();
      parser.feed(content);
      const root = parser.results();
      const isDrill = e.entryName.toUpperCase().endsWith('.DRL');
      if (isDrill) {
        assert(root.filetype === DRILL, `${e.entryName}: expected DRILL, got ${root.filetype}`);
        const bad = root.children.filter((c) => c.type === UNIMPLEMENTED);
        assert(bad.length === 0, `${e.entryName}: ${bad.length} unrecognized drill tokens`);
        drillCount++;
      } else {
        assert(root.filetype === GERBER, `${e.entryName}: expected GERBER, got ${root.filetype}`);
        assert(root.done === true, `${e.entryName}: parser did not reach done`);
        const bad = root.children.filter(
          (c) => c.type === UNIMPLEMENTED && !(c as { value: string }).value.startsWith('%TF'),
        );
        assert(bad.length === 0, `${e.entryName}: ${bad.length} unrecognized gerber tokens`);
        gerberCount++;
      }
    }
    console.log(`  tracespace parsed ${gerberCount} gerbers + ${drillCount} drill files clean`);
    summary.push(['Gerbers parsed', `${gerberCount} gerber + ${drillCount} drill`]);

    // BOM must contain every placed LCSC id.
    const bom = await readFile(join(fabDir, 'bom.csv'), 'utf8');
    for (const lcsc of uniqueLcsc) assert(bom.includes(lcsc), `bom.csv missing ${lcsc}`);
    console.log(`  bom.csv contains all ${uniqueLcsc.length} LCSC ids`);
    summary.push(['BOM LCSC ids', `${uniqueLcsc.length}/${uniqueLcsc.length} present`]);

    // CPL must have one data row per component.
    const cpl = await readFile(join(fabDir, 'cpl.csv'), 'utf8');
    const cplRows = cpl.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const dataRows = cplRows.length - 1; // minus header
    assert(dataRows === PLACEMENTS.length, `cpl rows ${dataRows} != components ${PLACEMENTS.length}`);
    console.log(`  cpl.csv has ${dataRows} rows for ${PLACEMENTS.length} components`);
    summary.push(['CPL rows', `${dataRows} == ${PLACEMENTS.length} components`]);

    // --- persist + copy artifacts -----------------------------------------
    step('save_board + copy artifacts to .superpowers/sdd/e2e/');
    await call('save_board');
    await copyFile(boardFile, join(E2E_DIR, 'esp32-breakout.flamingo'));
    for (const f of await readdir(fabDir)) await copyFile(join(fabDir, f), join(E2E_DIR, f));
    // Publish the routed render into docs/images for the README.
    await mkdir(DOCS_IMG_DIR, { recursive: true });
    await copyFile(join(E2E_DIR, 'after-route.png'), join(DOCS_IMG_DIR, 'esp32-breakout.png'));
    console.log(`  artifacts in ${E2E_DIR}`);

    summary.unshift(['Components', String(PLACEMENTS.length)]);
    summary.unshift(['Nets', String(Object.keys(NETS).length)]);
    summary.push(['Elapsed', `${((Date.now() - t0) / 1000).toFixed(0)}s`]);

    // --- summary table -----------------------------------------------------
    console.log('\n' + '='.repeat(52));
    console.log('  FLAMINGO E2E — ESP32-S3 BREAKOUT — PASS');
    console.log('='.repeat(52));
    const w = Math.max(...summary.map(([k]) => k.length));
    for (const [k, v] of summary) console.log(`  ${k.padEnd(w)}  ${v}`);
    console.log('='.repeat(52));
  } finally {
    if (client) await client.close().catch(() => {});
    if (started) await started.close().catch(() => {});
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Call the screenshot tool and write the returned PNG (base64) to `outPath`. */
async function saveScreenshot(
  client: Client,
  outPath: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const r = (await client.callTool({
    name: 'screenshot',
    arguments: { widthPx: 1600, ...extra },
  })) as CallToolResult;
  const content = r.content as Array<{ type: string; data?: string; text?: string }>;
  const img = content.find((c) => c.type === 'image');
  if (!img?.data) throw new Error('screenshot returned no image data');
  await writeFile(outPath, Buffer.from(img.data, 'base64'));
  const summary = content.find((c) => c.type === 'text')?.text ?? '';
  console.log(`  wrote ${outPath} (${summary})`);
}

main().catch((err: unknown) => {
  console.error('\nE2E FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
