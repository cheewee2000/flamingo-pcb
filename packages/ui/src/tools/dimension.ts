/**
 * Flamingo UI - dimension tool.
 *
 * Three clicks place a persistent linear dimension: first the two measured
 * points, then a third click sets which side the dimension line sits on and
 * how far out (the signed perpendicular offset). Commits an `addDimension`
 * op; dimensions are documentation only and never affect DRC or fab
 * exports. Points snap like every other tool (Ctrl/Cmd bypasses).
 */

import type { Point } from '@flamingo/engine';
import { dist } from '@flamingo/engine';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';
import { drawDimension } from '../renderer.js';
import { drawOverlayDot, drawOverlayLabel, strokeOverlayLine } from './overlay-utils.js';

const PREVIEW_COLOR = '#4dff88';

/** Signed perpendicular distance of `p` from the (a → b) line: left of a→b is positive. */
function perpOffset(a: Point, b: Point, p: Point): number {
  const len = dist(a, b);
  if (len < 1e-6) return 0;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  return ux * (p.y - a.y) - uy * (p.x - a.x);
}

export function createDimensionTool(): Tool {
  let a: Point | null = null;
  let b: Point | null = null;
  let cursor: Point | null = null;

  function reset(): void {
    a = null;
    b = null;
    cursor = null;
  }

  return {
    id: 'dimension',
    label: 'Dimension',
    shortcut: 'D',
    cursor: 'crosshair',

    onDeactivate(): void {
      reset();
    },

    onPointerDown(ev: PointerEvt, ctx: ToolCtx): void {
      if (!a) {
        a = ev.world;
        return;
      }
      if (!b) {
        if (dist(a, ev.world) > 1e-6) b = ev.world;
        return;
      }
      ctx.sendOp({ op: 'addDimension', dimension: { a, b, offset: perpOffset(a, b, ev.world) } });
      reset();
    },

    onPointerMove(ev: PointerEvt): void {
      cursor = ev.world;
    },

    drawOverlay(ctx2d, view): void {
      if (!a || !cursor) return;
      if (!b) {
        strokeOverlayLine(ctx2d, view, a, cursor, PREVIEW_COLOR, 1.5, [6, 4]);
        drawOverlayDot(ctx2d, view, a, PREVIEW_COLOR, 3);
        const mid = { x: (a.x + cursor.x) / 2, y: (a.y + cursor.y) / 2 };
        drawOverlayLabel(ctx2d, view, mid, `${dist(a, cursor).toFixed(2)} mm`, PREVIEW_COLOR);
        return;
      }
      drawDimension(ctx2d, view, a, b, perpOffset(a, b, cursor), PREVIEW_COLOR);
    },
  };
}
