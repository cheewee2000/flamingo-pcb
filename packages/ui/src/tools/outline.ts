/**
 * Flamingo UI - outline tool.
 *
 * Two sub-modes, switched via `state.toolOptions.outlineMode` (toolbar
 * buttons in panels.ts): 'rect' (click-drag two corners, Shift = square) and
 * 'polygon' (click points, double-click or Enter closes). Either mode ends
 * by sending a single `setOutline` op -- cornerRadius/arcs are not
 * generated here (rect mode is 4 straight line segs; polygon mode
 * closed-polygon-to-line-segs).
 */

import type { Point } from '@flamingo/engine';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';
import { closedPolygonToLineSegs, drawPolygonInProgress, rectCornersFromDrag, strokeOverlayPolygon } from './overlay-utils.js';

const OUTLINE_COLOR = '#ffcc66';

export function createOutlineTool(): Tool {
  let dragStart: Point | null = null;
  let dragCurrent: Point | null = null;
  let dragSquare = false;
  let polyPoints: Point[] = [];
  let cursorWorld: Point | null = null;

  function reset(): void {
    dragStart = null;
    dragCurrent = null;
    dragSquare = false;
    polyPoints = [];
    cursorWorld = null;
  }

  function closePolygon(ctx: ToolCtx): void {
    if (polyPoints.length < 3) return;
    ctx.sendOp({ op: 'setOutline', outline: closedPolygonToLineSegs(polyPoints) });
    polyPoints = [];
  }

  return {
    id: 'outline',
    label: 'Outline',
    shortcut: 'O',
    cursor: 'crosshair',

    onDeactivate(): void {
      reset();
    },

    onPointerDown(ev: PointerEvt, ctx: ToolCtx): void {
      const mode = ctx.getState().toolOptions.outlineMode;
      if (mode === 'rect') {
        dragStart = ev.world;
        dragCurrent = ev.world;
        dragSquare = ev.shift;
      } else {
        polyPoints.push(ev.world);
      }
    },

    onPointerMove(ev: PointerEvt): void {
      cursorWorld = ev.world;
      if (dragStart) {
        dragCurrent = ev.world;
        dragSquare = ev.shift;
      }
    },

    onPointerUp(ev: PointerEvt, ctx: ToolCtx): void {
      if (dragStart) {
        const corners = rectCornersFromDrag(dragStart, ev.world, ev.shift);
        ctx.sendOp({ op: 'setOutline', outline: closedPolygonToLineSegs(corners) });
        dragStart = null;
        dragCurrent = null;
      }
    },

    onDoubleClick(_ev: PointerEvt, ctx: ToolCtx): void {
      if (ctx.getState().toolOptions.outlineMode !== 'polygon') return;
      polyPoints.pop(); // drop the point the second mousedown of the dblclick already added
      closePolygon(ctx);
    },

    onKey(ev: KeyboardEvent, ctx: ToolCtx): boolean {
      if (ev.code === 'Enter' && ctx.getState().toolOptions.outlineMode === 'polygon') {
        closePolygon(ctx);
        return true;
      }
      return false;
    },

    drawOverlay(ctx2d, view, state): void {
      if (state.toolOptions.outlineMode === 'rect') {
        if (dragStart && dragCurrent) {
          strokeOverlayPolygon(ctx2d, view, rectCornersFromDrag(dragStart, dragCurrent, dragSquare), OUTLINE_COLOR, 1.5, true);
        }
      } else {
        drawPolygonInProgress(ctx2d, view, polyPoints, cursorWorld, OUTLINE_COLOR);
      }
    },
  };
}
