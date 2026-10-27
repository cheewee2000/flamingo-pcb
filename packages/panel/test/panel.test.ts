import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, newPanel, parsePanel, serializePanel } from '../src/panel.js';
import { settingsFromLimits } from '../src/config.js';
import { applyPanelOp } from '../src/ops.js';
import type { Panel } from '../src/types.js';
import { LIMITS } from './helpers.js';

function demo(): Panel {
  let p = newPanel('demo');
  for (const op of [
    { op: 'addSource', source: { path: 'a.flamingo', hash: 'sha256:aa', name: 'sensor' } },
    { op: 'addSource', source: { path: 'sub/b.flamingo', hash: 'sha256:bb', name: 'mini', needed: 5 } },
    { op: 'addInstance', source: 'S', at: { x: 7, y: 7 } },
    { op: 'addInstance', source: 'M', at: { x: 50, y: 7 }, rotation: 90, populate: false, pinned: true },
  ] as const) {
    const r = applyPanelOp(p, op);
    if (!r.ok) throw new Error(r.error);
    p = r.panel;
  }
  return p;
}

describe('panel format', () => {
  it('newPanel starts empty with the default settings', () => {
    const p = newPanel('x');
    expect(p.kind).toBe('flamingo-panel');
    expect(p.formatVersion).toBe(1);
    expect(p.sources).toEqual([]);
    expect(p.instances).toEqual([]);
    expect(p.settings).toEqual(DEFAULT_SETTINGS);
    expect(p.settings).not.toBe(DEFAULT_SETTINGS); // a copy, never the shared object
  });

  it('the built-in default settings match the limits config', () => {
    expect(settingsFromLimits(LIMITS)).toEqual({
      ...DEFAULT_SETTINGS,
      tabs: { ...DEFAULT_SETTINGS.tabs, holeOverlap: LIMITS.tabs.holeOverlap.value },
    });
    expect(DEFAULT_SETTINGS.tabs.holeOverlap).toBeCloseTo(LIMITS.tabs.holeOverlap.value, 3);
  });

  it('round-trips through serialize / parse', () => {
    const p = demo();
    expect(parsePanel(serializePanel(p))).toEqual(p);
  });

  it('loads an older file with a nice-to-have quantity, and drops it', () => {
    const old = JSON.parse(serializePanel(demo())) as { sources: Array<Record<string, unknown>> };
    old.sources[1]!.niceToHave = 8;
    const p = parsePanel(JSON.stringify(old));
    expect(p).toEqual(demo());
    expect(serializePanel(p)).not.toContain('niceToHave');
  });

  it('serializes as indented JSON, one value per line', () => {
    const text = serializePanel(demo());
    expect(text).toContain('\n  "sources": [\n');
    expect(text.split('\n').length).toBeGreaterThan(40);
  });

  it('keeps source paths relative and stores no board content', () => {
    const text = serializePanel(demo());
    expect(text).toContain('"path": "sub/b.flamingo"');
    expect(text).not.toContain('components');
  });

  it('refuses settings an op would refuse, so a bad file cannot hang the tab layout', () => {
    const withTabs = (tabs: Record<string, unknown>): string => {
      const raw = JSON.parse(serializePanel(demo()));
      raw.settings.tabs = { ...raw.settings.tabs, ...tabs };
      return JSON.stringify(raw);
    };
    expect(() => parsePanel(withTabs({ holePitch: 0 }))).toThrow('tabs.holePitch must be a number > 0');
    expect(() => parsePanel(withTabs({ pitch: -1 }))).toThrow('tabs.pitch');
    expect(() => parsePanel(withTabs({ width: 'wide' }))).toThrow('tabs.width');
    expect(parsePanel(withTabs({ holePitch: 0.8 })).settings.tabs.holePitch).toBe(0.8);
  });

  it('fills in settings missing from an older file', () => {
    const p = demo();
    const raw = JSON.parse(serializePanel(p));
    delete raw.settings.toolingHoles;
    delete raw.settings.tabs.maxLength;
    raw.settings.spacing = 3;
    const parsed = parsePanel(JSON.stringify(raw));
    expect(parsed.settings.toolingHoles).toEqual(DEFAULT_SETTINGS.toolingHoles);
    expect(parsed.settings.tabs.maxLength).toBe(DEFAULT_SETTINGS.tabs.maxLength);
    expect(parsed.settings.spacing).toBe(3);
  });

  it('defaults pinned to false and populate to true', () => {
    const raw = JSON.parse(serializePanel(demo()));
    delete raw.instances[0].pinned;
    delete raw.instances[0].populate;
    const parsed = parsePanel(JSON.stringify(raw));
    expect(parsed.instances[0]!.pinned).toBe(false);
    expect(parsed.instances[0]!.populate).toBe(true);
  });

  it.each([
    ['not json', 'Invalid JSON'],
    ['[]', 'must be a JSON object'],
    ['{"formatVersion":1,"name":"b","outline":[]}', 'Not a panel file'],
    ['{"kind":"flamingo-panel","formatVersion":2,"name":"x","sources":[],"instances":[]}', 'Unsupported formatVersion'],
    ['{"kind":"flamingo-panel","formatVersion":1,"sources":[],"instances":[]}', 'name'],
    ['{"kind":"flamingo-panel","formatVersion":1,"name":"x","instances":[]}', 'sources'],
  ])('rejects %s', (text, message) => {
    expect(() => parsePanel(text)).toThrow(message);
  });

  it('rejects an instance of an unknown source, a bad rotation, and duplicate ids', () => {
    const base = JSON.parse(serializePanel(demo()));
    const a = structuredClone(base);
    a.instances[0].source = 'Z';
    expect(() => parsePanel(JSON.stringify(a))).toThrow('unknown source');
    const b = structuredClone(base);
    b.instances[0].rotation = 'up';
    expect(() => parsePanel(JSON.stringify(b))).toThrow('rotation');
    b.instances[0].rotation = 45;
    expect(parsePanel(JSON.stringify(b)).instances[0]!.rotation).toBe(45);
    const c = structuredClone(base);
    c.instances[1].id = c.instances[0].id;
    expect(() => parsePanel(JSON.stringify(c))).toThrow('Duplicate instance id');
  });
});

describe('stored cost curve', () => {
  const curve = {
    key: 'fnv1a:0',
    objective: 'total' as const,
    entered: [11],
    points: [{ quantity: 11, total: 40, perBoard: 3.64, way: { id: 'x', kind: 'merged' as const, title: 'one panel' }, estimate: true }],
    impossible: [],
    pricedAt: '2026-10-27T00:00:00.000Z',
  };

  it('is written with the panel and read back', () => {
    const p = { ...demo(), curve };
    expect(parsePanel(serializePanel(p)).curve).toEqual(curve);
  });

  it('is left out when absent and dropped when damaged, never a reason to refuse the file', () => {
    expect(parsePanel(serializePanel(demo()))).not.toHaveProperty('curve');
    const broken = JSON.parse(serializePanel({ ...demo(), curve }));
    broken.curve.points = 'none';
    expect(parsePanel(JSON.stringify(broken))).not.toHaveProperty('curve');
  });
});
