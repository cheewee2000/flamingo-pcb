import { describe, it, expect } from 'vitest';
import { applyOp, newBoard, isFullyRouted } from '@flamingo/engine';
import type { Board, Footprint, Op, PathSeg } from '@flamingo/engine';
import { exportDSN, importSES } from '@flamingo/fab';
import { findJava, runFreerouting } from '../src/route.js';

const R0603: Footprint = {
  name: 'R0603',
  lcsc: 'C25804',
  pads: [
    { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
    { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
  ],
  silk: [],
  courtyard: [],
};

const OUTLINE: PathSeg[] = [
  { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
  { type: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 20 } },
  { type: 'line', start: { x: 10, y: 20 }, end: { x: 0, y: 20 } },
  { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
];

function apply(b: Board, op: Op): Board {
  const r = applyOp(b, op);
  if (!r.ok) throw new Error(`${op.op}: ${r.error}`);
  return r.board;
}

function demoBoard(): Board {
  let b = newBoard('routeit', 2);
  b = apply(b, { op: 'setOutline', outline: OUTLINE });
  b = apply(b, { op: 'placeComponent', refdes: 'R1', lcsc: 'C25804', footprint: R0603, at: { x: 5, y: 5 }, rotation: 0, side: 'top', fields: {} });
  b = apply(b, { op: 'placeComponent', refdes: 'R2', lcsc: 'C25804', footprint: R0603, at: { x: 5, y: 15 }, rotation: 0, side: 'top', fields: {} });
  b = apply(b, { op: 'connectPins', net: 'N1', pins: ['R1.1', 'R2.1'] });
  b = apply(b, { op: 'connectPins', net: 'N2', pins: ['R1.2', 'R2.2'] });
  return b;
}

const SKIP = !findJava() || !!process.env.FLAMINGO_SKIP_ROUTE_IT;

describe.skipIf(SKIP)('freerouting integration', () => {
  it('routes a 2-net demo board end-to-end (real java + jar)', async () => {
    let board = demoBoard();
    expect(isFullyRouted(board)).toHaveLength(2);

    const dsn = exportDSN(board);
    const ses = await runFreerouting(dsn, { passes: 5 });

    const { tracks, vias } = importSES(ses, board);
    expect(tracks.length).toBeGreaterThan(0);

    board = apply(board, { op: 'addTracks', tracks, vias });
    expect(isFullyRouted(board)).toEqual([]);
  }, 300_000);
});
