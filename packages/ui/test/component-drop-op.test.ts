/**
 * Select-tool drag of components: the pure drop->op computation
 * (`componentDropOp`). Mirrors select-item-drag.test.ts's coverage of the
 * sibling `itemDropOp` -- direct calls, no pointer flow, no DOM.
 *
 * `componentDropOp` builds a `moveComponent`/`moveComponents` op for the
 * dragged component(s), and -- when any moved pad has a connected F.Cu/B.Cu
 * line track -- wraps it in a `transaction` with a `reshapeTracks` op that
 * removes the original track(s) and adds a 45°/octilinear replacement
 * ending at the moved pad's new world anchor (see reroute.ts `route45`).
 * With no connected tracks it returns the bare move op.
 */
import { describe, it, expect } from 'vitest';
import type { Board, Op, Point, Track } from '@flamingo/engine';
import { componentDropOp } from '../src/tools/select.js';

/** True if a→b is horizontal, vertical, or an exact 45° diagonal. */
function isOctilinear(a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);
}

// U1: at (0,0), pad '1' at local (2,0) -> world anchor (2,0), on net N1, with
// one F.Cu line track running from that pad out to (10,0). U2: at (20,0),
// pad '1' at local (0,0) -> world anchor (20,0), no connected track.
function makeBoard(): Board {
  return {
    copperLayers: 2,
    components: [
      {
        refdes: 'U1',
        lcsc: 'C1',
        at: { x: 0, y: 0 },
        rotation: 0,
        side: 'top',
        fields: {},
        footprint: {
          name: 'test1',
          lcsc: 'C1',
          pads: [{ number: '1', shape: 'rect', at: { x: 2, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' }],
          silk: [],
          courtyard: [],
        },
      },
      {
        refdes: 'U2',
        lcsc: 'C2',
        at: { x: 20, y: 0 },
        rotation: 0,
        side: 'top',
        fields: {},
        footprint: {
          name: 'test2',
          lcsc: 'C2',
          pads: [{ number: '1', shape: 'rect', at: { x: 0, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' }],
          silk: [],
          courtyard: [],
        },
      },
    ],
    tracks: [{ id: 't1', layer: 'F.Cu', width: 0.25, net: 'N1', seg: { type: 'line', start: { x: 2, y: 0 }, end: { x: 10, y: 0 } } }],
    vias: [],
    holes: [],
    silk: [],
    silkLines: [],
    dimensions: [],
    keepouts: [],
    zones: [],
    nets: [{ name: 'N1', class: 'default', pins: ['U1.1'] }],
  } as unknown as Board;
}

describe('componentDropOp', () => {
  it('a single component with a connected trace returns a transaction that rubber-bands the track', () => {
    const board = makeBoard();
    const delta: Point = { x: 5, y: 5 };
    const op = componentDropOp(board, [{ refdes: 'U1', startAt: { x: 0, y: 0 } }], delta);

    expect(op.op).toBe('transaction');
    const txOps = (op as Extract<Op, { op: 'transaction' }>).ops;
    expect(txOps).toHaveLength(2);

    expect(txOps[0]).toEqual({ op: 'moveComponent', refdes: 'U1', at: { x: 5, y: 5 } });

    const reshape = txOps[1] as Extract<Op, { op: 'reshapeTracks' }>;
    expect(reshape.op).toBe('reshapeTracks');
    expect(reshape.remove).toContain('t1');
    expect(reshape.add.length).toBeGreaterThan(0);

    // Moved pad anchor: local (2,0) + component delta (5,5) = (7,5).
    const movedAnchor: Point = { x: 7, y: 5 };
    for (const seg of reshape.add as Track[]) {
      expect(seg.seg.type).toBe('line');
      if (seg.seg.type !== 'line') continue;
      expect(isOctilinear(seg.seg.start, seg.seg.end)).toBe(true);
    }
    const lastSeg = reshape.add[reshape.add.length - 1].seg;
    expect(lastSeg.type).toBe('line');
    if (lastSeg.type === 'line') expect(lastSeg.end).toEqual(movedAnchor);
  });

  it('a component with no connected traces returns a bare moveComponent op', () => {
    const board = makeBoard();
    const op = componentDropOp(board, [{ refdes: 'U2', startAt: { x: 20, y: 0 } }], { x: 3, y: -2 });
    expect(op).toEqual({ op: 'moveComponent', refdes: 'U2', at: { x: 23, y: -2 } });
  });

  it('a zero delta on an untraced component still returns a bare moveComponent op', () => {
    const board = makeBoard();
    const op = componentDropOp(board, [{ refdes: 'U2', startAt: { x: 20, y: 0 } }], { x: 0, y: 0 });
    expect(op).toEqual({ op: 'moveComponent', refdes: 'U2', at: { x: 20, y: 0 } });
  });

  it('group drag of two components returns moveComponents, wrapped in a transaction when either has a trace', () => {
    const board = makeBoard();
    const delta: Point = { x: 5, y: 5 };
    const op = componentDropOp(
      board,
      [
        { refdes: 'U1', startAt: { x: 0, y: 0 } },
        { refdes: 'U2', startAt: { x: 20, y: 0 } },
      ],
      delta,
    );

    expect(op.op).toBe('transaction');
    const txOps = (op as Extract<Op, { op: 'transaction' }>).ops;
    const moveOp = txOps[0] as Extract<Op, { op: 'moveComponents' }>;
    expect(moveOp.op).toBe('moveComponents');
    const refdesInMoves = moveOp.moves.map((m) => m.refdes);
    expect(refdesInMoves).toContain('U1');
    expect(refdesInMoves).toContain('U2');
    expect(moveOp.moves).toEqual([
      { refdes: 'U1', at: { x: 5, y: 5 } },
      { refdes: 'U2', at: { x: 25, y: 5 } },
    ]);

    const reshape = txOps[1] as Extract<Op, { op: 'reshapeTracks' }>;
    expect(reshape.op).toBe('reshapeTracks');
    expect(reshape.remove).toContain('t1');
  });

  it('group drag with no connected traces on either component returns a bare moveComponents op', () => {
    const board = makeBoard();
    board.tracks = []; // strip U1's connected trace too
    const op = componentDropOp(
      board,
      [
        { refdes: 'U1', startAt: { x: 0, y: 0 } },
        { refdes: 'U2', startAt: { x: 20, y: 0 } },
      ],
      { x: 1, y: 1 },
    );
    expect(op).toEqual({
      op: 'moveComponents',
      moves: [
        { refdes: 'U1', at: { x: 1, y: 1 } },
        { refdes: 'U2', at: { x: 21, y: 1 } },
      ],
    });
  });
});
