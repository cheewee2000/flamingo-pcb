/**
 * Select-tool drag of standalone silk text and mounting holes.
 *
 * Covers the pure drop->op computation (`itemDropOp`) plus the tool's
 * pointer flow driven directly through the `Tool` interface with a stubbed
 * `ToolCtx` (the UI suite runs in node, no DOM needed for pointer handlers):
 * a drag past the 4px threshold sends exactly one `editSilkText` / `editHole`
 * op with the new `at`; a click below the threshold sends nothing and
 * preserves the existing click-select behavior.
 */
import { describe, it, expect } from 'vitest';
import type { Board, Op, Point } from '@flamingo/engine';
import { createSelectTool, itemDropOp } from '../src/tools/select.js';
import type { PointerEvt, ToolCtx } from '../src/tools/tool.js';
import type { AppState } from '../src/state.js';

// ---------------------------------------------------------------------------
// itemDropOp (pure)
// ---------------------------------------------------------------------------

describe('itemDropOp', () => {
  it('builds an editSilkText op at startAt + delta', () => {
    const op = itemDropOp({ kind: 'silk', id: 'silk-1', startAt: { x: 5, y: 5 } }, { x: 2, y: 3 });
    expect(op).toEqual({ op: 'editSilkText', id: 'silk-1', text: { at: { x: 7, y: 8 } } });
  });

  it('builds an editHole op at startAt + delta', () => {
    const op = itemDropOp({ kind: 'hole', id: 'hole-1', startAt: { x: 20, y: 10 } }, { x: -1.5, y: 0.5 });
    expect(op).toEqual({ op: 'editHole', id: 'hole-1', hole: { at: { x: 18.5, y: 10.5 } } });
  });

  it('a zero delta returns the start position unchanged', () => {
    const op = itemDropOp({ kind: 'silk', id: 's', startAt: { x: 1.25, y: -4 } }, { x: 0, y: 0 });
    expect(op).toEqual({ op: 'editSilkText', id: 's', text: { at: { x: 1.25, y: -4 } } });
  });
});

// ---------------------------------------------------------------------------
// Tool pointer flow
// ---------------------------------------------------------------------------

function makeBoard(): Board {
  return {
    components: [],
    tracks: [],
    vias: [],
    holes: [{ id: 'hole-1', at: { x: 20, y: 10 }, drill: 2.2, padDiameter: 4, plated: true }],
    silk: [{ id: 'silk-1', layer: 'F.Silk', at: { x: 5, y: 5 }, text: 'hello', height: 1, rotation: 0 }],
    dimensions: [],
    keepouts: [],
    zones: [],
    nets: [],
  } as unknown as Board;
}

function makeCtx(): { ctx: ToolCtx; ops: Op[]; state: AppState } {
  const state = {
    board: makeBoard(),
    view: { scale: 10, originPxX: 0, originPxY: 0, flipped: false },
    selection: null,
    multiSelection: [],
    selectedNet: null,
    snapEnabled: false,
    snapMm: 0.5,
  } as unknown as AppState;
  const ops: Op[] = [];
  const ctx: ToolCtx = {
    sendOp: (op) => ops.push(op),
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    viewportEl: null as unknown as HTMLElement,
  };
  return { ctx, ops, state };
}

/** Pointer event at world mm `w`; screen px derived at the test's 10 px/mm scale. */
function evt(w: Point): PointerEvt {
  return {
    world: w,
    worldRaw: w,
    screen: { x: w.x * 10, y: w.y * 10 },
    button: 0,
    shift: false,
    alt: false,
    ctrlOrCmd: false,
  };
}

describe('select tool - silk/hole drag', () => {
  it('dragging a silk text past the threshold sends one editSilkText op and selects it', () => {
    const { ctx, ops, state } = makeCtx();
    const tool = createSelectTool();
    tool.onPointerDown!(evt({ x: 5, y: 5 }), ctx);
    tool.onPointerMove!(evt({ x: 7, y: 8 }), ctx);
    tool.onPointerUp!(evt({ x: 7, y: 8 }), ctx);
    expect(ops).toEqual([{ op: 'editSilkText', id: 'silk-1', text: { at: { x: 7, y: 8 } } }]);
    expect(state.selection).toEqual({ kind: 'silk', id: 'silk-1' });
  });

  it('dragging a hole past the threshold sends one editHole op and selects it', () => {
    const { ctx, ops, state } = makeCtx();
    const tool = createSelectTool();
    tool.onPointerDown!(evt({ x: 20, y: 10 }), ctx);
    tool.onPointerMove!(evt({ x: 22, y: 13 }), ctx);
    tool.onPointerUp!(evt({ x: 22, y: 13 }), ctx);
    expect(ops).toEqual([{ op: 'editHole', id: 'hole-1', hole: { at: { x: 22, y: 13 } } }]);
    expect(state.selection).toEqual({ kind: 'hole', id: 'hole-1' });
  });

  it('a click below the threshold sends no op and click-selects the silk item', () => {
    const { ctx, ops, state } = makeCtx();
    const tool = createSelectTool();
    tool.onPointerDown!(evt({ x: 5, y: 5 }), ctx);
    tool.onPointerUp!(evt({ x: 5.1, y: 5 }), ctx); // 1px on screen -- below the 4px threshold
    expect(ops).toEqual([]);
    expect(state.selection).toEqual({ kind: 'silk', id: 'silk-1' });
    expect(state.multiSelection).toEqual([]);
  });

  it('a drag from empty space still sweeps a marquee (no item ops)', () => {
    const { ctx, ops, state } = makeCtx();
    const tool = createSelectTool();
    tool.onPointerDown!(evt({ x: 40, y: 40 }), ctx);
    tool.onPointerMove!(evt({ x: 50, y: 50 }), ctx);
    tool.onPointerUp!(evt({ x: 50, y: 50 }), ctx);
    expect(ops).toEqual([]);
    expect(state.multiSelection).toEqual([]);
    expect(state.selection).toBeNull();
  });
});
