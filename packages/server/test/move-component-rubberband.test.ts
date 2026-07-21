import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newBoard, tracksAtPad } from '@flamingo/engine';
import type { Footprint } from '@flamingo/engine';
import type { PartInfo } from '@flamingo/parts';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';
import type { PartsApi } from '../src/mcp.js';
import type { RouteRunner } from '../src/route.js';

// Minimal one-pad footprint: pad "1" at the footprint origin, so a component
// placed at world (0,0) has its pad anchored at world (0,0) too.
const ONE_PAD_FOOTPRINT: Footprint = {
  name: 'ONEPAD',
  lcsc: 'C1PAD',
  pads: [{ number: '1', shape: 'circle', at: { x: 0, y: 0 }, rotation: 0, size: { w: 0.6, h: 0.6 }, layer: 'top' }],
  silk: [],
  courtyard: [],
};

const ONE_PAD_INFO: PartInfo = {
  lcsc: 'C1PAD',
  mfr: 'TESTCO',
  mpn: 'ONEPAD',
  description: 'single-pad test footprint',
  package: 'ONEPAD',
  basic: true,
};

const mockPartsApi: PartsApi = {
  fetchPart: async (lcsc: string) => {
    if (lcsc !== 'C1PAD') throw new Error(`unknown fixture part "${lcsc}"`);
    return { footprint: ONE_PAD_FOOTPRINT, info: ONE_PAD_INFO };
  },
  searchParts: async () => [ONE_PAD_INFO],
  fetchStock: async (lcsc: string) => ({ lcsc, stock: 1_000_000, basic: false }),
};

const mockRouteRunner: RouteRunner = {
  run: async () => {
    throw new Error('autoroute not used in this test');
  },
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('move_component rubber-bands connected traces', () => {
  let doc: Doc;
  let started: StartedServer;
  let base: string;
  let client: Client;
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'flamingo-mcp-rubberband-test-'));
    doc = new Doc(newBoard('rubberbandtest', 2));
    started = await startServer(doc, 0, {
      partsApi: mockPartsApi,
      projectDir,
      routeRunner: mockRouteRunner,
    });
    base = `http://localhost:${started.port}`;

    client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await started.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  it('follows the pad, stays octilinear, and undoes atomically', async () => {
    // R1 at (0,0) -> pad "1" world anchor is (0,0).
    await client.callTool({
      name: 'place_component',
      arguments: { lcsc: 'C1PAD', refdes: 'R1', x: 0, y: 0 },
    });
    await client.callTool({ name: 'connect_pins', arguments: { net: 'N1', pins: ['R1.1'] } });
    await client.callTool({
      name: 'add_track',
      arguments: { layer: 'F.Cu', net: 'N1', start: { x: 0, y: 0 }, end: { x: 0, y: 5 } },
    });

    expect(doc.board.tracks).toHaveLength(1);
    const originalTrack = doc.board.tracks[0]!;
    const originalComponentAt = { ...doc.board.components[0]!.at };

    const moveResult = await client.callTool({
      name: 'move_component',
      arguments: { refdes: 'R1', x: 3, y: 0 },
    });
    expect(moveResult.isError).toBeFalsy();
    expect(textOf(moveResult as any)).toContain('R1');

    // Component actually moved.
    const movedComp = doc.board.components.find((c) => c.refdes === 'R1')!;
    expect(movedComp.at).toEqual({ x: 3, y: 0 });

    // The trace followed the pad -- island connectivity preserved.
    const hits = tracksAtPad(doc.board, 'R1', '1');
    expect(hits.length).toBeGreaterThan(0);

    // Every reshaped line segment is octilinear (0/45/90 degree legs only).
    for (const track of doc.board.tracks) {
      if (track.seg.type !== 'line') continue;
      const dx = track.seg.end.x - track.seg.start.x;
      const dy = track.seg.end.y - track.seg.start.y;
      expect(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)).toBe(true);
    }

    // The original (now-stale) track id is gone -- it was replaced, not mutated in place.
    expect(doc.board.tracks.some((t) => t.id === originalTrack.id)).toBe(false);

    // A single undo restores BOTH the component position and the original track.
    const undoResult = await client.callTool({ name: 'undo', arguments: {} });
    expect(undoResult.isError).toBeFalsy();

    const restoredComp = doc.board.components.find((c) => c.refdes === 'R1')!;
    expect(restoredComp.at).toEqual(originalComponentAt);
    expect(doc.board.tracks).toHaveLength(1);
    expect(doc.board.tracks[0]).toEqual(originalTrack);
  });

  it('a component with no connected tracks still gets a bare move (no dangling reshape)', async () => {
    await client.callTool({
      name: 'place_component',
      arguments: { lcsc: 'C1PAD', refdes: 'R1', x: 0, y: 0 },
    });

    const moveResult = await client.callTool({
      name: 'move_component',
      arguments: { refdes: 'R1', x: 7, y: 2, rotation: 90 },
    });
    expect(moveResult.isError).toBeFalsy();

    const comp = doc.board.components.find((c) => c.refdes === 'R1')!;
    expect(comp.at).toEqual({ x: 7, y: 2 });
    expect(comp.rotation).toBe(90);
    expect(doc.board.tracks).toHaveLength(0);

    // Still a single undo step.
    await client.callTool({ name: 'undo', arguments: {} });
    const restored = doc.board.components.find((c) => c.refdes === 'R1')!;
    expect(restored.at).toEqual({ x: 0, y: 0 });
    expect(restored.rotation).toBe(0);
  });
});
