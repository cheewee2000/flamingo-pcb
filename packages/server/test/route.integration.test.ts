import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyOp, newBoard, isFullyRouted } from '@flamingo/engine';
import type { Board, Footprint, Op, PathSeg } from '@flamingo/engine';
import { exportDSN, importSES } from '@flamingo/fab';
import { parseEasyedaFootprint } from '@flamingo/parts';
import { findJava, runFreerouting } from '../src/route.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Load a parsed EasyEDA footprint from the parts package's test fixtures. */
function fixtureFootprint(lcsc: string): Footprint {
  const path = join(here, '..', '..', 'parts', 'test', 'fixtures', `${lcsc}.json`);
  const { footprint } = parseEasyedaFootprint(JSON.parse(readFileSync(path, 'utf8')));
  return footprint;
}

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

  // Verification of the bottom-side mirror convention against the REAL router.
  //
  // exportDSN emits `(side back)` for bottom components and relies on Specctra
  // mirroring the (front-defined) image around the component origin (local
  // x -> -x) before rotate+translate — the same rule OUR engine uses in
  // componentTransformPoints/padWorld. isFullyRouted checks geometric contact
  // between freerouting's track endpoints and OUR computed pad world anchors,
  // so if Specctra's back-side mirror disagreed with our convention the router
  // would route to differently-placed pads and this would report unrouted nets.
  //
  // The bottom part (C2150, SOT-23-3) has asymmetric pads and a nonzero
  // rotation, so a wrong mirror/rotation sign shows up as a real miss. A small
  // copper keepout also exercises the (keepout ...) syntax against the router.
  it('routes a bottom-side asymmetric part + keepout end-to-end (mirror convention)', async () => {
    const sot23 = fixtureFootprint('C2150'); // pads 1:(1,-0.95) 2:(1,0.95) 3:(-1,0)
    const r0603 = fixtureFootprint('C25804'); // 2 pads at (+/-0.75, 0)

    // A 20x20 board with room for the router to drop vias between layers.
    const bigOutline: PathSeg[] = [
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
      { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
      { type: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 } },
      { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
    ];
    let board = newBoard('mirrorit', 2);
    board = apply(board, { op: 'setOutline', outline: bigOutline });
    // Bottom-side transistor, rotated 90deg — the convention under test.
    board = apply(board, {
      op: 'placeComponent',
      refdes: 'Q1',
      lcsc: 'C2150',
      footprint: sot23,
      at: { x: 10, y: 7 },
      rotation: 90,
      side: 'bottom',
      fields: {},
    });
    // Top-side resistor, straight above it (each net crosses layers -> a via).
    board = apply(board, {
      op: 'placeComponent',
      refdes: 'R1',
      lcsc: 'C25804',
      footprint: r0603,
      at: { x: 10, y: 14 },
      rotation: 0,
      side: 'top',
      fields: {},
    });
    // Two nets, each spanning the top part and the bottom part (needs a via).
    board = apply(board, { op: 'connectPins', net: 'N1', pins: ['Q1.1', 'R1.1'] });
    board = apply(board, { op: 'connectPins', net: 'N2', pins: ['Q1.3', 'R1.2'] });
    // Small copper keepout in a corner, clear of the route (routable-around);
    // its only job here is to make real freerouting accept the keepout syntax.
    board = apply(board, {
      op: 'addKeepout',
      keepout: {
        layers: ['F.Cu'],
        polygon: [
          { x: 2, y: 2 },
          { x: 5, y: 2 },
          { x: 5, y: 5 },
          { x: 2, y: 5 },
        ],
        keepout: { copper: true, via: false },
      },
    });

    expect(isFullyRouted(board)).toHaveLength(2);

    const dsn = exportDSN(board);
    const ses = await runFreerouting(dsn, { passes: 8 });

    const { tracks, vias } = importSES(ses, board);
    expect(tracks.length).toBeGreaterThan(0);

    board = apply(board, { op: 'addTracks', tracks, vias });
    // The decisive assertion: freerouting's endpoints land on OUR pad anchors.
    expect(isFullyRouted(board)).toEqual([]);
  }, 300_000);
});
