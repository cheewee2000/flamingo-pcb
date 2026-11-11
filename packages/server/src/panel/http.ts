/**
 * Panel HTTP routes and WebSocket channel.
 *
 * Routes live under /api/panel/. The WebSocket shares the board editor's /ws
 * endpoint and is selected with `?channel=panel`: on connect, and after every
 * change, the server pushes `{type:'panel', view}`; edits arrive as
 * `{type:'op', op}` and are answered with `{type:'opResult', result}` to the
 * sender only. That is the board channel's protocol with `panel` in place of
 * `board`, so an edit made over MCP shows up in every open browser and an
 * edit made in a browser is what MCP reads next.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { zipFiles } from '@flamingo/fab';
import { WebSocket } from 'ws';
import type { Objective, PanelOp } from '@flamingo/panel';
import { OBJECTIVES, listSourced } from '@flamingo/panel';
import type { PanelSession } from './session.js';

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function quantitiesOf(v: string | null): number[] | undefined {
  if (!v) return undefined;
  const out = v
    .split(',')
    .map((q) => Number(q))
    .filter((q) => Number.isInteger(q) && q >= 1);
  return out.length > 0 ? out : undefined;
}

function objectiveOf(v: unknown): Objective {
  return typeof v === 'string' && (OBJECTIVES as readonly string[]).includes(v) ? (v as Objective) : 'total';
}

/** `?view=fab` asks for the fabricated view; anything else is the layout. */
function viewOf(v: string | null): 'layout' | 'fab' {
  return v === 'fab' ? 'fab' : 'layout';
}

/** Handle a request under /api/panel. Returns false when the route is unknown. */
export async function handlePanelApi(
  session: PanelSession,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const route = pathname.replace(/^\/api\/panel\/?/, '');

  if (method === 'GET') {
    req.resume();
    switch (route) {
      case '': {
        sendJSON(res, 200, await session.view());
        return true;
      }
      case 'files': {
        sendJSON(res, 200, {
          ok: true,
          current: session.doc.filePath ?? null,
          panels: await session.listPanelFiles(),
          boards: await session.listBoardFiles(),
        });
        return true;
      }
      case 'quote': {
        sendJSON(res, 200, { ok: true, ...(await session.quote(objectiveOf(url.searchParams.get('objective')))) });
        return true;
      }
      case 'cost-curve': {
        // `quantities=a,b,c` prices those alone; `price=0` only reports what is stored and what is missing.
        const quantities = quantitiesOf(url.searchParams.get('quantities'));
        const price = url.searchParams.get('price') !== '0';
        sendJSON(res, 200, { ok: true, ...(await session.costCurve(objectiveOf(url.searchParams.get('objective')), quantities, price)) });
        return true;
      }
      case 'config': {
        sendJSON(res, 200, {
          ok: true,
          limits: session.limits,
          fees: session.fees,
          unverified: [...listSourced(session.fees, 'fees'), ...listSourced(session.limits, 'limits')]
            .filter((e) => !e.entry.verified)
            .map((e) => e.path),
        });
        return true;
      }
      case 'render.svg': {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        res.end(await session.renderSvg(undefined, viewOf(url.searchParams.get('view'))));
        return true;
      }
      case 'render.png': {
        const w = Number(url.searchParams.get('widthPx'));
        const png = await session.renderPng(Number.isFinite(w) && w > 0 ? w : undefined, viewOf(url.searchParams.get('view')));
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
        return true;
      }
      case 'export.zip': {
        const built = await session.buildFab({ waive: url.searchParams.get('waive') === '1' });
        if (!built.ok) {
          sendJSON(res, 400, { ok: false, error: built.error, issues: built.blocking ?? [] });
          return true;
        }
        // Gerbers at the top level so the zip uploads to JLCPCB as it is; the
        // BOM, the placement list and the picture ride along.
        const files = new Map(built.files.gerbers);
        files.set('bom.csv', built.files.bom);
        files.set('cpl.csv', built.files.cpl);
        files.set('panel.render.svg', built.files.svg);
        files.set('panel.fab.svg', built.files.fabSvg);
        const name = `${session.panel.name.replace(/[^\w.-]+/g, '_') || 'panel'}-panel-fab.zip`;
        const zip = zipFiles(files);
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${name}"`,
          'content-length': zip.length,
        });
        res.end(zip);
        return true;
      }
      case 'scenario-export.zip': {
        const id = url.searchParams.get('id') ?? '';
        const built = await session.buildScenarioFab(id, { waive: url.searchParams.get('waive') === '1' });
        if (!built.ok) {
          sendJSON(res, 400, { ok: false, error: built.error, issues: built.blocking ?? [] });
          return true;
        }
        // One folder per order, each holding what that order uploads to
        // JLCPCB: its gerbers.zip as it is, the BOM, the placement list and a
        // picture. orders.txt says what quantities to enter for each.
        const files = new Map<string, string | Buffer>();
        const plan = [`${built.scenario.title}`, ''];
        for (const o of built.orders) {
          files.set(`${o.folder}/gerbers.zip`, zipFiles(o.gerbers));
          files.set(`${o.folder}/bom.csv`, o.bom);
          files.set(`${o.folder}/cpl.csv`, o.cpl);
          files.set(`${o.folder}/${o.svgName}`, o.svg);
          if (o.fabSvg) files.set(`${o.folder}/panel.fab.svg`, o.fabSvg);
          plan.push(`${o.folder}/  ${o.label}: PCB qty ${o.made}, ${o.assembled > 0 ? `assemble ${o.assembled}` : 'no assembly'}`);
        }
        files.set('orders.txt', `${plan.join('\n')}\n`);
        const name = `${session.panel.name.replace(/[^\w.-]+/g, '_') || 'panel'}-${built.scenario.kind}-fab.zip`;
        const zip = zipFiles(files);
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${name}"`,
          'content-length': zip.length,
        });
        res.end(zip);
        return true;
      }
      default:
        return false;
    }
  }

  if (method !== 'POST') {
    req.resume();
    return false;
  }

  const body = await readJson(req);
  if (body === null) {
    sendJSON(res, 400, { ok: false, error: 'invalid JSON body' });
    return true;
  }
  const str = (k: string): string | undefined => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof body[k] === 'number' ? (body[k] as number) : undefined);

  switch (route) {
    case 'op': {
      if (typeof body.op !== 'string') {
        sendJSON(res, 400, { ok: false, error: 'body must be a PanelOp object with an "op" field' });
        return true;
      }
      const result = session.apply(body as unknown as PanelOp);
      sendJSON(res, result.ok ? 200 : 400, result);
      return true;
    }
    case 'undo': {
      sendJSON(res, 200, { ok: session.undo() });
      return true;
    }
    case 'redo': {
      sendJSON(res, 200, { ok: session.redo() });
      return true;
    }
    case 'new': {
      const name = str('name');
      if (!name) {
        sendJSON(res, 400, { ok: false, error: 'body must be {"name": "..."}' });
        return true;
      }
      const r = await session.create(name, str('path'));
      sendJSON(res, r.ok ? 200 : 400, r);
      return true;
    }
    case 'open': {
      const path = str('path');
      if (!path) {
        sendJSON(res, 400, { ok: false, error: 'body must be {"path": "<file.flamboyance>"}' });
        return true;
      }
      const r = await session.open(path);
      sendJSON(res, r.ok ? 200 : 400, r);
      return true;
    }
    case 'save': {
      const r = await session.save();
      sendJSON(res, r.ok ? 200 : 500, r);
      return true;
    }
    case 'add-board': {
      const path = str('path');
      if (!path) {
        sendJSON(res, 400, { ok: false, error: 'body must be {"path": "<board.flamingo>"}' });
        return true;
      }
      const r = await session.addBoard(path, { key: str('key'), needed: num('needed') });
      sendJSON(res, r.ok ? 200 : 400, r);
      return true;
    }
    case 'refresh': {
      const keys = Array.isArray(body.boards) ? body.boards.filter((k): k is string => typeof k === 'string') : undefined;
      const r = await session.refreshSources(keys);
      sendJSON(res, r.ok ? 200 : 400, r);
      return true;
    }
    case 'count': {
      const key = str('board');
      const count = num('count');
      if (!key || count === undefined) {
        sendJSON(res, 400, { ok: false, error: 'body must be {"board": "S", "count": 3}' });
        return true;
      }
      const r = await session.setInstanceCount(key, count);
      sendJSON(res, r.ok ? 200 : 400, r);
      return true;
    }
    case 'rotate': {
      const id = str('id');
      if (!id) {
        sendJSON(res, 400, { ok: false, error: 'body must be {"id": "S1"}' });
        return true;
      }
      const r = await session.rotateInstance(id, { by: num('by') ?? 90 });
      sendJSON(res, r.ok ? 200 : 400, r);
      return true;
    }
    case 'duplicate': {
      const id = str('id');
      if (!id) {
        sendJSON(res, 400, { ok: false, error: 'body must be {"id": "S1"}' });
        return true;
      }
      const r = await session.duplicateInstance(id);
      sendJSON(res, r.ok ? 200 : 400, r);
      return true;
    }
    case 'arrange': {
      sendJSON(res, 200, await session.arrange({ rotate: body.rotate !== false, ...(typeof body.rotationStep === 'number' ? { rotationStep: body.rotationStep } : {}) }));
      return true;
    }
    case 'apply-scenario': {
      const id = str('id');
      if (!id) {
        sendJSON(res, 400, { ok: false, error: 'body must be {"id": "<scenario id>"}' });
        return true;
      }
      const r = await session.applyScenario(id, objectiveOf(body.objective));
      sendJSON(res, r.ok ? 200 : 400, r);
      return true;
    }
    case 'export': {
      const r = await session.exportFab({ outDir: str('outDir'), waive: body.waive === true });
      sendJSON(res, r.ok ? 200 : 400, r.ok ? r : { ok: false, error: r.error, issues: r.blocking ?? [] });
      return true;
    }
    default:
      return false;
  }
}

export interface PanelChannel {
  /** Adopt a socket that connected with ?channel=panel. */
  add(ws: WebSocket): void;
  close(): void;
}

/** Whether an upgrade request asks for the panel channel. */
export function isPanelChannel(req: IncomingMessage): boolean {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams.get('channel') === 'panel';
  } catch {
    return false;
  }
}

const LOADING_INTERVAL_MS = 100;

export function attachPanelChannel(session: PanelSession): PanelChannel {
  const clients = new Set<WebSocket>();
  let pushing = false;
  let again = false;

  // Changes can arrive faster than views are derived; never let an older view
  // overtake a newer one, and never derive two at once.
  async function push(): Promise<void> {
    if (pushing) {
      again = true;
      return;
    }
    pushing = true;
    try {
      do {
        again = false;
        if (clients.size === 0) break;
        const msg = JSON.stringify({ type: 'panel', view: await session.view() });
        for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      } while (again);
    } catch (err) {
      console.error('[flamingo] panel view failed:', err);
    } finally {
      pushing = false;
    }
  }

  const onChange = (): void => {
    void push();
  };
  session.on('change', onChange);

  // Progress of the board checks a view is waiting on, at most every 100 ms.
  // The first update and the end of it (null) go out at once, so the end
  // always reaches a client before the view it was waiting for.
  let loadingTimer: ReturnType<typeof setTimeout> | null = null;
  let loadingSentAt = 0;
  function sendLoading(): void {
    loadingTimer = null;
    loadingSentAt = Date.now();
    const msg = JSON.stringify({ type: 'loading', loading: session.loading() });
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
  const onLoading = (): void => {
    const done = session.loading() === null;
    if (loadingTimer && !done) return; // the latest state goes out when it fires
    if (loadingTimer) clearTimeout(loadingTimer);
    const wait = LOADING_INTERVAL_MS - (Date.now() - loadingSentAt);
    if (done || wait <= 0) sendLoading();
    else loadingTimer = setTimeout(sendLoading, wait);
  };
  session.on('loading', onLoading);

  return {
    add(ws: WebSocket): void {
      clients.add(ws);
      const loading = session.loading();
      if (loading) ws.send(JSON.stringify({ type: 'loading', loading }));
      void (async () => {
        try {
          ws.send(JSON.stringify({ type: 'panel', view: await session.view() }));
        } catch (err) {
          console.error('[flamingo] panel view failed:', err);
        }
      })();

      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (typeof msg !== 'object' || msg === null || (msg as { type?: unknown }).type !== 'op') return;
        const op = (msg as { op?: unknown }).op;
        if (typeof op !== 'object' || op === null || typeof (op as { op?: unknown }).op !== 'string') {
          ws.send(JSON.stringify({ type: 'opResult', result: { ok: false, error: 'body must be a PanelOp object with an "op" field' } }));
          return;
        }
        try {
          const result = session.apply(op as PanelOp);
          ws.send(JSON.stringify({ type: 'opResult', result: result.ok ? { ok: true, created: result.created } : result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'opResult', result: { ok: false, error: err instanceof Error ? err.message : String(err) } }));
        }
      });

      ws.on('close', () => {
        clients.delete(ws);
      });
    },
    close(): void {
      session.removeListener('change', onChange);
      session.removeListener('loading', onLoading);
      if (loadingTimer) clearTimeout(loadingTimer);
      for (const ws of clients) ws.terminate();
      clients.clear();
    },
  };
}
