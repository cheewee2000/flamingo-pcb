/**
 * Flamingo UI - pan/zoom/flip view transform + the pointer/wheel/keyboard
 * handlers that drive it.
 *
 * World space: mm, y-up (engine convention). Screen space: CSS px, y-down,
 * origin at the canvas's top-left. `ViewTransform` (state.ts) tracks a px/mm
 * scale plus the screen-px position of the world origin; flipping mirrors X
 * (viewing the board from the bottom) without touching Y.
 */

import type { Point } from '@flamingo/engine';
import { MAX_SCALE, MIN_SCALE, type ViewTransform } from './state.js';

const ZOOM_STEP = 1.15;
const FIT_MARGIN_PX = 32;
const FIT_MARGIN_MM = 2;

function sign(view: ViewTransform): 1 | -1 {
  return view.flipped ? -1 : 1;
}

/** World mm -> canvas px. */
export function worldToScreen(view: ViewTransform, p: Point): Point {
  return {
    x: view.originPxX + p.x * view.scale * sign(view),
    y: view.originPxY - p.y * view.scale,
  };
}

/** Canvas px -> world mm. */
export function screenToWorld(view: ViewTransform, p: Point): Point {
  return {
    x: (p.x - view.originPxX) / (view.scale * sign(view)),
    y: (view.originPxY - p.y) / view.scale,
  };
}

/** Zoom by `factor`, keeping the world point currently under `screenPt` fixed on screen. */
export function zoomAt(view: ViewTransform, screenPt: Point, factor: number): ViewTransform {
  const world = screenToWorld(view, screenPt);
  const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const s = view.flipped ? -1 : 1;
  return {
    ...view,
    scale: newScale,
    originPxX: screenPt.x - world.x * newScale * s,
    originPxY: screenPt.y + world.y * newScale,
  };
}

/** Pan by a screen-space delta (px). Independent of scale/flip. */
export function panBy(view: ViewTransform, dxPx: number, dyPx: number): ViewTransform {
  return { ...view, originPxX: view.originPxX + dxPx, originPxY: view.originPxY + dyPx };
}

/** Toggle top/bottom viewing, mirroring X about the current canvas center. */
export function flipView(view: ViewTransform, canvasWidthPx: number, canvasHeightPx: number): ViewTransform {
  const center = { x: canvasWidthPx / 2, y: canvasHeightPx / 2 };
  const world = screenToWorld(view, center);
  const flipped = !view.flipped;
  const s = flipped ? -1 : 1;
  return {
    ...view,
    flipped,
    originPxX: center.x - world.x * view.scale * s,
  };
}

/** Fit `bbox` (world mm) centered in a canvas of the given px size. Preserves current flip state. */
export function fitToBoard(
  view: ViewTransform,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  canvasWidthPx: number,
  canvasHeightPx: number,
): ViewTransform {
  const w = Math.max(bbox.maxX - bbox.minX, 1e-6) + 2 * FIT_MARGIN_MM;
  const h = Math.max(bbox.maxY - bbox.minY, 1e-6) + 2 * FIT_MARGIN_MM;
  const availW = Math.max(canvasWidthPx - 2 * FIT_MARGIN_PX, 10);
  const availH = Math.max(canvasHeightPx - 2 * FIT_MARGIN_PX, 10);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(availW / w, availH / h)));
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const s = view.flipped ? -1 : 1;
  return {
    ...view,
    scale,
    originPxX: canvasWidthPx / 2 - cx * scale * s,
    originPxY: canvasHeightPx / 2 + cy * scale,
  };
}

export interface ViewControls {
  detach(): void;
  /** True while a middle-button, right-button, or space+left-drag pan gesture is
   * in progress -- main.ts uses this to suppress editing-tool pointerdown routing
   * so panning never also starts a tool gesture (component drag, new polygon
   * point, ...). */
  isPanning(): boolean;
}

/**
 * Wire wheel-zoom-at-cursor and middle-button/right-button/space+drag pan onto
 * `canvas` (the canvas context menu is suppressed so right-drag pans cleanly).
 * Reads the current view via `getView`, writes updates via `setView`
 * (typically `store.set({view})`); does not own state itself.
 */
export function attachViewControls(
  canvas: HTMLCanvasElement,
  getView: () => ViewTransform,
  setView: (v: ViewTransform) => void,
): ViewControls {
  let spaceHeld = false;
  let panning = false;
  let lastX = 0;
  let lastY = 0;

  function canvasPoint(ev: MouseEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    setView(zoomAt(getView(), canvasPoint(ev), factor));
  }

  function startPan(x: number, y: number): void {
    panning = true;
    lastX = x;
    lastY = y;
    canvas.classList.add('panning');
  }

  function onMouseDown(ev: MouseEvent): void {
    const isMiddle = ev.button === 1;
    const isRight = ev.button === 2;
    const isSpaceDrag = ev.button === 0 && spaceHeld;
    if (!isMiddle && !isRight && !isSpaceDrag) return;
    ev.preventDefault();
    startPan(ev.clientX, ev.clientY);
  }

  function onMouseMove(ev: MouseEvent): void {
    if (!panning) return;
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    setView(panBy(getView(), dx, dy));
  }

  function endPan(): void {
    panning = false;
    canvas.classList.remove('panning');
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.code === 'Space') spaceHeld = true;
  }

  function onKeyUp(ev: KeyboardEvent): void {
    if (ev.code === 'Space') spaceHeld = false;
  }

  // Right-button drag pans too, so suppress the canvas context menu -- otherwise
  // the menu pops on right-button release and interrupts the gesture.
  function onContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
  }

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', endPan);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('contextmenu', onContextMenu);
  // Prevent the browser's default middle-click autoscroll cursor from showing.
  canvas.addEventListener('auxclick', (ev) => ev.preventDefault());

  return {
    detach(): void {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', endPan);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
    isPanning: () => panning,
  };
}
