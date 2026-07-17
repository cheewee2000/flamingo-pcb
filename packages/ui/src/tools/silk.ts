/**
 * Flamingo UI - silk text tool.
 *
 * Click drops a floating inline `<input>` (appended to `ctx.viewportEl`,
 * positioned at the click's screen coords) instead of a `window.prompt` --
 * Enter commits `addSilkText` (F.Silk, height 1mm, rotation 0) and removes
 * the input; an empty commit is discarded. Escape is handled globally
 * (main.ts always routes Escape to switching back to select), which calls
 * `onDeactivate` here and tears the input down -- that's "Esc cancels".
 */

import type { Point } from '@flamingo/engine';
import type { PointerEvt, Tool, ToolCtx } from './tool.js';

const SILK_HEIGHT_MM = 1;

export function createSilkTool(): Tool {
  let inputEl: HTMLInputElement | null = null;
  let anchorWorld: Point | null = null;

  function cleanup(): void {
    inputEl?.remove();
    inputEl = null;
    anchorWorld = null;
  }

  function commit(ctx: ToolCtx): void {
    const text = inputEl?.value.trim() ?? '';
    if (text && anchorWorld) {
      ctx.sendOp({
        op: 'addSilkText',
        text: { layer: 'F.Silk', at: anchorWorld, text, height: SILK_HEIGHT_MM, rotation: 0 },
      });
    }
    cleanup();
  }

  return {
    id: 'silk',
    label: 'Silk Text',
    shortcut: 'T',
    cursor: 'text',

    onDeactivate(): void {
      cleanup();
    },

    onPointerDown(ev: PointerEvt, ctx: ToolCtx): void {
      if (inputEl) {
        // A previous label is still pending -- commit it before starting the next one.
        commit(ctx);
      }
      anchorWorld = ev.world;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'silk-inline-input';
      input.placeholder = 'silk text…';
      input.style.left = `${ev.screen.x}px`;
      input.style.top = `${ev.screen.y}px`;
      input.addEventListener('keydown', (kev) => {
        if (kev.key === 'Enter') commit(ctx);
        else if (kev.key === 'Escape') cleanup();
      });
      ctx.viewportEl.appendChild(input);
      input.focus();
      inputEl = input;
    },
  };
}
