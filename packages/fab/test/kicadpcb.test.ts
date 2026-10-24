import { describe, it, expect } from 'vitest';
import { applyOp, newBoard } from '@flamingo/engine';
import type { Board, Footprint, Op, PathSeg } from '@flamingo/engine';
import { exportKiCadPcb, importKiCadRoutes } from '../src/kicadpcb.js';

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
  { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
  { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 15 } },
  { type: 'line', start: { x: 20, y: 15 }, end: { x: 0, y: 15 } },
  { type: 'line', start: { x: 0, y: 15 }, end: { x: 0, y: 0 } },
];

function apply(b: Board, op: Op): Board {
  const r = applyOp(b, op);
  if (!r.ok) throw new Error(`op ${op.op} failed: ${r.error}`);
  return r.board;
}

function tinyBoard(): Board {
  let b = newBoard('t', 4);
  b = apply(b, { op: 'setOutline', outline: OUTLINE });
  b = apply(b, { op: 'placeComponent', refdes: 'R1', lcsc: 'C25804', footprint: R0603, at: { x: 5, y: 5 }, rotation: 0, side: 'top', fields: {} });
  b = apply(b, { op: 'placeComponent', refdes: 'R2', lcsc: 'C25804', footprint: R0603, at: { x: 10, y: 5 }, rotation: 90, side: 'bottom', fields: {} });
  b = apply(b, { op: 'connectPins', net: 'N1', pins: ['R1.2', 'R2.1'] });
  return b;
}

describe('exportKiCadPcb', () => {
  it('writes copper layers, pads in world space with y negated, and net names', () => {
    const pcb = exportKiCadPcb(tinyBoard());
    expect(pcb).toContain('(0 "F.Cu" signal)');
    expect(pcb).toContain('(4 "In1.Cu" signal)');
    expect(pcb).toContain('(6 "In2.Cu" signal)');
    expect(pcb).toContain('(2 "B.Cu" signal)');
    // R1 (top, rot 0) pad 2 sits at world (5.75, 5) -> KiCad (5.75, -5).
    expect(pcb).toMatch(/\(pad "2" smd rect\s*\(at 5\.75 -5\)/);
    expect(pcb).toContain('(net "N1")');
    // R2 is on the bottom side: its pads are on B.Cu.
    expect(pcb).toMatch(/\(layer "B\.Cu"\)\s*\(uuid [^)]*\)\s*\(at 0 0\)/);
    expect(pcb).toContain('(layer "Edge.Cuts")');
  });

  it('writes existing copper only as obstacles for nets that are not being routed', () => {
    let b = tinyBoard();
    b = apply(b, {
      op: 'addTracks',
      tracks: [{ layer: 'F.Cu', width: 0.25, net: 'N1', seg: { type: 'line', start: { x: 5.75, y: 5 }, end: { x: 8, y: 8 } } }],
      vias: [],
    });
    expect(exportKiCadPcb(b)).not.toContain('(segment');
    expect(exportKiCadPcb(b, { nets: ['OTHER'] })).toContain('(segment');
    expect(exportKiCadPcb(b, { nets: ['N1'] })).not.toContain('(segment');
    expect(exportKiCadPcb(b, { nets: ['N1'], keep: true })).toContain('(segment');
  });
});

describe('importKiCadRoutes', () => {
  const routed = `(kicad_pcb
\t(segment
\t\t(start 5.75 -5)
\t\t(end 8 -8)
\t\t(width 0.127)
\t\t(layer "F.Cu")
\t\t(net "N1")
\t\t(uuid "00000000-0000-4000-8000-000000000001")
\t)
\t(via
\t\t(at 8 -8)
\t\t(size 0.45)
\t\t(drill 0.2)
\t\t(layers "F.Cu" "B.Cu")
\t\t(net "N1")
\t\t(uuid "00000000-0000-4000-8000-000000000002")
\t)
)`;

  it('reads segments and vias back with y un-negated', () => {
    const { tracks, vias } = importKiCadRoutes(routed);
    expect(tracks).toEqual([{ layer: 'F.Cu', width: 0.127, net: 'N1', seg: { type: 'line', start: { x: 5.75, y: 5 }, end: { x: 8, y: 8 } } }]);
    expect(vias).toEqual([{ at: { x: 8, y: 8 }, diameter: 0.45, drill: 0.2, net: 'N1' }]);
  });

  it('accepts the extra via/segment attributes the router writes (capping, filling, locked)', () => {
    const text = `(kicad_pcb
\t(segment
\t\t(start 1 -1)
\t\t(end 2 -1)
\t\t(width 0.1)
\t\t(layer "B.Cu")
\t\t(locked yes)
\t\t(net "N1")
\t)
\t(via
\t\t(at 17.550000 -45.800000)
\t\t(size 0.25)
\t\t(drill 0.15)
\t\t(layers "F.Cu" "B.Cu")
\t\t(capping yes)
\t\t(filling yes)
\t\t(net "SDC_D2")
\t)
)`;
    const { tracks, vias } = importKiCadRoutes(text);
    expect(tracks).toHaveLength(1);
    expect(vias).toEqual([{ at: { x: 17.55, y: 45.8 }, diameter: 0.25, drill: 0.15, net: 'SDC_D2' }]);
  });

  it('refuses arc tracks instead of silently dropping them', () => {
    expect(() => importKiCadRoutes('(kicad_pcb\n\t(arc\n\t\t(start 0 0)\n\t)\n)')).toThrow(/arc/);
  });

  it('round-trips an exported board: re-importing its own copper reproduces it', () => {
    let b = tinyBoard();
    b = apply(b, {
      op: 'addTracks',
      tracks: [{ layer: 'B.Cu', width: 0.2, net: 'N1', seg: { type: 'line', start: { x: 1, y: 2 }, end: { x: 3, y: 4 } } }],
      vias: [{ at: { x: 3, y: 4 }, drill: 0.3, diameter: 0.6, net: 'N1' }],
    });
    const { tracks, vias } = importKiCadRoutes(exportKiCadPcb(b, { nets: ['N1'], keep: true }));
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ layer: 'B.Cu', width: 0.2, net: 'N1', seg: { start: { x: 1, y: 2 }, end: { x: 3, y: 4 } } });
    expect(vias).toEqual([{ at: { x: 3, y: 4 }, diameter: 0.6, drill: 0.3, net: 'N1' }]);
  });
});
