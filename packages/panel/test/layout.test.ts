import { describe, it, expect } from 'vitest';
import { checkPanel } from '../src/check.js';
import { computeGeometry, edgeSpans, tabCentres, tabCounts } from '../src/geometry.js';
import { arrange, sizeLimit } from '../src/layout.js';
import type { ArrangeResult } from '../src/layout.js';
import type { ResolvedSource } from '../src/resolved.js';
import type { Panel } from '../src/types.js';
import { EDGE_CONN, LIMITS, applyAll, awkwardBoard, comp, panelOf, plainBoard, resolved } from './helpers.js';
import type { InstanceSpec } from './helpers.js';

function arranged(panel: Panel, sources: ResolvedSource[], result: ArrangeResult): Panel {
  if (!result.ok) throw new Error(`arrange failed: ${result.reason}`);
  return applyAll(panel, { op: 'placeInstances', placements: result.placements });
}

function errors(panel: Panel, sources: ResolvedSource[]): string[] {
  return checkPanel(panel, sources, LIMITS)
    .filter((i) => i.severity === 'error')
    .map((i) => `${i.code}: ${i.message}`);
}

const many = (key: string, n: number): InstanceSpec[] => Array.from({ length: n }, () => [key, 0, 0]);

describe('arrange', () => {
  const a = resolved('A', plainBoard('alpha', 40, 30));
  const b = resolved('B', plainBoard('beta', 18, 12));

  it('lays identical boards out in a grid with no check errors', () => {
    const panel = panelOf([a], many('A', 6));
    const result = arrange(panel, [a], LIMITS);
    const out = arranged(panel, [a], result);
    expect(errors(out, [a])).toEqual([]);
    const g = computeGeometry(out, [a]);
    // 3 x 2 boards of 40 x 30 at 2 mm, 5 mm rails top and bottom.
    expect(g.frame!.width).toBeCloseTo(3 * 40 + 2 * 2, 3);
    expect(g.frame!.height).toBeCloseTo(2 * 30 + 3 * 2 + 10, 3);
    expect(result.ok && result.width).toBeCloseTo(g.frame!.width, 3);
  });

  it('puts the panel corner at the origin', () => {
    const panel = panelOf([a], many('A', 4));
    const out = arranged(panel, [a], arrange(panel, [a], LIMITS));
    const g = computeGeometry(out, [a]);
    expect(g.frame!.outer.minX).toBeCloseTo(0, 6);
    expect(g.frame!.outer.minY).toBeCloseTo(0, 6);
  });

  it('packs two different boards, 1 + 5, without errors', () => {
    const panel = panelOf([a, b], [...many('A', 1), ...many('B', 5)]);
    const out = arranged(panel, [a, b], arrange(panel, [a, b], LIMITS));
    expect(errors(out, [a, b])).toEqual([]);
    const g = computeGeometry(out, [a, b]);
    expect(g.instances).toHaveLength(6);
    expect(g.frame!.width * g.frame!.height).toBeLessThan(90 * 60);
  });

  it('turns boards by 90 degrees when that packs tighter', () => {
    const tall = resolved('T', plainBoard('tall', 20, 110));
    const panel = panelOf([tall], many('T', 2));
    // Upright, two boards need 130 mm of height; the limit allows 100 x 250.
    const result = arrange(panel, [tall], LIMITS, { limit: { width: 250, height: 100, label: 'test' } });
    const out = arranged(panel, [tall], result);
    expect(errors(out, [tall])).toEqual([]);
    expect(result.ok && Math.min(result.width, result.height)).toBeLessThanOrEqual(100);
  });

  it('keeps each rotation where rotation is not allowed', () => {
    const panel = panelOf([a], [
      ['A', 0, 0, { rotation: 180 }],
      ['A', 0, 0, { rotation: 90 }],
    ]);
    const result = arrange(panel, [a], LIMITS, { rotate: false });
    expect(result.ok && result.placements.map((p) => p.rotation)).toEqual([180, 90]);
  });

  it('packs a board as it is or a quarter turn from it', () => {
    const panel = panelOf([a], [['A', 0, 0, { rotation: 180 }]]);
    const result = arrange(panel, [a], LIMITS);
    expect(result.ok && [180, 270]).toContain(result.ok && result.placements[0]!.rotation);
  });

  it('leaves pinned instances where they are and packs around them', () => {
    const panel = panelOf([a], [
      ['A', 50, 7, { pinned: true }],
      ...many('A', 3),
    ]);
    const result = arrange(panel, [a], LIMITS);
    expect(result.ok && result.placements.map((p) => p.id)).toEqual(['A2', 'A3', 'A4']);
    const out = arranged(panel, [a], result);
    expect(out.instances[0]).toMatchObject({ id: 'A1', at: { x: 50, y: 7 }, pinned: true });
    expect(errors(out, [a])).toEqual([]);
  });

  it('packs on both sides of a pinned instance', () => {
    const panel = panelOf([a, b], [
      ['A', 30, 7, { pinned: true }],
      ...many('B', 4),
    ]);
    const out = arranged(panel, [a, b], arrange(panel, [a, b], LIMITS));
    expect(errors(out, [a, b])).toEqual([]);
    // Something went into the 30 mm left of the pinned board.
    expect(out.instances.some((i) => !i.pinned && i.at.x < 30)).toBe(true);
  });

  it('with everything pinned there is nothing to move', () => {
    const panel = panelOf([a], [
      ['A', 0, 7, { pinned: true }],
      ['A', 42, 7, { pinned: true }],
    ]);
    const result = arrange(panel, [a], LIMITS);
    expect(result).toMatchObject({ ok: true, placements: [] });
  });

  it('gives blocked edges their clearance', () => {
    const awk = resolved('W', awkwardBoard()); // 30 x 20, S needs 2.5 mm, N needs 3 mm
    const panel = panelOf([awk], many('W', 4), [{ op: 'setSettings', settings: { rails: { left: 5, right: 5 } } }]);
    const out = arranged(panel, [awk], arrange(panel, [awk], LIMITS));
    const issues = checkPanel(out, [awk], LIMITS).filter((i) => i.severity === 'error');
    expect(issues.map((i) => i.code)).toEqual([]);
    const g = computeGeometry(out, [awk]);
    // No tab touches a blocked edge, and every board is still held.
    for (const t of g.tabs) {
      const inst = g.instances.find((i) => i.id === t.a)!;
      expect(inst.edges[t.side].blocked).toBe(false);
    }
    expect([...tabCounts(g).values()].every((n) => n >= 2)).toBe(true);
  });

  it('turns a board around when its blocked edge would leave it hanging', () => {
    // A connector on the S edge and nothing else blocked. Rails top and bottom
    // only: a board in the bottom row with its connector facing the rail can
    // only be held from above and from the sides.
    const conn = plainBoard('conn', 22, 16);
    conn.components.push(comp('J1', EDGE_CONN, 11, 0.5));
    const c = resolved('C', conn);
    const panel = panelOf([c], many('C', 2));
    const out = arranged(panel, [c], arrange(panel, [c], LIMITS));
    const g = computeGeometry(out, [c]);
    expect([...tabCounts(g).values()].every((n) => n >= 2)).toBe(true);
    expect(errors(out, [c])).toEqual([]);
    // Left as it was when turning is not allowed.
    const fixed = arranged(panel, [c], arrange(panel, [c], LIMITS, { rotate: false }));
    expect(fixed.instances.every((i) => i.rotation === 0)).toBe(true);
  });

  it('arranging again and again never leaves a board without tabs', () => {
    // Boards added one at a time, arranged after each, as the + button does:
    // rotations pile up from one arrange to the next.
    const conn = plainBoard('conn', 22, 16);
    conn.components.push(comp('J1', EDGE_CONN, 0.5, 8, { rotation: 270 })); // overhangs W
    const c = resolved('C', conn);
    let panel = panelOf([a, c], [['A', 0, 0]]);
    for (let n = 1; n <= 7; n++) {
      panel = applyAll(panel, { op: 'addInstance', source: 'C' });
      panel = arranged(panel, [a, c], arrange(panel, [a, c], LIMITS));
      const g = computeGeometry(panel, [a, c]);
      expect([...tabCounts(g)].filter(([, t]) => t === 0).map(([id]) => id), `after adding C${n}`).toEqual([]);
      expect(errors(panel, [a, c]), `after adding C${n}`).toEqual([]);
    }
  });

  it('keeps two overhanging parts clear of each other', () => {
    const conn = plainBoard('conn', 22, 16);
    conn.components.push(comp('J1', EDGE_CONN, 11, 0.5)); // overhangs S by 1.5 mm
    const c = resolved('C', conn);
    // Whatever the packer does with eight of them, the check must find no fault.
    const panel = panelOf([c], many('C', 8), [{ op: 'setSettings', settings: { rails: { left: 5, right: 5 } } }]);
    const out = arranged(panel, [c], arrange(panel, [c], LIMITS));
    expect(errors(out, [c])).toEqual([]);
  });

  it('says why and how big when the instances do not fit', () => {
    const panel = panelOf([a], many('A', 60));
    const result = arrange(panel, [a], LIMITS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('60 instances do not fit within 250 x 250 mm (the assembly panel limit)');
    expect(result.reason).toContain('The smallest panel that holds them is');
    expect(result.smallestFit!.width * result.smallestFit!.height).toBeGreaterThan(250 * 250);
    expect(result.limit).toMatchObject({ width: 250, height: 250 });
  });

  it('the reported smallest panel really holds the instances', () => {
    const panel = panelOf([a], many('A', 60));
    const fail = arrange(panel, [a], LIMITS);
    if (fail.ok) throw new Error('expected a failure');
    const roomy = arrange(panel, [a], LIMITS, {
      limit: { width: fail.smallestFit!.width, height: fail.smallestFit!.height, label: 'test' },
    });
    expect(roomy.ok).toBe(true);
  });

  it('names the board that is too big on its own', () => {
    const big = resolved('G', plainBoard('giant', 300, 120));
    const panel = panelOf([big, b], [['G', 0, 0], ...many('B', 2)]);
    const result = arrange(panel, [big, b], LIMITS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Board G (300 x 120 mm) does not fit on its own');
    expect(result.smallestFit).toBeDefined();
  });

  it('bare boards only have to fit the fab', () => {
    const big = resolved('G', plainBoard('giant', 300, 120));
    const panel = panelOf([big], [
      ['G', 0, 0, { populate: false }],
      ['G', 0, 0, { populate: false }],
    ]);
    expect(sizeLimit(panel, [big], LIMITS)).toMatchObject({ width: 670, height: 600 });
    expect(arrange(panel, [big], LIMITS).ok).toBe(true);
  });

  it('a single populated board may use the single-board assembly limit', () => {
    const big = resolved('G', plainBoard('giant', 300, 120));
    const panel = panelOf([big], [['G', 0, 0]]);
    expect(sizeLimit(panel, [big], LIMITS)).toMatchObject({ width: 500, height: 470 });
  });

  it('skips instances whose source cannot be read', () => {
    const gone: ResolvedSource = { ...b, geometry: undefined, board: undefined, error: 'cannot read' };
    const panel = panelOf([a, gone], [...many('A', 2), ['B', 0, 0]]);
    const result = arrange(panel, [a, gone], LIMITS);
    expect(result).toMatchObject({ ok: true, skipped: ['B1'] });
    expect(result.ok && result.placements.map((p) => p.id)).toEqual(['A1', 'A2']);
  });

  it('prefers rails along the long sides over a slightly smaller strip', () => {
    // Stacked, two boards make a 40 x 76 mm panel with its rails on the short
    // sides; side by side they make 82 x 44 mm with the rails on the long ones.
    const panel = panelOf([a], many('A', 2));
    const result = arrange(panel, [a], LIMITS);
    expect(result).toMatchObject({ ok: true, width: 82, height: 44 });
  });

  it('fills the limit before giving up', () => {
    // 6 x 7 boards of 40 x 30 fit 250 x 250 exactly.
    const panel = panelOf([a], many('A', 42));
    const result = arrange(panel, [a], LIMITS);
    expect(result).toMatchObject({ ok: true, width: 250 });
    expect(arrange(panelOf([a], many('A', 43)), [a], LIMITS).ok).toBe(false);
  });

  it('packs a silk-divider panel edge to edge', () => {
    const panel = panelOf([a], many('A', 4), [
      { op: 'setSettings', settings: { separation: 'silk-divider', rails: { top: 0, bottom: 0 } } },
    ]);
    const out = arranged(panel, [a], arrange(panel, [a], LIMITS));
    expect(errors(out, [a])).toEqual([]);
    const g = computeGeometry(out, [a]);
    expect(g.frame!.width * g.frame!.height).toBeCloseTo(4 * 40 * 30, 3);
    expect(g.tabs).toEqual([]);
    expect(g.profile).toHaveLength(1);
    expect(g.dividers).toHaveLength(4);
  });

  it('is deterministic', () => {
    const panel = panelOf([a, b], [...many('A', 2), ...many('B', 7)]);
    expect(arrange(panel, [a, b], LIMITS)).toEqual(arrange(panel, [a, b], LIMITS));
  });
});

describe('rails, tabs, fiducials and tooling holes', () => {
  const a = resolved('A', plainBoard('alpha', 40, 30));

  function grid(): Panel {
    const panel = panelOf([a], many('A', 6));
    return arranged(panel, [a], arrange(panel, [a], LIMITS));
  }

  it('adds the rails the settings ask for', () => {
    const g = computeGeometry(grid(), [a]);
    expect(g.rails.map((r) => r.side).sort()).toEqual(['bottom', 'top']);
    const bottom = g.rails.find((r) => r.side === 'bottom')!;
    expect(bottom.box.maxY - bottom.box.minY).toBeCloseTo(5, 6);
    expect(bottom.box.maxX - bottom.box.minX).toBeCloseTo(g.frame!.width, 6);
  });

  it('holds every board with at least two tabs', () => {
    const g = computeGeometry(grid(), [a]);
    const counts = tabCounts(g);
    expect(counts.size).toBe(6);
    for (const n of counts.values()) expect(n).toBeGreaterThanOrEqual(2);
  });

  it('bridges exactly the gap, and only gaps', () => {
    const g = computeGeometry(grid(), [a]);
    for (const t of g.tabs) {
      expect(t.length).toBeCloseTo(2, 6);
      expect(t.b).not.toBe(t.a);
    }
    // Each pair of neighbouring boards is tabbed once, not once from each side.
    const pairs = g.tabs.filter((t) => !t.b.startsWith('rail:')).map((t) => [t.a, t.b].sort().join('-') + t.center.x + t.center.y);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('perforates board ends of a tab, not rail ends', () => {
    const g = computeGeometry(grid(), [a]);
    const toRail = g.tabs.find((t) => t.b.startsWith('rail:'))!;
    const between = g.tabs.find((t) => !t.b.startsWith('rail:'))!;
    expect(toRail.holes).toHaveLength(5);
    expect(between.holes).toHaveLength(10);
    // Holes sit a third of their diameter into the board.
    const inst = g.instances.find((i) => i.id === between.a)!;
    const edge = between.side === 'E' ? inst.bbox.maxX : inst.bbox.maxY;
    const coord = (p: { x: number; y: number }): number => (between.side === 'E' ? p.x : p.y);
    expect(Math.min(...between.holes.map((h) => Math.abs(coord(h) - edge)))).toBeCloseTo(0.6 * (0.5 - 1 / 3), 3);
  });

  it('solid tabs have no holes', () => {
    const panel = applyAll(grid(), { op: 'setSettings', settings: { separation: 'solid-tab' } });
    const g = computeGeometry(panel, [a]);
    expect(g.tabs.length).toBeGreaterThan(0);
    expect(g.tabs.every((t) => t.holes.length === 0)).toBe(true);
  });

  it('places three fiducials and four tooling holes on the rails', () => {
    const g = computeGeometry(grid(), [a]);
    expect(g.fiducials).toHaveLength(3);
    expect(g.toolingHoles).toHaveLength(4);
    const { outer } = g.frame!;
    for (const f of g.fiducials) {
      const fromEdge = Math.min(f.at.y - outer.minY, outer.maxY - f.at.y);
      expect(fromEdge).toBeCloseTo(3.85, 6);
      expect(f.side).toBe('top');
    }
    for (const h of g.toolingHoles) {
      expect(Math.min(h.at.y - outer.minY, outer.maxY - h.at.y)).toBeCloseTo(2.5, 6);
      expect(h.diameter).toBe(2);
    }
    expect(g.featureNotes).toEqual([]);
  });

  it('adds bottom-side fiducials when a populated board has bottom parts', () => {
    const board = plainBoard('two-sided', 80, 60);
    board.components.push({ ...board.components[0]!, refdes: 'R2', side: 'bottom' });
    const src = resolved('A', board);
    const g = computeGeometry(panelOf([src], [['A', 0, 7]]), [src]);
    expect(g.fiducials.filter((f) => f.side === 'bottom')).toHaveLength(3);
    expect(g.fiducials.filter((f) => f.side === 'top')).toHaveLength(3);
  });

  it('the routed profile is one frame with an opening per gap', () => {
    const panel = applyAll(grid(), { op: 'setSettings', settings: { rails: { left: 5, right: 5 } } });
    const g = computeGeometry(arranged(panel, [a], arrange(panel, [a], LIMITS)), [a]);
    const area = (ring: { x: number; y: number }[]): number =>
      Math.abs(ring.reduce((s, p, i) => s + p.x * ring[(i + 1) % ring.length]!.y - ring[(i + 1) % ring.length]!.x * p.y, 0)) / 2;
    const rings = [...g.profile].sort((p, q) => area(q) - area(p));
    // The largest ring is the panel outline.
    expect(area(rings[0]!)).toBeCloseTo(g.frame!.width * g.frame!.height, 1);
    expect(rings.length).toBeGreaterThan(6);
    // Solid material: outline area minus the openings equals boards + rails + tabs, within weld slivers.
    const openings = rings.slice(1).reduce((s, r) => s + area(r), 0);
    const solid = area(rings[0]!) - openings;
    expect(solid).toBeGreaterThan(6 * 40 * 30);
    expect(solid).toBeLessThan(g.frame!.width * g.frame!.height);
  });

  it('finds the straight stretch of a rounded edge', () => {
    const outline = [
      { x: 2, y: 0 },
      { x: 38, y: 0 },
      { x: 40, y: 2 },
      { x: 40, y: 28 },
      { x: 38, y: 30 },
      { x: 2, y: 30 },
      { x: 0, y: 28 },
      { x: 0, y: 2 },
    ];
    const bbox = { minX: 0, minY: 0, maxX: 40, maxY: 30 };
    expect(edgeSpans(outline, bbox, 'S')).toEqual([[2, 38]]);
    expect(edgeSpans(outline, bbox, 'E')).toEqual([[2, 28]]);
  });

  it('spreads tabs along an edge', () => {
    expect(tabCentres(0, 12, 5, 50)).toEqual([6]);
    expect(tabCentres(0, 13, 5, 50)).toEqual([6.5]);
    expect(tabCentres(0, 14, 5, 50)).toEqual([3.5, 10.5]);
    expect(tabCentres(0, 40, 5, 50)).toEqual([10, 30]);
    expect(tabCentres(0, 120, 5, 50)).toEqual([20, 60, 100]);
    expect(tabCentres(0, 4, 5, 50)).toEqual([]);
  });

  it('finishes on a pathological pitch, as a hand-edited file could carry', () => {
    // Settings set directly, past validation: the geometry must still terminate.
    expect(tabCentres(0, 1e6, 5, 0)).toHaveLength(Math.floor((1e6 - 2) / 5));
    expect(tabCentres(0, 40, 5, 1e-300).length).toBeLessThanOrEqual(7);
    expect(tabCentres(0, 40, 5, Number.NaN)).toEqual([]);
    for (const holePitch of [0, 1e-300, Number.NaN, Number.POSITIVE_INFINITY]) {
      const panel = grid();
      panel.settings.tabs.holePitch = holePitch;
      const g = computeGeometry(panel, [a]);
      expect(g.tabs.length).toBeGreaterThan(0);
      for (const t of g.tabs) expect(t.holes.length).toBeLessThanOrEqual(400);
    }
  });
});
