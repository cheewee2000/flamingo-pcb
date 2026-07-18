import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import { WebSocket, WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Board, Op, RenderOpts } from '@flamingo/engine';
import { fillAllZones, parseBoard, ratsnest, renderSVG, runDRC, splitLabelLayers } from '@flamingo/engine';
import { exportFab } from '@flamingo/fab';
import type { Model3d } from '@flamingo/parts';
import { extractModel3d, fetchPart, readCache, searchParts } from '@flamingo/parts';
import { runAutoroute } from './autoroute.js';
import { Doc } from './document.js';
import type { McpContext, PartsApi } from './mcp.js';
import { createMcpServer, resolveFabOutDir } from './mcp.js';
import type { RouteRunner } from './route.js';
import { defaultRouteRunner } from './route.js';
import type { ScreenshotOpts } from './screenshot.js';
import { renderPNG } from './screenshot.js';
import { render3dHtml } from './viewer3d.js';
import { exportStep } from './step.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/server/dist/http.js -> packages/ui/dist
const UI_DIST = join(here, '..', '..', 'ui', 'dist');

const DEFAULT_PORT = 4242;

const PLACEHOLDER_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Flamingo</title>
  </head>
  <body>
    <p>Flamingo — UI not built yet</p>
  </body>
</html>
`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function mimeFor(path: string): string {
  return MIME_TYPES[extname(path)] ?? 'application/octet-stream';
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

function sendHTML(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function sendNotFound(res: ServerResponse): void {
  sendJSON(res, 404, { ok: false, error: 'not found' });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Serve uiDistDir at '/' if it exists, else a placeholder page. Returns true if handled. */
async function serveStatic(pathname: string, res: ServerResponse, uiDistDir: string): Promise<boolean> {
  const uiDistExists = await pathExists(uiDistDir);
  if (!uiDistExists) {
    if (pathname === '/') {
      sendHTML(res, 200, PLACEHOLDER_HTML);
      return true;
    }
    return false;
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(uiDistDir, rel));
  if (!filePath.startsWith(normalize(uiDistDir))) {
    sendJSON(res, 403, { ok: false, error: 'forbidden' });
    return true;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': mimeFor(filePath) });
    res.end(data);
    return true;
  } catch {
    // SPA fallback to index.html for client-side routes.
    try {
      const data = await readFile(join(uiDistDir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
}

/** Directories /api/projects lists boards from (and /api/open may open from). */
function boardSearchRoots(ctx: McpContext): string[] {
  return [...new Set([resolve(ctx.projectDir), resolve(process.cwd())])];
}

const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'fab', 'fixtures']);
const SCAN_MAX_DEPTH = 4;

export interface ProjectEntry {
  /** Absolute path — feed back to POST /api/open verbatim. */
  path: string;
  /** File basename without the .flamingo extension. */
  name: string;
  mtimeMs: number;
}

/** Find every *.flamingo file under `roots` (bounded depth, build/vcs dirs skipped), newest first. */
async function findBoardFiles(roots: string[]): Promise<ProjectEntry[]> {
  const found = new Map<string, ProjectEntry>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: skip
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(full, depth + 1);
      } else if (e.isFile() && extname(e.name) === '.flamingo' && !found.has(full)) {
        try {
          const s = await stat(full);
          found.set(full, { path: full, name: basename(e.name, '.flamingo'), mtimeMs: s.mtimeMs });
        } catch {
          // raced deletion: skip
        }
      }
    }
  }

  for (const root of roots) await walk(root, 0);
  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Cache dir for downloaded OBJ 3D models: `~/.flamingo/models/`. */
function modelsCacheDir(): string {
  return join(homedir(), '.flamingo', 'models');
}

const MODEL_UUID_RE = /^[0-9a-f]{32}$/;

/**
 * Resolve a component's 3D model from its LCSC id via the parts cache. On a
 * cache miss, fetchPart populates `~/.flamingo/parts/<lcsc>.json` (fetching the
 * raw EasyEDA response), which we then re-read to extract the SVGNODE model.
 * Returns null (never throws) when the part can't be resolved or has no model.
 */
async function loadModel3d(lcsc: string): Promise<Model3d | null> {
  let raw = await readCache(lcsc);
  if (raw === null) {
    try {
      await fetchPart(lcsc);
    } catch {
      return null; // part not found / network error
    }
    raw = await readCache(lcsc);
  }
  if (raw === null) return null;
  try {
    return extractModel3d(raw);
  } catch {
    return null;
  }
}

/** Zip the four fab files in `dir` into `res` (attachment already headered). Resolves once fully flushed. */
function streamFabZip(dir: string, res: ServerResponse): Promise<void> {
  return new Promise((resolveP, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolveP();
      }
    };
    archive.on('error', reject);
    // 'finish' fires once the response is fully flushed; 'close' covers a client
    // that aborts mid-download. Either way the temp dir is safe to remove.
    res.on('finish', finish);
    res.on('close', finish);
    archive.pipe(res);
    for (const name of ['gerbers.zip', 'bom.csv', 'cpl.csv', 'board.render.svg']) {
      archive.file(join(dir, name), { name });
    }
    void archive.finalize();
  });
}

async function handleApi(
  ctx: McpContext,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const doc = ctx.doc;
  // Every route below except the body-reading POSTs ignores the request body --
  // drain it so the connection can be reused instead of stalling on unread data.
  const readsBody =
    method === 'POST' &&
    (pathname === '/api/op' || pathname === '/api/export' || pathname === '/api/route' || pathname === '/api/open');
  if (!readsBody) {
    req.resume();
  }

  if (method === 'GET' && pathname === '/api/board') {
    sendJSON(res, 200, doc.board);
    return true;
  }

  if (method === 'POST' && pathname === '/api/op') {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      sendJSON(res, 400, { ok: false, error: 'invalid JSON body' });
      return true;
    }
    if (typeof body !== 'object' || body === null || typeof (body as { op?: unknown }).op !== 'string') {
      sendJSON(res, 400, { ok: false, error: 'body must be an Op object with an "op" field' });
      return true;
    }
    try {
      const result = doc.apply(body as Op);
      sendJSON(res, result.ok ? 200 : 400, result);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/undo') {
    const board = doc.undo();
    sendJSON(res, 200, { ok: board !== null, board: doc.board });
    return true;
  }

  if (method === 'POST' && pathname === '/api/redo') {
    const board = doc.redo();
    sendJSON(res, 200, { ok: board !== null, board: doc.board });
    return true;
  }

  if (method === 'GET' && pathname === '/api/ratsnest') {
    sendJSON(res, 200, ratsnest(doc.board));
    return true;
  }

  if (method === 'GET' && pathname === '/api/drc') {
    // Run on the *filled* board, matching the export gate: the raw zone
    // outline polygon overlaps every non-pour-net pad, so an unfilled check
    // would drown real findings in zone-clearance noise.
    const board = doc.board.zones.length > 0 ? fillAllZones(doc.board) : doc.board;
    sendJSON(res, 200, { ok: true, violations: runDRC(board) });
    return true;
  }

  if (method === 'GET' && pathname === '/api/render.svg') {
    const opts: RenderOpts = {};
    const layersParam = url.searchParams.get('layers');
    const rawLayers = layersParam
      ? layersParam.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const split = splitLabelLayers(rawLayers);
    opts.layers = split.layers;
    opts.showPadLabels = split.showPadLabels;
    opts.showNetLabels = split.showNetLabels;
    const highlightNet = url.searchParams.get('highlightNet');
    if (highlightNet) opts.highlightNet = highlightNet;
    const boardToRender = doc.board.zones.length > 0 ? fillAllZones(doc.board) : doc.board;
    const svg = renderSVG(boardToRender, opts);
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    res.end(svg);
    return true;
  }

  if (method === 'GET' && pathname === '/api/render.png') {
    const opts: ScreenshotOpts = {};
    const layers = url.searchParams.get('layers');
    if (layers) {
      opts.layers = layers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const region = url.searchParams.get('region');
    if (region) {
      const nums = region.split(',').map((s) => Number(s.trim()));
      if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) {
        const [minX, minY, maxX, maxY] = nums as [number, number, number, number];
        opts.region = { minX, minY, maxX, maxY };
      } else {
        sendJSON(res, 400, { ok: false, error: 'region must be minX,minY,maxX,maxY (numbers)' });
        return true;
      }
    }
    const widthPxRaw = url.searchParams.get('widthPx');
    if (widthPxRaw) {
      const n = Number(widthPxRaw);
      if (Number.isFinite(n)) opts.widthPx = n;
    }
    const highlightNet = url.searchParams.get('highlightNet');
    if (highlightNet) opts.highlightNet = highlightNet;
    const showRatsnest = url.searchParams.get('showRatsnest');
    if (showRatsnest !== null) opts.showRatsnest = showRatsnest !== '0';
    const showDrc = url.searchParams.get('showDrc');
    if (showDrc !== null) opts.showDrc = showDrc !== '0';

    const png = renderPNG(doc.board, opts);
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png);
    return true;
  }

  if (method === 'POST' && pathname === '/api/export') {
    const raw = await readBody(req);
    let body: unknown = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        sendJSON(res, 400, { ok: false, error: 'invalid JSON body' });
        return true;
      }
    }
    const outDirRaw = typeof body === 'object' && body !== null ? (body as { outDir?: unknown }).outDir : undefined;
    if (outDirRaw !== undefined && typeof outDirRaw !== 'string') {
      sendJSON(res, 400, { ok: false, error: 'outDir must be a string' });
      return true;
    }

    const filled = fillAllZones(doc.board);
    const violations = runDRC(filled);
    if (violations.length > 0) {
      sendJSON(res, 400, {
        ok: false,
        error: 'DRC violations present; export refused',
        violations,
      });
      return true;
    }

    const targetDir = resolveFabOutDir(ctx, outDirRaw);
    try {
      const result = await exportFab(doc.board, targetDir);
      sendJSON(res, 200, { ok: true, outDir: targetDir, ...result });
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/route') {
    const raw = await readBody(req);
    let body: unknown = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        sendJSON(res, 400, { ok: false, error: 'invalid JSON body' });
        return true;
      }
    }
    const netsRaw = typeof body === 'object' && body !== null ? (body as { nets?: unknown }).nets : undefined;
    const passesRaw = typeof body === 'object' && body !== null ? (body as { passes?: unknown }).passes : undefined;
    if (netsRaw !== undefined && !(Array.isArray(netsRaw) && netsRaw.every((n) => typeof n === 'string'))) {
      sendJSON(res, 400, { ok: false, error: 'nets must be an array of strings' });
      return true;
    }
    if (passesRaw !== undefined && (typeof passesRaw !== 'number' || !Number.isFinite(passesRaw))) {
      sendJSON(res, 400, { ok: false, error: 'passes must be a number' });
      return true;
    }
    try {
      const result = await runAutoroute(doc, ctx.route, {
        nets: netsRaw as string[] | undefined,
        passes: passesRaw as number | undefined,
      });
      sendJSON(res, 200, {
        ok: true,
        ...result,
        fullyRouted: result.remaining.length === 0,
      });
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (method === 'GET' && pathname === '/api/export.step') {
    try {
      const step = exportStep(doc.board);
      const fileName = `${doc.board.name.replace(/[^\w.-]+/g, '_') || 'board'}.step`;
      res.writeHead(200, {
        'content-type': 'application/step',
        'content-disposition': `attachment; filename="${fileName}"`,
      });
      res.end(step);
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (method === 'GET' && pathname === '/api/models') {
    // Per-component 3D model refs for the live board, keyed by refdes. Parts
    // that can't be resolved or have no 3D model are omitted. Model JSON is
    // resolved once per distinct LCSC id.
    const byLcsc = new Map<string, Model3d | null>();
    const models: Record<string, {
      uuid: string;
      objUrl: string;
      originMm: Model3d['originMm'];
      zMm: number;
      rotationDeg: Model3d['rotationDeg'];
    }> = {};
    for (const c of doc.board.components) {
      if (!c.lcsc) continue;
      let m = byLcsc.get(c.lcsc);
      if (m === undefined) {
        m = await loadModel3d(c.lcsc);
        byLcsc.set(c.lcsc, m);
      }
      if (!m) continue;
      models[c.refdes] = {
        uuid: m.uuid,
        objUrl: `/api/model/${m.uuid}.obj`,
        originMm: m.originMm,
        zMm: m.zMm,
        rotationDeg: m.rotationDeg,
      };
    }
    sendJSON(res, 200, { models });
    return true;
  }

  if (method === 'GET' && pathname.startsWith('/api/model/') && pathname.endsWith('.obj')) {
    const uuid = pathname.slice('/api/model/'.length, -'.obj'.length);
    if (!MODEL_UUID_RE.test(uuid)) {
      sendJSON(res, 400, { ok: false, error: 'model uuid must be 32 hex chars' });
      return true;
    }
    const filePath = join(modelsCacheDir(), `${uuid}.obj`);
    let data: Buffer | null = null;
    try {
      data = await readFile(filePath);
    } catch {
      data = null; // cache miss: download below
    }
    if (data === null) {
      try {
        const resp = await fetch(`https://modules.easyeda.com/3dmodel/${uuid}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data = Buffer.from(await resp.arrayBuffer());
        await mkdir(modelsCacheDir(), { recursive: true });
        await writeFile(filePath, data);
      } catch (err) {
        sendJSON(res, 502, { ok: false, error: `could not fetch model: ${err instanceof Error ? err.message : String(err)}` });
        return true;
      }
    }
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(data);
    return true;
  }

  if (method === 'GET' && pathname === '/api/export.fab') {
    // DRC-gated fab download (mirrors POST /api/export's gate). ?waive=1 bypasses
    // the gate like the export_fab MCP tool's waiveDrc; violations are still
    // computed but not fatal. Streams a single zip of the fab fileset.
    const waive = url.searchParams.get('waive') === '1';
    const filled = fillAllZones(doc.board);
    const violations = runDRC(filled);
    if (violations.length > 0 && !waive) {
      sendJSON(res, 400, {
        ok: false,
        error: 'DRC violations present; export refused',
        violations,
      });
      return true;
    }
    let tmpDir: string | null = null;
    try {
      tmpDir = await mkdtemp(join(tmpdir(), 'flamingo-fab-'));
      await exportFab(doc.board, tmpDir);
      const fileName = `${doc.board.name.replace(/[^\w.-]+/g, '_') || 'board'}-fab.zip`;
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${fileName}"`,
      });
      await streamFabZip(tmpDir, res);
    } catch (err) {
      if (!res.headersSent) {
        sendJSON(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    return true;
  }

  if (method === 'GET' && pathname === '/api/projects') {
    try {
      const roots = boardSearchRoots(ctx);
      const projects = await findBoardFiles(roots);
      const current = doc.filePath ? resolve(doc.filePath) : null;
      sendJSON(res, 200, { ok: true, current, projects });
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/open') {
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(req)) || '{}');
    } catch {
      sendJSON(res, 400, { ok: false, error: 'invalid JSON body' });
      return true;
    }
    const pathRaw = (parsed as { path?: unknown }).path;
    if (typeof pathRaw !== 'string' || pathRaw.length === 0) {
      sendJSON(res, 400, { ok: false, error: 'body must be {"path": "<board.flamingo>"}' });
      return true;
    }
    const abs = resolve(isAbsolute(pathRaw) ? pathRaw : join(ctx.projectDir, pathRaw));
    const roots = boardSearchRoots(ctx);
    if (extname(abs) !== '.flamingo' || !roots.some((r) => abs.startsWith(r + sep))) {
      sendJSON(res, 400, { ok: false, error: 'path must be a .flamingo file inside the project' });
      return true;
    }
    let board: Board;
    try {
      board = parseBoard(await readFile(abs, 'utf8'));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: `could not open "${abs}": ${err instanceof Error ? err.message : String(err)}` });
      return true;
    }
    // Pure read of an on-disk file: swap the board without marking dirty (same
    // rule as the open_board MCP tool). The doc's 'change' event broadcasts the
    // new board to every websocket client.
    doc.resetBoard(board, abs, false);
    sendJSON(res, 200, { ok: true, path: abs, name: board.name });
    return true;
  }

  if (method === 'POST' && pathname === '/api/save') {
    try {
      await doc.save();
      sendJSON(res, 200, { ok: true });
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}

/**
 * Handle a request to /mcp by spinning up a fresh McpServer + transport for
 * this request only (stateless mode: `sessionIdGenerator: undefined`).
 *
 * Stateless is the simplest reliable pattern for the Streamable HTTP
 * transport here: Flamingo's MCP tools all read/write through `ctx.doc`,
 * which already IS the durable state (with its own undo/redo), so there is
 * nothing session-scoped that a persistent transport would buy us. A new
 * McpServer/transport pair per request avoids having to manage a session
 * store, reconnection, or transport cleanup lifecycles.
 */
async function handleMcp(
  ctx: McpContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const mcpServer = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void mcpServer.close();
  });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) {
      sendJSON(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function makeRequestListener(
  ctx: McpContext,
  uiDistDir: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  const doc = ctx.doc;
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    void (async () => {
      try {
        if (pathname === '/mcp') {
          // Mounted ahead of /api/ routing per the MCP endpoint decision --
          // handleMcp owns the request/response lifecycle from here (it reads
          // the raw body itself), so return without falling through.
          if (method === 'POST' || method === 'GET' || method === 'DELETE') {
            await handleMcp(ctx, req, res);
          } else {
            req.resume();
            sendNotFound(res);
          }
          return;
        }
        if (pathname.startsWith('/api/')) {
          const handled = await handleApi(ctx, method, pathname, url, req, res);
          if (!handled) sendNotFound(res);
          return;
        }
        req.resume(); // static/unknown routes never read the body
        if (method === 'GET' && pathname === '/3d') {
          // Regenerated from the live board on every request.
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(render3dHtml(ctx.doc.board));
          return;
        }
        if (method === 'GET' || method === 'HEAD') {
          const served = await serveStatic(pathname, res, uiDistDir);
          if (served) return;
        }
        sendNotFound(res);
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  };
}

function attachWebSocket(doc: Doc, server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();

  const onChange = (board: unknown): void => {
    const msg = JSON.stringify({ type: 'board', board });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  };
  doc.on('change', onChange);

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'board', board: doc.board }));

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed message
      }
      if (typeof msg !== 'object' || msg === null || (msg as { type?: unknown }).type !== 'op') {
        return; // ignore anything that isn't a well-formed op message
      }
      const op = (msg as { op?: unknown }).op;
      if (typeof op !== 'object' || op === null || typeof (op as { op?: unknown }).op !== 'string') {
        ws.send(JSON.stringify({ type: 'opResult', result: { ok: false, error: 'body must be an Op object with an "op" field' } }));
        return;
      }
      try {
        const result = doc.apply(op as Op);
        ws.send(JSON.stringify({ type: 'opResult', result }));
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: 'opResult',
            result: { ok: false, error: err instanceof Error ? err.message : String(err) },
          }),
        );
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  wss.on('close', () => {
    doc.removeListener('change', onChange);
  });

  return wss;
}

export interface StartedServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

export interface StartServerOptions {
  /** Base directory MCP tools resolve relative paths against (new_board/open_board). Defaults to process.cwd(). */
  projectDir?: string;
  /** Parts lookup implementation for MCP's parts_search/parts_get/place_component tools. Defaults to the real @flamingo/parts network client -- tests should inject a mock. */
  partsApi?: PartsApi;
  /** Directory to serve the built UI from at '/'. Defaults to packages/ui/dist -- tests should inject a temp dir so behavior doesn't depend on whether the real UI has been built. */
  uiDistDir?: string;
  /** Freerouting runner for the autoroute MCP tool. Defaults to the real java/jar runner -- tests should inject a mock. */
  routeRunner?: RouteRunner;
}

/**
 * Start the Flamingo HTTP + WebSocket server for the given Doc.
 * Pass port 0 to bind an ephemeral port (tests must do this).
 */
export function startServer(
  doc: Doc,
  port: number = DEFAULT_PORT,
  opts: StartServerOptions = {},
): Promise<StartedServer> {
  const ctx: McpContext = {
    doc,
    projectDir: opts.projectDir ?? process.cwd(),
    partsApi: opts.partsApi ?? { fetchPart, searchParts },
    route: opts.routeRunner ?? defaultRouteRunner,
  };
  const uiDistDir = opts.uiDistDir ?? UI_DIST;
  const server = http.createServer(makeRequestListener(ctx, uiDistDir));
  const wss = attachWebSocket(doc, server);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        close: async () => {
          await new Promise<void>((res, rej) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => {
              server.close((err) => (err ? rej(err) : res()));
            });
          });
          await doc.close();
        },
      });
    });
  });
}
