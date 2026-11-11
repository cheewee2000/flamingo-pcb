import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StartedServer } from '../src/http.js';
import type { PanelView } from '../src/panel/session.js';
import type { PanelLoading } from '@flamingo/panel';
import { startPanelServer, writeBoards } from './panel-helpers.js';

interface Msg {
  type: string;
  view?: PanelView;
  board?: { name: string };
  result?: { ok: boolean; error?: string; created?: string[] };
  loading?: PanelLoading | null;
}

function queue(ws: WebSocket): { next(): Promise<Msg>; until(pred: (m: Msg) => boolean): Promise<Msg> } {
  const buffered: Msg[] = [];
  const waiters: Array<(m: Msg) => void> = [];
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString()) as Msg;
    const w = waiters.shift();
    if (w) w(msg);
    else buffered.push(msg);
  });
  const next = (): Promise<Msg> => {
    const m = buffered.shift();
    return m ? Promise.resolve(m) : new Promise((r) => waiters.push(r));
  };
  return {
    next,
    async until(pred) {
      for (;;) {
        const m = await next();
        if (pred(m)) return m;
      }
    },
  };
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('panel sync: MCP, HTTP and WebSocket act on one panel', () => {
  let dir: string;
  let uiDir: string;
  let started: StartedServer;
  let base: string;
  let client: Client;
  const sockets: WebSocket[] = [];

  async function panelSocket(): Promise<{ ws: WebSocket; q: ReturnType<typeof queue> }> {
    const ws = new WebSocket(`ws://localhost:${started.port}/ws?channel=panel`);
    const q = queue(ws); // listen before the first message can arrive
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    sockets.push(ws);
    return { ws, q };
  }

  async function post(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-sync-'));
    uiDir = join(dir, 'ui-dist');
    await mkdir(uiDir);
    await writeFile(join(uiDir, 'index.html'), '<title>editor</title>');
    await writeFile(join(uiDir, 'panel.html'), '<title>panel</title>');
    await writeBoards(dir);
    started = await startPanelServer(dir, uiDir);
    base = `http://localhost:${started.port}`;
    client = new Client({ name: 'sync-test', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await client.close();
    await started.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('sends the panel view on connect', async () => {
    const { q } = await panelSocket();
    const first = await q.next();
    expect(first.type).toBe('panel');
    expect(first.view!.panel.name).toBe('panel');
    expect(first.view!.panel.instances).toEqual([]);
    expect(first.view!.limits.map((l) => l.label)).toEqual(['assembly max (single board)', 'fab max (2-layer)']);
  });

  it('a change made over MCP reaches the browser', async () => {
    const { q } = await panelSocket();
    await q.next();
    await client.callTool({ name: 'panel_new', arguments: { name: 'combo' } });
    await client.callTool({ name: 'panel_add_board', arguments: { path: 'mini.flamingo', needed: 5 } });
    await client.callTool({ name: 'panel_add_instance', arguments: { board: 'M', x: 10, y: 7 } });
    const seen = await q.until((m) => m.type === 'panel' && m.view!.panel.instances.length === 1);
    expect(seen.view!.panel.name).toBe('combo');
    expect(seen.view!.sources[0]).toMatchObject({ key: 'M', needed: 5, instances: 1, populated: 1 });
    expect(seen.view!.geometry.instances[0]).toMatchObject({ id: 'M1', bbox: { minX: 10, minY: 7, maxX: 28, maxY: 19 } });
    expect(seen.view!.geometry.frame).toMatchObject({ width: 18, height: 12 + 2 * 2 + 2 * 5 });
    expect(seen.view!.quote.cost!.total).toBeGreaterThan(0);
  });

  it('reports the board checks a view waits on, then the view', async () => {
    const { q } = await panelSocket();
    await q.next();
    await client.callTool({ name: 'panel_new', arguments: { name: 'combo' } });
    await client.callTool({ name: 'panel_add_board', arguments: { path: 'mini.flamingo' } });
    await client.callTool({ name: 'panel_add_instance', arguments: { board: 'M', x: 0, y: 0 } });
    const first = await q.until((m) => m.type === 'loading' && m.loading !== null);
    expect(first.loading!.boards).toEqual([expect.objectContaining({ key: 'M', name: expect.any(String), color: expect.stringMatching(/^#/) })]);
    expect(first.loading!.startedAt).toBeGreaterThan(0);
    await q.until((m) => m.type === 'loading' && m.loading === null);
    const view = await q.until((m) => m.type === 'panel' && m.view!.panel.instances.length === 1);
    expect(view.view!.sources[0]!.key).toBe('M');

    // The result is kept: the same board on the next change runs no check.
    await client.callTool({ name: 'panel_add_instance', arguments: { board: 'M', x: 40, y: 0 } });
    const next = await q.until((m) => m.type === 'panel' || (m.type === 'loading' && m.loading !== null));
    expect(next.type).toBe('panel');
  });

  it('a change made in the browser is what MCP reads next', async () => {
    await client.callTool({ name: 'panel_new', arguments: { name: 'combo' } });
    await client.callTool({ name: 'panel_add_board', arguments: { path: 'mini.flamingo' } });
    const { ws, q } = await panelSocket();
    await q.next();

    ws.send(JSON.stringify({ type: 'op', op: { op: 'addInstance', source: 'M', at: { x: 3, y: 9 } } }));
    const result = await q.until((m) => m.type === 'opResult');
    expect(result.result).toEqual({ ok: true, created: ['M1'] });

    // The drag that pins: what the canvas sends on drop.
    ws.send(JSON.stringify({ type: 'op', op: { op: 'moveInstance', id: 'M1', at: { x: 40, y: 12 }, pin: true } }));
    await q.until((m) => m.type === 'panel' && m.view!.panel.instances[0]?.at.x === 40);

    const state = (await client.callTool({ name: 'panel_get_state', arguments: {} })) as { content: Array<{ text: string }> };
    expect(state.content[0]!.text).toContain('M1 at (40, 12) rot 0 — populated, pinned');
  });

  it('every browser sees a change made in another', async () => {
    await post('/api/panel/new', { name: 'combo' });
    await post('/api/panel/add-board', { path: 'mini.flamingo' });
    const a = await panelSocket();
    const b = await panelSocket();
    await a.q.next();
    await b.q.next();
    a.ws.send(JSON.stringify({ type: 'op', op: { op: 'addInstance', source: 'M' } }));
    const seenByB = await b.q.until((m) => m.type === 'panel' && m.view!.panel.instances.length === 1);
    expect(seenByB.view!.panel.instances[0]!.id).toBe('M1');
    // Only the sender gets the result.
    expect((await a.q.until((m) => m.type === 'opResult')).result!.ok).toBe(true);
  });

  it('a rejected op is reported to the sender and changes nothing', async () => {
    const { ws, q } = await panelSocket();
    await q.next();
    ws.send(JSON.stringify({ type: 'op', op: { op: 'removeInstance', id: 'X1' } }));
    expect((await q.until((m) => m.type === 'opResult')).result).toEqual({ ok: false, error: 'Unknown instance "X1"' });
    ws.send(JSON.stringify({ type: 'op', op: 'nonsense' }));
    expect((await q.until((m) => m.type === 'opResult')).result!.ok).toBe(false);
  });

  it('views carry a rising revision', async () => {
    await post('/api/panel/new', { name: 'combo' });
    await post('/api/panel/add-board', { path: 'mini.flamingo' });
    const { ws, q } = await panelSocket();
    const first = (await q.next()).view!.revision;
    ws.send(JSON.stringify({ type: 'op', op: { op: 'addInstance', source: 'M' } }));
    const second = (await q.until((m) => m.type === 'panel')).view!.revision;
    expect(second).toBeGreaterThan(first);
  });

  it('the board channel and the panel channel stay apart', async () => {
    const board = await open(`ws://localhost:${started.port}/ws`);
    sockets.push(board);
    const bq = queue(board);
    const { q: pq } = await panelSocket();
    await pq.next();

    await post('/api/panel/new', { name: 'combo' });
    await pq.until((m) => m.type === 'panel' && m.view!.panel.name === 'combo');

    // A board op reaches board sockets only.
    await fetch(`${base}/api/op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'setBoardMeta', name: 'renamed' }),
    });
    const got = await bq.until((m) => m.type === 'board' && m.board!.name === 'renamed');
    expect(got.type).toBe('board');

    // Give stray messages a moment to arrive, then check nothing crossed over.
    await new Promise((r) => setTimeout(r, 50));
    const strayOnPanel = await Promise.race([pq.next(), new Promise<null>((r) => setTimeout(() => r(null), 50))]);
    expect(strayOnPanel === null || strayOnPanel.type === 'panel').toBe(true);
  });

  it('HTTP: count, rotate, duplicate, arrange, undo', async () => {
    await post('/api/panel/new', { name: 'combo' });
    await post('/api/panel/add-board', { path: 'sensor.flamingo' });
    await post('/api/panel/add-board', { path: 'mini.flamingo', needed: 5 });

    const grown = await post('/api/panel/count', { board: 'M', count: 3 });
    expect(grown.json).toMatchObject({ ok: true, added: ['M1', 'M2', 'M3'], removed: [] });
    expect((grown.json.arranged as { ok: boolean }).ok).toBe(true);
    await post('/api/panel/count', { board: 'S', count: 1 });

    let view = (await (await fetch(`${base}/api/panel`)).json()) as PanelView;
    expect(view.panel.instances.map((i) => i.id)).toEqual(['M1', 'M2', 'M3', 'S1']);
    expect(view.issues.filter((i) => i.severity === 'error')).toEqual([]);

    // Growing the count is one undo step, arrange included.
    await post('/api/panel/undo');
    view = (await (await fetch(`${base}/api/panel`)).json()) as PanelView;
    expect(view.panel.instances.map((i) => i.id)).toEqual(['M1', 'M2', 'M3']);
    await post('/api/panel/redo');

    const shrunk = await post('/api/panel/count', { board: 'M', count: 1 });
    expect(shrunk.json).toMatchObject({ ok: true, removed: ['M3', 'M2'] });

    const dup = await post('/api/panel/duplicate', { id: 'S1' });
    expect(dup.json).toMatchObject({ ok: true, created: ['S2'] });
    const rot = await post('/api/panel/rotate', { id: 'S2' });
    expect(rot.status).toBe(200);

    const arranged = await post('/api/panel/arrange');
    expect(arranged.json).toMatchObject({ ok: true });
    view = (await (await fetch(`${base}/api/panel`)).json()) as PanelView;
    expect(view.issues.filter((i) => i.severity === 'error')).toEqual([]);

    expect((await post('/api/panel/count', { board: 'Q', count: 1 })).status).toBe(400);
    expect((await post('/api/panel/rotate', {})).status).toBe(400);
    expect((await fetch(`${base}/api/panel/nope`)).status).toBe(404);
  });

  it('HTTP: quote, apply a scenario, export a zip', async () => {
    await post('/api/panel/new', { name: 'combo' });
    await post('/api/panel/add-board', { path: 'sensor.flamingo', needed: 1 });
    await post('/api/panel/add-board', { path: 'mini.flamingo', needed: 5 });

    const quote = (await (await fetch(`${base}/api/panel/quote?objective=total`)).json()) as {
      ok: boolean;
      scenarios: Array<{ id: string; total: number; estimate: boolean }>;
    };
    expect(quote.ok).toBe(true);
    expect(quote.scenarios.map((s) => s.id)).toContain('merged-needed-x2');
    expect(quote.scenarios.every((s) => s.estimate)).toBe(true);

    const applied = await post('/api/panel/apply-scenario', { id: 'merged-needed-x2' });
    expect(applied.json).toMatchObject({ ok: true, loaded: true });
    const view = (await (await fetch(`${base}/api/panel`)).json()) as PanelView;
    expect(view.panel.instances).toHaveLength(4);
    // The live cost of the plate now equals the scenario that was loaded.
    expect(view.quote.cost!.total).toBeCloseTo(quote.scenarios.find((s) => s.id === 'merged-needed-x2')!.total, 2);

    const zipRes = await fetch(`${base}/api/panel/export.zip`);
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get('content-type')).toBe('application/zip');
    expect(zipRes.headers.get('content-disposition')).toBe('attachment; filename="combo-panel-fab.zip"');
    const names = new AdmZip(Buffer.from(await zipRes.arrayBuffer())).getEntries().map((e) => e.entryName);
    expect(names).toEqual(expect.arrayContaining(['combo.GTL', 'combo.GKO', 'combo-NPTH.DRL', 'bom.csv', 'cpl.csv', 'panel.render.svg', 'panel.fab.svg']));

    // Errors refuse the download, with the findings, unless waived.
    await post('/api/panel/op', { op: 'moveInstance', id: 'M1', at: { x: 1, y: 8 }, pin: true });
    const refused = await fetch(`${base}/api/panel/export.zip`);
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { issues: Array<{ code: string }> };
    expect(body.issues.length).toBeGreaterThan(0);
    expect((await fetch(`${base}/api/panel/export.zip?waive=1`)).status).toBe(200);
  });

  it('HTTP: exports a scenario of separate orders, one folder per order, leaving the plate alone', async () => {
    await post('/api/panel/new', { name: 'combo' });
    await post('/api/panel/add-board', { path: 'sensor.flamingo', needed: 1 });
    await post('/api/panel/add-board', { path: 'mini.flamingo', needed: 5 });
    const before = (await (await fetch(`${base}/api/panel`)).json()) as PanelView;

    const res = await fetch(`${base}/api/panel/scenario-export.zip?id=separate`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="combo-separate-fab.zip"');
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName);
    for (const folder of ['S-sensor', 'M-mini']) {
      expect(names).toEqual(
        expect.arrayContaining([`${folder}/gerbers.zip`, `${folder}/bom.csv`, `${folder}/cpl.csv`, `${folder}/board.render.svg`]),
      );
    }
    // Each order's gerbers.zip is a board's own fileset, ready to upload.
    const gerbers = new AdmZip(zip.getEntry('M-mini/gerbers.zip')!.getData()).getEntries().map((e) => e.entryName);
    expect(gerbers.some((n) => n.endsWith('.GKO'))).toBe(true);
    expect(zip.getEntry('orders.txt')!.getData().toString()).toMatch(/M-mini\/.*PCB qty 5/);

    const after = (await (await fetch(`${base}/api/panel`)).json()) as PanelView;
    expect(after.panel.instances).toEqual(before.panel.instances);
    expect((await fetch(`${base}/api/panel/scenario-export.zip?id=nope`)).status).toBe(400);
  });

  it('HTTP: lists files and serves the config with its unverified entries', async () => {
    await post('/api/panel/new', { name: 'combo' });
    await post('/api/panel/add-board', { path: 'mini.flamingo' });
    const files = (await (await fetch(`${base}/api/panel/files`)).json()) as {
      current: string;
      panels: Array<{ name: string }>;
      boards: Array<{ name: string; onPanel: boolean }>;
    };
    expect(files.current).toBe(join(dir, 'combo.flamboyance'));
    expect(files.panels.map((p) => p.name)).toEqual(['combo']);
    expect(files.boards.map((b) => [b.name, b.onPanel]).sort()).toEqual([
      ['mini', true],
      ['sensor', false],
    ]);

    const config = (await (await fetch(`${base}/api/panel/config`)).json()) as { unverified: string[] };
    expect(config.unverified).toContain('fees.pcb.differentDesigns.perExtraDesign');
    expect(config.unverified).not.toContain('fees.assembly.economic.setupFee');
  });

  it('serves the panel page at /panel and the editor at /', async () => {
    expect(await (await fetch(`${base}/panel`)).text()).toBe('<title>panel</title>');
    expect(await (await fetch(`${base}/`)).text()).toBe('<title>editor</title>');
    const svg = await fetch(`${base}/api/panel/render.svg`);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    const png = await fetch(`${base}/api/panel/render.png?widthPx=400`);
    expect(Buffer.from(await png.arrayBuffer()).readUInt32BE(16)).toBe(400);
    const fab = await fetch(`${base}/api/panel/render.svg?view=fab`);
    expect(fab.status).toBe(200);
    expect(await fab.text()).toMatch(/^<svg /);
  });

  it('an unsaved panel gets a file as soon as it gains a board', async () => {
    expect(started.panel!.doc.filePath).toBeUndefined();
    await post('/api/panel/add-board', { path: 'mini.flamingo' });
    expect(started.panel!.doc.filePath).toBe(join(dir, 'panel.flamboyance'));
  });
});
