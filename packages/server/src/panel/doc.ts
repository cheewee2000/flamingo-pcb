/**
 * In-memory host for a panel: the panel counterpart of `Doc` (document.ts).
 *
 * Same behaviour on purpose: an op that succeeds pushes the state it replaced
 * onto the undo stack, clears redo, emits 'change' and schedules a debounced
 * atomic save; open/new swap the panel in place and forget history. The
 * undo/redo bookkeeping itself is the generic `History` from @flamingo/panel.
 *
 * `Doc` was left untouched rather than rebuilt on `History`, so the board
 * editor cannot change behaviour because panels exist.
 */

import { EventEmitter } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Panel, PanelCurve, PanelOp, PanelOpError, PanelOpResult } from '@flamingo/panel';
import { applyPanelOp, History, parsePanel, serializePanel } from '@flamingo/panel';

const DEFAULT_DEBOUNCE_MS = 500;

export class PanelDoc extends EventEmitter {
  private history: History<Panel>;
  private _filePath: string | undefined;
  private readonly debounceMs: number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** Bumped on every change to the panel, so a finishing save knows whether it wrote the current one. */
  private version = 0;
  /** Saves run one at a time, in call order, so an older panel's rename never lands last. */
  private saveChain: Promise<void> = Promise.resolve();
  /**
   * The stored cost curve, held beside the history rather than in it: a
   * cache that an undo must not roll back and that is no undo step itself.
   */
  private _curve: PanelCurve | undefined;

  constructor(initial: Panel, filePath?: string, debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    super();
    const { curve, ...panel } = initial;
    this.history = new History(panel);
    this._curve = curve;
    this._filePath = filePath;
    this.debounceMs = debounceMs;
  }

  /** The panel the ops edit; never carries the stored curve. */
  get panel(): Panel {
    return this.history.state;
  }

  get curve(): PanelCurve | undefined {
    return this._curve;
  }

  /**
   * Keep a priced curve with the file. Not an undo step and not a change to
   * the panel (no 'change' is emitted); the same curve again writes nothing.
   */
  setCurve(curve: PanelCurve | undefined): void {
    if (curve === this._curve) return;
    if (JSON.stringify(curve ?? null) === JSON.stringify(this._curve ?? null)) return;
    this._curve = curve;
    this.version++;
    if (this._filePath) this.dirty = true;
    this.scheduleSave();
  }

  get filePath(): string | undefined {
    return this._filePath;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** Apply an op. On success it becomes one undo step; on failure nothing changes. */
  apply(op: PanelOp): PanelOpResult | PanelOpError {
    const result = applyPanelOp(this.history.state, op);
    if (result.ok) {
      this.history.commit(result.panel);
      this.changed();
    }
    return result;
  }

  undo(): Panel | null {
    const prev = this.history.undo();
    if (prev !== null) this.changed();
    return prev;
  }

  redo(): Panel | null {
    const next = this.history.redo();
    if (next !== null) this.changed();
    return next;
  }

  /**
   * Swap in another panel (and optionally the path saves go to), forgetting
   * history. `persist` false is for opening a file that is already on disk:
   * reading a file must not rewrite it.
   */
  reset(panel: Panel, filePath?: string, persist = true): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const { curve, ...rest } = panel;
    this.history.reset(rest);
    this._curve = curve;
    this.version++;
    if (filePath !== undefined) this._filePath = filePath;
    this.dirty = false;
    if (persist && this._filePath) this.dirty = true;
    this.emit('change', this.panel);
    if (persist) this.scheduleSave();
  }

  /**
   * Tell listeners that something the panel depends on changed without the
   * panel itself changing (a source board was edited on disk).
   */
  touch(): void {
    this.emit('change', this.panel);
  }

  private changed(): void {
    this.version++;
    if (this._filePath) this.dirty = true;
    this.emit('change', this.panel);
    this.scheduleSave();
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
   * Write now, atomically (tmp file + rename). Rejects without a file path.
   * Chained like `Doc.save()`: the autosave and a panel_save or close() in
   * flight together write in call order, so the last one called wins.
   */
  save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this._filePath) return Promise.reject(new Error('no file path set — cannot save'));
    const task = this.saveChain.then(() => this.doSave());
    // A failed save must not wedge the ones queued after it.
    this.saveChain = task.catch(() => undefined);
    return task;
  }

  private async doSave(): Promise<void> {
    const filePath = this._filePath;
    if (!filePath) throw new Error('no file path set — cannot save');
    const version = this.version;
    const tmpPath = `${filePath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, serializePanel(this._curve ? { ...this.panel, curve: this._curve } : this.panel), 'utf8');
    await rename(tmpPath, filePath);
    // An edit made while this was writing is not on disk yet.
    if (this.version === version) this.dirty = false;
  }

  /** Flush unsaved changes, if any. Safe to call repeatedly. */
  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty && this._filePath) await this.save();
  }

  static async load(filePath: string): Promise<PanelDoc> {
    return new PanelDoc(parsePanel(await readFile(filePath, 'utf8')), filePath);
  }
}
