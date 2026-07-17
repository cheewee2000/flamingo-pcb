/**
 * Flamingo UI - ripup tool.
 *
 * Click a track/via -> `removeItem` for that item. Alt-click -> `unroute`
 * the item's whole net (removes every track/via on that net).
 */

import { hitTrackOrVia } from '../hit-test.js';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';

export function createRipupTool(): Tool {
  return {
    id: 'ripup',
    label: 'Rip Up',
    shortcut: 'X',
    cursor: 'not-allowed',

    onPointerDown(ev: PointerEvt, ctx: ToolCtx): void {
      const state = ctx.getState();
      if (!state.board) return;
      const hit = hitTrackOrVia(state.board, ev.world, state.view.scale);
      if (!hit) return;
      if (ev.alt) {
        ctx.sendOp({ op: 'unroute', net: hit.net });
      } else {
        ctx.sendOp({ op: 'removeItem', id: hit.id });
      }
    },
  };
}
