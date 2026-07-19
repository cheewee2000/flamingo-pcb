import { EventEmitter } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Board, Op, OpError, OpResult } from '@flamingo/engine';
import { applyOp, parseBoard, serializeBoard } from '@flamingo/engine';
import type { RouteStatus } from './autoroute.js';

const UNDO_CAP = 200;
const DEFAULT_DEBOUNCE_MS = 500;

/**
 * In-memory document host wrapping a Board with undo/redo and optional
 * debounced disk persistence.
 *
 * Snapshot safety: `applyOp` structuredClone()s the board on every call, so
 * boards pushed onto the undo/redo stacks are never mutated by later
 * operations -- a value returned by `undo()`/`redo()` stays exactly as it
 * was even after further `apply()` calls.
 */
export class Doc extends EventEmitter {
  private _board: Board;
  private _filePath: string | undefined;
  private readonly debounceMs: number;
  private undoStack: Board[] = [];
  private redoStack: Board[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(initial: Board, filePath?: string, debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    super();
    this._board = initial;
    this._filePath = filePath;
    this.debounceMs = debounceMs;
  }

  get board(): Board {
    return this._board;
  }

  /** The board's current on-disk path, if any (set by the constructor/resetBoard). */
  get filePath(): string | undefined {
    return this._filePath;
  }

  /**
   * Emit a transient autoroute progress/terminal status. Not document state
   * (no undo, no persistence) -- it rides the same emitter as 'change' so the
   * HTTP layer can fan it out to every websocket client (see attachWebSocket).
   */
  emitRouteStatus(status: RouteStatus): void {
    this.emit('routeStatus', status);
  }

  /**
   * Apply an Op to the current board. On success: push the pre-op board
   * onto the undo stack (capped at 200), clear the redo stack, emit
   * 'change' with the new board, and (if constructed with a filePath)
   * schedule a debounced save. Returns the OpResult/OpError from applyOp
   * unchanged.
   */
  apply(op: Op): OpResult | OpError {
    const result = applyOp(this._board, op);
    if (result.ok) {
      this.pushUndo(this._board);
      this.redoStack = [];
      this._board = result.board;
      this.markDirty();
      this.emit('change', this._board);
      this.scheduleSave();
    }
    return result;
  }

  undo(): Board | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(this._board);
    this._board = prev;
    this.markDirty();
    this.emit('change', this._board);
    this.scheduleSave();
    return this._board;
  }

  redo(): Board | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.pushUndo(this._board);
    this._board = next;
    this.markDirty();
    this.emit('change', this._board);
    this.scheduleSave();
    return this._board;
  }

  /**
   * Replace the entire board (and, optionally, the file path future saves
   * target), discarding undo/redo history. Used by the MCP new_board/
   * open_board tools, which point a *running* server at a different board --
   * every other route/socket keeps referencing this same Doc instance, so
   * this mutates state in place rather than requiring a new Doc.
   *
   * `persist` (default true) controls whether this swap marks the doc dirty
   * and schedules a debounced save -- new_board wants that (it's creating
   * content that needs to land on disk), but open_board is a pure read of an
   * already-on-disk file and must not trigger a rewrite of the file it just
   * read. Either way the board is swapped and 'change' is emitted.
   */
  resetBoard(board: Board, filePath?: string, persist = true): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this._board = board;
    if (filePath !== undefined) this._filePath = filePath;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    if (persist) this.markDirty();
    this.emit('change', this._board);
    if (persist) this.scheduleSave();
  }

  private markDirty(): void {
    if (this._filePath) this.dirty = true;
  }

  private pushUndo(board: Board): void {
    this.undoStack.push(board);
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
  }

  private scheduleSave(): void {
    if (!this._filePath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((err: unknown) => {
        console.error(`[flamingo] failed to save ${this._filePath}:`, err);
        this.emit('saveError', err);
      });
    }, this.debounceMs);
  }

  /**
   * Force an immediate, atomic write (write tmp file + rename). Throws if no
   * filePath is set -- there is nothing to write to, and silently succeeding
   * would let callers (e.g. the save_board MCP tool) report "Saved." having
   * written nothing. Also throws on write failure -- direct callers (HTTP
   * /api/save, close()) are responsible for handling/reporting the error;
   * the debounced path installed by scheduleSave() catches instead (and
   * never fires without a filePath in the first place -- see scheduleSave).
   */
  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this._filePath) throw new Error('no file path set — cannot save');
    const data = serializeBoard(this._board);
    const tmpPath = `${this._filePath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, data, 'utf8');
    await rename(tmpPath, this._filePath);
    this.dirty = false;
  }

  /**
   * Cancel any pending debounced save and, if there are unsaved changes,
   * flush them synchronously with respect to the caller. Safe to call
   * multiple times or with nothing dirty (no-op write in that case). Only
   * attempts the flush when a filePath is set -- markDirty() never sets
   * dirty without one, so this is belt-and-suspenders against save()'s new
   * throw-without-a-filePath behavior, keeping close() on an unpathed Doc a
   * clean no-op rather than a rejection.
   */
  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty && this._filePath) {
      await this.save();
    }
  }

  static async load(filePath: string): Promise<Doc> {
    const data = await readFile(filePath, 'utf8');
    const board = parseBoard(data);
    return new Doc(board, filePath);
  }
}
