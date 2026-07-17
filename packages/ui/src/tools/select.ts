/**
 * Flamingo UI - select tool (default tool).
 *
 * Click selects whatever is under the cursor (component/track/via/zone/
 * keepout/hole/silk -- see hit-test.ts `hitEditTarget`) as `state.selection`,
 * the target for R (rotate +90), F (flip side, components only) and
 * Delete/Backspace (remove). Dragging a component shows a ghost outline and
 * only sends `moveComponent` on drop -- never mid-drag, per the task-10
 * decision that the server is the single authority.
 *
 * Clicking a pad/track/via also still toggles `selectedNet` exactly like
 * Task 9's viewer did (via the narrower `hitTest`) -- this is preserved
 * un-changed alongside the new edit-selection so existing net-highlight
 * behavior keeps working with select as the default tool.
 */

import type { ComponentInst, Point } from '@flamingo/engine';
import { componentTransformPoints, dist, padOutline } from '@flamingo/engine';
import { hitEditTarget, hitTest } from '../hit-test.js';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';
import { fillOverlayPolygon, strokeOverlayPolygon } from './overlay-utils.js';

const DRAG_THRESHOLD_PX = 4;
const SELECT_COLOR = '#4da6ff';
const GHOST_FILL = '#4da6ff';

export function createSelectTool(): Tool {
  let dragRefdes: string | null = null;
  let dragStartWorld: Point | null = null;
  let dragStartAt: Point | null = null;
  let dragCurrentAt: Point | null = null;
  let downScreen: Point | null = null;

  function reset(): void {
    dragRefdes = null;
    dragStartWorld = null;
    dragStartAt = null;
    dragCurrentAt = null;
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
        const comp = state.board.components.find((c) => c.refdes === hit.refdes);
        if (comp) {
          dragRefdes = hit.refdes;
          dragStartWorld = ev.world;
          dragStartAt = comp.at;
          dragCurrentAt = comp.at;
        }
      }
    },

    onPointerMove(ev: PointerEvt): void {
      if (!dragRefdes || !dragStartWorld || !dragStartAt) return;
      dragCurrentAt = {
        x: dragStartAt.x + (ev.world.x - dragStartWorld.x),
        y: dragStartAt.y + (ev.world.y - dragStartWorld.y),
      };
    },

    onPointerUp(ev: PointerEvt, ctx: ToolCtx): void {
      const state = ctx.getState();
      const board = state.board;
      if (!board) {
        reset();
        return;
      }
      const moved = downScreen !== null && dist(downScreen, ev.screen) > DRAG_THRESHOLD_PX;

      if (dragRefdes && dragCurrentAt && moved) {
        ctx.sendOp({ op: 'moveComponent', refdes: dragRefdes, at: dragCurrentAt });
        ctx.setState({ selection: { kind: 'component', refdes: dragRefdes } });
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
      const editHit = hitEditTarget(board, ev.worldRaw, state.view.scale);
      ctx.setState({ selectedNet, selection: editHit });
    },

    onKey(ev: KeyboardEvent, ctx: ToolCtx): boolean {
      const state = ctx.getState();
      const sel = state.selection;
      if (!state.board || !sel) return false;

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
      if (ev.code === 'Delete' || ev.code === 'Backspace') {
        if (sel.kind === 'component') {
          ctx.sendOp({ op: 'removeComponent', refdes: sel.refdes });
        } else {
          ctx.sendOp({ op: 'removeItem', id: sel.id });
        }
        ctx.setState({ selection: null });
        return true;
      }
      return false;
    },

    drawOverlay(ctx2d, view, state): void {
      if (!dragRefdes || !dragCurrentAt || !state.board) return;
      const comp = state.board.components.find((c) => c.refdes === dragRefdes);
      if (!comp) return;
      const ghost: ComponentInst = { ...comp, at: dragCurrentAt };
      for (const pad of ghost.footprint.pads) {
        fillOverlayPolygon(ctx2d, view, padOutline(ghost, pad), GHOST_FILL, 0.4);
      }
      for (const ring of ghost.footprint.courtyard) {
        if (ring.length < 2) continue;
        strokeOverlayPolygon(ctx2d, view, componentTransformPoints(ghost, ring), SELECT_COLOR, 1.5, true);
      }
    },
  };
}
