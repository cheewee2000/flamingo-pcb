/**
 * Flamingo UI - shared helpers for editing-tool overlays (Task 10).
 *
 * Small canvas-drawing primitives (in world space, translated to screen
 * space via `worldToScreen` per point -- the canvas 2D context itself is
 * never given a world-space transform, matching renderer.ts's approach) plus
 * a couple of small geometry helpers (rect-from-drag, snap-to-grid,
 * polygon-to-outline-segs) that more than one tool needs. Kept out of the
 * individual tool files to avoid copy-paste per the task-10 decisions.
 */

import type { PathSeg, Point } from '@flamingo/engine';
import type { AppState, ViewTransform } from '../state.js';
import { worldToScreen } from '../view.js';

// ---------------------------------------------------------------------------
// Grid snap
// ---------------------------------------------------------------------------

/** Snap `p` to the current grid (state.snapMm) if snap is enabled, else return `p` unchanged. */
export function snapPoint(p: Point, state: AppState): Point {
  if (!state.snapEnabled) return p;
  const g = state.snapMm;
  if (!(g > 0)) return p;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Two drag corners -> 4 rectangle corners (CCW-ish, matching engine outline winding), optionally forced square. */
export function rectCornersFromDrag(a: Point, b: Point, square: boolean): Point[] {
  let x1 = b.x;
  let y1 = b.y;
  if (square) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    x1 = a.x + Math.sign(dx || 1) * m;
    y1 = a.y + Math.sign(dy || 1) * m;
  }
  const minX = Math.min(a.x, x1);
  const maxX = Math.max(a.x, x1);
  const minY = Math.min(a.y, y1);
  const maxY = Math.max(a.y, y1);
  return [
    { x: maxX, y: minY },
    { x: minX, y: minY },
    { x: minX, y: maxY },
    { x: maxX, y: maxY },
  ];
}

/** Ordered vertex loop -> closed PathSeg[] of line segments (last point connects back to the first). */
export function closedPolygonToLineSegs(points: Point[]): PathSeg[] {
  const segs: PathSeg[] = [];
  for (let i = 0; i < points.length; i++) {
    segs.push({ type: 'line', start: points[i], end: points[(i + 1) % points.length] });
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Canvas drawing primitives (screen space via worldToScreen)
// ---------------------------------------------------------------------------

function tracePolygon(ctx: CanvasRenderingContext2D, view: ViewTransform, pts: Point[], close: boolean): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = worldToScreen(view, p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (close) ctx.closePath();
}

export function strokeOverlayPolygon(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  pts: Point[],
  color: string,
  widthPx = 1.5,
  close = true,
): void {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx;
  ctx.setLineDash([]);
  tracePolygon(ctx, view, pts, close);
  ctx.stroke();
  ctx.restore();
}

export function fillOverlayPolygon(ctx: CanvasRenderingContext2D, view: ViewTransform, pts: Point[], color: string, alpha = 0.35): void {
  if (pts.length < 3) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  tracePolygon(ctx, view, pts, true);
  ctx.fill();
  ctx.restore();
}

export function strokeOverlayLine(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  a: Point,
  b: Point,
  color: string,
  widthPx = 1.5,
  dash: number[] = [],
): void {
  const sa = worldToScreen(view, a);
  const sb = worldToScreen(view, b);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y);
  ctx.lineTo(sb.x, sb.y);
  ctx.stroke();
  ctx.restore();
}

export function drawOverlayDot(ctx: CanvasRenderingContext2D, view: ViewTransform, p: Point, color: string, radiusPx = 3): void {
  const s = worldToScreen(view, p);
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(s.x, s.y, radiusPx, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
}

export function drawOverlayLabel(ctx: CanvasRenderingContext2D, view: ViewTransform, at: Point, text: string, color = '#fff'): void {
  const s = worldToScreen(view, at);
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = '11px var(--mono, monospace)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(text, s.x + 6, s.y - 6);
  ctx.restore();
}

/** Draw an in-progress click-to-place polygon: committed points + dots + a dashed preview segment to the cursor. */
export function drawPolygonInProgress(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  points: Point[],
  cursorWorld: Point | null,
  color: string,
): void {
  if (points.length === 0) return;
  strokeOverlayPolygon(ctx, view, points, color, 1.5, false);
  if (cursorWorld) {
    strokeOverlayLine(ctx, view, points[points.length - 1], cursorWorld, color, 1, [4, 4]);
  }
  for (const p of points) drawOverlayDot(ctx, view, p, color, 3);
}
