import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { newBoard } from '@flamingo/engine';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';
import type { RouteRunner } from '../src/route.js';

/**
 * Queues every message the socket receives from the moment this is called
 * (synchronously, before any `await`) so nothing is lost to a race between
 * the server sending a message (e.g. right on `connection`) and the test
 * getting around to waiting for it.
 */
function messageQueue(ws: WebSocket): { next(): Promise<unknown> } {
  const queue: unknown[] = [];
  const waiters: ((v: unknown) => void)[] = [];

  ws.on('message', (data: Buffer) => {
    const msg: unknown = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      queue.push(msg);
    }
  });

  return {
    next(): Promise<unknown> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

describe('WebSocket API', () => {
  let doc: Doc;
  let started: StartedServer;
  let wsUrl: string;

  beforeEach(async () => {
    doc = new Doc(newBoard('wstest', 2));
    started = await startServer(doc, 0);
    wsUrl = `ws://localhost:${started.port}/ws`;
  });

  afterEach(async () => {
    await started.close();
  });

  it('sends the current board on connect', async () => {
    const ws = new WebSocket(wsUrl);
    const queue = messageQueue(ws);
    await waitOpen(ws);

    const msg = (await queue.next()) as { type: string; board: { name: string } };
    expect(msg.type).toBe('board');
    expect(msg.board.name).toBe('wstest');
    ws.close();
  });

  it('broadcasts a board change to both clients when one sends an op, and replies opResult to the sender', async () => {
    const clientA = new WebSocket(wsUrl);
    const queueA = messageQueue(clientA);
    const clientB = new WebSocket(wsUrl);
    const queueB = messageQueue(clientB);
    await Promise.all([waitOpen(clientA), waitOpen(clientB)]);

    // Consume the initial 'board' message each client gets on connect.
    await queueA.next();
    await queueB.next();

    clientA.send(
      JSON.stringify({
        type: 'op',
        op: { op: 'setBoardMeta', name: 'wschanged' },
      }),
    );

    const bBroadcast = (await queueB.next()) as { type: string; board: { name: string } };
    expect(bBroadcast.type).toBe('board');
    expect(bBroadcast.board.name).toBe('wschanged');

    // clientA (the sender) gets both the change broadcast and the direct
    // opResult reply, in either order -- collect both and check by type.
    const aMsg1 = await queueA.next();
    const aMsg2 = await queueA.next();
    const aMessages = [aMsg1, aMsg2] as Array<{ type: string; board?: { name: string }; result?: { ok: boolean; board: { name: string } } }>;

    const opResultMsg = aMessages.find((m) => m.type === 'opResult');
    const boardMsg = aMessages.find((m) => m.type === 'board');

    expect(opResultMsg).toBeDefined();
    expect(opResultMsg?.result?.ok).toBe(true);
    expect(opResultMsg?.result?.board.name).toBe('wschanged');

    expect(boardMsg).toBeDefined();
    expect(boardMsg?.board?.name).toBe('wschanged');

    expect(doc.board.name).toBe('wschanged');

    clientA.close();
    clientB.close();
  });

  it('ignores malformed messages without crashing the connection', async () => {
    const ws = new WebSocket(wsUrl);
    const queue = messageQueue(ws);
    await waitOpen(ws);
    await queue.next(); // initial board message

    ws.send('not json');

    // Connection should still be usable afterwards.
    ws.send(JSON.stringify({ type: 'op', op: { op: 'setBoardMeta', name: 'stillAlive' } }));
    const msg = (await queue.next()) as { type: string };
    // The op change broadcast and the opResult reply may arrive in either
    // order; either is proof the connection survived the malformed message.
    expect(['board', 'opResult']).toContain(msg.type);

    ws.close();
  });

  it('replies with an opResult error instead of crashing on a malformed op payload', async () => {
    const ws = new WebSocket(wsUrl);
    const queue = messageQueue(ws);
    await waitOpen(ws);
    await queue.next(); // initial board message

    ws.send(JSON.stringify({ type: 'op', op: null }));
    const reply = (await queue.next()) as { type: string; result: { ok: boolean; error: string } };
    expect(reply.type).toBe('opResult');
    expect(reply.result.ok).toBe(false);
    expect(typeof reply.result.error).toBe('string');

    // Connection must still be usable afterwards.
    ws.send(JSON.stringify({ type: 'op', op: { op: 'setBoardMeta', name: 'survived' } }));
    const nextReply = (await queue.next()) as { type: string };
    expect(['board', 'opResult']).toContain(nextReply.type);
    expect(doc.board.name).toBe('survived');

    ws.close();
  });

  it('broadcasts live routeStatus (running… then a terminal done) to all clients during /api/route', async () => {
    // A mock runner that emits freerouting-style progress through onProgress and
    // returns a trivially-valid empty SES (no java involved).
    const runner: RouteRunner = {
      run: async (_dsn, opts) => {
        opts?.onProgress?.({ kind: 'started', threads: 4 });
        opts?.onProgress?.({ kind: 'pass', pass: 1, score: 100, unrouted: 2 });
        opts?.onProgress?.({ kind: 'session-done', score: 120, unrouted: 0 });
        return '(session route.ses (routes (resolution um 1)))';
      },
    };
    const rdoc = new Doc(newBoard('routetest', 2));
    const rserver = await startServer(rdoc, 0, { routeRunner: runner });
    try {
      const ws = new WebSocket(`ws://localhost:${rserver.port}/ws`);
      const queue = messageQueue(ws);
      await waitOpen(ws);
      await queue.next(); // initial board

      const res = await fetch(`http://localhost:${rserver.port}/api/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.ok).toBe(true);

      // Drain messages until the terminal routeStatus arrives, collecting the
      // routeStatus stream (board broadcasts from applied ops are interleaved).
      const statuses: Array<{ state: string; stage?: string; pass?: number; unrouted?: number }> = [];
      for (let i = 0; i < 50; i++) {
        const msg = (await queue.next()) as { type: string; status?: { state: string; stage?: string; pass?: number; unrouted?: number } };
        if (msg.type === 'routeStatus' && msg.status) {
          statuses.push(msg.status);
          if (msg.status.state === 'done' || msg.status.state === 'failed') break;
        }
      }

      expect(statuses.some((s) => s.state === 'running')).toBe(true);
      expect(statuses.some((s) => s.state === 'running' && s.stage === 'route' && s.pass === 1 && s.unrouted === 2)).toBe(true);
      const terminal = statuses[statuses.length - 1];
      expect(terminal.state).toBe('done');

      ws.close();
    } finally {
      await rserver.close();
    }
  });

  it('replies with an opResult error instead of crashing when applyOp throws on a wrong-typed field', async () => {
    const ws = new WebSocket(wsUrl);
    const queue = messageQueue(ws);
    await waitOpen(ws);
    await queue.next(); // initial board message

    // pins:42 instead of an array of strings -- applyOp's `for (const pin of
    // op.pins)` throws a raw TypeError rather than returning an OpError.
    ws.send(JSON.stringify({ type: 'op', op: { op: 'connectPins', net: 'x', pins: 42 } }));
    const reply = (await queue.next()) as { type: string; result: { ok: boolean; error: string } };
    expect(reply.type).toBe('opResult');
    expect(reply.result.ok).toBe(false);
    expect(typeof reply.result.error).toBe('string');

    // Connection must still be usable afterwards.
    ws.send(JSON.stringify({ type: 'op', op: { op: 'setBoardMeta', name: 'survived' } }));
    const nextReply = (await queue.next()) as { type: string };
    expect(['board', 'opResult']).toContain(nextReply.type);
    expect(doc.board.name).toBe('survived');

    ws.close();
  });
});
