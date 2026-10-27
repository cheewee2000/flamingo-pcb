import { describe, it, expect } from 'vitest';
import { newPanel } from '../src/panel.js';
import { applyPanelOp, nextInstanceId, suggestSourceKey } from '../src/ops.js';
import type { PanelOp } from '../src/ops.js';
import { History } from '../src/history.js';
import type { Panel } from '../src/types.js';

function apply(p: Panel, ...ops: PanelOp[]): Panel {
  for (const op of ops) {
    const r = applyPanelOp(p, op);
    if (!r.ok) throw new Error(`${op.op}: ${r.error}`);
    p = r.panel;
  }
  return p;
}

function errorOf(p: Panel, op: PanelOp): string {
  const r = applyPanelOp(p, op);
  if (r.ok) throw new Error(`${op.op} unexpectedly succeeded`);
  return r.error;
}

const SENSOR: PanelOp = { op: 'addSource', source: { path: 'sensor.flamingo', hash: 'h1', name: 'sensor' } };
const MINI: PanelOp = { op: 'addSource', source: { path: 'mini.flamingo', hash: 'h2', name: 'mini' } };

describe('applyPanelOp', () => {
  it('never mutates its input', () => {
    const p = newPanel('x');
    const before = structuredClone(p);
    apply(p, SENSOR, { op: 'addInstance', source: 'S' });
    expect(p).toEqual(before);
  });

  it('addSource picks the first letter of the name as the key, then the next free letter', () => {
    const p = apply(newPanel('x'), SENSOR, MINI, {
      op: 'addSource',
      source: { path: 'second-sensor.flamingo', hash: 'h3', name: 'sensor2' },
    });
    expect(p.sources.map((s) => s.key)).toEqual(['S', 'M', 'A']);
    expect(p.sources[0]).toEqual({ key: 'S', path: 'sensor.flamingo', hash: 'h1', name: 'sensor', needed: 1 });
    expect(suggestSourceKey(p, 'zebra')).toBe('Z');
  });

  it('addSource rejects a board that is already on the panel, a taken key and a malformed key', () => {
    const p = apply(newPanel('x'), SENSOR);
    expect(errorOf(p, SENSOR)).toContain('already on the panel');
    expect(errorOf(p, { op: 'addSource', source: { path: 'o.flamingo', hash: 'h', name: 'o', key: 'S' } })).toContain(
      'already in use',
    );
    expect(errorOf(p, { op: 'addSource', source: { path: 'o.flamingo', hash: 'h', name: 'o', key: 's1' } })).toContain(
      'Invalid source key',
    );
  });

  it('addInstance numbers instances per source', () => {
    const p = apply(
      newPanel('x'),
      SENSOR,
      MINI,
      { op: 'addInstance', source: 'S' },
      { op: 'addInstance', source: 'M' },
      { op: 'addInstance', source: 'M' },
    );
    expect(p.instances.map((i) => i.id)).toEqual(['S1', 'M1', 'M2']);
    expect(p.instances[0]).toEqual({
      id: 'S1',
      source: 'S',
      at: { x: 0, y: 0 },
      rotation: 0,
      pinned: false,
      populate: true,
    });
    expect(nextInstanceId(p, 'M')).toBe('M3');
  });

  it('reports the created instance id', () => {
    const p = apply(newPanel('x'), SENSOR);
    const r = applyPanelOp(p, { op: 'addInstance', source: 'S' });
    expect(r.ok && r.created).toEqual(['S1']);
  });

  it('removeInstance leaves the numbering of the others alone', () => {
    const p = apply(
      newPanel('x'),
      MINI,
      { op: 'addInstance', source: 'M' },
      { op: 'addInstance', source: 'M' },
      { op: 'addInstance', source: 'M' },
      { op: 'removeInstance', id: 'M2' },
    );
    expect(p.instances.map((i) => i.id)).toEqual(['M1', 'M3']);
    expect(apply(p, { op: 'addInstance', source: 'M' }).instances.map((i) => i.id)).toEqual(['M1', 'M3', 'M4']);
  });

  it('removeSource takes its instances with it', () => {
    const p = apply(
      newPanel('x'),
      SENSOR,
      MINI,
      { op: 'addInstance', source: 'S' },
      { op: 'addInstance', source: 'M' },
      { op: 'removeSource', key: 'M' },
    );
    expect(p.sources.map((s) => s.key)).toEqual(['S']);
    expect(p.instances.map((i) => i.id)).toEqual(['S1']);
  });

  it('moveInstance moves and optionally pins', () => {
    const p = apply(newPanel('x'), SENSOR, { op: 'addInstance', source: 'S' });
    const moved = apply(p, { op: 'moveInstance', id: 'S1', at: { x: 12, y: 3 } });
    expect(moved.instances[0]).toMatchObject({ at: { x: 12, y: 3 }, pinned: false });
    const pinned = apply(p, { op: 'moveInstance', id: 'S1', at: { x: 12, y: 3 }, pin: true });
    expect(pinned.instances[0]!.pinned).toBe(true);
  });

  it('rotateInstance turns by 90 by default, wraps, and accepts an absolute rotation', () => {
    let p = apply(newPanel('x'), SENSOR, { op: 'addInstance', source: 'S', rotation: 270 });
    p = apply(p, { op: 'rotateInstance', id: 'S1' });
    expect(p.instances[0]!.rotation).toBe(0);
    p = apply(p, { op: 'rotateInstance', id: 'S1', by: -90 });
    expect(p.instances[0]!.rotation).toBe(270);
    p = apply(p, { op: 'rotateInstance', id: 'S1', rotation: 180 });
    expect(p.instances[0]!.rotation).toBe(180);
    p = apply(p, { op: 'rotateInstance', id: 'S1', by: 45 });
    expect(p.instances[0]!.rotation).toBe(225);
    p = apply(p, { op: 'rotateInstance', id: 'S1', rotation: -36 });
    expect(p.instances[0]!.rotation).toBe(324);
    expect(errorOf(p, { op: 'rotateInstance', id: 'S1', by: Number.NaN })).toContain('degrees');
  });

  it('setPopulate and setPinned flip their flags', () => {
    const p = apply(
      newPanel('x'),
      SENSOR,
      { op: 'addInstance', source: 'S' },
      { op: 'setPopulate', id: 'S1', populate: false },
      { op: 'setPinned', id: 'S1', pinned: true },
    );
    expect(p.instances[0]).toMatchObject({ populate: false, pinned: true });
  });

  it('setQuantity validates counts', () => {
    const p = apply(newPanel('x'), SENSOR, { op: 'setQuantity', key: 'S', needed: 4 });
    expect(p.sources[0]).toMatchObject({ needed: 4 });
    expect(errorOf(p, { op: 'setQuantity', key: 'S', needed: -1 })).toContain('non-negative integer');
    expect(errorOf(p, { op: 'setQuantity', key: 'S', needed: 1.5 })).toContain('non-negative integer');
  });

  it('refreshSource records the new hash', () => {
    const p = apply(newPanel('x'), SENSOR, { op: 'refreshSource', key: 'S', hash: 'h9', name: 'sensor v2' });
    expect(p.sources[0]).toMatchObject({ hash: 'h9', name: 'sensor v2' });
  });

  it('placeInstances is all-or-nothing', () => {
    const p = apply(newPanel('x'), MINI, { op: 'addInstance', source: 'M' }, { op: 'addInstance', source: 'M' });
    expect(
      errorOf(p, {
        op: 'placeInstances',
        placements: [
          { id: 'M1', at: { x: 5, y: 5 } },
          { id: 'M9', at: { x: 9, y: 9 } },
        ],
      }),
    ).toContain('Unknown instance "M9"');
    const placed = apply(p, {
      op: 'placeInstances',
      placements: [
        { id: 'M1', at: { x: 5, y: 5 }, rotation: 90 },
        { id: 'M2', at: { x: 9, y: 9 } },
      ],
    });
    expect(placed.instances.map((i) => [i.at.x, i.rotation])).toEqual([
      [5, 90],
      [9, 0],
    ]);
  });

  it('setLayout replaces every instance and can patch settings with it', () => {
    const p = apply(newPanel('x'), SENSOR, MINI, { op: 'addInstance', source: 'S' });
    const next = apply(p, {
      op: 'setLayout',
      instances: [
        { id: 'M1', source: 'M', at: { x: 1, y: 2 }, rotation: 0, pinned: false, populate: true },
        { id: 'M2', source: 'M', at: { x: 20, y: 2 }, rotation: 0, pinned: false, populate: false },
      ],
      settings: { separation: 'silk-divider', rails: { top: 0, bottom: 0 } },
    });
    expect(next.instances.map((i) => i.id)).toEqual(['M1', 'M2']);
    expect(next.settings.separation).toBe('silk-divider');
    expect(next.settings.rails).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(
      errorOf(p, {
        op: 'setLayout',
        instances: [{ id: 'Q1', source: 'Q', at: { x: 0, y: 0 }, rotation: 0, pinned: false, populate: true }],
      }),
    ).toContain('Unknown source');
  });

  it('setSettings patches one number without restating its group, and validates', () => {
    const p = apply(newPanel('x'), { op: 'setSettings', settings: { spacing: 1.6, rails: { left: 5 } } });
    expect(p.settings.spacing).toBe(1.6);
    expect(p.settings.rails).toEqual({ top: 5, bottom: 5, left: 5, right: 0 });
    expect(errorOf(p, { op: 'setSettings', settings: { spacing: 0 } })).toContain('spacing');
    expect(errorOf(p, { op: 'setSettings', settings: { rails: { top: -1 } } })).toContain('rails.top');
    expect(errorOf(p, { op: 'setSettings', settings: { copperLayers: 3 as unknown as 2 } })).toContain('copperLayers');
  });

  it('a transaction applies every op or none', () => {
    const p = apply(newPanel('x'), SENSOR);
    const good = apply(p, {
      op: 'transaction',
      ops: [
        { op: 'addInstance', source: 'S' },
        { op: 'addInstance', source: 'S' },
      ],
    });
    expect(good.instances).toHaveLength(2);
    expect(
      errorOf(p, {
        op: 'transaction',
        ops: [
          { op: 'addInstance', source: 'S' },
          { op: 'removeInstance', id: 'nope' },
        ],
      }),
    ).toContain('Unknown instance');
  });

  it.each<PanelOp>([
    { op: 'removeInstance', id: 'S9' },
    { op: 'moveInstance', id: 'S9', at: { x: 0, y: 0 } },
    { op: 'setPopulate', id: 'S9', populate: false },
    { op: 'setPinned', id: 'S9', pinned: true },
    { op: 'addInstance', source: 'Q' },
    { op: 'setQuantity', key: 'Q', needed: 1 },
    { op: 'removeSource', key: 'Q' },
  ])('rejects $op on something that does not exist', (op) => {
    expect(applyPanelOp(apply(newPanel('x'), SENSOR), op).ok).toBe(false);
  });

  it('rejects a move to a non-finite position', () => {
    const p = apply(newPanel('x'), SENSOR, { op: 'addInstance', source: 'S' });
    expect(errorOf(p, { op: 'moveInstance', id: 'S1', at: { x: NaN, y: 0 } })).toContain('at must be');
  });
});

describe('History', () => {
  function reduce(h: History<Panel>, op: PanelOp): void {
    const r = applyPanelOp(h.state, op);
    if (!r.ok) throw new Error(r.error);
    h.commit(r.panel);
  }

  it('undoes and redoes ops in order', () => {
    const h = new History(newPanel('x'));
    reduce(h, SENSOR);
    reduce(h, { op: 'addInstance', source: 'S' });
    reduce(h, { op: 'moveInstance', id: 'S1', at: { x: 9, y: 9 } });
    expect(h.state.instances[0]!.at).toEqual({ x: 9, y: 9 });

    expect(h.undo()!.instances[0]!.at).toEqual({ x: 0, y: 0 });
    expect(h.undo()!.instances).toEqual([]);
    expect(h.canRedo).toBe(true);
    expect(h.redo()!.instances).toHaveLength(1);
    expect(h.redo()!.instances[0]!.at).toEqual({ x: 9, y: 9 });
    expect(h.redo()).toBeNull();
  });

  it('returns null when there is nothing to undo', () => {
    const h = new History(newPanel('x'));
    expect(h.canUndo).toBe(false);
    expect(h.undo()).toBeNull();
  });

  it('a new op after an undo drops the redo stack', () => {
    const h = new History(newPanel('x'));
    reduce(h, SENSOR);
    reduce(h, { op: 'addInstance', source: 'S' });
    h.undo();
    reduce(h, MINI);
    expect(h.canRedo).toBe(false);
    expect(h.state.sources.map((s) => s.key)).toEqual(['S', 'M']);
  });

  it('a failed op leaves state and history untouched', () => {
    const h = new History(newPanel('x'));
    reduce(h, SENSOR);
    const before = h.state;
    expect(applyPanelOp(h.state, { op: 'removeInstance', id: 'S1' }).ok).toBe(false);
    expect(h.state).toBe(before);
    expect(h.undo()!.sources).toEqual([]);
  });

  it('keeps snapshots intact after later ops', () => {
    const h = new History(newPanel('x'));
    reduce(h, SENSOR);
    reduce(h, { op: 'addInstance', source: 'S' });
    const snapshot = structuredClone(h.state);
    reduce(h, { op: 'moveInstance', id: 'S1', at: { x: 50, y: 50 } });
    expect(h.undo()).toEqual(snapshot);
  });

  it('caps the undo stack', () => {
    const h = new History(newPanel('x'), 3);
    for (let i = 0; i < 5; i++) reduce(h, { op: 'setName', name: `n${i}` });
    let steps = 0;
    while (h.undo()) steps++;
    expect(steps).toBe(3);
    expect(h.state.name).toBe('n1');
  });

  it('reset forgets history', () => {
    const h = new History(newPanel('x'));
    reduce(h, SENSOR);
    h.reset(newPanel('fresh'));
    expect(h.canUndo).toBe(false);
    expect(h.state.name).toBe('fresh');
  });
});
