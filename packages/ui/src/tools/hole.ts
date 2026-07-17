/**
 * Flamingo UI - mounting-hole tool.
 *
 * Click places a hole at the (snapped) cursor. Drill diameter and the
 * plated checkbox live in the toolbar's options row (default 2.2mm / M2,
 * unplated NPTH). Unplated: padDiameter === drill (no annular ring).
 * Plated: padDiameter = drill + 1.8mm, per the task-10 decision.
 */

import type { Point } from '@flamingo/engine';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';
import { drawOverlayDot } from './overlay-utils.js';

const HOLE_COLOR = '#eeeeee';
const PLATED_PAD_MARGIN_MM = 1.8;

export function createHoleTool(): Tool {
  let hoverWorld: Point | null = null;

  return {
    id: 'hole',
    label: 'Hole',
    shortcut: 'H',
    cursor: 'crosshair',

    onDeactivate(): void {
      hoverWorld = null;
    },

    onPointerMove(ev: PointerEvt): void {
      hoverWorld = ev.world;
    },

    onPointerDown(ev: PointerEvt, ctx: ToolCtx): void {
      const { holeDrillMm, holePlated } = ctx.getState().toolOptions;
      const padDiameter = holePlated ? holeDrillMm + PLATED_PAD_MARGIN_MM : holeDrillMm;
      ctx.sendOp({
        op: 'addHole',
        hole: { at: ev.world, drill: holeDrillMm, padDiameter, plated: holePlated },
      });
    },

    drawOverlay(ctx2d, view): void {
      if (!hoverWorld) return;
      drawOverlayDot(ctx2d, view, hoverWorld, HOLE_COLOR, 4);
    },
  };
}
