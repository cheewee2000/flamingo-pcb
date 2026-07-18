/**
 * Flamingo UI - entry point. Wires the store, WebSocket client, view
 * controls, renderer, panels, and the editing-tool manager together; owns
 * hover hit-testing and the global keyboard shortcuts (tool switching,
 * Escape-to-select, F/Home view controls).
 */

import './style.css';
import type { Board, Op, Point } from '@flamingo/engine';
import { boardBBox, padOutline, ratsnest } from '@flamingo/engine';
import { store, type AppState } from './state.js';
import { attachViewControls, centerOn, fitToBoard, flipView, screenToWorld } from './view.js';
import { createRenderer } from './renderer.js';
import { initPanels } from './panels.js';
import { connectWs } from './ws.js';
import { hitTest } from './hit-test.js';
import { createToolManager } from './tools/manager.js';
import { snapPoint } from './tools/overlay-utils.js';
import type { PointerEvt, ToolCtx } from './tools/tool.js';
import { VERSION } from './version.js';
import { createViewer3D } from './viewer3d/viewer.js';

// Stamp the build version into the status bar (see index.html #status-version).
const versionEl = document.getElementById('status-version');
if (versionEl) versionEl.textContent = `Flamingo v${VERSION}`;

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

/** Select a component and center the view on it (BOM/properties click-through). */
function focusComponent(refdes: string): void {
  const state = store.get();
  const board = state.board;
  if (!board) return;
  const comp = board.components.find((c) => c.refdes === refdes);
  if (!comp) return;
  const pts = comp.footprint.pads.flatMap((pad) => padOutline(comp, pad));
  let center: Point = comp.at;
  if (pts.length > 0) {
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }
  const rect = canvas.getBoundingClientRect();
  store.set({
    selection: { kind: 'component', refdes },
    view: centerOn(state.view, center, rect.width, rect.height),
  });
}

/**
 * After /api/open succeeds: clear all selection state and load the new board
 * by GET rather than waiting on the websocket push — the ws 'board' message
 * may have raced ahead of the fetch response, in which case no further push
 * comes and the view would stay fit to the previous board.
 */
function boardOpened(): void {
  store.set({ selection: null, selectedNet: null, hover: null });
  void (async () => {
    try {
      const board = (await (await fetch('/api/board')).json()) as Board;
      const rect = canvas.getBoundingClientRect();
      const state = store.get();
      store.set({
        board,
        ratsnestLines: ratsnest(board),
        view: fitToBoard(state.view, boardBBox(board), rect.width, rect.height),
        hasFitOnce: true,
      });
    } catch {
      // Fall back to refitting whenever the next ws board message lands.
      store.set({ hasFitOnce: false });
    }
  })();
}

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
    routeBtn: document.getElementById('route-btn') as HTMLButtonElement,
    routeStatus: document.getElementById('route-status')!,
    ripAllBtn: document.getElementById('ripall-btn') as HTMLButtonElement,
    exportFabBtn: document.getElementById('exportfab-btn') as HTMLButtonElement,
    exportFabStatus: document.getElementById('exportfab-status')!,
    bomList: document.getElementById('bom-list')!,
    propsPanel: document.getElementById('props-panel')!,
    projectName: document.getElementById('project-name')!,
    openBtn: document.getElementById('open-btn') as HTMLButtonElement,
    saveBtn: document.getElementById('save-btn') as HTMLButtonElement,
  },
  toolManager,
  { focusComponent, boardOpened, sendOp: (op) => wsApi.sendOp(op) },
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
// 2D / 3D view tabs. The 3D tab shows a WebGL viewer in the same viewport; its
// render loop only runs while the 3D tab is active. The board is fed to the
// viewer on every change, but it only rebuilds its scene while visible.
// ---------------------------------------------------------------------------

const viewer3dCanvas = document.getElementById('viewer3d-canvas') as HTMLCanvasElement;
const viewer3dHud = document.getElementById('viewer3d-hud') as HTMLElement;
const viewer3d = createViewer3D(viewer3dCanvas, viewportEl);

// Keep the viewer's board in sync (rebuilds itself only when the 3D tab is up).
let lastBoard3d: Board | null = null;
store.subscribe((state) => {
  if (state.board !== lastBoard3d) {
    lastBoard3d = state.board;
    viewer3d.setBoard(state.board);
  }
});

function setView(view: '2d' | '3d'): void {
  const is3d = view === '3d';
  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.classList.toggle('active', (tab as HTMLElement).dataset.view === view);
  });
  canvas.hidden = is3d;
  viewer3dCanvas.hidden = !is3d;
  viewer3dHud.hidden = !is3d;
  viewer3d.setActive(is3d);
}
document.getElementById('view-tab-2d')?.addEventListener('click', () => setView('2d'));
document.getElementById('view-tab-3d')?.addEventListener('click', () => setView('3d'));

(document.getElementById('v3d-components') as HTMLInputElement)?.addEventListener('change', (e) => {
  viewer3d.setShowComponents((e.target as HTMLInputElement).checked);
});
(document.getElementById('v3d-silk') as HTMLInputElement)?.addEventListener('change', (e) => {
  viewer3d.setShowSilk((e.target as HTMLInputElement).checked);
});

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
  KeyD: 'dimension',
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
