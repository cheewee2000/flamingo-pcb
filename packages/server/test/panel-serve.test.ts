import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serializeBoard } from '@flamingo/engine';
import { PANEL_EXTENSION, parsePanel } from '@flamingo/panel';
import type { StartedServer } from '../src/http.js';
import type { PanelView } from '../src/panel/session.js';
import { PANEL_TOOL_NAMES } from '../src/panel/mcp.js';
import { miniBoard, startPanelServer, testSession, writeBoards } from './panel-helpers.js';

describe('a server started on a panel file', () => {
  let dir: string;
  let started: StartedServer;
  let base: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-serve-'));
    const uiDir = join(dir, 'ui-dist');
    await mkdir(join(uiDir, 'assets'), { recursive: true });
    await writeFile(join(uiDir, 'index.html'), '<title>editor</title>');
    await writeFile(join(uiDir, 'panel.html'), '<title>panel</title>');
    await writeFile(join(uiDir, 'assets', 'panel.js'), '// panel');
    await writeBoards(dir);
    started = await startPanelServer(dir, uiDir, { board: false });
    base = `http://localhost:${started.port}`;
  });

  afterEach(async () => {
    await started.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('has the panel view at the root, where a board has its editor', async () => {
    for (const path of ['/', '/index.html']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe('<title>panel</title>');
    }
    const asset = await fetch(`${base}/assets/panel.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('// panel');
  });

  it('sends /panel, where the view is on a board server, to the root', async () => {
    const res = await fetch(`${base}/panel`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('serves the panel routes and none of the board routes', async () => {
    const view = (await (await fetch(`${base}/api/panel`)).json()) as PanelView;
    expect(view.panel.instances).toEqual([]);
    expect((await fetch(`${base}/api/board`)).status).toBe(404);
    expect((await fetch(`${base}/3d`)).status).toBe(404);
  });

  it('refuses a board socket, and serves the panel one', async () => {
    const wsBase = `ws://localhost:${started.port}/ws`;
    const board = new WebSocket(wsBase);
    const status = await new Promise<number | undefined>((res) => {
      board.once('unexpected-response', (_req, resp) => res(resp.statusCode));
      board.once('open', () => res(undefined));
    });
    expect(status).toBe(404);

    const panel = new WebSocket(`${wsBase}?channel=panel`);
    try {
      const first = await new Promise<{ type: string }>((res, rej) => {
        panel.once('message', (data: Buffer) => res(JSON.parse(data.toString()) as { type: string }));
        panel.once('error', rej);
      });
      expect(first.type).toBe('panel');
    } finally {
      panel.close();
    }
  });

  it('serves the panel tools and none of the board tools', async () => {
    const client = new Client({ name: 'serve-test', version: '0.1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...PANEL_TOOL_NAMES].sort());
    } finally {
      await client.close();
    }
  });
});

describe('a board server', () => {
  it('still has the editor at the root and the panel view at /panel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-serve-'));
    const uiDir = join(dir, 'ui-dist');
    await mkdir(uiDir);
    await writeFile(join(uiDir, 'index.html'), '<title>editor</title>');
    await writeFile(join(uiDir, 'panel.html'), '<title>panel</title>');
    const started = await startPanelServer(dir, uiDir);
    try {
      const base = `http://localhost:${started.port}`;
      expect(await (await fetch(`${base}/`)).text()).toBe('<title>editor</title>');
      expect(await (await fetch(`${base}/panel`)).text()).toBe('<title>panel</title>');
      expect((await fetch(`${base}/api/board`)).status).toBe(200);
    } finally {
      await started.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a panel notices its boards changing on disk', () => {
  it('pushes a new view when a source board is rewritten by someone else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-watch-'));
    const session = testSession(dir, { watchMs: 25 });
    try {
      const { mini } = await writeBoards(dir);
      await session.create('watched');
      const added = await session.addBoard('mini.flamingo', { key: 'M', needed: 1 });
      expect(added.ok).toBe(true);
      expect((await session.view()).sources[0]!.stale).toBe(false);

      await new Promise((r) => setTimeout(r, 80)); // the watcher has seen the file as it is
      const changed = new Promise<void>((resolve) => session.doc.once('change', () => resolve()));
      const edited = miniBoard();
      edited.name = 'mini, edited in another shell';
      await writeFile(mini, serializeBoard(edited));
      await utimes(mini, new Date(), new Date(Date.now() + 5000));
      await changed;
      expect((await session.view()).sources[0]!.stale).toBe(true);
    } finally {
      await session.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('flamingo serve <file.flamboyance>', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
  let dir: string;
  let child: ChildProcess | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-serve-cli-'));
  });

  afterEach(async () => {
    child?.kill('SIGKILL');
    child = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** Run the CLI until it prints a line matching `until`, or exits. */
  function run(args: string[], until: RegExp): Promise<{ out: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      let out = '';
      child = spawn(process.execPath, [cli, ...args], {
        cwd: dir,
        env: { ...process.env, FLAMINGO_PORT: '0', FLAMINGO_PANEL_PRICES: 'off', FLAMINGO_STOCK_CHECK: 'off' },
      });
      const seen = (chunk: Buffer): void => {
        out += chunk.toString();
        if (until.test(out)) resolve({ out, code: null });
      };
      child.stdout!.on('data', seen);
      child.stderr!.on('data', seen);
      child.once('error', reject);
      child.once('exit', (code) => resolve({ out, code }));
    });
  }

  it.skipIf(!existsSync(cli))('creates the file if it is missing and serves its view at the root', async () => {
    expect(PANEL_EXTENSION).toBe('.flamboyance');
    const { out } = await run(['serve', 'combo.flamboyance'], /serving combo\.flamboyance at http:\/\/localhost:(\d+)/);
    const port = /http:\/\/localhost:(\d+)/.exec(out)?.[1];
    expect(port, out).toBeTruthy();
    expect(out).not.toContain('/panel');

    const panel = parsePanel(await readFile(join(dir, 'combo.flamboyance'), 'utf8'));
    expect(panel.name).toBe('combo');
    const view = (await (await fetch(`http://localhost:${port}/api/panel`)).json()) as PanelView;
    expect(view.filePath).toBe(join(dir, 'combo.flamboyance'));
    expect((await fetch(`http://localhost:${port}/`)).status).toBe(200);
  });

  for (const old of ['combo.flamingo-panel', 'combo.plamingo']) {
    it.skipIf(!existsSync(cli))(`says what to do with a file that has the old extension (${old})`, async () => {
      const { out, code } = await run(['serve', old], /\n$^/);
      expect(code).toBe(1);
      expect(out).toContain('panel files end in .flamboyance now');
      expect(existsSync(join(dir, old))).toBe(false);
    });
  }
});
