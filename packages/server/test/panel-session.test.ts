import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeBoard } from '@flamingo/engine';
import type { PanelSession } from '../src/panel/session.js';
import { miniBoard, testSession, writeBoards } from './panel-helpers.js';

// Lets a test hold the next source read until it says so.
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
vi.mock('@flamingo/panel/node', async (original) => {
  const m = await original<typeof import('@flamingo/panel/node')>();
  return {
    ...m,
    resolveSources: async (...args: Parameters<typeof m.resolveSources>) => {
      const sources = await m.resolveSources(...args);
      const hold = gate.hold;
      gate.hold = null;
      if (hold) await hold;
      return sources;
    },
  };
});

/** The session's private parts a test needs to reach. */
interface Internals {
  drcCache: Map<string, { hash: string }>;
}

function internals(session: PanelSession): Internals {
  return session as unknown as Internals;
}

describe('PanelSession derived state', () => {
  let dir: string;
  let session: PanelSession;
  let mini: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-session-'));
    ({ mini } = await writeBoards(dir));
    session = testSession(dir, { watchMs: 0 });
    await session.create('p');
    expect((await session.addBoard('mini.flamingo', { key: 'M', needed: 1 })).ok).toBe(true);
    expect(session.apply({ op: 'addInstance', source: 'M' }).ok).toBe(true);
  });

  afterEach(async () => {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('a board saved while a view is deriving is not hidden behind that view', async () => {
    // Hold the first derivation inside its source read.
    let release!: () => void;
    gate.hold = new Promise<void>((r) => (release = r));

    const first = session.view();
    await new Promise((r) => setTimeout(r, 20));
    const edited = miniBoard();
    edited.name = 'mini, saved mid-derive';
    await writeFile(mini, serializeBoard(edited));
    session.touch();

    const second = session.view();
    expect(second).not.toBe(first);
    release();
    expect((await first).sources[0]!.name).toBe('mini');
    expect((await second).sources[0]!.name).toBe('mini, saved mid-derive');
    // And the old view was not cached over the new one.
    expect((await session.view()).sources[0]!.name).toBe('mini, saved mid-derive');
  });

  it('keeps one DRC result per source board', async () => {
    await session.view();
    const cache = internals(session).drcCache;
    expect([...cache.keys()]).toEqual(['M']);
    const before = cache.get('M')!.hash;

    const edited = miniBoard();
    edited.components[0]!.at.x += 1;
    await writeFile(mini, serializeBoard(edited));
    session.touch();
    await session.view();
    expect([...cache.keys()]).toEqual(['M']);
    expect(cache.get('M')!.hash).not.toBe(before);
  });

  it('duplicates beside the original from the board geometry, without deriving a view', async () => {
    const view = vi.spyOn(session, 'view');
    expect(session.apply({ op: 'rotateInstance', id: 'M1', rotation: 90 }).ok).toBe(true);
    const m1 = session.panel.instances.find((i) => i.id === 'M1')!;
    const r = await session.duplicateInstance('M1');
    expect(r.ok).toBe(true);
    const m2 = session.panel.instances.find((i) => i.id === 'M2')!;
    // mini is 18 x 12: turned 90 degrees it is 12 wide.
    expect(m2.at.x).toBeCloseTo(m1.at.x + 12 + session.panel.settings.spacing);
    expect(m2.at.y).toBe(m1.at.y);
    expect(m2.rotation).toBe(90);
    expect(view).not.toHaveBeenCalled();
  });
});

describe('PanelSession cost curve', () => {
  let dir: string;
  let session: PanelSession;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-curve-'));
    await writeBoards(dir);
    session = testSession(dir, { watchMs: 0 });
    await session.create('p');
    expect((await session.addBoard('mini.flamingo', { key: 'M', needed: 11 })).ok).toBe(true);
  });

  afterEach(async () => {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('puts the quantity entered on the curve, stores the points in the file, and reuses them', async () => {
    const first = await session.costCurve();
    expect(first.entered).toEqual([11]);
    expect(first.points.some((p) => p.quantity === 11)).toBe(true);
    expect(first.priced).toBe(first.points.length + first.impossible.length);
    expect(session.doc.curve?.entered).toEqual([11]);

    expect(session.apply({ op: 'setQuantity', key: 'M', needed: 7 }).ok).toBe(true);
    const second = await session.costCurve();
    expect(second.entered).toEqual([7, 11]);
    expect(second.priced).toBe(1);

    await session.save();
    const other = testSession(dir, { watchMs: 0 });
    try {
      expect((await other.open(join(dir, 'p.flamboyance'))).ok).toBe(true);
      const third = await other.costCurve();
      expect(third.priced).toBe(0);
      expect(third.points).toEqual(second.points);
    } finally {
      await other.close();
    }
  });
});

describe('PanelSession part lookup', () => {
  it("puts JLCPCB's library data on the resolved parts, and its basic flag over the board's", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-session-parts-'));
    const session = testSession(dir, {
      watchMs: 0,
      partLookup: async (lcsc) =>
        lcsc === 'C25804'
          ? { jlc: { basic: false, standardOnly: true, prices: [{ from: 1, to: null, price: 0.002 }], attrition: { loss: 10, minimum: 20 } } }
          : { unitPrice: 1.5 },
    });
    try {
      await writeBoards(dir);
      await session.create('p');
      expect((await session.addBoard('mini.flamingo', { key: 'M', needed: 1 })).ok).toBe(true);
      expect(session.apply({ op: 'addInstance', source: 'M' }).ok).toBe(true);
      const parts = (await session.resolved())[0]!.geometry!.parts;
      const r = parts.find((p) => p.lcsc === 'C25804')!;
      expect(r.jlc).toEqual({ basic: false, standardOnly: true, prices: [{ from: 1, to: null, price: 0.002 }], attrition: { loss: 10, minimum: 20 } });
      expect(r.basic).toBe(false);
      expect(r.unitPrice).toBeUndefined();
      for (const p of parts.filter((p) => p.lcsc !== 'C25804')) expect(p.unitPrice).toBe(1.5);
      const view = await session.view();
      expect(view.issues.map((c) => c.code)).toContain('assembly-standard-only');
    } finally {
      await session.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
