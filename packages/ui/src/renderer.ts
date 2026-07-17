/**
 * Flamingo UI - canvas 2D renderer.
 *
 * `draw()` is a pure function: board + AppState in, pixels out via a
 * CanvasRenderingContext2D. `createRenderer()` owns the canvas element,
 * device-pixel-ratio sizing, and a rAF-scheduled-when-dirty redraw loop --
 * it subscribes to the store and marks itself dirty on every change rather
 * than drawing synchronously, so bursts of state updates (e.g. a mouse-move
 * flood while panning) collapse into one paint per frame.
 *
 * Coordinates: engine/world space is mm, y-up. Canvas space is px, y-down.
 * `view.ts`'s `worldToScreen` folds in the y-down "flip" (a sense-preserving
 * relabeling, not a mirror -- see its header) plus the optional X mirror for
 * bottom-view. Because that's a relabeling and not a real mirror, arc sweep
 * direction and rotation angles pass through *unchanged* from world to
 * screen in the unflipped case; only `view.flipped` (a genuine mirror) flips
 * rotational sense. See `arcParams` below.
 */

import type {
  Board,
  ComponentInst,
  Keepout,
  LayerId,
  Pad,
  PathSeg,
  Point,
  SilkItem,
  Track,
} from '@flamingo/engine';
// Value imports deliberately bypass the '@flamingo/engine' barrel (index.ts)
// and go straight at the submodules that hold them. The barrel also
// re-exports applyOp from ops.ts, which imports 'node:crypto' -- fine in
// Node (the server), but Vite's browser build chokes trying to resolve that
// through its node-builtin-external stub even though nothing here ever
// calls applyOp. geometry.js/layers.js/connectivity.js never touch ops.js,
// so importing them directly keeps the UI bundle browser-clean.
import { componentTransformPoints, componentTransformRotation, padOutline, outlineToPolygon } from '@flamingo/engine/dist/geometry.js';
import { copperLayersOf } from '@flamingo/engine/dist/layers.js';
import type { AppState, ViewTransform } from './state.js';
import { RATSNEST_KEY, SILK_KEY } from './state.js';
import { screenToWorld, worldToScreen } from './view.js';

// ---------------------------------------------------------------------------
// Color table -- COPIED from packages/engine/src/render.ts (binding table).
// Keep these two lists in sync by hand; canvas draws differently from SVG,
// but the palette must match. Do not rename/retint casually.
// ---------------------------------------------------------------------------
const COPPER_COLOR: Partial<Record<LayerId, string>> = {
  'F.Cu': '#C83434',
  'In1.Cu': '#7FC87F',
  'In2.Cu': '#CE7D2C',
  'In3.Cu': '#9C6BC8',
  'In4.Cu': '#C8B96B',
  'B.Cu': '#4D7FC4',
};
const SILK_COLOR: Record<'F.Silk' | 'B.Silk', string> = {
  'F.Silk': '#F2EDA1',
  'B.Silk': '#E8B2A7',
};
const EDGE_COLOR = '#D0D2CD';
const THROUGH_PAD_COLOR = '#B8B85A';
const HOLE_COLOR = '#222';
const RATSNEST_COLOR = '#ffffff66';
const HIGHLIGHT_COLOR = '#00FFFF';
const DRC_COLOR = '#FF0000';
const KEEPOUT_COLOR = '#FF6600';
const HOVER_COLOR = '#ffffffcc';
const BACKGROUND = '#1a1a1a';

const REFDES_HEIGHT_MM = 1.0;

// ---------------------------------------------------------------------------
// Small path/shape helpers
// ---------------------------------------------------------------------------

function pathPolygon(ctx: CanvasRenderingContext2D, view: ViewTransform, pts: Point[]): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = worldToScreen(view, p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
}

function fillPolygon(ctx: CanvasRenderingContext2D, view: ViewTransform, pts: Point[], color: string, alpha = 1): void {
  if (pts.length < 3) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  pathPolygon(ctx, view, pts);
  ctx.fill();
  ctx.restore();
}

function strokePolygon(ctx: CanvasRenderingContext2D, view: ViewTransform, pts: Point[], color: string, widthMm: number): void {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(widthMm * view.scale, 0.5);
  pathPolygon(ctx, view, pts);
  ctx.stroke();
  ctx.restore();
}

function fillCircle(ctx: CanvasRenderingContext2D, view: ViewTransform, center: Point, radiusMm: number, color: string): void {
  const s = worldToScreen(view, center);
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(s.x, s.y, Math.max(radiusMm * view.scale, 0.4), 0, 2 * Math.PI);
  ctx.fill();
}

function strokeCircle(ctx: CanvasRenderingContext2D, view: ViewTransform, center: Point, radiusMm: number, color: string, widthMm: number): void {
  const s = worldToScreen(view, center);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(widthMm * view.scale, 0.5);
  ctx.beginPath();
  ctx.arc(s.x, s.y, Math.max(radiusMm * view.scale, 0.4), 0, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

/**
 * Screen-space center/radius/angles/direction for drawing a world-space
 * circular arc with `ctx.arc`. `worldCw` must already account for any
 * component-mirror (bottom-side footprints negate their local cw, same as
 * engine/render.ts's `effectiveCw`); `view.flipped` (a real mirror, unlike
 * the constant y "flip") is folded in here.
 */
function arcParams(view: ViewTransform, start: Point, end: Point, center: Point, worldCw: boolean) {
  const s = worldToScreen(view, start);
  const e = worldToScreen(view, end);
  const c = worldToScreen(view, center);
  const r = view.scale * Math.hypot(start.x - center.x, start.y - center.y);
  const startAngle = Math.atan2(s.y - c.y, s.x - c.x);
  const endAngle = Math.atan2(e.y - c.y, e.x - c.x);
  const ccw = view.flipped ? worldCw : !worldCw;
  return { cx: c.x, cy: c.y, r, startAngle, endAngle, ccw };
}

function pathSeg(ctx: CanvasRenderingContext2D, view: ViewTransform, seg: PathSeg): void {
  ctx.beginPath();
  if (seg.type === 'line') {
    const s = worldToScreen(view, seg.start);
    const e = worldToScreen(view, seg.end);
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
  } else {
    const { cx, cy, r, startAngle, endAngle, ccw } = arcParams(view, seg.start, seg.end, seg.center, seg.cw);
    ctx.arc(cx, cy, r, startAngle, endAngle, ccw);
  }
}

function strokeTrack(ctx: CanvasRenderingContext2D, view: ViewTransform, t: Track, color: string, extraWidthMm = 0): void {
  pathSeg(ctx, view, t.seg);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max((t.width + extraWidthMm) * view.scale, 0.6);
  ctx.stroke();
}

/** Draw text so it reads correctly under the current view flip: measure the
 * on-screen direction of the world rotation by transforming two points,
 * rather than hand-deriving a sign convention. */
function drawRotatedText(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  at: Point,
  worldRotDeg: number,
  text: string,
  heightMm: number,
  color: string,
): void {
  const rad = (worldRotDeg * Math.PI) / 180;
  const dirWorld = { x: at.x + Math.cos(rad), y: at.y + Math.sin(rad) };
  const p = worldToScreen(view, at);
  const pd = worldToScreen(view, dirWorld);
  const angle = Math.atan2(pd.y - p.y, pd.x - p.x);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.font = `${Math.max(heightMm * view.scale, 6)}px var(--mono, monospace)`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function silkColorFor(side: 'top' | 'bottom'): string {
  return side === 'top' ? SILK_COLOR['F.Silk'] : SILK_COLOR['B.Silk'];
}

function drawFootprintSilkItem(ctx: CanvasRenderingContext2D, view: ViewTransform, c: ComponentInst, item: SilkItem, color: string): void {
  const mirror = c.side === 'bottom';
  switch (item.kind) {
    case 'line': {
      const [ws, we] = componentTransformPoints(c, [item.start, item.end]);
      ctx.beginPath();
      const s = worldToScreen(view, ws);
      const e = worldToScreen(view, we);
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(item.width * view.scale, 0.5);
      ctx.stroke();
      break;
    }
    case 'arc': {
      const [ws, we, wc] = componentTransformPoints(c, [item.start, item.end, item.center]);
      const worldCw = mirror ? !item.cw : item.cw;
      const { cx, cy, r, startAngle, endAngle, ccw } = arcParams(view, ws, we, wc, worldCw);
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, endAngle, ccw);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(item.width * view.scale, 0.5);
      ctx.stroke();
      break;
    }
    case 'circle': {
      const [wc] = componentTransformPoints(c, [item.center]);
      strokeCircle(ctx, view, wc, item.radius, color, item.width);
      break;
    }
    case 'text': {
      const [wat] = componentTransformPoints(c, [item.at]);
      const worldRot = componentTransformRotation(c, item.rotation);
      drawRotatedText(ctx, view, wat, worldRot, item.text, item.height, color);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

const GRID_COLOR = 'rgba(255,255,255,0.16)';
const MIN_GRID_SPACING_PX = 8;

function drawGrid(ctx: CanvasRenderingContext2D, view: ViewTransform, widthPx: number, heightPx: number): void {
  const spacingMm = view.scale > 40 ? 0.1 : 1;
  const spacingPx = spacingMm * view.scale;
  if (spacingPx < MIN_GRID_SPACING_PX) return;

  const a = screenToWorld(view, { x: 0, y: 0 });
  const b = screenToWorld(view, { x: widthPx, y: heightPx });
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);

  const startX = Math.floor(minX / spacingMm) * spacingMm;
  const startY = Math.floor(minY / spacingMm) * spacingMm;

  ctx.fillStyle = GRID_COLOR;
  for (let x = startX; x <= maxX; x += spacingMm) {
    for (let y = startY; y <= maxY; y += spacingMm) {
      const s = worldToScreen(view, { x, y });
      ctx.fillRect(s.x - 0.5, s.y - 0.5, 1, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Keepout hatch (clip + repeated 45deg lines, world-space spacing)
// ---------------------------------------------------------------------------

function drawKeepout(ctx: CanvasRenderingContext2D, view: ViewTransform, widthPx: number, heightPx: number, k: Keepout): void {
  const screenPts = k.polygon.map((p) => worldToScreen(view, p));
  if (screenPts.length < 3) return;

  ctx.save();
  pathPolygon(ctx, view, k.polygon);
  ctx.clip();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = KEEPOUT_COLOR;
  ctx.lineWidth = Math.max(0.2 * view.scale, 0.5);
  const spacingPx = Math.max(1 * view.scale, 3);
  const diag = Math.hypot(widthPx, heightPx) * 1.5;
  for (let offset = -diag; offset < diag; offset += spacingPx) {
    ctx.beginPath();
    ctx.moveTo(offset, -diag);
    ctx.lineTo(offset + diag, -diag + diag);
    ctx.stroke();
  }
  ctx.restore();

  strokePolygon(ctx, view, k.polygon, KEEPOUT_COLOR, 0.1);
}

// ---------------------------------------------------------------------------
// Main draw
// ---------------------------------------------------------------------------

function padPhysicalLayer(c: ComponentInst, pad: Pad): LayerId {
  // Only called for non-through pads (callers filter `pad.layer === 'through'`
  // first); through is folded to 'top' here only to satisfy the type checker.
  const localSide: 'top' | 'bottom' = pad.layer === 'bottom' ? 'bottom' : 'top';
  const physicalSide: 'top' | 'bottom' = c.side === 'bottom' ? (localSide === 'top' ? 'bottom' : 'top') : localSide;
  return physicalSide === 'top' ? 'F.Cu' : 'B.Cu';
}

function resolvePin(b: Board, ref: string): { comp: ComponentInst; pad: Pad } | undefined {
  const dot = ref.indexOf('.');
  if (dot === -1) return undefined;
  const comp = b.components.find((c) => c.refdes === ref.slice(0, dot));
  if (!comp) return undefined;
  const pad = comp.footprint.pads.find((p) => p.number === ref.slice(dot + 1));
  if (!pad) return undefined;
  return { comp, pad };
}

/**
 * Pure full-frame redraw. Render order (bottom-up, per task-9 brief):
 * B.Cu zones/tracks/pads -> inner -> F.Cu zones/tracks/pads -> through-pads
 * + vias + holes -> silk -> outline -> keepouts -> ratsnest -> hover halo ->
 * selection halo -> DRC markers.
 */
export function draw(board: Board, state: AppState, ctx: CanvasRenderingContext2D, widthPx: number, heightPx: number): void {
  const view = state.view;
  const vis = state.layerVisibility;

  ctx.save();
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, widthPx, heightPx);

  drawGrid(ctx, view, widthPx, heightPx);

  // ---- copper layers, bottom-up ----
  const layerOrder = copperLayersOf(board).slice().reverse();
  for (const layer of layerOrder) {
    if (vis[layer] === false) continue;
    const color = COPPER_COLOR[layer]!;

    for (const z of board.zones) {
      if (z.layer !== layer) continue;
      if (z.fill && z.fill.length > 0) {
        for (const poly of z.fill) fillPolygon(ctx, view, poly, color, 0.55);
      } else {
        fillPolygon(ctx, view, z.polygon, color, 0.25);
      }
    }

    for (const t of board.tracks) {
      if (t.layer !== layer) continue;
      strokeTrack(ctx, view, t, color);
    }

    if (layer === 'F.Cu' || layer === 'B.Cu') {
      for (const c of board.components) {
        for (const pad of c.footprint.pads) {
          if (pad.layer === 'through') continue;
          if (padPhysicalLayer(c, pad) !== layer) continue;
          fillPolygon(ctx, view, padOutline(c, pad), color);
        }
      }
    }
  }

  // ---- through-hole pads + vias + mounting holes ----
  for (const c of board.components) {
    for (const pad of c.footprint.pads) {
      if (pad.layer !== 'through') continue;
      fillPolygon(ctx, view, padOutline(c, pad), THROUGH_PAD_COLOR);
      if (pad.drill) {
        const [at] = componentTransformPoints(c, [pad.at]);
        fillCircle(ctx, view, at, pad.drill.diameter / 2, HOLE_COLOR);
      }
    }
  }
  for (const v of board.vias) {
    fillCircle(ctx, view, v.at, v.diameter / 2, THROUGH_PAD_COLOR);
    fillCircle(ctx, view, v.at, v.drill / 2, HOLE_COLOR);
  }
  for (const h of board.holes) {
    if (h.plated) {
      fillCircle(ctx, view, h.at, h.padDiameter / 2, THROUGH_PAD_COLOR);
      fillCircle(ctx, view, h.at, h.drill / 2, HOLE_COLOR);
    } else {
      strokeCircle(ctx, view, h.at, h.drill / 2, EDGE_COLOR, 0.1);
    }
  }

  // ---- silk: footprint items + refdes labels + board-level SilkText ----
  if (vis[SILK_KEY] !== false) {
    for (const side of ['bottom', 'top'] as const) {
      const color = silkColorFor(side);
      for (const c of board.components) {
        if (c.side !== side) continue;
        for (const item of c.footprint.silk) drawFootprintSilkItem(ctx, view, c, item, color);
        const [origin] = componentTransformPoints(c, [{ x: 0, y: 0 }]);
        const p = worldToScreen(view, origin);
        ctx.fillStyle = color;
        ctx.font = `${Math.max(REFDES_HEIGHT_MM * view.scale, 6)}px var(--mono, monospace)`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(c.refdes, p.x, p.y);
      }
      const silkLayer = side === 'top' ? 'F.Silk' : 'B.Silk';
      for (const s of board.silk) {
        if (s.layer !== silkLayer) continue;
        drawRotatedText(ctx, view, s.at, s.rotation, s.text, s.height, color);
      }
    }
  }

  // ---- board outline ----
  if (board.outline.length > 0) {
    try {
      strokePolygon(ctx, view, outlineToPolygon(board.outline), EDGE_COLOR, 0.1);
    } catch {
      // Malformed outline (gap > tolerance) mid-edit -- skip rather than throw during a live redraw.
    }
  }

  // ---- keepouts ----
  for (const k of board.keepouts) drawKeepout(ctx, view, widthPx, heightPx, k);

  // ---- ratsnest ----
  if (vis[RATSNEST_KEY] !== false) {
    ctx.save();
    ctx.strokeStyle = RATSNEST_COLOR;
    ctx.setLineDash([Math.max(0.5 * view.scale, 2), Math.max(0.5 * view.scale, 2)]);
    ctx.lineWidth = Math.max(0.1 * view.scale, 0.5);
    for (const line of state.ratsnestLines) {
      const s = worldToScreen(view, line.from);
      const e = worldToScreen(view, line.to);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- hover halo (single item) ----
  if (state.hover) {
    const hit = state.hover;
    if (hit.kind === 'pad') {
      const found = resolvePin(board, `${hit.refdes}.${hit.padNumber}`);
      if (found) strokePolygon(ctx, view, padOutline(found.comp, found.pad), HOVER_COLOR, 0.12);
    } else if (hit.kind === 'track') {
      const t = board.tracks.find((tr) => tr.id === hit.id);
      if (t) strokeTrack(ctx, view, t, HOVER_COLOR, 0.12);
    } else if (hit.kind === 'via') {
      const v = board.vias.find((via) => via.id === hit.id);
      if (v) strokeCircle(ctx, view, v.at, v.diameter / 2 + 0.06, HOVER_COLOR, 0.12);
    }
  }

  // ---- selection halo (whole net) ----
  if (state.selectedNet) {
    const net = state.selectedNet;
    for (const t of board.tracks) {
      if (t.net !== net) continue;
      strokeTrack(ctx, view, t, HIGHLIGHT_COLOR, 0.1);
    }
    for (const v of board.vias) {
      if (v.net !== net) continue;
      strokeCircle(ctx, view, v.at, v.diameter / 2 + 0.1, HIGHLIGHT_COLOR, 0.1);
    }
    const netObj = board.nets.find((n) => n.name === net);
    if (netObj) {
      for (const ref of netObj.pins) {
        const found = resolvePin(board, ref);
        if (found) strokePolygon(ctx, view, padOutline(found.comp, found.pad), HIGHLIGHT_COLOR, 0.1);
      }
    }
  }

  // ---- DRC markers (always empty today; wired for a later task) ----
  for (const m of state.drcMarkers) strokeCircle(ctx, view, m, 0.5, DRC_COLOR, 0.15);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// rAF-scheduled-when-dirty controller
// ---------------------------------------------------------------------------

export interface Renderer {
  /** Mark the frame dirty; a redraw happens on the next animation frame. */
  requestRedraw(): void;
  dispose(): void;
}

/** Owns canvas sizing (device-pixel-ratio aware) and the redraw loop for `canvas`. */
export function createRenderer(canvas: HTMLCanvasElement, getState: () => AppState): Renderer {
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('2D canvas context unavailable');
  const ctx: CanvasRenderingContext2D = ctx2d;

  let widthPx = 0;
  let heightPx = 0;
  let dirty = false;
  let rafHandle = 0;

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    widthPx = Math.max(1, Math.round(rect.width));
    heightPx = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(widthPx * dpr);
    canvas.height = Math.round(heightPx * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestRedraw();
  }

  function frame(): void {
    rafHandle = 0;
    if (!dirty) return;
    dirty = false;
    const state = getState();
    if (state.board) draw(state.board, state, ctx, widthPx, heightPx);
  }

  function requestRedraw(): void {
    dirty = true;
    if (rafHandle) return;
    rafHandle = requestAnimationFrame(frame);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  return {
    requestRedraw,
    dispose(): void {
      ro.disconnect();
      if (rafHandle) cancelAnimationFrame(rafHandle);
    },
  };
}
