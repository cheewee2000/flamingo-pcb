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
  RatLine,
  SilkItem,
  Track,
} from '@flamingo/engine';
import {
  componentTransformPoints,
  componentTransformRotation,
  padOutline,
  outlineToPolygon,
  copperLayersOf,
  padCopperLayers,
  isSlot,
  holeSlotCenterline,
  capsulePolygon,
  labelFontMm,
  padNetMap,
} from '@flamingo/engine';
import type { AppState, ViewTransform } from './state.js';
import { DIMS_KEY, LABEL_NETS_KEY, LABEL_PADS_KEY, RATSNEST_KEY, SILK_KEY, ZONES_KEY } from './state.js';
import { screenToWorld, worldToScreen } from './view.js';

// ---------------------------------------------------------------------------
// Color table -- COPIED from packages/engine/src/render.ts's LAYER_COLORS
// (binding table). Keep these two lists in sync by hand; canvas draws
// differently from SVG, but the palette must match. Do not rename/retint
// casually. Exported so packages/ui/test/consistency.test.ts can assert this
// stays equal to the engine's LAYER_COLORS (drift insurance for the
// hand-kept-in-sync copy).
// ---------------------------------------------------------------------------
export const COPPER_COLOR: Partial<Record<LayerId, string>> = {
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
// Matches SELECT_COLOR in tools/select.ts (the drag ghost) so "selected" reads
// as one color everywhere.
const SELECTION_COLOR = '#4da6ff';
const BACKGROUND = '#1a1a1a';
// Label overlay colors -- kept in sync by hand with PAD_LABEL_COLOR /
// NET_LABEL_COLOR in packages/engine/src/render.ts (the SVG renderer).
const PAD_LABEL_COLOR = '#22D3EE';
const NET_LABEL_COLOR = '#FACC15';
const LABEL_MIN_PX = 7;

const REFDES_HEIGHT_MM = 1.0;

// ctx.font cannot resolve CSS custom properties (`var(--mono)` is silently
// rejected and the previous font sticks), so spell the stack out here. Kept
// in sync with --mono in style.css.
const CANVAS_FONT = `'Space Mono', 'Menlo', monospace`;

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
  ctx.font = `${Math.max(heightMm * view.scale, 6)}px ${CANVAS_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

const DIMENSION_COLOR = '#E8E8E8';
const DIM_ARROW_MM = 1.1;
const DIM_EXT_OVERSHOOT_MM = 0.7;
const DIM_TEXT_MM = 1.4;

/**
 * Compute the world-space endpoints of a dimension's measurement line:
 * a/b displaced by `offset` mm along the left-hand perpendicular of a→b.
 * Returns null for degenerate (zero-length) dimensions.
 */
export function dimensionLine(a: Point, b: Point, offset: number): { A: Point; B: Point; u: Point; n: Point; len: number } | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return null;
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const n = { x: -u.y, y: u.x };
  return {
    A: { x: a.x + n.x * offset, y: a.y + n.y * offset },
    B: { x: b.x + n.x * offset, y: b.y + n.y * offset },
    u,
    n,
    len,
  };
}

/** Draw one linear dimension: extension lines, measurement line, arrowheads, mm text. */
export function drawDimension(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  a: Point,
  b: Point,
  offset: number,
  color: string = DIMENSION_COLOR,
): void {
  const d = dimensionLine(a, b, offset);
  if (!d) return;
  const { A, B, u, n, len } = d;
  const over = Math.sign(offset || 1) * DIM_EXT_OVERSHOOT_MM;
  const lineMm = 0.08;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(lineMm * view.scale, 1);

  const seg = (p: Point, q: Point): void => {
    const s = worldToScreen(view, p);
    const e = worldToScreen(view, q);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
  };
  // Extension lines from the measured points, slightly past the dimension line.
  seg(a, { x: A.x + n.x * over, y: A.y + n.y * over });
  seg(b, { x: B.x + n.x * over, y: B.y + n.y * over });
  seg(A, B);

  // Arrowheads at A and B, pointing outward along ±u.
  const arrow = (tip: Point, dir: Point): void => {
    const t = worldToScreen(view, tip);
    const base = { x: tip.x - dir.x * DIM_ARROW_MM, y: tip.y - dir.y * DIM_ARROW_MM };
    const half = { x: -dir.y * DIM_ARROW_MM * 0.32, y: dir.x * DIM_ARROW_MM * 0.32 };
    const p1 = worldToScreen(view, { x: base.x + half.x, y: base.y + half.y });
    const p2 = worldToScreen(view, { x: base.x - half.x, y: base.y - half.y });
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.closePath();
    ctx.fill();
  };
  arrow(A, { x: -u.x, y: -u.y });
  arrow(B, u);

  // Length text above the middle of the dimension line, kept upright.
  const textOff = Math.sign(offset || 1) * (DIM_TEXT_MM * 0.9);
  const mid = {
    x: (A.x + B.x) / 2 + n.x * textOff,
    y: (A.y + B.y) / 2 + n.y * textOff,
  };
  const p = worldToScreen(view, mid);
  const pd = worldToScreen(view, { x: mid.x + u.x, y: mid.y + u.y });
  let angle = Math.atan2(pd.y - p.y, pd.x - p.x);
  if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
  ctx.translate(p.x, p.y);
  ctx.rotate(angle);
  ctx.font = `${Math.max(DIM_TEXT_MM * view.scale, 9)}px ${CANVAS_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${len.toFixed(2)}`, 0, 0);
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
  const cu = copperLayersOf(board);
  const layerOrder = cu.slice().reverse();
  for (const layer of layerOrder) {
    if (vis[layer] === false) continue;
    const color = COPPER_COLOR[layer]!;

    if (vis[ZONES_KEY] !== false) {
      for (const z of board.zones) {
        if (z.layer !== layer) continue;
        if (z.fill && z.fill.length > 0) {
          for (const poly of z.fill) fillPolygon(ctx, view, poly, color, 0.55);
        } else {
          fillPolygon(ctx, view, z.polygon, color, 0.25);
        }
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
          if (!padCopperLayers(pad, c.side, cu).includes(layer)) continue;
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
    if (isSlot(h)) {
      const { start, end } = holeSlotCenterline(h);
      if (h.plated) {
        fillPolygon(ctx, view, capsulePolygon(start, end, h.padDiameter / 2), THROUGH_PAD_COLOR);
        fillPolygon(ctx, view, capsulePolygon(start, end, h.drill / 2), HOLE_COLOR);
      } else {
        strokePolygon(ctx, view, capsulePolygon(start, end, h.drill / 2), EDGE_COLOR, 0.1);
      }
    } else if (h.plated) {
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
        ctx.font = `${Math.max(REFDES_HEIGHT_MM * view.scale, 6)}px ${CANVAS_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(c.refdes, p.x, p.y);
      }
      const silkLayer = side === 'top' ? 'F.Silk' : 'B.Silk';
      for (const s of board.silk) {
        if (s.layer !== silkLayer) continue;
        drawRotatedText(ctx, view, s.at, s.rotation, s.text, s.height, color);
      }
      for (const line of board.silkLines) {
        if (line.layer !== silkLayer) continue;
        const s = worldToScreen(view, line.start);
        const e = worldToScreen(view, line.end);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
        ctx.lineCap = 'round';
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(line.width * view.scale, 0.6);
        ctx.stroke();
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

  // ---- ratsnest (selected-net lines drawn on top, highlighted) ----
  if (vis[RATSNEST_KEY] !== false) {
    ctx.save();
    ctx.setLineDash([Math.max(0.5 * view.scale, 2), Math.max(0.5 * view.scale, 2)]);
    const strokeRat = (line: RatLine): void => {
      const s = worldToScreen(view, line.from);
      const e = worldToScreen(view, line.to);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
    };
    ctx.strokeStyle = RATSNEST_COLOR;
    ctx.lineWidth = Math.max(0.1 * view.scale, 0.5);
    for (const line of state.ratsnestLines) {
      if (line.net !== state.selectedNet) strokeRat(line);
    }
    if (state.selectedNet) {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = Math.max(0.15 * view.scale, 1);
      for (const line of state.ratsnestLines) {
        if (line.net === state.selectedNet) strokeRat(line);
      }
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

  // ---- selection halo (components incl. window selection; hole/slot outline) ----
  const sel = state.selection;
  const selectedRefdes = new Set(state.multiSelection);
  if (sel && sel.kind === 'component') selectedRefdes.add(sel.refdes);
  if (selectedRefdes.size > 0) {
    for (const comp of board.components) {
      if (!selectedRefdes.has(comp.refdes)) continue;
      for (const pad of comp.footprint.pads) {
        strokePolygon(ctx, view, padOutline(comp, pad), SELECTION_COLOR, 0.1);
      }
      for (const ring of comp.footprint.courtyard) {
        if (ring.length >= 3) strokePolygon(ctx, view, componentTransformPoints(comp, ring), SELECTION_COLOR, 0.12);
      }
    }
  } else if (sel && sel.kind === 'hole') {
    const h = board.holes.find((x) => x.id === sel.id);
    if (h) {
      const { start, end } = holeSlotCenterline(h);
      strokePolygon(ctx, view, capsulePolygon(start, end, Math.max(h.padDiameter, h.drill) / 2 + 0.15), SELECTION_COLOR, 0.12);
    }
  }

  // ---- label overlays (pad numbers + net names) ----
  const showPadLabels = vis[LABEL_PADS_KEY] !== false;
  const showNetLabels = vis[LABEL_NETS_KEY] !== false;
  if (showPadLabels || showNetLabels) {
    const netByPin = showNetLabels ? padNetMap(board) : null;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of board.components) {
      for (const pad of c.footprint.pads) {
        const [center] = componentTransformPoints(c, [pad.at]);
        const fontMm = labelFontMm(pad);
        const fontPx = Math.max(fontMm * view.scale, LABEL_MIN_PX);
        ctx.font = `${fontPx}px ${CANVAS_FONT}`;
        if (showPadLabels) {
          const s = worldToScreen(view, center);
          ctx.fillStyle = PAD_LABEL_COLOR;
          ctx.fillText(pad.number, s.x, s.y);
        }
        if (netByPin) {
          const netName = netByPin.get(`${c.refdes}.${pad.number}`);
          if (netName) {
            const offset = Math.min(pad.size.w, pad.size.h) / 2 + fontMm;
            const s = worldToScreen(view, { x: center.x, y: center.y - offset });
            ctx.fillStyle = NET_LABEL_COLOR;
            ctx.fillText(netName, s.x, s.y);
          }
        }
      }
    }
  }

  // ---- dimensions ----
  if (vis[DIMS_KEY] !== false) {
    for (const dim of board.dimensions) {
      const selected = sel !== null && sel.kind === 'dimension' && sel.id === dim.id;
      drawDimension(ctx, view, dim.a, dim.b, dim.offset, selected ? SELECTION_COLOR : undefined);
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
export function createRenderer(
  canvas: HTMLCanvasElement,
  getState: () => AppState,
  drawOverlay?: (ctx2d: CanvasRenderingContext2D, view: ViewTransform, state: AppState) => void,
): Renderer {
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
    if (state.board) {
      draw(state.board, state, ctx, widthPx, heightPx);
      drawOverlay?.(ctx, state.view, state);
    }
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
