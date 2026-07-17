/**
 * Flamingo UI - measure tool.
 *
 * Click-drag a ruler between two world points; drawOverlay shows the line
 * plus a live mm readout, and `state.measureMm` is kept in sync so the
 * status bar (panels.ts) and the toolbar's options row can show the same
 * number. No ops are ever sent -- this tool is read-only. Esc (global,
 * routed through onDeactivate) clears the ruler.
 */

import type { Point } from '@flamingo/engine';
import { dist } from '@flamingo/engine';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';
import { drawOverlayDot, drawOverlayLabel, strokeOverlayLine } from './overlay-utils.js';

const MEASURE_COLOR = '#4dff88';

export function createMeasureTool(): Tool {
  let start: Point | null = null;
  let current: Point | null = null;
  let dragging = false;

  function reset(ctx: ToolCtx): void {
    start = null;
    current = null;
    dragging = false;
    ctx.setState({ measureMm: null });
  }

  return {
    id: 'measure',
    label: 'Measure',
    shortcut: 'M',
    cursor: 'crosshair',

    onDeactivate(ctx: ToolCtx): void {
      reset(ctx);
    },

    onPointerDown(ev: PointerEvt): void {
      start = ev.world;
      current = ev.world;
      dragging = true;
    },

    onPointerMove(ev: PointerEvt, ctx: ToolCtx): void {
      if (!dragging || !start) return;
      current = ev.world;
      ctx.setState({ measureMm: dist(start, current) });
    },

    onPointerUp(ev: PointerEvt): void {
      dragging = false;
      current = ev.world;
    },

    drawOverlay(ctx2d, view): void {
      if (!start || !current) return;
      strokeOverlayLine(ctx2d, view, start, current, MEASURE_COLOR, 1.5, [6, 4]);
      drawOverlayDot(ctx2d, view, start, MEASURE_COLOR, 3);
      drawOverlayDot(ctx2d, view, current, MEASURE_COLOR, 3);
      const mid = { x: (start.x + current.x) / 2, y: (start.y + current.y) / 2 };
      drawOverlayLabel(ctx2d, view, mid, `${dist(start, current).toFixed(2)} mm`, MEASURE_COLOR);
    },
  };
}
