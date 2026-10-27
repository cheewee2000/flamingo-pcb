import http from 'node:http';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Board, Op } from '@flamingo/engine';
import { fillAllZones, parseBoard, renderSVG } from '@flamingo/engine';
import { generateBOM, generateCPL, generateGerbers, zipFiles } from '@flamingo/fab';
import type { Model3d } from '@flamingo/parts';
import { extractModel3d, fetchJlcStock, fetchPart, readCache, searchParts } from '@flamingo/parts';
import { runAutorouteBroadcast } from './autoroute.js';
import { Doc } from './document.js';
import type { BoardMcpContext, McpContext, PartsApi } from './mcp.js';
import { boardSearchRoots, createMcpServer, runDrcWithStock } from './mcp.js';
import type { RouteRunner } from './route.js';
import { defaultRouteRunner } from './route.js';
import type { ScreenshotOpts } from './screenshot.js';
import { renderPNG } from './screenshot.js';
import { BOARD_T, exportStep, exportStepDetail, stepHasSolids } from './step.js';
import { exportDxf, exportSvg } from './drawing.js';
import type { ExportFormat, ExportQuery } from './export-opts.js';
import { exportFileName, parseExportQuery } from './export-opts.js';
import { parseObjMesh, placeMeshGroups } from './objmesh.js';
import type { MeshGroup } from './objmesh.js';
import type { PanelChannel } from './panel/http.js';
import { attachPanelChannel, handlePanelApi, isPanelChannel } from './panel/http.js';
import { partLookupFrom } from './panel/parts.js';
import { PanelSession } from './panel/session.js';

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

/**
 * CSRF guard shared by the mutating HTTP routes and the /ws upgrade: browsers
 * attach an Origin header on cross-site requests (including a "simple"
 * text/plain form POST, which needs no CORS preflight), so rejecting any
 * request that names a non-local origin stops a malicious page from driving
 * board mutations through a victim's open localhost session. A request with
 * no Origin header at all (curl, an MCP client, the Electron app's own
 * same-origin fetches) is allowed through.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' || // WHATWG URL keeps IPv6 brackets
      extraAllowedHosts().has(hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/**
 * Hostnames to trust besides loopback, from FLAMINGO_ALLOWED_HOSTS
 * (comma-separated, e.g. `FLAMINGO_ALLOWED_HOSTS=bennet`): for a server bound to
 * a LAN or tailnet address and opened by that name from another machine, whose
 * page would otherwise be refused its WebSocket and every edit. Empty by default,
 * so the guard stays loopback-only unless the person serving opts in. Read on each
 * call, so a test or a long-lived process sees the current value.
 */
function extraAllowedHosts(): Set<string> {
  return new Set(
    (process.env.FLAMINGO_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
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
  const uiDistExists = existsSync(uiDistDir);
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

/** Read a model OBJ from `~/.flamingo/models/`, downloading + caching on a miss. Throws on download failure. */
async function loadModelObj(uuid: string): Promise<Buffer> {
  const filePath = join(modelsCacheDir(), `${uuid}.obj`);
  try {
    return await readFile(filePath);
  } catch {
    // cache miss: download below
  }
  const resp = await fetch(`https://modules.easyeda.com/3dmodel/${uuid}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = Buffer.from(await resp.arrayBuffer());
  await mkdir(modelsCacheDir(), { recursive: true });
  await writeFile(filePath, data);
  return data;
}

/**
 * World-placed per-material mesh groups for every component whose part has a
 * 3D model (refdes → groups), for the detail STEP export. Parts that can't
 * resolve are simply omitted (they fall back to courtyard blocks).
 */
async function collectDetailModels(board: Board): Promise<Map<string, MeshGroup[]>> {
  const byLcsc = new Map<string, Model3d | null>();
  const parsedByUuid = new Map<string, MeshGroup[]>();
  const out = new Map<string, MeshGroup[]>();
  for (const c of board.components) {
    if (!c.lcsc) continue;
    let m = byLcsc.get(c.lcsc);
    if (m === undefined) {
      m = await loadModel3d(c.lcsc);
      byLcsc.set(c.lcsc, m);
    }
    if (!m) continue;
    let groups = parsedByUuid.get(m.uuid);
    if (groups === undefined) {
      try {
        groups = parseObjMesh((await loadModelObj(m.uuid)).toString('utf8'));
      } catch {
        groups = []; // download failed: courtyard-block fallback
      }
      parsedByUuid.set(m.uuid, groups);
    }
    if (groups.length === 0) continue;
    out.set(c.refdes, placeMeshGroups(groups, m, { at: c.at, rotation: c.rotation, side: c.side }, BOARD_T));
  }
  return out;
}

async function handleApi(
  ctx: BoardMcpContext,
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
    (pathname === '/api/op' || pathname === '/api/route' || pathname === '/api/open');
  if (!readsBody) {
    req.resume();
  }

  // Every /api/* POST mutates the board (there are no read-only ones) -- gate
  // them all here, once, instead of per-route, per the CSRF guard above.
  if (method === 'POST' && !isAllowedOrigin(req.headers.origin)) {
    req.resume();
    sendJSON(res, 403, { ok: false, error: 'cross-origin request rejected' });
    return true;
  }

  if (method === 'GET' && pathname === '/api/board') {
    sendJSON(res, 200, doc.board);
    return true;
  }

  if (method === 'POST' && pathname === '/api/op') {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      req.resume();
      sendJSON(res, 400, { ok: false, error: 'content-type must be application/json' });
      return true;
    }
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

  if (method === 'GET' && pathname === '/api/drc') {
    // Run on the *filled* board, matching the export gate: the raw zone
    // outline polygon overlaps every non-pour-net pad, so an unfilled check
    // would drown real findings in zone-clearance noise. Shares runDrcWithStock
    // with the export_fab MCP tool and /api/export.fab below so the UI, MCP,
    // and fab download all gate on exactly the same checks (geometry + stock).
    const board = doc.board.zones.length > 0 ? fillAllZones(doc.board) : doc.board;
    const { violations, advisories } = await runDrcWithStock(ctx, board);
    sendJSON(res, 200, { ok: true, violations, advisories });
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
      const result = await runAutorouteBroadcast(
        doc,
        ctx.route,
        {
          nets: netsRaw as string[] | undefined,
          passes: passesRaw as number | undefined,
        },
        (status) => doc.emitRouteStatus(status),
      );
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

  const exportMatch = method === 'GET' ? /^\/api\/export\.(step|dxf|svg)$/.exec(pathname) : null;
  if (exportMatch) {
    // Mechanical exports, driven by the UI's export modal:
    //   ?detail=hd (step; `mode=detail` also works) adds copper/silk/real meshes
    //   &include=board,comps,vias,pth,mnt   (default: all)
    //   &side=top|bottom|both (step)  &layers=single|layered (dxf)  &units=mm|in (dxf/svg)
    const format = exportMatch[1] as ExportFormat;
    let q: ExportQuery;
    try {
      q = parseExportQuery(url.searchParams);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    try {
      let body: string;
      let contentType: string;
      if (format === 'step') {
        const opts = { include: q.include, side: q.side };
        body = q.detail
          ? exportStepDetail(doc.board, q.include.comps ? await collectDetailModels(doc.board) : new Map(), opts)
          : exportStep(doc.board, opts);
        if (!stepHasSolids(body)) {
          throw new Error('Nothing to export: the board has no outline, or the selected elements have no geometry');
        }
        contentType = 'application/step';
      } else if (format === 'dxf') {
        body = exportDxf(doc.board, { include: q.include, layers: q.layers, units: q.units });
        contentType = 'application/dxf';
      } else {
        body = exportSvg(doc.board, { include: q.include, units: q.units });
        contentType = 'image/svg+xml';
      }
      const fileName = exportFileName(doc.board.name, format, q);
      res.writeHead(200, {
        'content-type': contentType,
        'content-disposition': `attachment; filename="${fileName}"`,
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
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
    let data: Buffer | null;
    try {
      data = await loadModelObj(uuid);
    } catch (err) {
      sendJSON(res, 502, { ok: false, error: `could not fetch model: ${err instanceof Error ? err.message : String(err)}` });
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(data);
    return true;
  }

  if (method === 'GET' && pathname === '/api/export.fab') {
    // DRC + stock gated fab download (mirrors the export_fab MCP tool's gate,
    // via the shared runDrcWithStock). ?waive=1 bypasses the gate like
    // waiveDrc; violations are still computed but not fatal. Streams a single
    // zip of the fab fileset.
    const waive = url.searchParams.get('waive') === '1';
    const filled = fillAllZones(doc.board);
    const { violations, advisories } = await runDrcWithStock(ctx, filled);
    if (violations.length > 0 && !waive) {
      sendJSON(res, 400, {
        ok: false,
        error: 'DRC violations present; export refused',
        violations,
        advisories,
      });
      return true;
    }
    try {
      // Gerbers from the already-filled board, top-level in the zip so the
      // download is directly uploadable to JLCPCB; bom/cpl/svg ride along.
      const files = new Map<string, string>(generateGerbers(filled).files);
      files.set('bom.csv', generateBOM(doc.board));
      files.set('cpl.csv', generateCPL(doc.board));
      files.set('board.render.svg', renderSVG(filled));
      const fileName = `${doc.board.name.replace(/[^\w.-]+/g, '_') || 'board'}-fab.zip`;
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${fileName}"`,
      });
      res.end(zipFiles(files));
    } catch (err) {
      if (!res.headersSent) {
        sendJSON(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
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
        if (ctx.panel && (pathname === '/api/panel' || pathname.startsWith('/api/panel/'))) {
          // Panel routes read their own bodies, so they are dispatched before
          // handleApi, which drains the body of every route it does not list.
          const handled = await handlePanelApi(ctx.panel, method, pathname, url, req, res);
          if (!handled) sendNotFound(res);
          return;
        }
        const doc = ctx.doc;
        if (!doc) {
          // Started on a panel file: the panel view is the page at '/', the
          // way the editor is for a board file, and there is no board here.
          req.resume();
          if (pathname.startsWith('/api/') || pathname === '/3d') {
            sendNotFound(res);
            return;
          }
          if (method === 'GET' && (pathname === '/panel' || pathname === '/panel/')) {
            // Where the view lives on a server started on a board.
            res.writeHead(302, { location: '/' });
            res.end();
            return;
          }
          if (method === 'GET' || method === 'HEAD') {
            const page = pathname === '/' || pathname === '/index.html' || !/\.[a-z0-9]+$/i.test(pathname);
            if (await serveStatic(page ? '/panel.html' : pathname, res, uiDistDir)) return;
          }
          sendNotFound(res);
          return;
        }
        if (pathname.startsWith('/api/')) {
          const handled = await handleApi({ ...ctx, doc }, method, pathname, url, req, res);
          if (!handled) sendNotFound(res);
          return;
        }
        req.resume(); // static/unknown routes never read the body
        if (ctx.panel && method === 'GET' && (pathname === '/panel' || pathname === '/panel/')) {
          // The panel view is a page of its own (packages/ui/panel.html).
          const served = await serveStatic('/panel.html', res, uiDistDir);
          if (served) return;
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

function attachWebSocket(doc: Doc | null, server: http.Server, panelChannel?: PanelChannel): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // Same CSRF guard as the /api/* POSTs: refuse the upgrade if the browser
    // sent an Origin that isn't local (a plain WS client / curl / the
    // Electron app's own page sends none, and is allowed through).
    verifyClient: (info, callback) => {
      if (!isAllowedOrigin(info.origin)) callback(false, 403, 'cross-origin request rejected');
      // A server with no board has only the panel channel to offer.
      else if (!doc && !(panelChannel && isPanelChannel(info.req))) callback(false, 404, 'no board on this server');
      else callback(true);
    },
  });
  if (!doc) {
    wss.on('connection', (ws: WebSocket) => panelChannel?.add(ws));
    return wss;
  }
  const clients = new Set<WebSocket>();

  // `file` is the board file's name (e.g. "blinky.flamingo"), which the UI
  // shows as the browser tab title. Read per message: new_board/open_board
  // switch files.
  const fileName = (): string | undefined => (doc.filePath ? basename(doc.filePath) : undefined);

  const onChange = (board: unknown): void => {
    const msg = JSON.stringify({ type: 'board', board, file: fileName() });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  };
  doc.on('change', onChange);

  // Live autoroute progress: fan out to every client (unlike opResult, which is
  // sender-only) so anyone watching sees the route advance regardless of who
  // started it (UI button or MCP tool).
  const onRouteStatus = (status: unknown): void => {
    const msg = JSON.stringify({ type: 'routeStatus', status });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  };
  doc.on('routeStatus', onRouteStatus);

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // /ws?channel=panel is the panel view's socket: it gets panel views and
    // sends panel ops, and never sees board traffic.
    if (panelChannel && isPanelChannel(req)) {
      panelChannel.add(ws);
      return;
    }
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'board', board: doc.board, file: fileName() }));

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
    doc.removeListener('routeStatus', onRouteStatus);
  });

  return wss;
}

export interface StartedServer {
  server: http.Server;
  port: number;
  /** The panel session, when the server was started with `panel`. */
  panel?: PanelSession;
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
  /**
   * Panelization: the panel MCP tools, the /api/panel routes, the /panel page
   * and the panel WebSocket channel. Off by default, so a server started
   * without it behaves exactly as before; `flamingo serve` turns it on. Pass
   * true for a fresh session, or a session to use (e.g. one that opened a file).
   */
  panel?: boolean | PanelSession;
}

/**
 * Start the Flamingo HTTP + WebSocket server for the given Doc.
 * Pass port 0 to bind an ephemeral port (tests must do this).
 *
 * `doc` null is a server started on a panel file: there is no board, so the
 * panel view is the page at '/', only the panel tools are served over MCP,
 * and the board routes, tools and WebSocket are not. It needs `panel`.
 */
export function startServer(
  doc: Doc | null,
  port: number = DEFAULT_PORT,
  opts: StartServerOptions = {},
): Promise<StartedServer> {
  const projectDir = opts.projectDir ?? process.cwd();
  const partsApi = opts.partsApi ?? { fetchPart, searchParts, fetchStock: fetchJlcStock };
  const panel =
    opts.panel instanceof PanelSession
      ? opts.panel
      : opts.panel === true
        ? new PanelSession({
            projectDir,
            partLookup: partLookupFrom(partsApi),
          })
        : undefined;
  if (!doc && !panel) return Promise.reject(new Error('a server with no board needs a panel'));
  const ctx: McpContext = {
    ...(doc ? { doc } : {}),
    projectDir,
    partsApi,
    route: opts.routeRunner ?? defaultRouteRunner,
    ...(panel ? { panel } : {}),
  };
  const uiDistDir = opts.uiDistDir ?? UI_DIST;
  const server = http.createServer(makeRequestListener(ctx, uiDistDir));
  const panelChannel = panel ? attachPanelChannel(panel) : undefined;

  // A board edited in the editor is a source board changed on disk: about when
  // its autosave lands, let the panel view notice (stale flag, new geometry).
  // A save that lands later still shows up through the session's file watcher.
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  const onBoardChange = (): void => {
    if (!panel || panel.panel.sources.length === 0) return;
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      staleTimer = null;
      panel.touch();
    }, 900);
  };
  if (panel) doc?.on('change', onBoardChange);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      // Attach only after listen succeeds. ws forwards the http server's
      // 'error' to the WebSocketServer, where — with no listener — Node
      // throws "unhandled 'error' event" *inside* the emit, so a listen
      // failure (EADDRINUSE) would crash uncaught before `reject` ever ran.
      // Late attach also keeps a failed listen from leaking doc listeners.
      const wss = attachWebSocket(doc, server, panelChannel);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        ...(panel ? { panel } : {}),
        close: async () => {
          if (staleTimer) clearTimeout(staleTimer);
          doc?.removeListener('change', onBoardChange);
          panelChannel?.close();
          await new Promise<void>((res, rej) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => {
              server.close((err) => (err ? rej(err) : res()));
              // close() only stops the listener and then waits: a browser's
              // idle keep-alive sockets or an attached MCP client's long-lived
              // stream would keep it pending forever (a quitting desktop app
              // turns into a zombie process). Destroy whatever remains.
              server.closeAllConnections();
            });
          });
          await doc?.close();
          await panel?.close();
        },
      });
    });
  });
}
