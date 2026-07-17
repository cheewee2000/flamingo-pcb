import { describe, it, expect } from 'vitest';
import { applyOp, newBoard } from '@flamingo/engine';
import type { Board, Footprint, Op, PathSeg } from '@flamingo/engine';
import { exportDSN } from '../src/dsn.js';

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

const RECT_OUTLINE: PathSeg[] = [
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

/** A tiny 2-resistor board: R1, R2 (shared R0603 footprint), one net N1. */
function tinyBoard(): Board {
  let b = newBoard('t', 2);
  b = apply(b, { op: 'setOutline', outline: RECT_OUTLINE });
  b = apply(b, {
    op: 'placeComponent',
    refdes: 'R1',
    lcsc: 'C25804',
    footprint: R0603,
    at: { x: 5, y: 5 },
    rotation: 0,
    side: 'top',
    fields: {},
  });
  b = apply(b, {
    op: 'placeComponent',
    refdes: 'R2',
    lcsc: 'C25804',
    footprint: R0603,
    at: { x: 10, y: 5 },
    rotation: 0,
    side: 'top',
    fields: {},
  });
  b = apply(b, { op: 'connectPins', net: 'N1', pins: ['R1.2', 'R2.1'] });
  return b;
}

const GOLDEN = `(pcb t
  (parser
    (string_quote ")
    (space_in_quoted_tokens on)
    (host_cad flamingo)
    (host_version 0.1.0)
  )
  (resolution um 1)
  (unit um)
  (structure
    (layer F.Cu (type signal))
    (layer B.Cu (type signal))
    (boundary (path pcb 0 0 0 20000 0 20000 15000 0 15000 0 0))
    (via V_300_600)
    (rule (width 250) (clearance 200))
  )
  (placement
    (component R0603
      (place R1 5000 5000 front 0)
      (place R2 10000 5000 front 0)
    )
  )
  (library
    (image R0603
      (pin rect_800x900_F 1 -750 0)
      (pin rect_800x900_F 2 750 0)
    )
    (padstack rect_800x900_F (shape (rect F.Cu -400 -450 400 450)) (attach off))
    (padstack V_300_600 (shape (circle F.Cu 600)) (shape (circle B.Cu 600)) (attach off))
  )
  (network
    (net N1 (pins R1-2 R2-1))
    (class default N1 (circuit (use_via V_300_600)) (rule (width 250) (clearance 200)))
  )
)
`;

describe('exportDSN', () => {
  it('produces the exact golden DSN for a tiny 2-part board', () => {
    expect(exportDSN(tinyBoard())).toBe(GOLDEN);
  });

  it('dedupes identical pad geometry into a single padstack', () => {
    const dsn = exportDSN(tinyBoard());
    const matches = dsn.match(/\(padstack rect_800x900_F /g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('emits (side back) as `back` for bottom-side components', () => {
    let b = tinyBoard();
    b = apply(b, { op: 'moveComponent', refdes: 'R2', side: 'bottom' });
    const dsn = exportDSN(b);
    expect(dsn).toContain('(place R2 10000 5000 back 0)');
    expect(dsn).toContain('(place R1 5000 5000 front 0)');
  });

  it('subsetting: only routed nets in (network); others become protect wiring', () => {
    let b = tinyBoard();
    b = apply(b, { op: 'connectPins', net: 'N2', pins: ['R1.1', 'R2.2'] });
    // Give N2 an existing track so it must be emitted as a protect obstacle.
    b = apply(b, {
      op: 'addTrack',
      track: {
        layer: 'F.Cu',
        width: 0.25,
        net: 'N2',
        seg: { type: 'line', start: { x: 4.25, y: 5 }, end: { x: 10.75, y: 5 } },
      },
    });

    const dsn = exportDSN(b, { nets: ['N1'] });
    expect(dsn).toContain('(net N1 (pins R1-2 R2-1))');
    expect(dsn).not.toContain('(net N2 (pins');
    expect(dsn).toContain('(wiring');
    expect(dsn).toContain(
      '(wire (path F.Cu 250 4250 5000 10750 5000) (net N2) (type protect))',
    );
  });

  it('bakes pad rotation (mod 180 != 0) into a polygon padstack', () => {
    const fp: Footprint = {
      name: 'ROT',
      lcsc: 'X',
      pads: [
        { number: '1', shape: 'rect', at: { x: 0, y: 0 }, rotation: 90, size: { w: 1.0, h: 0.5 }, layer: 'top' },
      ],
      silk: [],
      courtyard: [],
    };
    let b = newBoard('r', 2);
    b = apply(b, {
      op: 'placeComponent',
      refdes: 'U1',
      lcsc: 'X',
      footprint: fp,
      at: { x: 5, y: 5 },
      rotation: 0,
      side: 'top',
      fields: {},
    });
    const dsn = exportDSN(b);
    expect(dsn).toMatch(/\(padstack poly_[0-9a-f]{8}_F \(shape \(polygon F\.Cu 0 /);
  });
});
