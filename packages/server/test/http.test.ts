import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newBoard } from '@flamingo/engine';
import type { Board, ComponentInst, Footprint } from '@flamingo/engine';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';
import type { RouteRunner } from '../src/route.js';

describe('HTTP API', () => {
  let doc: Doc;
  let started: StartedServer;
  let base: string;
  // A uiDistDir that is guaranteed not to exist, so these tests never depend
  // on whether packages/ui/dist happens to be built in this environment.
  let missingUiDistDir: string;

  beforeEach(async () => {
    doc = new Doc(newBoard('httptest', 2));
    missingUiDistDir = join(tmpdir(), `flamingo-http-no-ui-dist-${process.pid}-${Math.random().toString(36).slice(2)}`);
    started = await startServer(doc, 0, { uiDistDir: missingUiDistDir }); // ephemeral port
    base = `http://localhost:${started.port}`;
  });

  afterEach(async () => {
    await started.close();
  });

  it('binds to a real ephemeral port', () => {
    expect(started.port).toBeGreaterThan(0);
  });

  it('GET /api/board returns the current board', async () => {
    const res = await fetch(`${base}/api/board`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('httptest');
    expect(body.copperLayers).toBe(2);
  });

  it('POST /api/op applies a valid op and returns 200 with the OpResult', async () => {
    const res = await fetch(`${base}/api/op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'setBoardMeta', name: 'renamed' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.board.name).toBe('renamed');
    expect(doc.board.name).toBe('renamed');
  });

  it('POST /api/op returns 400 with {ok:false,error} for a bad op', async () => {
    const res = await fetch(`${base}/api/op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'moveComponent', refdes: 'U1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('POST /api/op returns 400 (not 500) when applyOp throws on a wrong-typed field', async () => {
    // pins:42 instead of an array of strings -- applyOp's `for (const pin of
    // op.pins)` throws a raw TypeError rather than returning an OpError.
    const res = await fetch(`${base}/api/op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'connectPins', net: 'x', pins: 42 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('POST /api/op returns 400 for malformed JSON', async () => {
    const res = await fetch(`${base}/api/op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('POST /api/undo and /api/redo round-trip', async () => {
    await fetch(`${base}/api/op`, {
      method: 'POST',
      body: JSON.stringify({ op: 'setBoardMeta', name: 'changed' }),
    });

    const undoRes = await fetch(`${base}/api/undo`, { method: 'POST' });
    expect(undoRes.status).toBe(200);
    const undoBody = await undoRes.json();
    expect(undoBody.ok).toBe(true);
    expect(undoBody.board.name).toBe('httptest');

    const redoRes = await fetch(`${base}/api/redo`, { method: 'POST' });
    expect(redoRes.status).toBe(200);
    const redoBody = await redoRes.json();
    expect(redoBody.ok).toBe(true);
    expect(redoBody.board.name).toBe('changed');

    // Nothing left to redo.
    const redoAgain = await fetch(`${base}/api/redo`, { method: 'POST' });
    expect(redoAgain.status).toBe(200);
    const redoAgainBody = await redoAgain.json();
    expect(redoAgainBody.ok).toBe(false);
  });

  it('GET /api/ratsnest returns an array', async () => {
    const res = await fetch(`${base}/api/ratsnest`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/render.svg returns an SVG document', async () => {
    const res = await fetch(`${base}/api/render.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    const text = await res.text();
    expect(text).toContain('<svg');
  });

  it('GET /api/render.svg accepts layers and highlightNet query params', async () => {
    const res = await fetch(`${base}/api/render.svg?layers=F.Cu,B.Cu&highlightNet=NET1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    const text = await res.text();
    expect(text).toContain('<svg');
  });

  it('GET /api/render.png returns a PNG image', async () => {
    const res = await fetch(`${base}/api/render.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('GET /api/render.png accepts layers, region, widthPx, highlightNet, showRatsnest/showDrc query params', async () => {
    const res = await fetch(
      `${base}/api/render.png?layers=F.Cu,B.Cu&region=0,0,10,10&widthPx=300&highlightNet=NET1&showRatsnest=0&showDrc=0`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // IHDR width field, big-endian u32 at byte offset 16.
    expect(buf.readUInt32BE(16)).toBe(300);
  });

  it('GET /api/render.png returns 400 when region has wrong count (too few values)', async () => {
    const res = await fetch(`${base}/api/render.png?region=0,0,10`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('region must be minX,minY,maxX,maxY (numbers)');
  });

  it('GET /api/render.png returns 400 when region has non-numeric values', async () => {
    const res = await fetch(`${base}/api/render.png?region=a,b,c,d`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('region must be minX,minY,maxX,maxY (numbers)');
  });

  it('GET /api/render.png returns 200 with valid region and PNG magic bytes', async () => {
    const res = await fetch(`${base}/api/render.png?region=0,0,10,10`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('POST /api/save returns ok:true when a filePath is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flamingo-http-save-'));
    const filePath = join(dir, 'board.flamingo');
    const pathedDoc = new Doc(newBoard('httptest-pathed', 2), filePath);
    const pathedServer = await startServer(pathedDoc, 0);
    try {
      const res = await fetch(`http://localhost:${pathedServer.port}/api/save`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    } finally {
      await pathedServer.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Doc.save() now throws instead of silently no-op-ing when no filePath is
  // set (see document.ts) -- the /api/save route's existing try/catch turns
  // that into a 500 with the error message rather than a false-positive 200.
  it('POST /api/save returns 500 with an error message when no filePath is set', async () => {
    const res = await fetch(`${base}/api/save`, { method: 'POST' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('no file path set');
  });

  describe('POST /api/export', () => {
    it('returns 400 with a violations report when the board has DRC violations (no outline)', async () => {
      const res = await fetch(`${base}/api/export`, { method: 'POST' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.violations)).toBe(true);
      expect(body.violations.length).toBeGreaterThan(0);
      expect(body.violations.some((v: { rule: string }) => v.rule === 'missing-outline')).toBe(true);
    });

    it('exports to outDir and returns 200 with file paths when DRC-clean', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'flamingo-http-export-'));
      const filePath = join(dir, 'board.flamingo');
      const cleanDoc = new Doc(newBoard('exporttest', 2), filePath);
      const cleanServer = await startServer(cleanDoc, 0, { uiDistDir: missingUiDistDir });
      try {
        const opRes = await fetch(`http://localhost:${cleanServer.port}/api/op`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            op: 'setOutline',
            outline: [
              { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
              { type: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
              { type: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
              { type: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
            ],
          }),
        });
        expect(opRes.status).toBe(200);

        const outDir = join(dir, 'exported-fab');
        const res = await fetch(`http://localhost:${cleanServer.port}/api/export`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ outDir }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.gerberZip).toBe(join(outDir, 'gerbers.zip'));
        expect(body.bomCsv).toBe(join(outDir, 'bom.csv'));
        expect(body.cplCsv).toBe(join(outDir, 'cpl.csv'));
      } finally {
        await cleanServer.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults outDir to <dirname(board file)>/fab when the body omits outDir', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'flamingo-http-export-default-'));
      const filePath = join(dir, 'board.flamingo');
      const defDoc = new Doc(newBoard('exportdefault', 2), filePath);
      const defServer = await startServer(defDoc, 0, { uiDistDir: missingUiDistDir });
      try {
        await fetch(`http://localhost:${defServer.port}/api/op`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            op: 'setOutline',
            outline: [
              { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
              { type: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
              { type: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
              { type: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
            ],
          }),
        });

        const res = await fetch(`http://localhost:${defServer.port}/api/export`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.bomCsv).toBe(join(dir, 'fab', 'bom.csv'));
      } finally {
        await defServer.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('POST /api/route', () => {
    // A routed board streams back over /ws; here we only exercise the endpoint
    // plumbing with a mock runner, so an SES with no wires is enough.
    const EMPTY_SES = '(session route.ses (routes (resolution um 1)))';

    function makeFootprint(): Footprint {
      return {
        name: 'test-fp',
        lcsc: 'C0',
        pads: [
          { number: '1', shape: 'rect', at: { x: -1, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' },
          { number: '2', shape: 'rect', at: { x: 1, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' },
        ],
        silk: [],
        courtyard: [],
      };
    }

    function makeComponent(refdes: string, x: number, y: number): ComponentInst {
      return { refdes, lcsc: 'C0', footprint: makeFootprint(), at: { x, y }, rotation: 0, side: 'top', fields: {} };
    }

    function routeBoard(): Board {
      const b = newBoard('routetest', 2);
      b.outline = [
        { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
        { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
        { type: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 } },
        { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
      ];
      b.components = [makeComponent('R1', 5, 10), makeComponent('R2', 15, 10)];
      b.nets = [{ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] }];
      return b;
    }

    async function startRouteServer(runner: RouteRunner): Promise<StartedServer> {
      return startServer(new Doc(routeBoard()), 0, { uiDistDir: missingUiDistDir, routeRunner: runner });
    }

    it('runs the autoroute pipeline and reports counts as JSON', async () => {
      const okRunner: RouteRunner = { run: async () => EMPTY_SES };
      const srv = await startRouteServer(okRunner);
      try {
        const res = await fetch(`http://localhost:${srv.port}/api/route`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.routedCount).toBe(1); // NET1 has >=2 pins
        expect(body.tracksAdded).toBe(0); // empty SES: no wires
        expect(body.viasAdded).toBe(0);
        expect(Array.isArray(body.remaining)).toBe(true);
        expect(body.fullyRouted).toBe(false); // still two islands after an empty route
      } finally {
        await srv.close();
      }
    });

    it('returns 500 with an error message when the router throws', async () => {
      const badRunner: RouteRunner = {
        run: async () => {
          throw new Error('java not found');
        },
      };
      const srv = await startRouteServer(badRunner);
      try {
        const res = await fetch(`http://localhost:${srv.port}/api/route`, { method: 'POST' });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toContain('java not found');
      } finally {
        await srv.close();
      }
    });

    it('returns 400 when nets is not an array of strings', async () => {
      const okRunner: RouteRunner = { run: async () => EMPTY_SES };
      const srv = await startRouteServer(okRunner);
      try {
        const res = await fetch(`http://localhost:${srv.port}/api/route`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nets: 42 }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
      } finally {
        await srv.close();
      }
    });
  });

  it('returns 404 with {ok:false,error} for an unknown /api route', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('returns 404 for an unknown non-api route (uiDistDir does not exist)', async () => {
    const res = await fetch(`${base}/some/random/path`);
    expect(res.status).toBe(404);
  });

  it('GET / serves the placeholder page when uiDistDir does not exist', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('Flamingo — UI not built yet');
  });

  describe('static file serving from uiDistDir', () => {
    let dir: string;
    let staticServer: StartedServer;
    let staticBase: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'flamingo-http-ui-dist-'));
      await writeFile(
        join(dir, 'index.html'),
        '<!doctype html><html><body><p>hello from temp ui dist</p></body></html>',
      );
      await mkdir(join(dir, 'assets'));
      await writeFile(join(dir, 'assets', 'app.js'), 'console.log("hi");');

      const staticDoc = new Doc(newBoard('httptest-static', 2));
      staticServer = await startServer(staticDoc, 0, { uiDistDir: dir });
      staticBase = `http://localhost:${staticServer.port}`;
    });

    afterEach(async () => {
      await staticServer.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('GET / serves index.html from uiDistDir when it exists', async () => {
      const res = await fetch(`${staticBase}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const text = await res.text();
      expect(text).toContain('hello from temp ui dist');
    });

    it('GET /assets/app.js serves a static asset with the correct content type', async () => {
      const res = await fetch(`${staticBase}/assets/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/javascript');
      const text = await res.text();
      expect(text).toContain('console.log("hi");');
    });

    it('GET /some/client-route falls back to index.html (SPA routing)', async () => {
      const res = await fetch(`${staticBase}/some/client-route`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const text = await res.text();
      expect(text).toContain('hello from temp ui dist');
    });
  });
});
