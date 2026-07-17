/**
 * Flamingo UI - editing-tool contract (Task 10).
 *
 * Each `tools/*.ts` file (other than this one and `overlay-utils.ts`)
 * implements exactly one `Tool`. main.ts owns a `ToolManager` (manager.ts)
 * that holds the single active tool and routes canvas pointer/keyboard
 * events plus the per-frame overlay draw to it. Tools never mutate the
 * board directly -- every edit goes out via `ToolCtx.sendOp`, and the
 * server (as the single authority) echoes back the new board over the
 * WebSocket, which flows into `store` the normal way.
 *
 * Tools keep their own transient state (drag start point, in-progress
 * polygon points, ...) as plain closure variables inside their factory
 * function -- there is exactly one live instance per tool (created once by
 * `createToolManager`), so this is simpler than threading transient state
 * through `AppState` and avoids extra store churn on every mousemove.
 */

import type { Op, Point } from '@flamingo/engine';
import type { AppState, ViewTransform } from '../state.js';

/** A pointer event already translated into world space, with grid-snap applied. */
export interface PointerEvt {
  /** World mm, snapped per the current grid-snap setting (bypassed while Ctrl/Cmd is held). */
  world: Point;
  /** World mm, never snapped -- useful for hit-testing against the actual cursor position. */
  worldRaw: Point;
  /** Canvas-relative CSS px. */
  screen: Point;
  button: number;
  shift: boolean;
  alt: boolean;
  ctrlOrCmd: boolean;
}

/** What a tool needs from the app to do its job -- the store and the WS op channel. */
export interface ToolCtx {
  /** Send an Op to the server. The server is the single authority -- tools never mutate the local board. */
  sendOp(op: Op): void;
  getState(): AppState;
  setState(patch: Partial<AppState>): void;
  /** Positioned ancestor of the canvas (#viewport) -- for tools that need to
   * overlay real DOM elements (silk's inline text input). */
  viewportEl: HTMLElement;
}

export interface Tool {
  readonly id: string;
  readonly label: string;
  /** Single-letter keyboard shortcut (display only -- routing lives in manager.ts/main.ts's shortcut map). */
  readonly shortcut: string;
  /** CSS cursor to show while this tool is active (see style.css `[data-tool]` rules). */
  readonly cursor?: string;

  /** Called once when this tool becomes active. */
  onActivate?(ctx: ToolCtx): void;
  /** Called once when another tool becomes active -- must discard any in-progress state (drag, pending polygon, pending input). */
  onDeactivate?(ctx: ToolCtx): void;

  onPointerDown?(ev: PointerEvt, ctx: ToolCtx): void;
  onPointerMove?(ev: PointerEvt, ctx: ToolCtx): void;
  onPointerUp?(ev: PointerEvt, ctx: ToolCtx): void;
  onDoubleClick?(ev: PointerEvt, ctx: ToolCtx): void;

  /** Return true to mark the key as handled (suppresses the global tool-switch-shortcut/flip-view/fit-to-board fallback). */
  onKey?(ev: KeyboardEvent, ctx: ToolCtx): boolean | void;

  /** Draw any in-progress preview (ghost outline, ruler, polygon-in-progress) on top of the normal board render. */
  drawOverlay?(ctx2d: CanvasRenderingContext2D, view: ViewTransform, state: AppState): void;
}
