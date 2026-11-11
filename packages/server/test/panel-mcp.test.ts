import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { createParser, GERBER, DRILL, UNIMPLEMENTED } from '@tracespace/parser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { newBoard, serializeBoard } from '@flamingo/engine';
import { parsePanel } from '@flamingo/panel';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';
import { PANEL_TOOL_NAMES } from '../src/panel/mcp.js';
import { miniBoard, sensorBoard, startPanelServer, writeBoards } from './panel-helpers.js';

function textOf(r: CallToolResult): string {
  return (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
}

describe('panel MCP tools', () => {
  let dir: string;
  let started: StartedServer;
  let client: Client;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; raw: CallToolResult }> {
    const raw = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { text: textOf(raw), isError: raw.isError === true, raw };
  }

  async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r.text;
  }

  /** The standard fixture: one sensor and five minis wanted, 1 + 3 on the panel. */
  async function build(): Promise<void> {
    await ok('panel_new', { name: 'combo' });
    await ok('panel_add_board', { path: 'sensor.flamingo', needed: 1 });
    await ok('panel_add_board', { path: 'mini.flamingo', needed: 5 });
    await ok('panel_add_instance', { board: 'S' });
    for (let i = 0; i < 3; i++) await ok('panel_add_instance', { board: 'M' });
    await ok('panel_arrange');
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-mcp-'));
    await writeBoards(dir);
    started = await startPanelServer(dir);
    client = new Client({ name: 'panel-test', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${started.port}/mcp`)));
  });

  afterEach(async () => {
    await client.close();
    await started.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the panel tools next to the 37 board tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of PANEL_TOOL_NAMES) expect(names).toContain(n);
    expect(tools).toHaveLength(37 + PANEL_TOOL_NAMES.length);
    for (const t of tools.filter((x) => (PANEL_TOOL_NAMES as readonly string[]).includes(x.name))) {
      expect(t.description, t.name).toBeTruthy();
      const props = (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [field, schema] of Object.entries(props)) expect(schema.description, `${t.name}.${field}`).toBeTruthy();
    }
  });

  it('a server started without panels has exactly the board tools', async () => {
    const plain = await startServer(new Doc(newBoard('x', 2)), 0, { projectDir: dir });
    const c = new Client({ name: 'plain', version: '0.1.0' });
    try {
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${plain.port}/mcp`)));
      const { tools } = await c.listTools();
      expect(tools).toHaveLength(37);
      expect(tools.some((t) => t.name.startsWith('panel_'))).toBe(false);
      expect((await fetch(`http://localhost:${plain.port}/api/panel`)).status).toBe(404);
    } finally {
      await c.close();
      await plain.close();
    }
  });

  it('panel_new creates the file next to the boards', async () => {
    const out = await ok('panel_new', { name: 'my combo' });
    expect(out).toContain(join(dir, 'my_combo.flamboyance'));
    const panel = parsePanel(await readFile(join(dir, 'my_combo.flamboyance'), 'utf8'));
    expect(panel).toMatchObject({ name: 'my combo', sources: [], instances: [] });
  });

  it('panel_add_board stores a relative path and a hash, and picks keys', async () => {
    await ok('panel_new', { name: 'combo' });
    expect(await ok('panel_add_board', { path: 'sensor.flamingo' })).toBe('Added board S = "sensor" (40 x 30 mm, 2-layer)');
    expect(await ok('panel_add_board', { path: join(dir, 'mini.flamingo'), needed: 5 })).toContain('Added board M');
    await ok('panel_save');
    const panel = parsePanel(await readFile(join(dir, 'combo.flamboyance'), 'utf8'));
    expect(panel.sources.map((s) => [s.key, s.path, s.needed])).toEqual([
      ['S', 'sensor.flamingo', 1],
      ['M', 'mini.flamingo', 5],
    ]);
    expect(panel.sources[0]!.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const dup = await call('panel_add_board', { path: 'sensor.flamingo' });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain('already on the panel');
    const missing = await call('panel_add_board', { path: 'nope.flamingo' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('could not read board');
  });

  it('builds, arranges and describes a panel', async () => {
    await build();
    const state = await ok('panel_get_state');
    expect(state).toContain('Panel "combo"');
    expect(state).toMatch(/Size: [\d.]+ x [\d.]+ mm, 2-layer \(jlcpcb-2l\), mouse-bite, spacing 2 mm/);
    expect(state).toContain('S = sensor.flamingo "sensor" (40 x 30 mm, 2-layer, 2 part line(s), 1 extended) — need 1, on panel 1 (1 populated)');
    expect(state).toContain('M = mini.flamingo "mini"');
    expect(state).toMatch(/M3 at \([\d.]+, [\d.]+\) rot (0|90) — populated/);
    expect(state).toContain('Check: 0 error(s)');
    expect(state).toMatch(/Estimated cost of this panel: ~\$\d+\.\d\d/);
  });

  it('panel_arrange reports a panel that does not fit as data, and changes nothing', async () => {
    await ok('panel_new', { name: 'big' });
    await ok('panel_add_board', { path: 'sensor.flamingo' });
    for (let i = 0; i < 45; i++) await ok('panel_add_instance', { board: 'S' });
    const before = started.panel!.panel;
    const r = await call('panel_arrange');
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Does not fit: 45 instances do not fit within 250 x 250 mm (the assembly panel limit)');
    expect(r.text).toMatch(/Smallest panel that would fit: [\d.]+ x [\d.]+ mm/);
    expect(started.panel!.panel).toBe(before);
  });

  it('moves, rotates, pins, populates and removes instances', async () => {
    await build();
    expect(await ok('panel_move_instance', { id: 'M1', x: 100, y: 7 })).toBe('Moved M1 to (100, 7), pinned');
    expect(await ok('panel_pin', { id: 'M1', pinned: false })).toBe('M1 is now unpinned');
    expect(await ok('panel_pin', { id: 'M1' })).toBe('M1 is now pinned');
    expect(await ok('panel_set_populate', { id: 'M2', populate: false })).toBe('M2 is now bare');

    // 18 x 12 at (100, 7) turned about its centre: 12 x 18 at (103, 4).
    expect(await ok('panel_rotate_instance', { id: 'M1' })).toBe('Rotated M1 to 90, now at (103, 4)');
    expect(await ok('panel_rotate_instance', { id: 'M1', rotation: 0 })).toBe('Rotated M1 to 0, now at (100, 7)');

    expect(await ok('panel_remove_instance', { id: 'M3' })).toBe('Removed M3');
    const panel = started.panel!.panel;
    expect(panel.instances.map((i) => i.id)).toEqual(['S1', 'M1', 'M2']);
    expect(panel.instances.find((i) => i.id === 'M1')).toMatchObject({ at: { x: 100, y: 7 }, pinned: true, rotation: 0 });
    expect(panel.instances.find((i) => i.id === 'M2')!.populate).toBe(false);

    const bad = await call('panel_move_instance', { id: 'Z9', x: 0, y: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe('ERROR: Unknown instance "Z9"');
  });

  it('panel_arrange works around a pinned instance', async () => {
    await build();
    await ok('panel_move_instance', { id: 'S1', x: 30, y: 7 });
    expect(await ok('panel_arrange')).toMatch(/^Arranged 3 instance\(s\)/);
    expect(started.panel!.panel.instances.find((i) => i.id === 'S1')).toMatchObject({ at: { x: 30, y: 7 }, pinned: true });
    expect(await ok('panel_check')).toContain('0 error(s)');
  });

  it('panel_undo and panel_redo walk the op log', async () => {
    await build();
    await ok('panel_set_populate', { id: 'M2', populate: false });
    await ok('panel_undo');
    expect(started.panel!.panel.instances.find((i) => i.id === 'M2')!.populate).toBe(true);
    await ok('panel_redo');
    expect(started.panel!.panel.instances.find((i) => i.id === 'M2')!.populate).toBe(false);
    const again = await call('panel_redo');
    expect(again.isError).toBe(true);
    expect(again.text).toContain('Nothing to redo');
  });

  it('panel_check lists findings as data', async () => {
    await build();
    await ok('panel_move_instance', { id: 'M1', x: 1, y: 8 }); // on top of the sensor
    const r = await call('panel_check');
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Panel check: \d+ error\(s\)/);
    expect(r.text).toContain('[error] [overlap]');
    expect(r.text).toContain('instances: S1, M1');
  });

  it('detects a source board edited on disk, and panel_refresh_boards accepts it', async () => {
    await build();
    expect(await ok('panel_check')).not.toContain('source-stale');

    const edited = miniBoard();
    edited.components[0]!.at.x += 1;
    const file = join(dir, 'mini.flamingo');
    await writeFile(file, serializeBoard(edited));
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    started.panel!.touch();

    const stale = await ok('panel_check');
    expect(stale).toContain('[warning] [source-stale] M (mini.flamingo) changed on disk');
    expect(await ok('panel_get_state')).toContain('STALE');
    expect(await ok('panel_refresh_boards')).toBe('Refreshed M');
    expect(await ok('panel_check')).not.toContain('source-stale');
    expect(await ok('panel_refresh_boards')).toBe('Nothing to refresh: no board changed.');
  });

  it('reports mixed layer counts and offers promotion', async () => {
    await writeFile(join(dir, 'four.flamingo'), serializeBoard({ ...miniBoard(4), name: 'four' }));
    await ok('panel_new', { name: 'mixed' });
    await ok('panel_add_board', { path: 'sensor.flamingo' });
    await ok('panel_add_board', { path: 'four.flamingo' });
    await ok('panel_add_instance', { board: 'S' });
    await ok('panel_add_instance', { board: 'F' });
    await ok('panel_arrange');
    const mixed = await ok('panel_check');
    expect(mixed).toContain('[error] [stackup-mismatch]');
    expect(mixed).toContain('promote the panel to 4 layers');

    expect(await ok('panel_set_settings', { copperLayers: 4 })).toContain('layers 4');
    const promoted = await ok('panel_check');
    expect(promoted).not.toContain('stackup-mismatch');
    expect(promoted).toContain('[info] [stackup-promoted] S (2-layer) will be made as 4-layer');
  });

  it('panel_screenshot returns a PNG', async () => {
    await build();
    const r = await call('panel_screenshot', { widthPx: 800 });
    const content = r.raw.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    const img = content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/png');
    const png = Buffer.from(img.data!, 'base64');
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(800);
    expect(r.text).toMatch(/800x\d+px, panel [\d.]+ x [\d.]+ mm, 4 instance\(s\), \d+ tab\(s\), 0 error\(s\)/);
    const fab = await call('panel_screenshot', { widthPx: 600, view: 'fab' });
    const fabImg = (fab.raw.content as Array<{ type: string; data?: string }>).find((c) => c.type === 'image')!;
    expect(Buffer.from(fabImg.data!, 'base64').readUInt32BE(16)).toBe(600);
    const layout = await call('panel_screenshot', { widthPx: 600 });
    expect((layout.raw.content as Array<{ data?: string }>).find((c) => c.data)!.data).not.toBe(fabImg.data);
  });

  it('quote_order ranks scenarios and flags estimates', async () => {
    await build();
    const out = await ok('quote_order');
    expect(out).toContain('THE PANEL AS IT STANDS');
    expect(out).toContain('Order: 5 panel(s), 2 assembled (Economic PCBA)');
    expect(out).toContain('S (sensor): 2 assembled + 3 bare (need 1; 1 over)');
    expect(out).toContain('M (mini): 6 assembled + 9 bare (need 5; 1 over)');
    expect(out).toMatch(/scenario\(s\), ranked by total cost:/);
    expect(out).toContain('[separate] Separate orders, one per design');
    expect(out).toContain('[merged-needed-x2] One panel, mouse bites');
    expect(out).toContain('[silk-divider-needed-x2] One board, silkscreen dividers');
    expect(out).toContain('~ marks an ESTIMATE');
    // Verified fees carry no mark; bare-board prices always do.
    expect(out).toMatch(/Economic PCBA setup\s+\$8\.18/);
    expect(out).toMatch(/5 panels, [\d.]+ x [\d.]+ mm, 2-layer\s+~\$/);
    // The module's price came from the injected lookup.
    expect(out).toMatch(/C2913204 MODULE x 5\s+~\$16\.00/);

    const totals = [...out.matchAll(/^\s*\d+\.\s+~\$(\d+\.\d\d)/gm)].map((m) => Number(m[1]));
    expect(totals.length).toBeGreaterThanOrEqual(5);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));

    const brief = await ok('quote_order', { objective: 'overage', detail: false });
    expect(brief).toContain('ranked by least overage');
    expect(brief).not.toContain('        Economic PCBA setup');
  });

  it('panel_apply_scenario loads a scenario onto the panel, as one undo step', async () => {
    await build();
    const before = started.panel!.panel;
    const out = await ok('panel_apply_scenario', { id: 'silk-divider-needed-x5' });
    expect(out).toContain('Loaded scenario "silk-divider-needed-x5"');
    const panel = started.panel!.panel;
    expect(panel.settings.separation).toBe('silk-divider');
    expect(panel.settings.rails).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(panel.instances.map((i) => i.id).sort()).toEqual(['M1', 'S1']);
    expect(await ok('panel_check')).toContain('0 error(s)');

    await ok('panel_undo');
    expect(started.panel!.panel).toEqual(before);

    expect(await ok('panel_apply_scenario', { id: 'separate' })).toContain('there is no panel to load');
    const unknown = await call('panel_apply_scenario', { id: 'nope' });
    expect(unknown.isError).toBe(true);
  });

  it('export_panel_fab writes a fileset that parses, with prefixed designators', async () => {
    await build();
    await ok('panel_set_populate', { id: 'M3', populate: false });
    const out = await ok('export_panel_fab');
    const fab = join(dir, 'fab', 'combo');
    expect(out).toContain(`Exported panel fab outputs to ${fab}`);
    expect(out).toContain('Placed by assembly: 4 component(s). Left off (bare instances): 1.');

    for (const f of ['gerbers.zip', 'bom.csv', 'cpl.csv', 'panel.render.svg', 'panel.fab.svg']) {
      expect((await stat(join(fab, f))).size).toBeGreaterThan(0);
    }
    const entries = new AdmZip(join(fab, 'gerbers.zip')).getEntries();
    expect(entries.map((e) => e.entryName).sort()).toContain('combo.GKO');
    for (const e of entries) {
      const parser = createParser();
      parser.feed(e.getData().toString('utf8'));
      const root = parser.results();
      if (e.entryName.endsWith('.DRL')) {
        expect(root.filetype).toBe(DRILL);
        expect(root.children.filter((c) => c.type === UNIMPLEMENTED)).toEqual([]);
      } else {
        expect(root.filetype).toBe(GERBER);
        expect(root.done).toBe(true);
      }
    }
    const bom = await readFile(join(fab, 'bom.csv'), 'utf8');
    expect(bom).toContain('"M1_R1,M2_R1,S1_R1"');
    expect(bom).toContain('S1_U1');
    expect(bom).not.toContain('M3_');
    const cpl = (await readFile(join(fab, 'cpl.csv'), 'utf8')).trim().split('\r\n');
    expect(cpl).toHaveLength(1 + 4);
    expect(cpl.slice(1).map((l) => l.split(',')[0]).sort()).toEqual(['M1_R1', 'M2_R1', 'S1_R1', 'S1_U1']);
  });

  it('export_panel_fab refuses on errors unless waived', async () => {
    await build();
    await ok('panel_move_instance', { id: 'M1', x: 1, y: 8 });
    const refused = await call('export_panel_fab', { outDir: 'out' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('[overlap]');
    expect(refused.text).toContain('Export refused');
    await expect(stat(join(dir, 'out'))).rejects.toThrow();

    const waived = await ok('export_panel_fab', { outDir: 'out', waive: true });
    expect(waived).toContain('Waived');
    expect((await stat(join(dir, 'out', 'gerbers.zip'))).size).toBeGreaterThan(0);
  });

  it('a source board with DRC violations of its own stops the export', async () => {
    const bad = sensorBoard();
    bad.name = 'bad';
    bad.components[1]!.at = { x: 20, y: 15 }; // resistor on top of the module: courtyard overlap
    await writeFile(join(dir, 'bad.flamingo'), serializeBoard(bad));
    await ok('panel_new', { name: 'withbad' });
    await ok('panel_add_board', { path: 'bad.flamingo' });
    await ok('panel_add_instance', { board: 'B' });
    await ok('panel_add_instance', { board: 'B' });
    await ok('panel_arrange');
    expect(await ok('panel_check')).toMatch(/\[error\] \[source-drc\] B \(bad\) has \d+ DRC violation/);
    expect((await call('export_panel_fab')).isError).toBe(true);
  });

  it('panel_open reads a saved panel back', async () => {
    await build();
    await ok('panel_save');
    await ok('panel_new', { name: 'other' });
    const out = await ok('panel_open', { path: 'combo.flamboyance' });
    expect(out).toContain('Panel "combo"');
    expect(started.panel!.panel.instances).toHaveLength(4);
    const bad = await call('panel_open', { path: 'sensor.flamingo' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Not a panel file');
  });

  it('autosaves panel edits like board edits', async () => {
    await build();
    await new Promise((r) => setTimeout(r, 120));
    const saved = parsePanel(await readFile(join(dir, 'combo.flamboyance'), 'utf8'));
    expect(saved).toEqual(started.panel!.panel);
  });

  it('leaves the board editor alone', async () => {
    await build();
    const board = (await (await fetch(`http://localhost:${started.port}/api/board`)).json()) as { name: string };
    expect(board.name).toBe('editor');
    expect(await ok('get_board_state')).toContain('Board "editor"');
  });
});
