/**
 * Flamingo UI - typed app state store.
 *
 * A single mutable state object plus a subscribe/notify pattern. Every
 * mutation goes through `setState`, which merges the patch and notifies
 * subscribers synchronously. `renderer.ts` subscribes and marks itself
 * dirty (rAF-scheduled redraw) rather than drawing inline here, so this
 * module has no dependency on canvas/DOM.
 */

import type { Board, Point, RatLine } from '@flamingo/engine';

/** Pan/zoom/flip transform between world mm (y-up) and canvas px (y-down). */
export interface ViewTransform {
  /** Pixels per millimeter. Clamped to [0.5, 200]. */
  scale: number;
  /** World point (mm) that maps to canvas pixel (0, 0) is NOT tracked directly;
   * instead we track the px offset of world origin (0,0) for cheap incremental
   * pan math: screenX = originPxX + worldX * scale * (flipped ? -1 : 1);
   * screenY = originPxY - worldY * scale. */
  originPxX: number;
  originPxY: number;
  /** True when viewing the board from the bottom (mirrors X, shows BOTTOM badge). */
  flipped: boolean;
}

/** What's under the cursor / selected, resolved by hit-testing in main.ts. */
export type HitInfo =
  | { kind: 'pad'; refdes: string; padNumber: string; net: string }
  | { kind: 'track'; id: string; net: string }
  | { kind: 'via'; id: string; net: string };

/**
 * Layer-visibility checkbox keys: one per copper layer present on the current
 * board (LayerId, e.g. 'F.Cu'/'B.Cu'), plus the two fixed pseudo-layers
 * 'Silk' (both F.Silk+B.Silk together) and 'Ratsnest'. Board outline (Edge)
 * and keepouts are always drawn -- they have no checkbox.
 */
export type LayerKey = string;

export interface AppState {
  board: Board | null;
  /** Ratsnest lines recomputed client-side whenever `board` changes (not
   * every frame -- connectivity is O(nets) and only needs to track edits). */
  ratsnestLines: RatLine[];
  /** Net name currently selected (click-to-highlight), or null. */
  selectedNet: string | null;
  /** Nearest hit under the cursor, or null. */
  hover: HitInfo | null;
  view: ViewTransform;
  layerVisibility: Record<LayerKey, boolean>;
  /** WebSocket connection status for the status bar. */
  connected: boolean;
  /** Always empty for now -- DRC markers land in a later task; the field
   * exists so renderer.ts/panels.ts already know how to draw/report them. */
  drcMarkers: Point[];
  /** Cursor position in world mm, for the status bar readout. Null when the
   * pointer is outside the canvas. */
  cursorMm: Point | null;
  /** Set once fit-to-board has run for the first board received. */
  hasFitOnce: boolean;
}

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 200;

export const SILK_KEY = 'Silk';
export const RATSNEST_KEY = 'Ratsnest';

function initialState(): AppState {
  return {
    board: null,
    ratsnestLines: [],
    selectedNet: null,
    hover: null,
    view: { scale: 10, originPxX: 0, originPxY: 0, flipped: false },
    layerVisibility: { [SILK_KEY]: true, [RATSNEST_KEY]: true },
    connected: false,
    drcMarkers: [],
    cursorMm: null,
    hasFitOnce: false,
  };
}

/**
 * Merge newly-seen layer keys (e.g. copper layers of a just-loaded board)
 * into `current`, defaulting any key not already present to visible. Never
 * removes a key -- switching board layer counts just leaves stale keys
 * unused.
 */
export function withLayerKeys(current: Record<LayerKey, boolean>, keys: LayerKey[]): Record<LayerKey, boolean> {
  const next = { ...current };
  for (const k of keys) {
    if (!(k in next)) next[k] = true;
  }
  return next;
}

type Listener = (state: AppState) => void;

/** Minimal typed store: get/set/subscribe. Notifies are synchronous. */
class Store {
  private state: AppState = initialState();
  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  /** Shallow-merge `patch` into state and notify subscribers. */
  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const store = new Store();
