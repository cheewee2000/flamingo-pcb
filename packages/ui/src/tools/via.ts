/**
 * Flamingo UI - manual via placement tool.
 *
 * Click places a via at the (snapped) cursor. The via's net comes from the
 * copper under the cursor when there is any (pad/track/via, via `hitTest`) --
 * hovering a GND track and clicking drops a GND stitching via right there --
 * otherwise from the toolbar options row's net dropdown (`toolOptions.viaNet`).
 * Drill/diameter default to the net's class values (same rule as the MCP
 * `add_via` tool); there are no size inputs here on purpose.
 */

import type { NetClass, Point } from '@flamingo/engine';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';
import { hitTest } from '../hit-test.js';
import { drawOverlayLabel } from './overlay-utils.js';
import { worldToScreen } from '../view.js';
import type { AppState } from '../state.js';

const VIA_COLOR = '#7fe57f';

/** The class governing `net` on this board (falls back to the first class, then to sane 0.3/0.6 defaults). */
function classForNet(state: AppState, net: string): Pick<NetClass, 'viaDrill' | 'viaDiameter'> {
  const board = state.board;
  const className = board?.nets.find((n) => n.name === net)?.class;
  const cls =
    board?.netClasses.find((c) => c.name === className) ?? board?.netClasses[0];
  return cls ?? { viaDrill: 0.3, viaDiameter: 0.6 };
}

export function createViaTool(): Tool {
  let hoverWorld: Point | null = null;
  /** Net inferred from the copper under the cursor, or null over bare board. */
  let hoverNet: string | null = null;

  function targetNet(state: AppState): string {
    return hoverNet ?? state.toolOptions.viaNet;
  }

  return {
    id: 'via',
    label: 'Via',
    shortcut: 'V',
    cursor: 'crosshair',

    onDeactivate(): void {
      hoverWorld = null;
      hoverNet = null;
    },

    onPointerMove(ev: PointerEvt, ctx: ToolCtx): void {
      hoverWorld = ev.world;
      const state = ctx.getState();
      hoverNet = state.board ? (hitTest(state.board, ev.worldRaw, state.view.scale)?.net ?? null) : null;
    },

    onPointerDown(ev: PointerEvt, ctx: ToolCtx): void {
      const state = ctx.getState();
      const net = targetNet(state);
      if (!net) return;
      const { viaDrill, viaDiameter } = classForNet(state, net);
      ctx.sendOp({
        op: 'addVia',
        via: { at: ev.world, net, drill: viaDrill, diameter: viaDiameter },
      });
    },

    drawOverlay(ctx2d, view, state): void {
      if (!hoverWorld) return;
      const net = targetNet(state);
      const { viaDiameter, viaDrill } = classForNet(state, net || '');
      const s = worldToScreen(view, hoverWorld);
      const rOuter = Math.max((viaDiameter / 2) * view.scale, 3);
      const rDrill = Math.max((viaDrill / 2) * view.scale, 1);
      ctx2d.save();
      ctx2d.strokeStyle = VIA_COLOR;
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.arc(s.x, s.y, rOuter, 0, 2 * Math.PI);
      ctx2d.stroke();
      ctx2d.beginPath();
      ctx2d.arc(s.x, s.y, rDrill, 0, 2 * Math.PI);
      ctx2d.stroke();
      ctx2d.restore();
      drawOverlayLabel(ctx2d, view, hoverWorld, net || 'no net', VIA_COLOR);
    },
  };
}
