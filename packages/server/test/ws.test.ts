import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { newBoard } from '@flamingo/engine';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';

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
});
