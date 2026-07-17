import { EventEmitter } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Board, Op, OpError, OpResult } from '@flamingo/engine';
import { applyOp, parseBoard, serializeBoard } from '@flamingo/engine';

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
  private filePath: string | undefined;
  private readonly debounceMs: number;
  private undoStack: Board[] = [];
  private redoStack: Board[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(initial: Board, filePath?: string, debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    super();
    this._board = initial;
    this.filePath = filePath;
    this.debounceMs = debounceMs;
  }

  get board(): Board {
    return this._board;
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
   */
  resetBoard(board: Board, filePath?: string): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this._board = board;
    if (filePath !== undefined) this.filePath = filePath;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.markDirty();
    this.emit('change', this._board);
    this.scheduleSave();
  }

  private markDirty(): void {
    if (this.filePath) this.dirty = true;
  }

  private pushUndo(board: Board): void {
    this.undoStack.push(board);
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
  }

  private scheduleSave(): void {
    if (!this.filePath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((err: unknown) => {
        console.error(`[flamingo] failed to save ${this.filePath}:`, err);
        this.emit('saveError', err);
      });
    }, this.debounceMs);
  }

  /**
   * Force an immediate, atomic write (write tmp file + rename). No-op
   * without a filePath. Throws on failure -- direct callers (HTTP
   * /api/save, close()) are responsible for handling/reporting the error;
   * the debounced path installed by scheduleSave() catches instead.
   */
  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.filePath) return;
    const data = serializeBoard(this._board);
    const tmpPath = `${this.filePath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, data, 'utf8');
    await rename(tmpPath, this.filePath);
    this.dirty = false;
  }

  /**
   * Cancel any pending debounced save and, if there are unsaved changes,
   * flush them synchronously with respect to the caller. Safe to call
   * multiple times or with nothing dirty (no-op write in that case).
   */
  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      await this.save();
    }
  }

  static async load(filePath: string): Promise<Doc> {
    const data = await readFile(filePath, 'utf8');
    const board = parseBoard(data);
    return new Doc(board, filePath);
  }
}
