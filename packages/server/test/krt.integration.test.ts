import { describe, it, expect } from 'vitest';
import { applyOp, newBoard, isFullyRouted } from '@flamingo/engine';
import type { Board, Footprint, Op, PathSeg } from '@flamingo/engine';
import { exportKiCadPcb, importKiCadRoutes } from '@flamingo/fab';
import { findKiCadRoutingTools, KRT_INSTALL_HINT, runKiCadRouter } from '../src/krt.js';

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
  { type: 'line', start: { x: 0, y: 0 }, end: { x: 30, y: 0 } },
  { type: 'line', start: { x: 30, y: 0 }, end: { x: 30, y: 20 } },
  { type: 'line', start: { x: 30, y: 20 }, end: { x: 0, y: 20 } },
  { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
];
function apply(b: Board, op: Op): Board {
  const r = applyOp(b, op);
  if (!r.ok) throw new Error(`op ${op.op} failed: ${r.error}`);
  return r.board;
}
function board(): Board {
  let b = newBoard('krt', 2);
  b = apply(b, { op: 'setOutline', outline: OUTLINE });
  b = apply(b, { op: 'placeComponent', refdes: 'R1', lcsc: 'C25804', footprint: R0603, at: { x: 8, y: 6 }, rotation: 0, side: 'top', fields: {} });
  b = apply(b, { op: 'placeComponent', refdes: 'R2', lcsc: 'C25804', footprint: R0603, at: { x: 22, y: 14 }, rotation: 0, side: 'top', fields: {} });
  return apply(b, { op: 'connectPins', net: 'N1', pins: ['R1.2', 'R2.1'] });
}

describe('findKiCadRoutingTools', () => {
  it('fails with install instructions when the checkout is missing', () => {
    expect(() => findKiCadRoutingTools('/nonexistent/krt')).toThrow(KRT_INSTALL_HINT);
  });
});

// Real-router round trip. Runs only where KiCadRoutingTools is installed:
//   FLAMINGO_KRT_DIR=/path/to/KiCadRoutingTools npm test -w @flamingo/server
const haveKrt = (() => {
  try {
    findKiCadRoutingTools();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!haveKrt)('KiCadRoutingTools integration', () => {
  it('routes a two-pad net end to end through the KiCad file round trip', async () => {
    const b = board();
    const routed = await runKiCadRouter(exportKiCadPcb(b, { nets: ['N1'] }), b, { nets: ['N1'] });
    const { tracks, vias } = importKiCadRoutes(routed);
    const mine = { tracks: tracks.filter((t) => t.net === 'N1'), vias: vias.filter((v) => v.net === 'N1') };
    expect(mine.tracks.length).toBeGreaterThan(0);
    let done = b;
    done = apply(done, { op: 'addTracks', tracks: mine.tracks, vias: mine.vias });
    expect(isFullyRouted(done)).toEqual([]);
  }, 120000);
});

describe('gridStepFor', () => {
  it('keeps the router default for coarse boards and tightens for fine-pitch parts', async () => {
    const { gridStepFor } = await import('../src/krt.js');
    expect(gridStepFor(board())).toBeUndefined();
    const fine: Footprint = {
      name: 'QFN',
      lcsc: 'C0',
      pads: Array.from({ length: 10 }, (_, i) => ({ number: String(i + 1), shape: 'rect' as const, at: { x: i * 0.35, y: 0 }, rotation: 0, size: { w: 0.15, h: 0.65 }, layer: 'top' as const })),
      silk: [],
      courtyard: [],
    };
    const b2 = apply(board(), { op: 'placeComponent', refdes: 'U1', lcsc: 'C0', footprint: fine, at: { x: 15, y: 10 }, rotation: 0, side: 'top', fields: {} });
    expect(gridStepFor(b2)).toBe(0.05);
  });
});

describe('readFlamingoConfig', () => {
  it('reads krtDir and router from the file named by FLAMINGO_CONFIG, and tolerates a missing file', async () => {
    const { readFlamingoConfig } = await import('../src/krt.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'flamingo-cfg-'));
    const prev = process.env.FLAMINGO_CONFIG;
    try {
      process.env.FLAMINGO_CONFIG = join(dir, 'missing.json');
      expect(readFlamingoConfig()).toEqual({});
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ krtDir: '/x/krt', router: 'krt' }));
      process.env.FLAMINGO_CONFIG = join(dir, 'config.json');
      expect(readFlamingoConfig()).toEqual({ krtDir: '/x/krt', router: 'krt' });
    } finally {
      if (prev === undefined) delete process.env.FLAMINGO_CONFIG;
      else process.env.FLAMINGO_CONFIG = prev;
    }
  });
});

describe('planStages', () => {
  it('routes a coarse board in one run, and a fine-pitch board signals-first then rails alone', async () => {
    const { planStages } = await import('../src/krt.js');
    const coarse = board();
    expect(planStages(coarse, ['N1']).map((s) => s.label)).toEqual(['all nets']);

    const fine: Footprint = {
      name: 'QFN',
      lcsc: 'C0',
      pads: Array.from({ length: 10 }, (_, i) => ({ number: String(i + 1), shape: 'rect' as const, at: { x: i * 0.35, y: 0 }, rotation: 0, size: { w: 0.15, h: 0.65 }, layer: 'top' as const })),
      silk: [],
      courtyard: [],
    };
    let b = apply(board(), { op: 'placeComponent', refdes: 'U1', lcsc: 'C0', footprint: fine, at: { x: 15, y: 10 }, rotation: 0, side: 'top', fields: {} });
    b = apply(b, { op: 'connectPins', net: 'SIG_B', pins: ['U1.7', 'R1.1'] });
    b = apply(b, { op: 'connectPins', net: 'SIG_A', pins: ['U1.2', 'R2.2'] });
    b = apply(b, { op: 'connectPins', net: 'GND', pins: ['U1.1', 'U1.3', 'U1.4', 'U1.5', 'U1.6'] });
    const stages = planStages(b, ['SIG_B', 'SIG_A', 'GND']);
    // signals ordered by the fine part's pin number (SIG_A on pin 2 before SIG_B on pin 7), then the rail on its own
    expect(stages[0]!.nets).toEqual(['SIG_A', 'SIG_B']);
    expect(stages.at(-1)!.nets).toEqual(['GND']);
    expect(stages.at(-1)!.label).toBe('rail GND');
  });
});
