/**
 * Flamingo UI - interactive track (trace) drawing tool.
 *
 * Click a pad/track/via to start a route on its net, then click to lay down
 * vertices; headings snap to 45deg increments (hold Shift for a free angle).
 * Pressing `l` (or changing the options-row layer dropdown) switches the active
 * copper layer and drops a layer-change via at the last placed vertex. Finish
 * by clicking copper on the same net (auto-commits), pressing Enter, or
 * double-clicking; Escape or a tool switch discards the in-progress route. The
 * whole route -- every segment plus its layer-change vias -- commits as one
 * atomic `addTracks` op, so a single undo removes all of it.
 *
 * Net inference and class-derived sizes follow via.ts. Track width and via
 * drill/diameter come from the route net's class (no size inputs, on purpose).
 *
 * Explicitly NOT included: push-and-shove, live DRC while drawing (the post-hoc
 * run_drc / export gate covers clearance), arc segments, and dragging existing
 * tracks. This tool only appends new geometry.
 */

import type { LayerId, NetClass, Point, Track, Via } from '@flamingo/engine';
import { copperLayersOf } from '@flamingo/engine';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';
import { hitTest } from '../hit-test.js';
import { drawOverlayLabel, strokeOverlayLine } from './overlay-utils.js';
import { worldToScreen } from '../view.js';
import type { AppState } from '../state.js';

const TRACK_COLOR = '#f5a623';
const VIA_COLOR = '#7fe57f';
const QUARTER = Math.PI / 4;

/** The class governing `net` on this board (falls back to the first class, then to sane defaults). */
function classForNet(state: AppState, net: string): Pick<NetClass, 'trackWidth' | 'viaDrill' | 'viaDiameter'> {
  const board = state.board;
  const className = board?.nets.find((n) => n.name === net)?.class;
  const cls = board?.netClasses.find((c) => c.name === className) ?? board?.netClasses[0];
  return cls ?? { trackWidth: 0.25, viaDrill: 0.3, viaDiameter: 0.6 };
}

/** Project `to` onto the nearest 45deg ray from `from` (unless `free`, e.g. Shift held). */
function constrainHeading(from: Point, to: Point, free: boolean): Point {
  if (free) return to;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return to;
  const ang = Math.round(Math.atan2(dy, dx) / QUARTER) * QUARTER;
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const proj = dx * ux + dy * uy;
  return { x: from.x + ux * proj, y: from.y + uy * proj };
}

export function createTrackTool(): Tool {
  /** Route net, set from the copper under the first click; null before a route starts. */
  let net: string | null = null;
  /** Placed vertices. */
  let points: Point[] = [];
  /** segLayer[i] is the copper layer of the segment points[i] -> points[i+1]. */
  let segLayer: LayerId[] = [];
  /** Vertex indices carrying a (through) layer-change via. */
  const viaAt = new Set<number>();
  /** Layer the next segment is drawn on. */
  let activeLayer: LayerId = 'F.Cu';
  /** Live cursor (heading-constrained), for the preview segment. */
  let cursor: Point | null = null;

  function reset(): void {
    net = null;
    points = [];
    segLayer = [];
    viaAt.clear();
    cursor = null;
  }

  /** Where the next vertex lands: raw first point, else heading-constrained from the last vertex. */
  function nextPoint(ev: PointerEvt): Point {
    if (points.length === 0) return ev.world;
    return constrainHeading(points[points.length - 1], ev.world, ev.shift);
  }

  function appendVertex(p: Point): void {
    if (points.length > 0) segLayer.push(activeLayer);
    points.push(p);
  }

  /** Switch the active layer, dropping a via at the last placed vertex (once per vertex). */
  function switchLayer(target: LayerId, ctx: ToolCtx): void {
    if (target === activeLayer) return;
    if (points.length >= 1) viaAt.add(points.length - 1);
    activeLayer = target;
    // Keep the options-row dropdown in sync (harmless when the change came from it).
    const opts = ctx.getState().toolOptions;
    if (opts.trackLayer !== target) ctx.setState({ toolOptions: { ...opts, trackLayer: target } });
  }

  /**
   * Reconcile the tool's active layer with the dropdown-backed toolOptions.trackLayer.
   * Before a route starts this just adopts the picked start layer; mid-route a
   * changed dropdown behaves exactly like the `l` key (drops a via, switches layer).
   */
  function reconcileLayer(ctx: ToolCtx): void {
    const wanted = ctx.getState().toolOptions.trackLayer;
    if (wanted === activeLayer) return;
    if (points.length === 0) activeLayer = wanted;
    else switchLayer(wanted, ctx);
  }

  function commit(ctx: ToolCtx): void {
    if (points.length >= 2 && net) {
      const { trackWidth, viaDrill, viaDiameter } = classForNet(ctx.getState(), net);
      const tracks: Omit<Track, 'id'>[] = [];
      for (let i = 0; i < points.length - 1; i++) {
        tracks.push({
          layer: segLayer[i],
          width: trackWidth,
          net,
          seg: { type: 'line', start: points[i], end: points[i + 1] },
        });
      }
      const vias: Omit<Via, 'id'>[] = [...viaAt].map((idx) => ({
        at: points[idx],
        net: net as string,
        drill: viaDrill,
        diameter: viaDiameter,
      }));
      ctx.sendOp({ op: 'addTracks', tracks, vias });
    }
    reset();
  }

  return {
    id: 'track',
    label: 'Track',
    shortcut: 'W',
    cursor: 'crosshair',

    onActivate(ctx: ToolCtx): void {
      reset();
      // Start on whatever layer the dropdown currently shows.
      activeLayer = ctx.getState().toolOptions.trackLayer;
    },

    onDeactivate(): void {
      reset();
    },

    onPointerMove(ev: PointerEvt, ctx: ToolCtx): void {
      reconcileLayer(ctx);
      cursor = nextPoint(ev);
    },

    onPointerDown(ev: PointerEvt, ctx: ToolCtx): void {
      reconcileLayer(ctx);
      const state = ctx.getState();
      const hit = state.board ? hitTest(state.board, ev.worldRaw, state.view.scale) : null;

      if (net === null) {
        // First click must land on copper -- its net becomes the route's net.
        if (hit?.net) {
          net = hit.net;
          appendVertex(ev.world);
        }
        return;
      }

      // Landing on copper of the same net finishes the route (the pad-to-pad case).
      if (hit?.net === net && points.length >= 1) {
        appendVertex(ev.world);
        commit(ctx);
        return;
      }

      appendVertex(nextPoint(ev));
    },

    onDoubleClick(_ev: PointerEvt, ctx: ToolCtx): void {
      // The two clicks composing the double-click each appended a vertex at the
      // same spot; drop the duplicate, then commit as drawn (mirrors zone.ts).
      if (points.length > 0) {
        points.pop();
        segLayer.pop();
      }
      commit(ctx);
    },

    onKey(ev: KeyboardEvent, ctx: ToolCtx): boolean {
      if (ev.code === 'Enter') {
        commit(ctx);
        return true;
      }
      if (ev.code === 'KeyL') {
        const board = ctx.getState().board;
        if (board && net !== null) {
          const layers = copperLayersOf(board);
          const idx = Math.max(0, layers.indexOf(activeLayer));
          switchLayer(layers[(idx + 1) % layers.length], ctx);
        }
        return true;
      }
      return false;
    },

    drawOverlay(ctx2d, view, state): void {
      if (net === null) {
        // Not started yet: a standing hint at the cursor.
        if (cursor) drawOverlayLabel(ctx2d, view, cursor, 'click a pad or track to start', TRACK_COLOR);
        return;
      }
      const { trackWidth, viaDiameter } = classForNet(state, net);

      // Committed segments at true width.
      for (let i = 0; i < points.length - 1; i++) {
        strokeTrue(ctx2d, view, points[i], points[i + 1], trackWidth, TRACK_COLOR);
      }
      // Live segment from the last vertex to the (constrained) cursor.
      const last = points[points.length - 1];
      if (last && cursor) strokeOverlayLine(ctx2d, view, last, cursor, TRACK_COLOR, 1, [4, 4]);

      // Layer-change via markers.
      for (const idx of viaAt) {
        const s = worldToScreen(view, points[idx]);
        const r = Math.max((viaDiameter / 2) * view.scale, 3);
        ctx2d.save();
        ctx2d.strokeStyle = VIA_COLOR;
        ctx2d.lineWidth = 1.5;
        ctx2d.beginPath();
        ctx2d.arc(s.x, s.y, r, 0, 2 * Math.PI);
        ctx2d.stroke();
        ctx2d.restore();
      }

      const labelAt = cursor ?? last;
      if (labelAt) drawOverlayLabel(ctx2d, view, labelAt, `${net} · ${trackWidth}mm · ${activeLayer}`, TRACK_COLOR);
    },
  };
}

/** Stroke a segment at true copper width (screen-scaled, min 1px, round caps). */
function strokeTrue(
  ctx2d: CanvasRenderingContext2D,
  view: AppState['view'],
  a: Point,
  b: Point,
  widthMm: number,
  color: string,
): void {
  const sa = worldToScreen(view, a);
  const sb = worldToScreen(view, b);
  ctx2d.save();
  ctx2d.strokeStyle = color;
  ctx2d.lineWidth = Math.max(widthMm * view.scale, 1);
  ctx2d.lineCap = 'round';
  ctx2d.globalAlpha = 0.8;
  ctx2d.beginPath();
  ctx2d.moveTo(sa.x, sa.y);
  ctx2d.lineTo(sb.x, sb.y);
  ctx2d.stroke();
  ctx2d.restore();
}
