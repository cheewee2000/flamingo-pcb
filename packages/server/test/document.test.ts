import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newBoard, parseBoard } from '@flamingo/engine';
import { Doc } from '../src/document.js';

function meta(name: string) {
  return { op: 'setBoardMeta' as const, name };
}

describe('Doc', () => {
  describe('filePath', () => {
    it('is undefined when constructed without one', () => {
      const doc = new Doc(newBoard('start', 2));
      expect(doc.filePath).toBeUndefined();
    });

    it('reflects the constructor path, and resetBoard\'s new path', () => {
      const doc = new Doc(newBoard('start', 2), '/tmp/x/board.flamingo');
      expect(doc.filePath).toBe('/tmp/x/board.flamingo');
      doc.resetBoard(newBoard('other', 2), '/tmp/y/other.flamingo', false);
      expect(doc.filePath).toBe('/tmp/y/other.flamingo');
    });
  });

  describe('apply/undo/redo', () => {
    it('round-trips through apply, undo, and redo', () => {
      const doc = new Doc(newBoard('start', 2));

      const r1 = doc.apply(meta('A'));
      expect(r1.ok).toBe(true);
      expect(doc.board.name).toBe('A');

      const r2 = doc.apply(meta('B'));
      expect(r2.ok).toBe(true);
      expect(doc.board.name).toBe('B');

      const afterUndo1 = doc.undo();
      expect(afterUndo1?.name).toBe('A');
      expect(doc.board.name).toBe('A');

      const afterRedo = doc.redo();
      expect(afterRedo?.name).toBe('B');
      expect(doc.board.name).toBe('B');

      // Undo all the way back to the initial board, then one more -> null.
      expect(doc.undo()?.name).toBe('A');
      expect(doc.undo()?.name).toBe('start');
      expect(doc.undo()).toBeNull();
    });

    it('clears the redo stack on a new apply after undo', () => {
      const doc = new Doc(newBoard('start', 2));
      doc.apply(meta('A'));
      doc.apply(meta('B'));
      doc.undo(); // back to A, redo=[B]
      doc.apply(meta('C')); // branches, should clear redo
      expect(doc.board.name).toBe('C');
      expect(doc.redo()).toBeNull();
    });

    it('returns null from undo/redo when the respective stack is empty', () => {
      const doc = new Doc(newBoard('start', 2));
      expect(doc.undo()).toBeNull();
      expect(doc.redo()).toBeNull();
    });

    it('returns the OpError unchanged from applyOp on failure, without mutating state', () => {
      const doc = new Doc(newBoard('start', 2));
      const result = doc.apply({ op: 'moveComponent', refdes: 'U1' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.error).toBe('string');
      }
      expect(doc.board.name).toBe('start');
      expect(doc.undo()).toBeNull(); // nothing pushed for a failed op
    });

    it('emits change on apply, undo, and redo', () => {
      const doc = new Doc(newBoard('start', 2));
      const seen: string[] = [];
      doc.on('change', (b) => seen.push(b.name));

      doc.apply(meta('A'));
      doc.apply(meta('B'));
      doc.undo();
      doc.redo();

      expect(seen).toEqual(['A', 'B', 'A', 'B']);
    });
  });

  describe('snapshot independence', () => {
    it('does not mutate a board returned by undo when later ops are applied', () => {
      const doc = new Doc(newBoard('start', 2));
      doc.apply(meta('A'));
      doc.apply(meta('B'));

      const snapshot = doc.undo(); // -> A
      expect(snapshot?.name).toBe('A');

      doc.apply(meta('C')); // branch off of A

      expect(snapshot?.name).toBe('A'); // unaffected by the later op
      expect(doc.board.name).toBe('C');
    });

    it('caps the undo stack at 200 entries', () => {
      const doc = new Doc(newBoard('start', 2));
      for (let i = 0; i < 205; i++) {
        const r = doc.apply(meta(`n${i}`));
        expect(r.ok).toBe(true);
      }
      let undone = 0;
      while (doc.undo() !== null) undone++;
      expect(undone).toBe(200);
    });
  });

  describe('persistence', () => {
    // Real, short debounce window (rather than fake timers) -- avoids racing
    // fake-timer clock advancement against real fs I/O completion.
    const DEBOUNCE_MS = 30;
    let dir: string;
    let filePath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'flamingo-doc-'));
      filePath = join(dir, 'board.flamingo');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function wait(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    it('debounces saves and writes the file after the debounce window', async () => {
      const doc = new Doc(newBoard('start', 2), filePath, DEBOUNCE_MS);

      doc.apply(meta('A'));
      expect(existsSync(filePath)).toBe(false);

      doc.apply(meta('B'));
      await wait(DEBOUNCE_MS / 2);
      expect(existsSync(filePath)).toBe(false); // reset by the second apply

      await wait(DEBOUNCE_MS * 4);
      expect(existsSync(filePath)).toBe(true);

      const saved = parseBoard(readFileSync(filePath, 'utf8'));
      expect(saved.name).toBe('B');
    });

    it('save() writes immediately and cancels a pending debounce', async () => {
      const doc = new Doc(newBoard('start', 2), filePath, DEBOUNCE_MS);
      doc.apply(meta('A'));
      await doc.save();
      expect(existsSync(filePath)).toBe(true);
      const saved = parseBoard(readFileSync(filePath, 'utf8'));
      expect(saved.name).toBe('A');
    });

    it('throws without a filePath instead of silently no-op-ing', async () => {
      const doc = new Doc(newBoard('start', 2));
      await expect(doc.save()).rejects.toThrow('no file path set — cannot save');
    });

    it('Doc.load reads back a saved board', async () => {
      const doc = new Doc(newBoard('roundtrip', 2), filePath, DEBOUNCE_MS);
      doc.apply(meta('Loaded'));
      await doc.save();

      const loaded = await Doc.load(filePath);
      expect(loaded.board.name).toBe('Loaded');
      expect(loaded.board.copperLayers).toBe(2);
    });

    it('close() flushes a pending debounced save immediately, with no wait', async () => {
      const doc = new Doc(newBoard('start', 2), filePath, DEBOUNCE_MS);
      doc.apply(meta('ClosedBeforeDebounce'));
      expect(existsSync(filePath)).toBe(false); // debounce timer hasn't fired yet

      await doc.close();

      expect(existsSync(filePath)).toBe(true);
      const saved = parseBoard(readFileSync(filePath, 'utf8'));
      expect(saved.name).toBe('ClosedBeforeDebounce');
    });

    it('close() with nothing dirty does not write a file', async () => {
      const doc = new Doc(newBoard('start', 2), filePath, DEBOUNCE_MS);
      await doc.close();
      expect(existsSync(filePath)).toBe(false);
    });

    it('close() with nothing dirty after a prior save does not write again', async () => {
      const doc = new Doc(newBoard('start', 2), filePath, DEBOUNCE_MS);
      doc.apply(meta('Saved'));
      await doc.save();
      const before = readFileSync(filePath, 'utf8');

      await doc.close();

      const after = readFileSync(filePath, 'utf8');
      expect(after).toBe(before);
    });

    it('close() on an unpathed doc resolves without throwing, even with edits applied', async () => {
      const doc = new Doc(newBoard('start', 2)); // no filePath
      doc.apply(meta('Edited'));
      await expect(doc.close()).resolves.toBeUndefined();
    });
  });

  describe('resetBoard persist option', () => {
    const DEBOUNCE_MS = 30;
    let dir: string;
    let filePath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'flamingo-doc-reset-'));
      filePath = join(dir, 'board.flamingo');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function wait(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    it('persist=false swaps the board and emits change, but schedules no save', async () => {
      const doc = new Doc(newBoard('start', 2), filePath, DEBOUNCE_MS);
      const seen: string[] = [];
      doc.on('change', (b) => seen.push(b.name));

      doc.resetBoard(newBoard('opened', 2), filePath, false);

      expect(doc.board.name).toBe('opened');
      expect(seen).toEqual(['opened']);

      await wait(DEBOUNCE_MS * 4);
      expect(existsSync(filePath)).toBe(false);
    });

    it('persist=true (default) still marks dirty and schedules a save', async () => {
      const doc = new Doc(newBoard('start', 2), filePath, DEBOUNCE_MS);

      doc.resetBoard(newBoard('created', 2), filePath, true);

      await wait(DEBOUNCE_MS * 4);
      expect(existsSync(filePath)).toBe(true);
      const saved = parseBoard(readFileSync(filePath, 'utf8'));
      expect(saved.name).toBe('created');
    });

    it('persist defaults to true when omitted', async () => {
      const doc = new Doc(newBoard('start', 2), filePath, DEBOUNCE_MS);

      doc.resetBoard(newBoard('created', 2), filePath);

      await wait(DEBOUNCE_MS * 4);
      expect(existsSync(filePath)).toBe(true);
    });
  });
});
