/**
 * Flamingo Panel - undo/redo history.
 *
 * The same snapshot scheme the board `Doc` uses (server/src/document.ts):
 * every applied op pushes the state it replaced, undo pops it back, and any
 * new op clears the redo stack. It is generic over the state type and knows
 * nothing about panels, files or sockets, so it can be unit-tested on its own
 * and reused by anything that reduces ops over immutable snapshots.
 */

export const HISTORY_CAP = 200;

export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];

  constructor(
    private current: T,
    private readonly cap: number = HISTORY_CAP,
  ) {}

  get state(): T {
    return this.current;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Record `next` as the new state; the state it replaces becomes undoable. */
  commit(next: T): void {
    this.undoStack.push(this.current);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.redoStack = [];
    this.current = next;
  }

  undo(): T | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(this.current);
    this.current = prev;
    return prev;
  }

  redo(): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(this.current);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.current = next;
    return next;
  }

  /** Replace the state and forget all history (open / new). */
  reset(state: T): void {
    this.current = state;
    this.undoStack = [];
    this.redoStack = [];
  }
}
