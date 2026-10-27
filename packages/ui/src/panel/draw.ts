/**
 * Panel view - canvas drawing.
 *
 * `drawPlate` is a pure function of the state: panel view in, pixels out.
 * Colour says which design a board is, and nothing else: every instance is
 * filled with a tint of its board's colour and outlined in it. What state a
 * thing is in is said with line weight, dashes, hatching and labels, so the
 * plate reads the same without colour:
 *
 *   panel outline      heavy solid line
 *   rails              diagonal hatch
 *   size limits        long-dash rectangles, labelled
 *   populated board    solid outline
 *   bare board         dashed outline, sparse hatch, label BARE
 *   selected           heavy outline, square handles at the corners
 *   pinned             filled square in the top-left corner, label PINNED
 *   stale source       dotted outline, label STALE
 *   blocked edge       heavy line with a comb of ticks pointing outward
 *   overhanging part   thin dashed polygon
 *   board-edge keepout cross hatch
 *   tab                filled bar; mouse-bite holes as open circles
 *   V-cut score        thin dashed line across the whole panel, over the boards
 *   error / warning    second outline outside the board (solid / dashed), label ERROR / WARNING
 *
 * The fabricated view (`state.look === 'fab'`, see `drawFab`) draws the same
 * panel as the fab makes it instead: colour there means material.
 *
 * The plate shows one of two things: the panel, which can be edited, or a
 * scenario that is not one panel (single boards, several orders), shown as one
 * plate per order, side by side, each drawn as a stack to say "several of
 * these". Those cannot be edited; see `drawScenario`.
 */

import type { Point } from '@flamingo/engine';
import type { Box, FabScene, PanelGeometry, PlacedInstance, Scenario, Side } from '@flamingo/panel';
import { BOARD_TINT, FAB_COLORS, boardColor, fabScene, tint } from '@flamingo/panel';
import type { ViewTransform } from '../state.js';
import { worldToScreen } from '../view.js';
import { mm, pieces, worstByInstance } from './format.js';
import { dragOffset, platePlaces } from './hit.js';
import type { Drag, PanelState } from './store.js';

const INK = '#000';
const PAPER = '#fff';
// ctx.font cannot resolve CSS custom properties: spell the stack out.
const FONT = `'Space Mono', 'Menlo', monospace`;
const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];

type Ctx = CanvasRenderingContext2D;

function corners(b: Box): Point[] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

function trace(ctx: Ctx, t: ViewTransform, pts: Point[], close = true): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = worldToScreen(t, p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (close) ctx.closePath();
}

function stroke(ctx: Ctx, width: number, dash: number[] = [], colour: string = INK): void {
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.strokeStyle = colour;
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Diagonal hatch inside the current path, at a fixed pitch in screen pixels. */
function hatch(
  ctx: Ctx,
  t: ViewTransform,
  pts: Point[],
  pitch: number,
  width: number,
  cross = false,
  colour: string = INK,
): void {
  const screen = pts.map((p) => worldToScreen(t, p));
  const xs = screen.map((p) => p.x);
  const ys = screen.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const h = y1 - y0;
  ctx.save();
  trace(ctx, t, pts);
  ctx.clip();
  ctx.beginPath();
  // Anchored to the plate, not to the shape, so hatches line up across shapes.
  const first = Math.floor((x0 - h) / pitch) * pitch;
  for (let x = first; x <= x1 + pitch; x += pitch) {
    ctx.moveTo(x, y1);
    ctx.lineTo(x + h, y0);
    if (cross) {
      ctx.moveTo(x + h, y1);
      ctx.lineTo(x, y0);
    }
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = colour;
  ctx.stroke();
  ctx.restore();
}

function label(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  px: number,
  bold = false,
  align: CanvasTextAlign = 'center',
  ground: string = PAPER,
  ink: string = INK,
): void {
  ctx.font = `${bold ? '700 ' : ''}${px}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  // A patch of the ground behind the text keeps it legible over hatching.
  const w = ctx.measureText(text).width;
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.fillStyle = ground;
  ctx.fillRect(left - 3, y - px * 0.62, w + 6, px * 1.24);
  ctx.fillStyle = ink;
  ctx.fillText(text, x, y);
}

function edgeEnds(b: Box, side: Side): [Point, Point] {
  switch (side) {
    case 'N':
      return [{ x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY }];
    case 'S':
      return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }];
    case 'E':
      return [{ x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }];
    case 'W':
      return [{ x: b.minX, y: b.minY }, { x: b.minX, y: b.maxY }];
  }
}

const NORMAL: Record<Side, Point> = {
  N: { x: 0, y: 1 },
  S: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  W: { x: -1, y: 0 },
};

function shift(pts: Point[], by: Point): Point[] {
  return by.x === 0 && by.y === 0 ? pts : pts.map((p) => ({ x: p.x + by.x, y: p.y + by.y }));
}

function shiftBox(b: Box, by: Point): Box {
  return { minX: b.minX + by.x, minY: b.minY + by.y, maxX: b.maxX + by.x, maxY: b.maxY + by.y };
}

/** What one plate is drawn with. */
interface Look {
  t: ViewTransform;
  holeDiameter: number;
  drag: Drag | null;
  selection: string | null;
  /** Lines under the plate's bottom-left corner; the first is bold. */
  caption: string[];
}

/** `t`, with everything moved by `by` mm. */
function moved(t: ViewTransform, by: Point): ViewTransform {
  return { ...t, originPxX: t.originPxX + by.x * t.scale * (t.flipped ? -1 : 1), originPxY: t.originPxY - by.y * t.scale };
}

function drawLimits(ctx: Ctx, state: PanelState, geometry: PanelGeometry, width: number, height: number): void {
  const view = state.view!;
  const t = state.transform;
  const origin = geometry.frame ? { x: geometry.frame.outer.minX, y: geometry.frame.outer.minY } : { x: 0, y: 0 };
  view.limits.forEach((l, i) => {
    const box: Box = { minX: origin.x, minY: origin.y, maxX: origin.x + l.width, maxY: origin.y + l.height };
    trace(ctx, t, corners(box));
    stroke(ctx, l.binding ? 1.5 : 1, [14, 6]);
    // The label sits inside the limit's top-left corner, or, when that corner
    // is out of view, as near to it as the plate allows. Limits are stacked so
    // that two labels pushed to the same edge do not cover each other.
    const corner = worldToScreen(t, { x: box.minX, y: box.maxY });
    const text = `${l.label}: ${l.width} × ${l.height} mm${l.verified ? '' : ' (est.)'}${l.binding ? ' — arrange packs within this' : ''}`;
    ctx.font = `${l.binding ? '700 ' : ''}11px ${FONT}`;
    const w = ctx.measureText(text).width;
    const x = Math.max(8, Math.min(corner.x + 8, width - w - 8));
    const y = Math.max(12 + i * 18, Math.min(corner.y + 12 + i * 18, height - 12));
    label(ctx, text, x, y, 11, l.binding, 'left');
  });
}

function drawFrame(ctx: Ctx, look: Look, geometry: PanelGeometry): void {
  const { t } = look;
  const frame = geometry.frame;
  if (!frame) return;

  for (const r of geometry.rails) {
    hatch(ctx, t, corners(r.box), 9, 0.6);
    trace(ctx, t, corners(r.box));
    stroke(ctx, 1);
  }

  for (const tab of geometry.tabs) {
    trace(ctx, t, tab.polygon);
    ctx.fillStyle = INK;
    ctx.fill();
  }
  const holeR = (look.holeDiameter / 2) * t.scale;
  if (holeR >= 1.2) {
    for (const tab of geometry.tabs) {
      for (const h of tab.holes) {
        const s = worldToScreen(t, h);
        ctx.beginPath();
        ctx.arc(s.x, s.y, holeR, 0, Math.PI * 2);
        ctx.fillStyle = PAPER;
        ctx.fill();
        stroke(ctx, 0.75);
      }
    }
  }

  for (const d of geometry.dividers) {
    trace(ctx, t, d, false);
    stroke(ctx, 1, [3, 3]);
  }

  trace(ctx, t, corners(frame.outer));
  stroke(ctx, 3);

  for (const h of geometry.toolingHoles) {
    const s = worldToScreen(t, h.at);
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(2, (h.diameter / 2) * t.scale), 0, Math.PI * 2);
    ctx.fillStyle = PAPER;
    ctx.fill();
    stroke(ctx, 1.5);
  }
  const seen = new Set<string>();
  for (const f of geometry.fiducials) {
    const key = `${f.at.x},${f.at.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = worldToScreen(t, f.at);
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(3, (f.maskDiameter / 2) * t.scale), 0, Math.PI * 2);
    ctx.fillStyle = PAPER;
    ctx.fill();
    stroke(ctx, 1);
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(1.5, (f.copperDiameter / 2) * t.scale), 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
  }

  const at = worldToScreen(t, { x: frame.outer.minX, y: frame.outer.minY });
  look.caption.forEach((line, i) => label(ctx, line, at.x, at.y + 14 + i * 17, 12, i === 0, 'left'));
}

function drawInstance(
  ctx: Ctx,
  look: Look,
  inst: PlacedInstance,
  level: 'error' | 'warning' | undefined,
  stale: boolean,
  colour: string,
): void {
  const { t } = look;
  const off = dragOffset(inst.id, look.drag);
  const moving = off.x !== 0 || off.y !== 0;
  const selected = look.selection === inst.id;
  const outline = shift(inst.outline, off);
  const box = shiftBox(inst.bbox, off);

  // Opaque, so an instance being dragged hides what is under it.
  trace(ctx, t, outline);
  ctx.fillStyle = tint(colour, BOARD_TINT);
  ctx.fill();

  for (const k of inst.keepouts) {
    const poly = shift(k, off);
    hatch(ctx, t, poly, 7, 0.5, true);
    trace(ctx, t, poly);
    stroke(ctx, 0.75, [2, 3]);
  }
  if (!inst.populate) hatch(ctx, t, outline, 16, 1, false, colour);

  trace(ctx, t, outline);
  if (selected) stroke(ctx, 4.5, inst.populate ? [] : [10, 5], colour);
  else if (!inst.populate) stroke(ctx, 2, [10, 5], colour);
  else if (stale) stroke(ctx, 2, [2, 4], colour);
  else stroke(ctx, 2, [], colour);

  for (const o of inst.overhangs) {
    trace(ctx, t, shift(o.polygon, off));
    stroke(ctx, 1, [4, 3]);
  }

  for (const side of SIDES) {
    if (!inst.edges[side].blocked) continue;
    const [a, b] = edgeEnds(box, side);
    const sa = worldToScreen(t, a);
    const sb = worldToScreen(t, b);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    stroke(ctx, 5);
    // The comb points away from the board. Screen y runs down, world y up.
    const n = { x: NORMAL[side].x, y: -NORMAL[side].y };
    const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
    const count = Math.max(2, Math.round(len / 12));
    ctx.beginPath();
    for (let i = 0; i <= count; i++) {
      const x = sa.x + ((sb.x - sa.x) * i) / count;
      const y = sa.y + ((sb.y - sa.y) * i) / count;
      ctx.moveTo(x, y);
      ctx.lineTo(x + n.x * 8, y + n.y * 8);
    }
    stroke(ctx, 1);
  }

  if (level) {
    const grow = 5 / t.scale;
    trace(ctx, t, corners({ minX: box.minX - grow, minY: box.minY - grow, maxX: box.maxX + grow, maxY: box.maxY + grow }));
    stroke(ctx, level === 'error' ? 2.5 : 1.25, level === 'error' ? [] : [6, 4]);
  }

  const tl = worldToScreen(t, { x: box.minX, y: box.maxY });
  if (inst.pinned) {
    ctx.fillStyle = INK;
    ctx.fillRect(tl.x + 5, tl.y + 5, 9, 9);
  }

  if (selected) {
    ctx.fillStyle = INK;
    for (const c of corners(box)) {
      const s = worldToScreen(t, c);
      ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
    }
  }

  const c = worldToScreen(t, { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
  const wPx = (box.maxX - box.minX) * t.scale;
  const hPx = (box.maxY - box.minY) * t.scale;
  const tags: string[] = [];
  if (!inst.populate) tags.push('BARE');
  if (inst.pinned) tags.push('PINNED');
  if (stale) tags.push('STALE');
  if (level) tags.push(level === 'error' ? 'ERROR' : 'WARNING');
  const big = Math.max(11, Math.min(30, hPx / 3.2, wPx / 3));
  const small = Math.max(9, Math.min(12, big * 0.5));
  const showTags = tags.length > 0 && hPx > big + small + 10;
  const ground = tint(colour, BOARD_TINT);
  label(ctx, inst.id, c.x, showTags ? c.y - small * 0.7 : c.y, big, true, 'center', ground);
  if (showTags) {
    // Tags that do not fit the board are dropped from the right.
    ctx.font = `${small}px ${FONT}`;
    let text = tags.join(' · ');
    while (tags.length > 1 && ctx.measureText(text).width > wPx - 8) {
      tags.pop();
      text = tags.join(' · ');
    }
    label(ctx, text, c.x, c.y + big * 0.62, small, false, 'center', ground);
  }

  if (moving) {
    const at = worldToScreen(t, { x: box.minX, y: box.minY });
    label(ctx, `${mm(box.minX)}, ${mm(box.minY)}`, at.x, at.y + 12, 11, false, 'left');
  }
}

/**
 * A scenario that is not one panel: one plate per order, side by side. Each is
 * drawn on top of two offset outlines, a stack, because an order is several of
 * the same piece.
 */
function drawScenario(ctx: Ctx, state: PanelState, scenario: Scenario): void {
  const view = state.view!;
  const keys = view.panel.sources.map((s) => s.key);
  const places = platePlaces(scenario.orders.map((o) => o.plate));
  scenario.orders.forEach((order, i) => {
    const frame = order.plate.frame;
    if (!frame) return;
    const t = moved(state.transform, places[i]!.offset);
    const made = order.priced.order.pcbQty;
    const assembled = order.priced.order.assembly?.qty ?? 0;

    for (const step of [2, 1]) {
      const back = { ...t, originPxX: t.originPxX + step * 7, originPxY: t.originPxY - step * 7 };
      trace(ctx, back, corners(frame.outer));
      ctx.fillStyle = PAPER;
      ctx.fill();
      stroke(ctx, 1);
    }
    trace(ctx, t, corners(frame.outer));
    ctx.fillStyle = PAPER;
    ctx.fill();

    const look: Look = {
      t,
      holeDiameter: view.panel.settings.tabs.holeDiameter,
      drag: null,
      selection: null,
      caption: [
        `Order ${i + 1} of ${scenario.orders.length}: ${pieces(made, order.panel)}, ${assembled} assembled`,
        `${order.panel ? 'panel' : 'single board'} ${mm(frame.width)} × ${mm(frame.height)} mm`,
      ],
    };
    drawFrame(ctx, look, order.plate);
    for (const inst of order.plate.instances) {
      drawInstance(ctx, look, inst, undefined, false, boardColor(keys, inst.source));
    }
    drawScores(ctx, look, order.plate);
    // How many of this piece, where the eye lands first.
    const corner = worldToScreen(t, { x: frame.outer.minX, y: frame.outer.maxY });
    label(ctx, `× ${made}`, corner.x, corner.y - 34, 22, true, 'left');
  });
}

/** Draw the plate. `width` and `height` are the canvas size in CSS pixels. */
export function drawPlate(ctx: Ctx, state: PanelState, width: number, height: number): void {
  ctx.setLineDash([]);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  const view = state.view;
  if (!view) return;

  const shown = state.preview ? state.quote?.scenarios.find((s) => s.id === state.preview) : undefined;
  if (shown) {
    drawScenario(ctx, state, shown);
    return;
  }

  const { geometry } = view;
  if (state.look !== 'fab') drawLimits(ctx, state, geometry, width, height);
  const order = view.quote.order;
  const look: Look = {
    t: state.transform,
    holeDiameter: view.panel.settings.tabs.holeDiameter,
    drag: state.drag,
    selection: state.selection,
    caption: geometry.frame
      ? [
          `${mm(geometry.frame.width)} × ${mm(geometry.frame.height)} mm`,
          ...(order ? [`to meet the need: ${pieces(order.pcbQty, order.piece.boards > 1)}, ${order.assembly?.qty ?? 0} assembled`] : []),
        ]
      : [],
  };
  if (state.look === 'fab') {
    drawFab(ctx, state, look, geometry);
    return;
  }
  drawFrame(ctx, look, geometry);

  const worst = worstByInstance(view.issues);
  const stale = new Set(view.sources.filter((s) => s.stale).map((s) => s.key));
  const keys = view.panel.sources.map((s) => s.key);
  // The dragged instance is drawn last, on top of the rest.
  const dragged = state.drag?.id;
  for (const inst of geometry.instances) {
    if (inst.id === dragged) continue;
    drawInstance(ctx, look, inst, worst.get(inst.id), stale.has(inst.source), boardColor(keys, inst.source));
  }
  const top = geometry.instances.find((i) => i.id === dragged);
  if (top) drawInstance(ctx, look, top, worst.get(top.id), stale.has(top.source), boardColor(keys, top.source));
  drawScores(ctx, look, geometry);
}

/** V-cut lines, drawn after the boards so a line through a board shows. */
function drawScores(ctx: Ctx, look: Look, geometry: PanelGeometry): void {
  for (const s of geometry.scores ?? []) {
    trace(ctx, look.t, [s.start, s.end], false);
    stroke(ctx, 1, [6, 3]);
  }
}

// ---------------------------------------------------------------------------
// Fabricated view
// ---------------------------------------------------------------------------

/** The scene is worked out once per geometry: the view replaces it on every change. */
const scenes = new WeakMap<PanelGeometry, FabScene>();

function sceneOf(state: PanelState, geometry: PanelGeometry): FabScene {
  let scene = scenes.get(geometry);
  if (!scene) {
    scene = fabScene(state.view!.panel.settings, geometry);
    scenes.set(geometry, scene);
  }
  return scene;
}

function disc(ctx: Ctx, t: ViewTransform, at: Point, diameter: number, fill: string): void {
  const s = worldToScreen(t, at);
  ctx.beginPath();
  ctx.arc(s.x, s.y, (diameter / 2) * t.scale, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A round badge with `!`: there are issues, the layout view says which. */
function badge(ctx: Ctx, x: number, y: number, level: 'error' | 'warning'): void {
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fillStyle = level === 'error' ? FAB_COLORS.error : FAB_COLORS.warning;
  ctx.fill();
  ctx.font = `700 12px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = FAB_COLORS.label;
  ctx.fillText('!', x, y + 0.5);
}

/**
 * The panel as the fab makes it, from the same primitives as the SVG render
 * (fabview.ts): laminate where material stays, the plate where the router
 * removes it, drilled holes punched through at true size. Selection and a
 * drag in progress are drawn over it; limits, blocked edges and error
 * outlines are not, only a small badge where there are issues.
 */
function drawFab(ctx: Ctx, state: PanelState, look: Look, geometry: PanelGeometry): void {
  const { t } = look;
  const view = state.view!;
  const scene = sceneOf(state, geometry);

  // Every ring in one path, filled even-odd: openings come out as holes.
  ctx.beginPath();
  for (const ring of scene.rings) {
    ring.points.forEach((p, i) => {
      const s = worldToScreen(t, p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  }
  ctx.fillStyle = FAB_COLORS.mask;
  ctx.fill('evenodd');

  for (const r of scene.rails) {
    trace(ctx, t, corners(r));
    ctx.fillStyle = FAB_COLORS.rail;
    ctx.fill();
  }
  for (const o of scene.outlines) {
    trace(ctx, t, o.outline);
    stroke(ctx, 0.75, [], FAB_COLORS.edge);
  }
  for (const d of scene.dividers) {
    trace(ctx, t, d, false);
    stroke(ctx, 1, [], FAB_COLORS.silk);
  }
  for (const s of scene.scores) {
    trace(ctx, t, [s.start, s.end], false);
    stroke(ctx, 1.25, [], FAB_COLORS.score);
  }
  for (const f of scene.fiducials) {
    disc(ctx, t, f.at, f.maskDiameter, FAB_COLORS.substrate);
    disc(ctx, t, f.at, f.copperDiameter, FAB_COLORS.copper);
  }
  for (const d of scene.drills) disc(ctx, t, d.at, d.diameter, PAPER);

  const worst = worstByInstance(view.issues);
  const stale = new Set(view.sources.filter((s) => s.stale).map((s) => s.key));
  for (const inst of geometry.instances) {
    const off = dragOffset(inst.id, look.drag);
    const moving = off.x !== 0 || off.y !== 0;
    const outline = shift(inst.outline, off);
    const box = shiftBox(inst.bbox, off);
    if (moving) {
      // The board in hand: where it would go. The material under it updates on drop.
      trace(ctx, t, outline);
      ctx.fillStyle = FAB_COLORS.mask;
      ctx.fill();
      stroke(ctx, 1.5, [6, 4], INK);
      const bl = worldToScreen(t, { x: box.minX, y: box.minY });
      label(ctx, `${mm(box.minX)}, ${mm(box.minY)}`, bl.x, bl.y + 12, 11, false, 'left');
    }
    if (look.selection === inst.id) {
      trace(ctx, t, outline);
      stroke(ctx, 3, [], INK);
      ctx.fillStyle = INK;
      for (const c of corners(box)) {
        const s = worldToScreen(t, c);
        ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
      }
    }

    const c = worldToScreen(t, { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
    const wPx = (box.maxX - box.minX) * t.scale;
    const hPx = (box.maxY - box.minY) * t.scale;
    const big = Math.max(11, Math.min(30, hPx / 3.2, wPx / 3));
    const small = Math.max(9, Math.min(12, big * 0.5));
    const tags: string[] = [];
    if (!inst.populate) tags.push('BARE');
    if (inst.pinned) tags.push('PINNED');
    if (stale.has(inst.source)) tags.push('STALE');
    const showTags = tags.length > 0 && hPx > big + small + 10;
    label(ctx, inst.id, c.x, showTags ? c.y - small * 0.7 : c.y, big, true, 'center', FAB_COLORS.mask, FAB_COLORS.label);
    if (showTags) label(ctx, tags.join(' · '), c.x, c.y + big * 0.62, small, false, 'center', FAB_COLORS.mask, FAB_COLORS.label);
    const level = worst.get(inst.id);
    if (level) badge(ctx, c.x, c.y - big * (showTags ? 1.3 : 0.9) - 6, level);
  }

  const frame = geometry.frame;
  if (!frame) return;
  const at = worldToScreen(t, { x: frame.outer.minX, y: frame.outer.minY });
  look.caption.forEach((line, i) => label(ctx, line, at.x, at.y + 14 + i * 17, 12, i === 0, 'left'));
  // Issues of the panel as a whole have no board to sit on: count them all above it.
  const errors = view.issues.filter((i) => i.severity === 'error').length;
  const warnings = view.issues.filter((i) => i.severity === 'warning').length;
  if (errors + warnings > 0) {
    const top = worldToScreen(t, { x: frame.outer.minX, y: frame.outer.maxY });
    badge(ctx, top.x + 8, top.y - 14, errors > 0 ? 'error' : 'warning');
    const text = [errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : '', warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '']
      .filter((s) => s !== '')
      .join(', ');
    label(ctx, `${text}: see Checks`, top.x + 20, top.y - 14, 11, false, 'left');
  }
}
