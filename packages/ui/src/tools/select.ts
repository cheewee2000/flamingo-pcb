/**
 * Flamingo UI - select tool (default tool).
 *
 * Click selects whatever is under the cursor (component/track/via/zone/
 * keepout/hole/silk/dimension -- see hit-test.ts `hitEditTarget`) as
 * `state.selection`, the target for R (rotate +90), F (flip side, components
 * only) and Delete/Backspace (remove).
 *
 * Window selection: dragging from anything that isn't a component sweeps a
 * marquee; every component fully inside the rectangle on release becomes
 * `state.multiSelection`. Dragging any member of that group moves the whole
 * group (one `moveComponents` op on drop, so a single undo restores all);
 * Delete removes every member. A plain click clears the group.
 *
 * Dragging a single component shows a ghost outline and only sends
 * `moveComponent` on drop -- never mid-drag, per the task-10 decision that
 * the server is the single authority.
 *
 * Clicking a pad/track/via also still toggles `selectedNet` exactly like
 * Task 9's viewer did (via the narrower `hitTest`).
 */

import type { ComponentInst, Point } from '@flamingo/engine';
import { bboxOf, componentTransformPoints, dist, padOutline } from '@flamingo/engine';
import { hitEditTarget, hitEditTargets, hitTest, sameEditTarget } from '../hit-test.js';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';
import { fillOverlayPolygon, strokeOverlayPolygon } from './overlay-utils.js';
import { worldToScreen } from '../view.js';

const DRAG_THRESHOLD_PX = 4;
const SELECT_COLOR = '#4da6ff';
const GHOST_FILL = '#4da6ff';
const MARQUEE_COLOR = '#ffffff';

function componentWorldBBox(c: ComponentInst): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const pts: Point[] = [];
  for (const ring of c.footprint.courtyard) pts.push(...componentTransformPoints(c, ring));
  for (const pad of c.footprint.pads) pts.push(...padOutline(c, pad));
  if (pts.length === 0) return null;
  return bboxOf(pts);
}

export function createSelectTool(): Tool {
  // Component drag (single, or the whole multiSelection group).
  let dragComps: { refdes: string; startAt: Point }[] = [];
  let dragGrabRefdes: string | null = null;
  let dragStartWorld: Point | null = null;
  let dragDelta: Point | null = null;
  // Marquee (window selection).
  let marqueeStart: Point | null = null;
  let marqueeCurrent: Point | null = null;
  let downScreen: Point | null = null;

  function reset(): void {
    dragComps = [];
    dragGrabRefdes = null;
    dragStartWorld = null;
    dragDelta = null;
    marqueeStart = null;
    marqueeCurrent = null;
    downScreen = null;
  }

  return {
    id: 'select',
    label: 'Select',
    shortcut: 'S',
    cursor: 'default',

    onDeactivate(): void {
      reset();
    },

    onPointerDown(ev: PointerEvt, ctx: ToolCtx): void {
      const state = ctx.getState();
      downScreen = ev.screen;
      if (!state.board) return;
      const hit = hitEditTarget(state.board, ev.worldRaw, state.view.scale);
      if (hit && hit.kind === 'component') {
        // Grabbing a member of the window selection drags the whole group.
        const group = state.multiSelection.includes(hit.refdes) ? state.multiSelection : [hit.refdes];
        dragComps = group
          .map((refdes) => state.board!.components.find((c) => c.refdes === refdes))
          .filter((c): c is ComponentInst => c !== undefined)
          .map((c) => ({ refdes: c.refdes, startAt: c.at }));
        dragGrabRefdes = hit.refdes;
        dragStartWorld = ev.world;
        dragDelta = { x: 0, y: 0 };
      } else {
        // Anything else (empty space, zone, keepout, ...): a drag from here is
        // a window selection; a plain click falls through to click-select.
        marqueeStart = ev.worldRaw;
        marqueeCurrent = ev.worldRaw;
      }
    },

    onPointerMove(ev: PointerEvt): void {
      if (dragStartWorld) {
        dragDelta = { x: ev.world.x - dragStartWorld.x, y: ev.world.y - dragStartWorld.y };
      } else if (marqueeStart) {
        marqueeCurrent = ev.worldRaw;
      }
    },

    onPointerUp(ev: PointerEvt, ctx: ToolCtx): void {
      const state = ctx.getState();
      const board = state.board;
      if (!board) {
        reset();
        return;
      }
      const moved = downScreen !== null && dist(downScreen, ev.screen) > DRAG_THRESHOLD_PX;

      // Drop a component drag (single or group).
      if (dragComps.length > 0 && dragDelta && moved) {
        const moves = dragComps.map((d) => ({
          refdes: d.refdes,
          at: { x: d.startAt.x + dragDelta!.x, y: d.startAt.y + dragDelta!.y },
        }));
        if (moves.length === 1) {
          ctx.sendOp({ op: 'moveComponent', refdes: moves[0].refdes, at: moves[0].at });
        } else {
          ctx.sendOp({ op: 'moveComponents', moves });
        }
        if (dragGrabRefdes) ctx.setState({ selection: { kind: 'component', refdes: dragGrabRefdes } });
        reset();
        return;
      }

      // Close a marquee: select every component fully inside the rectangle.
      if (marqueeStart && moved) {
        const x0 = Math.min(marqueeStart.x, ev.worldRaw.x);
        const x1 = Math.max(marqueeStart.x, ev.worldRaw.x);
        const y0 = Math.min(marqueeStart.y, ev.worldRaw.y);
        const y1 = Math.max(marqueeStart.y, ev.worldRaw.y);
        const inside: string[] = [];
        for (const c of board.components) {
          const bb = componentWorldBBox(c);
          if (!bb) continue;
          if (bb.minX >= x0 && bb.maxX <= x1 && bb.minY >= y0 && bb.maxY <= y1) inside.push(c.refdes);
        }
        ctx.setState({
          multiSelection: inside,
          selection: inside.length === 1 ? { kind: 'component', refdes: inside[0] } : null,
          selectedNet: null,
        });
        reset();
        return;
      }
      reset();

      // Plain click: preserve Task 9's pad/track/via net-highlight behavior...
      // Use worldRaw (unsnapped), matching onPointerDown above -- with the
      // default 0.5mm snap, a precise click on a thin track/pad can snap to a
      // point that no longer hits it.
      const netHit = hitTest(board, ev.worldRaw, state.view.scale);
      const cur = state.selectedNet;
      const selectedNet = netHit ? (cur === netHit.net ? null : netHit.net) : null;

      // ...alongside the broader edit-selection (component shadows its pads).
      // Clicking the same spot again cycles to the next item stacked under
      // the current selection (hole -> keepout -> zone -> hole -> ...).
      const hits = hitEditTargets(board, ev.worldRaw, state.view.scale);
      let editHit = hits[0] ?? null;
      if (state.selection && hits.length > 1) {
        const idx = hits.findIndex((h) => sameEditTarget(h, state.selection!));
        if (idx !== -1) editHit = hits[(idx + 1) % hits.length];
      }
      ctx.setState({ selectedNet, selection: editHit, multiSelection: [] });
    },

    onKey(ev: KeyboardEvent, ctx: ToolCtx): boolean {
      const state = ctx.getState();
      const sel = state.selection;
      if (!state.board) return false;

      if (ev.code === 'Delete' || ev.code === 'Backspace') {
        if (state.multiSelection.length > 0) {
          for (const refdes of state.multiSelection) {
            ctx.sendOp({ op: 'removeComponent', refdes });
          }
          ctx.setState({ selection: null, multiSelection: [] });
          return true;
        }
        if (sel) {
          if (sel.kind === 'component') {
            ctx.sendOp({ op: 'removeComponent', refdes: sel.refdes });
          } else {
            ctx.sendOp({ op: 'removeItem', id: sel.id });
          }
          ctx.setState({ selection: null });
          return true;
        }
        return false;
      }

      if (!sel) return false;
      if (ev.code === 'KeyR' && sel.kind === 'component') {
        const comp = state.board.components.find((c) => c.refdes === sel.refdes);
        if (comp) {
          const rotation = (((comp.rotation + 90) % 360) + 360) % 360;
          ctx.sendOp({ op: 'moveComponent', refdes: sel.refdes, rotation });
        }
        return true;
      }
      if (ev.code === 'KeyF' && sel.kind === 'component') {
        const comp = state.board.components.find((c) => c.refdes === sel.refdes);
        if (comp) {
          ctx.sendOp({ op: 'moveComponent', refdes: sel.refdes, side: comp.side === 'top' ? 'bottom' : 'top' });
        }
        return true;
      }
      return false;
    },

    drawOverlay(ctx2d, view, state): void {
      if (marqueeStart && marqueeCurrent) {
        const a = worldToScreen(view, marqueeStart);
        const b = worldToScreen(view, marqueeCurrent);
        ctx2d.save();
        ctx2d.strokeStyle = MARQUEE_COLOR;
        ctx2d.setLineDash([5, 4]);
        ctx2d.lineWidth = 1;
        ctx2d.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx2d.restore();
        return;
      }
      if (dragComps.length === 0 || !dragDelta || !state.board) return;
      for (const d of dragComps) {
        const comp = state.board.components.find((c) => c.refdes === d.refdes);
        if (!comp) continue;
        const ghost: ComponentInst = { ...comp, at: { x: d.startAt.x + dragDelta.x, y: d.startAt.y + dragDelta.y } };
        for (const pad of ghost.footprint.pads) {
          fillOverlayPolygon(ctx2d, view, padOutline(ghost, pad), GHOST_FILL, 0.4);
        }
        for (const ring of ghost.footprint.courtyard) {
          if (ring.length < 2) continue;
          strokeOverlayPolygon(ctx2d, view, componentTransformPoints(ghost, ring), SELECT_COLOR, 1.5, true);
        }
      }
    },
  };
}
