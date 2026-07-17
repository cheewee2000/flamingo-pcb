/**
 * Flamingo UI - tool manager.
 *
 * Owns the single set of Tool instances (one each, created once) and which
 * one is currently active. `setActive` runs the onDeactivate/onActivate
 * lifecycle and mirrors the active id into `state.activeTool` (for the
 * toolbar's active-button highlight and the `[data-tool]` cursor CSS) --
 * main.ts asks `active()` for the live Tool object to route pointer/key
 * events and the per-frame overlay draw to, rather than looking it up by id
 * on every event.
 */

import type { Tool, ToolCtx } from './tool.js';
import { createSelectTool } from './select.js';
import { createOutlineTool } from './outline.js';
import { createKeepoutTool } from './keepout.js';
import { createZoneTool } from './zone.js';
import { createHoleTool } from './hole.js';
import { createSilkTool } from './silk.js';
import { createRipupTool } from './ripup.js';
import { createMeasureTool } from './measure.js';
import { createDimensionTool } from './dimension.js';

export interface ToolManager {
  readonly tools: Tool[];
  active(): Tool;
  setActive(id: string): void;
}

export function createToolManager(ctx: ToolCtx): ToolManager {
  const tools: Tool[] = [
    createSelectTool(),
    createOutlineTool(),
    createKeepoutTool(),
    createZoneTool(),
    createHoleTool(),
    createSilkTool(),
    createRipupTool(),
    createMeasureTool(),
    createDimensionTool(),
  ];
  const byId = new Map(tools.map((t) => [t.id, t]));
  const initial = byId.get('select');
  if (!initial) throw new Error('tool manager: no "select" tool registered');
  let current: Tool = initial;
  ctx.setState({ activeTool: current.id });

  return {
    tools,
    active: () => current,
    setActive(id: string): void {
      const next = byId.get(id);
      if (!next || next === current) return;
      current.onDeactivate?.(ctx);
      current = next;
      ctx.setState({ activeTool: current.id, selection: null, multiSelection: [] });
      current.onActivate?.(ctx);
    },
  };
}
