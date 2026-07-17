/**
 * Flamingo UI - zone (copper pour) tool.
 *
 * Click points to build a polygon; double-click or Enter closes it and
 * sends `addZone` on the layer/net picked in the toolbar's options row
 * (panels.ts writes those into `state.toolOptions`). clearance/minWidth/
 * thermal are fixed per the task-10 decision. If no net is available/picked
 * yet, closing silently discards the polygon rather than sending an invalid
 * op -- the server would reject an empty net name anyway.
 */

import type { Point } from '@flamingo/engine';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';
import { drawPolygonInProgress } from './overlay-utils.js';

const ZONE_COLOR = '#66ccff';

export function createZoneTool(): Tool {
  let points: Point[] = [];
  let cursorWorld: Point | null = null;

  function reset(): void {
    points = [];
    cursorWorld = null;
  }

  function close(ctx: ToolCtx): void {
    if (points.length < 3) return;
    const { zoneLayer, zoneNet } = ctx.getState().toolOptions;
    if (zoneNet) {
      ctx.sendOp({
        op: 'addZone',
        zone: {
          layer: zoneLayer,
          net: zoneNet,
          polygon: points,
          clearance: 0.3,
          minWidth: 0.2,
          thermal: { gap: 0.5, spokeWidth: 0.5 },
        },
      });
    }
    points = [];
  }

  return {
    id: 'zone',
    label: 'Zone',
    shortcut: 'Z',
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
      drawPolygonInProgress(ctx2d, view, points, cursorWorld, ZONE_COLOR);
    },
  };
}
