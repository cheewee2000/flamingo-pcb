/**
 * Track tool pointer flow, driven directly through the `Tool` interface with a
 * stubbed `ToolCtx` (the UI suite runs in node, no DOM needed for the pointer/
 * key handlers). Covers: a first click on bare board starts nothing; a route
 * started on copper, carried across an `l` layer switch, and finished on a
 * same-net via commits exactly one `addTracks` op whose segments carry their
 * drawn layer and whose single via sits at the switch vertex; and Enter commits
 * a plain two-point route with no vias.
 */
import { describe, it, expect } from 'vitest';
import type { Board, Op, Point } from '@flamingo/engine';
import { createTrackTool } from '../src/tools/track.js';
import type { PointerEvt, ToolCtx } from '../src/tools/tool.js';
import type { AppState } from '../src/state.js';

// Two vias on NET1 give hitTest copper to start/finish on without building
// footprints; the default net class supplies width + via sizes.
function makeBoard(): Board {
  return {
    components: [],
    tracks: [],
    vias: [
      { id: 'v-a', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NET1' },
      { id: 'v-b', at: { x: 5, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NET1' },
    ],
    holes: [],
    silk: [],
    silkLines: [],
    dimensions: [],
    keepouts: [],
    zones: [],
    nets: [{ name: 'NET1', class: 'default', pins: [] }],
    netClasses: [{ name: 'default', trackWidth: 0.3, clearance: 0.2, viaDrill: 0.3, viaDiameter: 0.6 }],
    copperLayers: 2,
  } as unknown as Board;
}

function makeCtx(): { ctx: ToolCtx; ops: Op[]; state: AppState } {
  const state = {
    board: makeBoard(),
    view: { scale: 10, originPxX: 0, originPxY: 0, flipped: false },
    snapEnabled: false,
    snapMm: 0.5,
    toolOptions: { trackLayer: 'F.Cu' },
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

function evt(w: Point): PointerEvt {
  return { world: w, worldRaw: w, screen: { x: w.x * 10, y: w.y * 10 }, button: 0, shift: false, alt: false, ctrlOrCmd: false };
}

const key = (code: string): KeyboardEvent => ({ code }) as KeyboardEvent;

describe('track tool', () => {
  it('a first click on bare board starts no route and sends nothing', () => {
    const { ctx, ops } = makeCtx();
    const tool = createTrackTool();
    tool.onActivate!(ctx);
    tool.onPointerDown!(evt({ x: 2, y: 2 }), ctx); // nowhere near a via
    tool.onKey!(key('Enter'), ctx);
    expect(ops).toEqual([]);
  });

  it('commits one addTracks op with per-segment layers and a via at the layer switch', () => {
    const { ctx, ops } = makeCtx();
    const tool = createTrackTool();
    tool.onActivate!(ctx);
    tool.onPointerDown!(evt({ x: 0, y: 0 }), ctx); // start on via v-a (NET1)
    tool.onPointerDown!(evt({ x: 3, y: 0 }), ctx); // bare vertex, segment on F.Cu
    tool.onKey!(key('KeyL'), ctx); // switch to B.Cu, via at the last vertex
    tool.onPointerDown!(evt({ x: 5, y: 0 }), ctx); // finish on via v-b (same net) -> auto-commit

    expect(ops).toEqual([
      {
        op: 'addTracks',
        tracks: [
          { layer: 'F.Cu', width: 0.3, net: 'NET1', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 3, y: 0 } } },
          { layer: 'B.Cu', width: 0.3, net: 'NET1', seg: { type: 'line', start: { x: 3, y: 0 }, end: { x: 5, y: 0 } } },
        ],
        vias: [{ at: { x: 3, y: 0 }, net: 'NET1', drill: 0.3, diameter: 0.6 }],
      },
    ]);
  });

  it('Enter commits a plain two-point route with no vias', () => {
    const { ctx, ops } = makeCtx();
    const tool = createTrackTool();
    tool.onActivate!(ctx);
    tool.onPointerDown!(evt({ x: 0, y: 0 }), ctx);
    tool.onPointerDown!(evt({ x: 4, y: 0 }), ctx);
    tool.onKey!(key('Enter'), ctx);

    expect(ops).toEqual([
      {
        op: 'addTracks',
        tracks: [{ layer: 'F.Cu', width: 0.3, net: 'NET1', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 4, y: 0 } } }],
        vias: [],
      },
    ]);
  });

  it('discards the in-progress route on deactivate (tool switch / Escape)', () => {
    const { ctx, ops } = makeCtx();
    const tool = createTrackTool();
    tool.onActivate!(ctx);
    tool.onPointerDown!(evt({ x: 0, y: 0 }), ctx);
    tool.onPointerDown!(evt({ x: 4, y: 0 }), ctx);
    tool.onDeactivate!(ctx);
    tool.onKey!(key('Enter'), ctx); // nothing left to commit
    expect(ops).toEqual([]);
  });
});
