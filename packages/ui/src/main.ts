/**
 * Flamingo UI - entry point. Wires the store, WebSocket client, view
 * controls, renderer, and panels together; owns hit-testing (hover/click)
 * and the F/Home keyboard shortcuts.
 */

import './style.css';
import type { Board, ComponentInst, Pad, Point, Track, Via } from '@flamingo/engine';
import { boardBBox, dist, padOutline, pointInPolygon, pointSegDistance, ratsnest } from '@flamingo/engine';
import { store, type AppState, type HitInfo } from './state.js';
import { attachViewControls, fitToBoard, flipView, screenToWorld } from './view.js';
import { createRenderer } from './renderer.js';
import { initPanels } from './panels.js';
import { connectWs } from './ws.js';

const canvas = document.getElementById('board-canvas') as HTMLCanvasElement;

initPanels({
  layerList: document.getElementById('layer-list')!,
  netList: document.getElementById('net-list')!,
  boardInfo: document.getElementById('board-info')!,
  sideBadge: document.getElementById('side-badge')!,
  statusCursor: document.getElementById('status-cursor')!,
  statusZoom: document.getElementById('status-zoom')!,
  statusHover: document.getElementById('status-hover')!,
  statusConn: document.getElementById('status-conn')!,
});

const renderer = createRenderer(canvas, () => store.get());
store.subscribe(() => renderer.requestRedraw());

attachViewControls(
  canvas,
  () => store.get().view,
  (v) => store.set({ view: v }),
);

// ---------------------------------------------------------------------------
// Hit-testing: nearest pad (point-in-polygon) / track (distance-to-segment)
// / via (distance-to-center) under a world-space point. Tolerance grows at
// low zoom so clicks/hovers stay forgiving when the board is small on screen.
// ---------------------------------------------------------------------------

const TOLERANCE_PX = 4;

function findNet(board: Board, refdes: string, padNumber: string): string | undefined {
  const ref = `${refdes}.${padNumber}`;
  return board.nets.find((n) => n.pins.includes(ref))?.name;
}

function hitTest(board: Board, world: Point, scale: number): HitInfo | null {
  const tolMm = TOLERANCE_PX / scale;
  let best: { score: number; hit: HitInfo } | null = null;

  function consider(score: number, hit: HitInfo): void {
    if (!best || score < best.score) best = { score, hit };
  }

  for (const c of board.components as ComponentInst[]) {
    for (const pad of c.footprint.pads as Pad[]) {
      const outline = padOutline(c, pad);
      const inside = pointInPolygon(world, outline);
      let edgeDist = Infinity;
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i];
        const b = outline[(i + 1) % outline.length];
        edgeDist = Math.min(edgeDist, pointSegDistance(world, { type: 'line', start: a, end: b }));
      }
      if (inside || edgeDist < tolMm) {
        const net = findNet(board, c.refdes, pad.number);
        if (net) consider(inside ? 0 : edgeDist, { kind: 'pad', refdes: c.refdes, padNumber: pad.number, net });
      }
    }
  }

  for (const t of board.tracks as Track[]) {
    const d = pointSegDistance(world, t.seg);
    if (d < t.width / 2 + tolMm) {
      consider(Math.max(0, d - t.width / 2), { kind: 'track', id: t.id, net: t.net });
    }
  }

  for (const v of board.vias as Via[]) {
    const d = dist(world, v.at);
    if (d < v.diameter / 2 + tolMm) {
      consider(Math.max(0, d - v.diameter / 2), { kind: 'via', id: v.id, net: v.net });
    }
  }

  return best ? (best as { score: number; hit: HitInfo }).hit : null;
}

function canvasPoint(ev: MouseEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

canvas.addEventListener('mousemove', (ev) => {
  const state = store.get();
  const world = screenToWorld(state.view, canvasPoint(ev));
  const hover = state.board ? hitTest(state.board, world, state.view.scale) : null;
  store.set({ cursorMm: world, hover });
});

canvas.addEventListener('mouseleave', () => {
  store.set({ cursorMm: null, hover: null });
});

let downPos: Point | null = null;
canvas.addEventListener('mousedown', (ev) => {
  if (ev.button === 0) downPos = canvasPoint(ev);
});
canvas.addEventListener('click', (ev) => {
  const p = canvasPoint(ev);
  const wasDrag = downPos !== null && dist(downPos, p) > 4;
  downPos = null;
  if (wasDrag) return; // drag-pan, not a click-to-select

  const state = store.get();
  if (!state.board) return;
  const world = screenToWorld(state.view, p);
  const hit = hitTest(state.board, world, state.view.scale);
  store.set({ selectedNet: hit ? (state.selectedNet === hit.net ? null : hit.net) : null });
});

// ---------------------------------------------------------------------------
// Keyboard: F = flip to bottom view, Home = fit to board
// ---------------------------------------------------------------------------

function isTypingTarget(ev: KeyboardEvent): boolean {
  const el = ev.target;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

window.addEventListener('keydown', (ev) => {
  if (isTypingTarget(ev)) return;
  const state = store.get();
  const rect = canvas.getBoundingClientRect();
  if (ev.code === 'KeyF') {
    store.set({ view: flipView(state.view, rect.width, rect.height) });
  } else if (ev.code === 'Home' && state.board) {
    const bbox = boardBBox(state.board);
    store.set({ view: fitToBoard(state.view, bbox, rect.width, rect.height) });
  }
});

// ---------------------------------------------------------------------------
// Live sync
// ---------------------------------------------------------------------------

connectWs({
  onBoard(board: Board) {
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
  },
  onConnectionChange(connected: boolean) {
    store.set({ connected });
  },
});
