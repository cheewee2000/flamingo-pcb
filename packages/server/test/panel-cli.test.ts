import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePanel } from '@flamingo/panel';
import { runPanelCli } from '../src/panel/cli.js';
import { writeBoards } from './panel-helpers.js';

describe('flamingo panel CLI', () => {
  let dir: string;
  let file: string;

  async function run(...argv: string[]): Promise<{ status: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const status = await runPanelCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { status, out: out.join('\n'), err: err.join('\n') };
  }

  async function ok(...argv: string[]): Promise<string> {
    const r = await run(...argv);
    if (r.status !== 0) throw new Error(`panel ${argv.join(' ')} exited ${r.status}: ${r.err}`);
    return r.out;
  }

  async function build(): Promise<void> {
    await ok('new', file, '--name', 'combo');
    await ok('add-board', file, join(dir, 'sensor.flamingo'), '--needed', '1');
    await ok('add-board', file, join(dir, 'mini.flamingo'), '--needed', '5');
    await ok('add-instance', file, 'S');
    await ok('add-instance', file, 'M', '--count', '3');
    await ok('arrange', file);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-cli-'));
    file = join(dir, 'combo.flamboyance');
    await writeBoards(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prints usage', async () => {
    expect((await run('help')).out).toContain('Usage: flamingo panel <command>');
    expect((await run()).status).toBe(2);
    const unknown = await run('frobnicate', file);
    expect(unknown.status).not.toBe(0);
  });

  it('new refuses to overwrite', async () => {
    await ok('new', file);
    const again = await run('new', file);
    expect(again.status).toBe(1);
    expect(again.err).toContain('already exists');
  });

  it('every command persists to the file', async () => {
    await build();
    const panel = parsePanel(await readFile(file, 'utf8'));
    expect(panel.name).toBe('combo');
    expect(panel.sources.map((s) => [s.key, s.path, s.needed])).toEqual([
      ['S', 'sensor.flamingo', 1],
      ['M', 'mini.flamingo', 5],
    ]);
    expect(panel.instances.map((i) => i.id)).toEqual(['S1', 'M1', 'M2', 'M3']);
    // Arranged: no two instances share a corner any more.
    expect(new Set(panel.instances.map((i) => `${i.at.x},${i.at.y}`)).size).toBe(4);
  });

  it('show, check and the edit commands', async () => {
    await build();
    expect(await ok('show', file)).toContain('Panel "combo"');
    expect(await ok('check', file)).toContain('0 error(s)');

    expect(await ok('move-instance', file, 'M1', '--x', '100', '--y', '7')).toBe('Moved M1 to (100, 7), pinned');
    expect(await ok('rotate-instance', file, 'M1')).toBe('Rotated M1 to 90, now at (103, 4)');
    expect(await ok('pin', file, 'M1', '--unpin')).toBe('M1 is now unpinned');
    expect(await ok('set-populate', file, 'M2', 'false')).toBe('M2 is now bare');
    expect(await ok('set-quantity', file, 'S', '--needed', '2')).toBe('S: need 2');
    expect(await ok('set', file, '--rail-left', '5', '--rail-right', '5', '--spacing', '2.5')).toBe('Settings updated.');
    expect(await ok('remove-instance', file, 'M3')).toBe('Removed M3');

    const panel = parsePanel(await readFile(file, 'utf8'));
    expect(panel.instances.find((i) => i.id === 'M1')).toMatchObject({ at: { x: 103, y: 4 }, rotation: 90, pinned: false });
    expect(panel.instances.find((i) => i.id === 'M2')!.populate).toBe(false);
    expect(panel.settings.rails).toEqual({ top: 5, bottom: 5, left: 5, right: 5 });
    expect(panel.settings.spacing).toBe(2.5);
    expect(panel.sources[0]!.needed).toBe(2);
  });

  it('check exits 1 when there are errors, and says which', async () => {
    await build();
    await ok('move-instance', file, 'M1', '--x', '1', '--y', '8');
    const r = await run('check', file);
    expect(r.status).toBe(1);
    expect(r.out).toContain('[overlap]');
  });

  it('reports bad arguments', async () => {
    await build();
    expect((await run('move-instance', file, 'M1', '--x', 'left', '--y', '7')).err).toContain('--x must be a number');
    expect((await run('rotate-instance', file, 'M1', '--rotation', 'up')).err).toContain('rotation');
    expect((await run('set', file, '--layers', '3')).err).toContain('--layers must be auto, 2, 4 or 6');
    expect((await run('remove-instance', file, 'Z9')).err).toBe('Unknown instance "Z9"');
    expect((await run('show', join(dir, 'missing.flamboyance'))).err).toContain('does not exist');
  });

  it('quote prints ranked scenarios, and JSON on request', async () => {
    await build();
    const text = await ok('quote', file, '--offline', '--objective', 'overage');
    expect(text).toContain('THE PANEL AS IT STANDS');
    expect(text).toContain('ranked by least overage');
    expect(text).toContain('~ marks an ESTIMATE');

    const json = JSON.parse(await ok('quote', file, '--offline', '--json')) as {
      objective: string;
      scenarios: Array<{ id: string; total: number; lines: unknown[]; received: unknown[]; estimate: boolean }>;
      panel: { cost: { total: number } };
    };
    expect(json.objective).toBe('total');
    expect(json.scenarios.length).toBeGreaterThan(3);
    expect(json.scenarios[0]!.lines.length).toBeGreaterThan(0);
    expect(json.panel.cost.total).toBeGreaterThan(0);
    expect((await run('quote', file, '--objective', 'cheapest')).err).toContain('--objective must be one of');
  });

  it('apply-scenario replaces the layout in the file', async () => {
    await build();
    expect(await ok('apply-scenario', file, 'merged-needed-x5', '--offline')).toContain('Loaded scenario "merged-needed-x5"');
    expect(parsePanel(await readFile(file, 'utf8')).instances.map((i) => i.id).sort()).toEqual(['M1', 'S1']);
  });

  it('screenshot and export write their files', async () => {
    await build();
    const png = join(dir, 'shot.png');
    expect(await ok('screenshot', file, '--out', png, '--width', '600')).toBe(`Wrote ${png}`);
    expect((await readFile(png)).readUInt32BE(16)).toBe(600);

    const out = await ok('export', file, '--out', join(dir, 'out'));
    expect(out).toContain('Placed by assembly: 5 component(s). Left off (bare instances): 0.');
    for (const f of ['gerbers.zip', 'bom.csv', 'cpl.csv', 'panel.render.svg', 'panel.fab.svg']) {
      expect((await stat(join(dir, 'out', f))).size).toBeGreaterThan(0);
    }
  });

  it('export refuses on errors without --waive', async () => {
    await build();
    await ok('move-instance', file, 'M1', '--x', '1', '--y', '8');
    const refused = await run('export', file, '--out', join(dir, 'out'));
    expect(refused.status).toBe(1);
    expect(refused.err).toContain('Export refused');
    expect((await run('export', file, '--out', join(dir, 'out'), '--waive')).status).toBe(0);
  });
});
