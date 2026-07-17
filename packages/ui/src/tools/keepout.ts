/**
 * Flamingo UI - keepout tool.
 *
 * Click points to build a polygon; double-click or Enter closes it and
 * sends `addKeepout` with layers 'all' and copper+via keepout both true
 * (fixed per the task-10 decision -- no toolbar options for this tool).
 */

import type { Point } from '@flamingo/engine';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';
import { drawPolygonInProgress } from './overlay-utils.js';

const KEEPOUT_COLOR = '#ff8800';

export function createKeepoutTool(): Tool {
  let points: Point[] = [];
  let cursorWorld: Point | null = null;

  function reset(): void {
    points = [];
    cursorWorld = null;
  }

  function close(ctx: ToolCtx): void {
    if (points.length < 3) return;
    ctx.sendOp({
      op: 'addKeepout',
      keepout: { layers: 'all', polygon: points, keepout: { copper: true, via: true } },
    });
    points = [];
  }

  return {
    id: 'keepout',
    label: 'Keepout',
    shortcut: 'K',
    cursor: 'crosshair',

    onDeactivate(): void {
      reset();
    },

    onPointerDown(ev: PointerEvt): void {
      points.push(ev.world);
    },

    onPointerMove(ev: PointerEvt): void {
      cursorWorld = ev.world;
    },

    onDoubleClick(_ev: PointerEvt, ctx: ToolCtx): void {
      points.pop();
      close(ctx);
    },

    onKey(ev: KeyboardEvent, ctx: ToolCtx): boolean {
      if (ev.code === 'Enter') {
        close(ctx);
        return true;
      }
      return false;
    },

    drawOverlay(ctx2d, view): void {
      drawPolygonInProgress(ctx2d, view, points, cursorWorld, KEEPOUT_COLOR);
    },
  };
}
