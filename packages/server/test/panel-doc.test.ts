import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newPanel, parsePanel, serializePanel } from '@flamingo/panel';
import { PanelDoc } from '../src/panel/doc.js';

const ADD = { op: 'addSource', source: { path: 'a.flamingo', hash: 'h', name: 'alpha' } } as const;

describe('PanelDoc', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-paneldoc-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('apply emits change, and undo/redo walk the op log', () => {
    const doc = new PanelDoc(newPanel('p'));
    const seen: number[] = [];
    doc.on('change', (p) => seen.push(p.instances.length));

    expect(doc.apply(ADD).ok).toBe(true);
    expect(doc.apply({ op: 'addInstance', source: 'A' }).ok).toBe(true);
    expect(doc.panel.instances).toHaveLength(1);
    expect(doc.canUndo).toBe(true);

    expect(doc.undo()!.instances).toHaveLength(0);
    expect(doc.canRedo).toBe(true);
    expect(doc.redo()!.instances).toHaveLength(1);
    expect(doc.redo()).toBeNull();
    expect(seen).toEqual([0, 1, 0, 1]);
  });

  it('a rejected op changes nothing and emits nothing', () => {
    const doc = new PanelDoc(newPanel('p'));
    let changes = 0;
    doc.on('change', () => changes++);
    const r = doc.apply({ op: 'removeInstance', id: 'X1' });
    expect(r.ok).toBe(false);
    expect(changes).toBe(0);
    expect(doc.canUndo).toBe(false);
  });

  it('save writes the panel atomically and load reads it back', async () => {
    const file = join(dir, 'p.flamboyance');
    const doc = new PanelDoc(newPanel('p'), file, 10_000);
    doc.apply(ADD);
    doc.apply({ op: 'addInstance', source: 'A', at: { x: 3, y: 4 } });
    await doc.save();

    expect(parsePanel(await readFile(file, 'utf8'))).toEqual(doc.panel);
    expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);

    const loaded = await PanelDoc.load(file);
    expect(loaded.panel).toEqual(doc.panel);
    expect(loaded.filePath).toBe(file);
    expect(loaded.canUndo).toBe(false);
  });

  it('autosaves after the debounce', async () => {
    const file = join(dir, 'p.flamboyance');
    const doc = new PanelDoc(newPanel('p'), file, 20);
    doc.apply(ADD);
    await new Promise((r) => setTimeout(r, 80));
    expect(parsePanel(await readFile(file, 'utf8')).sources).toHaveLength(1);
  });

  it('close flushes a pending save', async () => {
    const file = join(dir, 'p.flamboyance');
    const doc = new PanelDoc(newPanel('p'), file, 10_000);
    doc.apply(ADD);
    await doc.close();
    expect(parsePanel(await readFile(file, 'utf8')).sources).toHaveLength(1);
  });

  it('save without a file path throws; close without one is a no-op', async () => {
    const doc = new PanelDoc(newPanel('p'));
    doc.apply(ADD);
    await expect(doc.save()).rejects.toThrow('no file path');
    await expect(doc.close()).resolves.toBeUndefined();
  });

  it('reset with persist=false does not rewrite the file it just read', async () => {
    const file = join(dir, 'p.flamboyance');
    const original = JSON.stringify(JSON.parse(serializePanel(newPanel('compact'))));
    await writeFile(file, original);
    const doc = new PanelDoc(newPanel('other'), undefined, 10);
    doc.apply(ADD);
    doc.reset(parsePanel(original), file, false);
    expect(doc.canUndo).toBe(false);
    expect(doc.panel.name).toBe('compact');
    await new Promise((r) => setTimeout(r, 60));
    await doc.close();
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('saves in flight together land in call order', async () => {
    const file = join(dir, 'p.flamboyance');
    const one = new PanelDoc(newPanel('p'));
    one.apply(ADD);
    one.apply({ op: 'addInstance', source: 'A' });
    const inst = one.panel.instances[0]!;
    // A big panel first, then a small one: unchained, the small write finishes
    // first and the big one's rename lands last.
    const instances = Array.from({ length: 50_000 }, (_, i) => ({ ...inst, id: `A${i + 1}`, at: { x: i, y: 0 } }));
    const doc = new PanelDoc({ ...one.panel, instances }, file, 10_000);
    const big = doc.save();
    doc.reset(newPanel('small'));
    const small = doc.save();
    await Promise.all([big, small]);
    expect(parsePanel(await readFile(file, 'utf8')).name).toBe('small');
  });

  it('an edit made while a save is writing is still saved by close', async () => {
    const file = join(dir, 'p.flamboyance');
    const doc = new PanelDoc(newPanel('p'), file, 10_000);
    doc.apply(ADD);
    const saving = doc.save();
    doc.apply({ op: 'addInstance', source: 'A' });
    await saving;
    await doc.close();
    expect(parsePanel(await readFile(file, 'utf8')).instances).toHaveLength(1);
  });

  it('a failed save does not stop later ones', async () => {
    const file = join(dir, 'missing-dir', 'p.flamboyance');
    const doc = new PanelDoc(newPanel('p'), file, 10_000);
    doc.apply(ADD);
    await expect(doc.save()).rejects.toThrow();
    await mkdir(join(dir, 'missing-dir'));
    await doc.save();
    expect(parsePanel(await readFile(file, 'utf8')).sources).toHaveLength(1);
  });

  it('load rejects a board file', async () => {
    const file = join(dir, 'b.flamingo');
    await writeFile(file, JSON.stringify({ formatVersion: 1, name: 'b', outline: [] }));
    await expect(PanelDoc.load(file)).rejects.toThrow('Not a panel file');
  });
});

describe('PanelDoc stored curve', () => {
  const curve = {
    key: 'fnv1a:0',
    objective: 'total' as const,
    entered: [11],
    points: [{ quantity: 11, total: 40, perBoard: 3.64, way: { id: 'x', kind: 'merged' as const, title: 'one panel' }, estimate: true }],
    impossible: [],
    pricedAt: '2026-10-27T00:00:00.000Z',
  };
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-paneldoc-curve-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is saved with the file, kept out of the ops, and not undone', async () => {
    const file = join(dir, 'p.flamboyance');
    const doc = new PanelDoc(newPanel('p'), file, 10_000);
    doc.apply(ADD);
    let changes = 0;
    doc.on('change', () => changes++);
    doc.setCurve(curve);
    expect(changes).toBe(0);
    expect(doc.canUndo).toBe(true);
    expect(doc.panel).not.toHaveProperty('curve');
    await doc.save();
    expect(parsePanel(await readFile(file, 'utf8')).curve).toEqual(curve);

    doc.undo();
    expect(doc.curve).toEqual(curve);
    expect(doc.canUndo).toBe(false);

    const loaded = await PanelDoc.load(file);
    expect(loaded.curve).toEqual(curve);
    expect(loaded.panel).not.toHaveProperty('curve');
  });

  it('the same curve again schedules no save', async () => {
    const file = join(dir, 'p.flamboyance');
    const doc = new PanelDoc(newPanel('p'), file, 10_000);
    await doc.save();
    const before = await readFile(file, 'utf8');
    doc.setCurve(curve);
    await doc.save();
    const once = await readFile(file, 'utf8');
    expect(once).not.toBe(before);
    doc.setCurve(JSON.parse(JSON.stringify(curve)));
    await doc.close();
    expect(await readFile(file, 'utf8')).toBe(once);
  });
});
