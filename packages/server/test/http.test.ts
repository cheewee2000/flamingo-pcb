import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newBoard } from '@flamingo/engine';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';

describe('HTTP API', () => {
  let doc: Doc;
  let started: StartedServer;
  let base: string;

  beforeEach(async () => {
    doc = new Doc(newBoard('httptest', 2));
    started = await startServer(doc, 0); // ephemeral port
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

  it('returns 404 with {ok:false,error} for an unknown /api route', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('returns 404 for an unknown non-api route (no ui/dist built)', async () => {
    const res = await fetch(`${base}/some/random/path`);
    expect(res.status).toBe(404);
  });

  it('GET / serves the placeholder page when packages/ui/dist does not exist', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('Flamingo — UI not built yet');
  });
});
