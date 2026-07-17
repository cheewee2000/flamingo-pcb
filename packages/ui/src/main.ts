/**
 * Flamingo UI - entry point. Wires the store, WebSocket client, view
 * controls, renderer, panels, and the editing-tool manager together; owns
 * hover hit-testing and the global keyboard shortcuts (tool switching,
 * Escape-to-select, F/Home view controls).
 */

import './style.css';
import type { Board, Op, Point } from '@flamingo/engine';
import { boardBBox, ratsnest } from '@flamingo/engine';
import { store, type AppState } from './state.js';
import { attachViewControls, fitToBoard, flipView, screenToWorld } from './view.js';
import { createRenderer } from './renderer.js';
import { initPanels } from './panels.js';
import { connectWs } from './ws.js';
import { hitTest } from './hit-test.js';
import { createToolManager } from './tools/manager.js';
import { snapPoint } from './tools/overlay-utils.js';
import type { PointerEvt, ToolCtx } from './tools/tool.js';

const canvas = document.getElementById('board-canvas') as HTMLCanvasElement;
const viewportEl = document.getElementById('viewport') as HTMLElement;

// ---------------------------------------------------------------------------
// Live sync -- set up first so `ctx.sendOp` exists before tools are created.
// ---------------------------------------------------------------------------

function onBoard(board: Board): void {
  const state = store.get();
  const ratsnestLines = ratsnest(board);
  const patch: Partial<AppState> = { board, ratsnestLines };
  if (!state.hasFitOnce) {
    const rect = canvas.getBoundingClientRect();
    const bbox = boardBBox(board);
    patch.view = fitToBoard(state.view, bbox, rect.width, rect.height);
    patch.hasFitOnce = true;
  }
  store.set(patch);
}

function onConnectionChange(connected: boolean): void {
  store.set({ connected });
}

const wsApi = connectWs({ onBoard, onConnectionChange });

// ---------------------------------------------------------------------------
// Editing tools (Task 10)
// ---------------------------------------------------------------------------

const toolCtx: ToolCtx = {
  sendOp: (op: Op) => wsApi.sendOp(op),
  getState: () => store.get(),
  setState: (patch: Partial<AppState>) => store.set(patch),
  viewportEl,
};

const toolManager = createToolManager(toolCtx);

initPanels(
  {
    layerList: document.getElementById('layer-list')!,
    netList: document.getElementById('net-list')!,
    boardInfo: document.getElementById('board-info')!,
    sideBadge: document.getElementById('side-badge')!,
    statusCursor: document.getElementById('status-cursor')!,
    statusZoom: document.getElementById('status-zoom')!,
    statusHover: document.getElementById('status-hover')!,
    statusConn: document.getElementById('status-conn')!,
    statusMeasure: document.getElementById('status-measure')!,
    toolButtons: document.getElementById('tool-buttons')!,
    toolOptions: document.getElementById('tool-options')!,
    snapToggle: document.getElementById('snap-toggle') as HTMLInputElement,
    undoBtn: document.getElementById('undo-btn') as HTMLButtonElement,
    redoBtn: document.getElementById('redo-btn') as HTMLButtonElement,
  },
  toolManager,
);

const renderer = createRenderer(canvas, () => store.get(), (ctx2d, view, state) => {
  toolManager.active().drawOverlay?.(ctx2d, view, state);
});
store.subscribe(() => renderer.requestRedraw());
store.subscribe((state) => {
  canvas.dataset.tool = state.activeTool;
});
canvas.dataset.tool = store.get().activeTool;

const viewControls = attachViewControls(
  canvas,
  () => store.get().view,
  (v) => store.set({ view: v }),
);

// ---------------------------------------------------------------------------
// Pointer routing: hover (always) + active tool's down/move/up/dblclick.
// ---------------------------------------------------------------------------

function canvasPoint(ev: MouseEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function toPointerEvt(ev: MouseEvent, state: AppState): PointerEvt {
  const screen = canvasPoint(ev);
  const worldRaw = screenToWorld(state.view, screen);
  const ctrlOrCmd = ev.ctrlKey || ev.metaKey;
  const world = ctrlOrCmd ? worldRaw : snapPoint(worldRaw, state);
  return { world, worldRaw, screen, button: ev.button, shift: ev.shiftKey, alt: ev.altKey, ctrlOrCmd };
}

canvas.addEventListener('mousemove', (ev) => {
  const state = store.get();
  const world = screenToWorld(state.view, canvasPoint(ev));
  const hover = state.board ? hitTest(state.board, world, state.view.scale) : null;
  store.set({ cursorMm: world, hover });
  toolManager.active().onPointerMove?.(toPointerEvt(ev, store.get()), toolCtx);
});

canvas.addEventListener('mouseleave', () => {
  store.set({ cursorMm: null, hover: null });
});

canvas.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return; // middle-button pan is handled by attachViewControls
  if (viewControls.isPanning()) return; // space+left-drag pan already claimed this gesture
  toolManager.active().onPointerDown?.(toPointerEvt(ev, store.get()), toolCtx);
});

canvas.addEventListener('mouseup', (ev) => {
  if (ev.button !== 0) return;
  // Mouse events bubble canvas -> ... -> window, and attachViewControls' endPan
  // is bound on window, so this canvas-level listener runs *before* endPan
  // resets `panning` to false: isPanning() is still true here for the mouseup
  // that ends a space+drag pan, letting us skip routing it to the tool as a click.
  if (viewControls.isPanning()) return;
  toolManager.active().onPointerUp?.(toPointerEvt(ev, store.get()), toolCtx);
});

canvas.addEventListener('dblclick', (ev) => {
  // Same bubble-order reasoning as mouseup above: a pan-ending drag can end in
  // a dblclick if the two mouseups land close together in time, so guard here too.
  if (viewControls.isPanning()) return;
  toolManager.active().onDoubleClick?.(toPointerEvt(ev, store.get()), toolCtx);
});

// ---------------------------------------------------------------------------
// Keyboard: Escape always returns to select; then the active tool gets first
// refusal (R/F/Delete for select, Enter for the polygon tools, ...); then
// tool-switch shortcuts; then the pre-existing F flip-view / Home fit-to-board.
// ---------------------------------------------------------------------------

function isTypingTarget(ev: KeyboardEvent): boolean {
  const el = ev.target;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

const TOOL_SHORTCUTS: Record<string, string> = {
  KeyS: 'select',
  KeyO: 'outline',
  KeyK: 'keepout',
  KeyZ: 'zone',
  KeyH: 'hole',
  KeyT: 'silk',
  KeyX: 'ripup',
  KeyM: 'measure',
};

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Escape') {
    // Escape always wins, even while typing in a tool-owned input (e.g. silk's inline text box).
    toolManager.setActive('select');
    return;
  }
  if (isTypingTarget(ev)) return;

  if (toolManager.active().onKey?.(ev, toolCtx)) return;

  const toolId = TOOL_SHORTCUTS[ev.code];
  if (toolId) {
    toolManager.setActive(toolId);
    return;
  }

  const state = store.get();
  const rect = canvas.getBoundingClientRect();
  if (ev.code === 'KeyF') {
    store.set({ view: flipView(state.view, rect.width, rect.height) });
  } else if (ev.code === 'Home' && state.board) {
    const bbox = boardBBox(state.board);
    store.set({ view: fitToBoard(state.view, bbox, rect.width, rect.height) });
  }
});
