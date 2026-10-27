#!/usr/bin/env node
/**
 * End-to-end check of panelization, through the public MCP tools only.
 *
 * Starts the real server on an ephemeral port with a temp project directory,
 * connects an MCP client, and then:
 *
 *   1. builds the ESP32 reference board (the board of e2e-esp32.ts) and a
 *      small USB-C breakout, from live LCSC parts, and routes them with
 *      Freerouting when a Java runtime is present
 *   2. creates a panel, adds both boards, asks for 1 + 5
 *   3. puts 1 + 5 instances on it, arranges, checks
 *   4. runs quote_order and loads a scenario
 *   5. exports the fab fileset and validates it: every Gerber and drill file
 *      through tracespace, the BOM and CPL row by row
 *   6. marks one instance bare and checks it leaves BOM and CPL
 *   7. switches to V-cut: the check refuses the rounded boards, and a waived
 *      export carries edge-to-edge score lines on the profile
 *
 *     npx tsx packages/server/scripts/e2e-panel.ts
 *
 * Exits 0 on success, 1 on any failure.
 *
 * Without Java the boards cannot be routed. The script then says so, carries
 * on with unrouted boards, and waives exactly the findings that follow from
 * that (each board's own unconnected nets); everything else is still asserted.
 * Set FLAMINGO_E2E_REQUIRE_ROUTING=1 to make a missing Java runtime a failure.
 *
 * Nothing is sent to JLCPCB: parts come from the EasyEDA/LCSC part API that
 * the board tools already use, and prices from the local fee table.
 */

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { createParser, GERBER, DRILL, UNIMPLEMENTED } from '@tracespace/parser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { newBoard } from '@flamingo/engine';
import { parsePanel } from '@flamingo/panel';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';
import { findJava } from '../src/route.js';
import { BREAKOUT, ESP32 } from './lib/reference-boards.js';
import type { BoardSpec } from './lib/reference-boards.js';

// run_drc would look every part up in JLCPCB's parts library. This script
// stays off jlcpcb.com altogether unless the caller asks for the stock check.
process.env.FLAMINGO_STOCK_CHECK ??= 'off';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', '..', '..', '.superpowers', 'sdd', 'e2e-panel');

let stepNo = 0;
function step(label: string): void {
  stepNo++;
  console.log(`\n[${stepNo}] ${label}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function textOf(r: CallToolResult): string {
  return (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
}
function indent(s: string): string {
  return s.split('\n').map((l) => '    ' + l).join('\n');
}

/** Minimal RFC-4180 reader, enough for the BOM and CPL. */
function csv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .map((l) => {
      const out: string[] = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i]!;
        if (quoted) {
          if (ch === '"' && l[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (ch === '"') quoted = false;
          else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      out.push(cur);
      return out;
    });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const projectDir = await mkdtemp(join(tmpdir(), 'flamingo-e2e-panel-'));
  const fabDir = join(projectDir, 'fab-panel');
  const java = findJava();
  const routing = java !== null;
  if (!routing && process.env.FLAMINGO_E2E_REQUIRE_ROUTING === '1') {
    throw new Error('no Java runtime found and FLAMINGO_E2E_REQUIRE_ROUTING=1');
  }

  let started: StartedServer | undefined;
  let client: Client | undefined;
  const summary: Array<[string, string]> = [];

  try {
    started = await startServer(new Doc(newBoard('bootstrap', 2)), 0, { projectDir, panel: true });
    client = new Client({ name: 'flamingo-e2e-panel', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${started.port}/mcp`)));
    console.log(`Server on http://localhost:${started.port}, project dir ${projectDir}`);
    console.log(routing ? `Java: ${java}` : 'Java: NOT FOUND — boards will not be routed (see the header of this script)');

    const cli = client;
    const raw = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> =>
      (await cli.callTool({ name, arguments: args })) as CallToolResult;
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const r = await raw(name, args);
      const text = textOf(r);
      if (r.isError) throw new Error(`tool "${name}" failed: ${text}`);
      return text;
    };

    // --- boards ------------------------------------------------------------
    const buildBoard = async (spec: BoardSpec): Promise<{ routed: boolean }> => {
      step(`build board "${spec.name}" (${spec.width} x ${spec.height} mm, ${spec.copperLayers}-layer, ${spec.placements.length} parts)`);
      await call('new_board', { name: spec.name, copperLayers: spec.copperLayers });
      await call('set_board_outline', { shape: 'rect', width: spec.width, height: spec.height, cornerRadius: spec.cornerRadius });
      for (const p of spec.placements) {
        console.log('  ' + (await call('place_component', {
          lcsc: p.lcsc, refdes: p.refdes, x: p.x, y: p.y, rotation: p.rotation ?? 0, value: p.value, role: p.role,
        })));
      }
      for (const [net, pins] of Object.entries(spec.nets)) await call('connect_pins', { net, pins });
      for (const c of spec.classes) {
        await call('create_net_class', { name: c.name, trackWidth: c.trackWidth, clearance: c.clearance, viaDrill: c.viaDrill, viaDiameter: c.viaDiameter });
        for (const net of c.nets) await call('assign_net_class', { net, class: c.name });
      }
      const i = spec.pourInset;
      const polygon = [
        { x: i, y: i },
        { x: spec.width - i, y: i },
        { x: spec.width - i, y: spec.height - i },
        { x: i, y: spec.height - i },
      ];
      for (const layer of ['F.Cu', 'B.Cu']) {
        await call('add_zone', { layer, net: 'GND', polygon, clearance: 0.3, minWidth: 0.25, thermalGap: 0.3, thermalSpokeWidth: 0.4 });
      }
      for (const [x, y] of spec.holes) await call('add_mounting_hole', { x, y, drill: 2.2, padDiameter: 4, plated: true });
      if (spec.silk) await call('add_silk_text', { layer: 'F.Silk', ...spec.silk });

      let routed = false;
      if (routing) {
        for (let attempt = 1; attempt <= 3 && !routed; attempt++) {
          console.log(`  autoroute, attempt ${attempt}/3: ` + (await call('autoroute', { passes: 20 })).split('\n')[0]);
          const drc = await call('run_drc');
          const gating = drc.split('\n').filter((l) => l.startsWith('[') && !l.startsWith('[stock-'));
          if (gating.length === 0) routed = true;
          else {
            console.log(`  ${gating.length} DRC finding(s) after routing:\n${indent(gating.slice(0, 6).join('\n'))}`);
            if (attempt < 3) await call('unroute');
          }
        }
        assert(routed, `${spec.name} did not route DRC-clean in 3 attempts`);
        console.log('  routed and DRC-clean');
      }
      await call('save_board');
      const st = await stat(join(projectDir, `${spec.name}.flamingo`));
      assert(st.size > 0, `${spec.name}.flamingo was not written`);
      return { routed };
    };

    const esp = await buildBoard(ESP32);
    const brk = await buildBoard(BREAKOUT);
    summary.push(['Boards', `${ESP32.name} (${ESP32.placements.length} parts), ${BREAKOUT.name} (${BREAKOUT.placements.length} parts)`]);
    summary.push(['Routing', esp.routed && brk.routed ? 'Freerouting, both boards DRC-clean' : 'SKIPPED (no Java runtime)']);

    // --- panel -------------------------------------------------------------
    step('panel_new + panel_add_board x2 (need 1 + 5)');
    console.log('  ' + (await call('panel_new', { name: 'combo' })));
    console.log('  ' + (await call('panel_add_board', { path: `${ESP32.name}.flamingo`, key: 'S', needed: 1 })));
    console.log('  ' + (await call('panel_add_board', { path: `${BREAKOUT.name}.flamingo`, key: 'M', needed: 5 })));

    step('panel_add_instance: 1 x S + 5 x M');
    await call('panel_add_instance', { board: 'S' });
    for (let i = 0; i < 5; i++) await call('panel_add_instance', { board: 'M' });

    step('panel_arrange');
    const arranged = await call('panel_arrange');
    console.log('  ' + arranged);
    assert(arranged.startsWith('Arranged 6 instance(s)'), `arrange did not place 6 instances: ${arranged}`);

    step('panel_get_state');
    const state = await call('panel_get_state');
    console.log(indent(state));
    for (const id of ['S1', 'M1', 'M2', 'M3', 'M4', 'M5']) assert(state.includes(`  ${id} at (`), `instance ${id} missing from the state`);

    step('panel_check');
    const check = await call('panel_check');
    console.log(indent(check));
    const errors = check.split('\n').filter((l) => l.startsWith('[error]'));
    const unroutedOnly = errors.every((l) => l.includes('[source-drc]') && /\(unconnected-net\)/.test(l));
    if (routing) {
      assert(errors.length === 0, `panel_check found errors on a routed panel:\n${errors.join('\n')}`);
    } else {
      assert(unroutedOnly, `panel_check found errors other than unrouted source boards:\n${errors.join('\n')}`);
    }
    // The breakout's connector hangs over its edge: that edge must be blocked.
    assert(/\[blocked-edge\] M1 edge [NESW] is blocked \(J1 overhangs/.test(check), 'the breakout connector edge was not detected as blocked');
    summary.push(['Panel check', routing ? '0 errors' : `${errors.length} error(s), all "source board not routed"`]);

    step('panel_screenshot');
    await mkdir(OUT_DIR, { recursive: true });
    const shot = await raw('panel_screenshot', { widthPx: 1600 });
    const img = (shot.content as Array<{ type: string; data?: string }>).find((c) => c.type === 'image');
    assert(img?.data, 'panel_screenshot returned no image');
    await writeFile(join(OUT_DIR, 'panel.png'), Buffer.from(img.data, 'base64'));
    console.log('  ' + textOf(shot));
    const fabShot = await raw('panel_screenshot', { widthPx: 1600, view: 'fab' });
    const fabImg = (fabShot.content as Array<{ type: string; data?: string }>).find((c) => c.type === 'image');
    assert(fabImg?.data, 'panel_screenshot view=fab returned no image');
    await writeFile(join(OUT_DIR, 'panel.fab.png'), Buffer.from(fabImg.data, 'base64'));

    // --- quote -------------------------------------------------------------
    step('quote_order');
    const quote = await call('quote_order');
    console.log(indent(quote));
    assert(quote.includes('THE PANEL AS IT STANDS'), 'quote has no section for the current panel');
    assert(/Order: 5 panel\(s\), \d+ assembled/.test(quote), 'quote does not state the order quantities');
    const ranked = [...quote.matchAll(/^\s*(\d+)\.\s+~?\$(\d+\.\d\d)\s+~?\$[\d.]+\/board\s+\[([\w-]+)\]/gm)].map((m) => ({
      total: Number(m[2]),
      id: m[3]!,
    }));
    assert(ranked.length >= 4, `expected at least 4 scenarios, got ${ranked.length}`);
    assert(ranked.every((r, i) => i === 0 || r.total >= ranked[i - 1]!.total), 'scenarios are not ranked by total');
    for (const kind of ['separate', 'merged-', 'silk-divider-']) {
      assert(ranked.some((r) => r.id.startsWith(kind)), `no "${kind}" scenario in the quote`);
    }
    assert(quote.includes('~ marks an ESTIMATE'), 'quote does not explain the estimate mark');
    assert(/Economic PCBA setup\s+\$8\.18/.test(quote), 'verified fee is missing or marked as an estimate');
    summary.push(['Scenarios', `${ranked.length}, cheapest ${ranked[0]!.id} at ~$${ranked[0]!.total.toFixed(2)}`]);

    step('panel_apply_scenario merged-needed-x2, then panel_undo back to 1 + 5');
    console.log('  ' + (await call('panel_apply_scenario', { id: 'merged-needed-x2' })));
    const loaded = await call('panel_get_state');
    assert(/Instances \(4\):/.test(loaded), 'scenario merged-needed-x2 should hold 1 x S + 3 x M');
    await call('panel_undo');
    assert(/Instances \(6\):/.test(await call('panel_get_state')), 'undo did not restore the 1 + 5 panel');

    // --- export ------------------------------------------------------------
    step('export_panel_fab');
    const exported = await call('export_panel_fab', { outDir: fabDir, ...(routing ? {} : { waive: true }) });
    console.log(indent(exported));
    const totalParts = ESP32.placements.length + 5 * BREAKOUT.placements.length;
    assert(exported.includes(`Placed by assembly: ${totalParts} component(s)`), `expected ${totalParts} placed components`);

    step('validate the fab fileset');
    for (const f of ['gerbers.zip', 'bom.csv', 'cpl.csv', 'panel.render.svg', 'panel.fab.svg']) {
      const st = await stat(join(fabDir, f));
      assert(st.isFile() && st.size > 0, `${f} missing or empty`);
    }
    const entries = new AdmZip(join(fabDir, 'gerbers.zip')).getEntries().filter((e) => !e.isDirectory);
    let gerbers = 0;
    let drills = 0;
    for (const e of entries) {
      const content = e.getData().toString('utf8');
      const parser = createParser();
      parser.feed(content);
      const root = parser.results();
      if (e.entryName.toUpperCase().endsWith('.DRL')) {
        assert(root.filetype === DRILL, `${e.entryName}: expected DRILL, got ${root.filetype}`);
        const bad = root.children.filter((c) => c.type === UNIMPLEMENTED);
        assert(bad.length === 0, `${e.entryName}: ${bad.length} unrecognized drill tokens`);
        drills++;
      } else {
        assert(root.filetype === GERBER, `${e.entryName}: expected GERBER, got ${root.filetype}`);
        assert(root.done === true, `${e.entryName}: parser did not reach done`);
        const bad = root.children.filter(
          (c) => c.type === UNIMPLEMENTED && !(c as { value: string }).value.startsWith('%TF'),
        );
        assert(bad.length === 0, `${e.entryName}: ${bad.length} unrecognized gerber tokens`);
        gerbers++;
      }
    }
    const names = entries.map((e) => e.entryName);
    for (const ext of ['GTL', 'GBL', 'GTS', 'GBS', 'GTO', 'GBO', 'GTP', 'GBP', 'GKO']) {
      assert(names.includes(`combo.${ext}`), `gerbers.zip has no combo.${ext}`);
    }
    assert(names.includes('combo-NPTH.DRL'), 'gerbers.zip has no non-plated drill file (mouse bites, tooling holes)');
    assert(names.includes('combo-PTH.DRL'), 'gerbers.zip has no plated drill file');
    console.log(`  tracespace parsed ${gerbers} gerbers + ${drills} drill files clean`);
    summary.push(['Gerbers parsed', `${gerbers} gerber + ${drills} drill`]);

    const panel = parsePanel(await readFile(join(projectDir, 'combo.flamboyance'), 'utf8').catch(async () => {
      await call('panel_save');
      return readFile(join(projectDir, 'combo.flamboyance'), 'utf8');
    }));
    const npth = entries.find((e) => e.entryName === 'combo-NPTH.DRL')!.getData().toString('utf8');
    assert(/T\d+C0\.600/.test(npth), 'no 0.6 mm mouse-bite tool in the non-plated drill file');
    assert(/T\d+C2\.000/.test(npth), 'no 2.0 mm tooling-hole tool in the non-plated drill file');
    const gko = entries.find((e) => e.entryName === 'combo.GKO')!.getData().toString('utf8');
    const contours = gko.split('\n').filter((l) => l.endsWith('D02*')).length;
    assert(contours > 4, `the profile has ${contours} contour(s); a routed panel has the outline plus an opening per gap`);
    console.log(`  profile: ${contours} routed contours; mouse-bite and tooling drills present`);

    // BOM: every designator prefixed with its instance, every LCSC id present.
    const bom = csv(await readFile(join(fabDir, 'bom.csv'), 'utf8'));
    assert(bom[0]!.join(',') === 'Comment,Designator,Footprint,LCSC Part #', 'unexpected BOM header');
    const designators = bom.slice(1).flatMap((r) => r[1]!.split(','));
    assert(designators.length === totalParts, `BOM lists ${designators.length} designators, expected ${totalParts}`);
    assert(designators.every((d) => /^(S1|M[1-5])_[A-Z]+\d+$/.test(d)), `BOM has a designator without an instance prefix: ${designators.find((d) => !/^(S1|M[1-5])_/.test(d))}`);
    assert(new Set(designators).size === designators.length, 'BOM lists a designator twice');
    const lcsc = new Set([...ESP32.placements, ...BREAKOUT.placements].map((p) => p.lcsc));
    for (const id of lcsc) assert(bom.some((r) => r[3] === id), `BOM is missing ${id}`);
    assert(new Set(bom.slice(1).map((r) => r[3])).size === bom.length - 1, 'an LCSC part appears on two BOM rows');
    console.log(`  bom.csv: ${designators.length} designators on ${bom.length - 1} rows, all ${lcsc.size} LCSC ids, all prefixed`);
    summary.push(['BOM', `${designators.length} designators, ${bom.length - 1} rows`]);

    // CPL: one row per component, inside the panel, breakouts all alike.
    const cpl = csv(await readFile(join(fabDir, 'cpl.csv'), 'utf8'));
    assert(cpl.length - 1 === totalParts, `CPL has ${cpl.length - 1} rows, expected ${totalParts}`);
    const sizeMatch = /Size: ([\d.]+) x ([\d.]+) mm/.exec(state);
    assert(sizeMatch, 'panel size missing from the state');
    const [pw, ph] = [Number(sizeMatch[1]), Number(sizeMatch[2])];
    const at = new Map(cpl.slice(1).map((r) => [r[0]!, { x: Number(r[1]), y: Number(r[2]), rot: Number(r[4]) }]));
    for (const [d, p] of at) {
      assert(p.x > -2 && p.x < pw + 2 && p.y > -2 && p.y < ph + 2, `${d} at (${p.x}, ${p.y}) is outside the ${pw} x ${ph} mm panel`);
    }
    // Two parts of one board keep their distance on every instance, whatever its rotation.
    const dist = (a: string, b: string): number => Math.hypot(at.get(a)!.x - at.get(b)!.x, at.get(a)!.y - at.get(b)!.y);
    const want = Math.hypot(12 - 17.5, 12.5 - 11); // R1 to C1 on the breakout
    for (let i = 1; i <= 5; i++) {
      assert(Math.abs(dist(`M${i}_R1`, `M${i}_C1`) - want) < 1e-3, `M${i}: R1 and C1 are ${dist(`M${i}_R1`, `M${i}_C1`)} mm apart, expected ${want}`);
    }
    // And an instance's rotation shows in its parts' rotations.
    for (const inst of panel.instances.filter((x) => x.source === 'M')) {
      const r1 = at.get(`${inst.id}_R1`)!;
      assert(((r1.rot - inst.rotation) % 360 + 360) % 360 === 0, `${inst.id}_R1 has rotation ${r1.rot} on an instance turned ${inst.rotation}`);
    }
    console.log(`  cpl.csv: ${cpl.length - 1} rows, all inside the ${pw} x ${ph} mm panel, geometry preserved per instance`);
    summary.push(['CPL', `${cpl.length - 1} rows, panel coordinates`]);

    // --- a bare instance ---------------------------------------------------
    step('panel_set_populate M5 false, export again');
    await call('panel_set_populate', { id: 'M5', populate: false });
    const bareDir = join(projectDir, 'fab-panel-bare');
    const bareOut = await call('export_panel_fab', { outDir: bareDir, ...(routing ? {} : { waive: true }) });
    assert(
      bareOut.includes(`Placed by assembly: ${totalParts - BREAKOUT.placements.length} component(s). Left off (bare instances): ${BREAKOUT.placements.length}.`),
      'the bare instance was not left off',
    );
    const bareBom = await readFile(join(bareDir, 'bom.csv'), 'utf8');
    const bareCpl = await readFile(join(bareDir, 'cpl.csv'), 'utf8');
    assert(!bareBom.includes('M5_') && !bareCpl.includes('M5_'), 'M5 still appears in the BOM or CPL');
    assert(bareBom.includes('M4_') && bareCpl.includes('M4_R1'), 'M4 went missing with M5');
    const bareNames = new AdmZip(join(bareDir, 'gerbers.zip')).getEntries().map((e) => e.entryName).sort();
    assert(JSON.stringify(bareNames) === JSON.stringify([...names].sort()), 'the bare panel has a different set of gerber files');
    console.log('  M5 is fabricated but absent from BOM and CPL');
    summary.push(['Bare instance', 'M5 left out of BOM and CPL, still fabricated']);
    await call('panel_undo');

    // --- V-cut -------------------------------------------------------------
    // Both reference boards have rounded corners, so V-cut must be refused by
    // the check; a waived export still has to carry the scores on the profile.
    step('panel_set_settings separation v-cut, check, export waived, then panel_undo');
    console.log('  ' + (await call('panel_set_settings', { separation: 'v-cut' })));
    const vcutCheck = await call('panel_check');
    assert(/not a plain rectangle \(rounded corners/.test(vcutCheck), 'panel_check did not refuse V-cut for boards with rounded corners');
    const vcutDir = join(projectDir, 'fab-panel-vcut');
    const refused = await raw('export_panel_fab', { outDir: vcutDir });
    assert(refused.isError === true, 'export_panel_fab wrote a V-cut panel of rounded boards without a waiver');
    await call('export_panel_fab', { outDir: vcutDir, waive: true });
    const vEntries = new AdmZip(join(vcutDir, 'gerbers.zip')).getEntries();
    const vGko = vEntries.find((e) => e.entryName === 'combo.GKO')!.getData().toString('utf8');
    const vParser = createParser();
    vParser.feed(vGko);
    assert(vParser.results().done === true, 'the V-cut profile does not parse');
    const vNpth = vEntries.find((e) => e.entryName === 'combo-NPTH.DRL')?.getData().toString('utf8') ?? '';
    // The boards bring non-plated holes of their own; the mouse bites must be gone.
    const hits = (drl: string): number => drl.split('\n').filter((l) => /^X/.test(l)).length;
    assert(hits(vNpth) < hits(npth), `a V-cut panel still has mouse-bite holes (${hits(vNpth)} non-plated hits, ${hits(npth)} with mouse bites)`);
    // Profile: the frame (one contour of 4 strokes), then one open stroke per score, then label text.
    const vState = await call('panel_get_state');
    const vSize = /Size: ([\d.]+) x ([\d.]+) mm/.exec(vState);
    assert(vSize, 'V-cut panel size missing from the state');
    const [vw, vh] = [Number(vSize[1]), Number(vSize[2])];
    const scoreLines = [...vGko.matchAll(/X(-?\d+)Y(-?\d+)D02\*\nX(-?\d+)Y(-?\d+)D01\*/g)].filter((m) => {
      const [x1, y1, x2, y2] = m.slice(1, 5).map((n) => Number(n) / 1e6);
      return (Math.abs(x1! - x2!) < 1e-6 && Math.abs(Math.abs(y2! - y1!) - vh) < 1e-3) || (Math.abs(y1! - y2!) < 1e-6 && Math.abs(Math.abs(x2! - x1!) - vw) < 1e-3);
    });
    assert(scoreLines.length >= 2, `expected edge-to-edge V-cut lines on the profile, found ${scoreLines.length}`);
    assert(/%ADD\d+C,0\.18\*%/.test(vGko), 'no V-CUT label stroke on the profile');
    console.log(`  ${scoreLines.length} edge-to-edge V-cut lines with labels on combo.GKO; V-cut refused for rounded boards`);
    summary.push(['V-cut', `${scoreLines.length} score lines on the profile; rounded boards refused`]);
    await call('panel_undo');
    assert(/mouse-bite/.test(await call('panel_get_state')), 'undo did not restore mouse bites');

    // --- keep the artifacts ------------------------------------------------
    step(`save + copy artifacts to ${OUT_DIR}`);
    await call('panel_save');
    for (const f of [`${ESP32.name}.flamingo`, `${BREAKOUT.name}.flamingo`, 'combo.flamboyance']) {
      await copyFile(join(projectDir, f), join(OUT_DIR, f));
    }
    await mkdir(join(OUT_DIR, 'fab'), { recursive: true });
    for (const f of await readdir(fabDir)) await copyFile(join(fabDir, f), join(OUT_DIR, 'fab', f));
    await writeFile(join(OUT_DIR, 'quote.txt'), quote);

    summary.push(['Elapsed', `${((Date.now() - t0) / 1000).toFixed(0)}s`]);
    console.log('\n' + '='.repeat(64));
    console.log(`  FLAMINGO E2E — PANEL 1 + 5 — PASS${routing ? '' : ' (UNROUTED BOARDS: no Java runtime)'}`);
    console.log('='.repeat(64));
    const w = Math.max(...summary.map(([k]) => k.length));
    for (const [k, v] of summary) console.log(`  ${k.padEnd(w)}  ${v}`);
    console.log('='.repeat(64));
  } finally {
    if (client) await client.close().catch(() => {});
    if (started) await started.close().catch(() => {});
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error('\nE2E FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
