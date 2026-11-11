import { describe, it, expect } from 'vitest';
import polygonClipping from 'polygon-clipping';
import type { Point } from '@flamingo/engine';
import { polyIntersects } from '@flamingo/engine';
import { checkPanel } from '../src/check.js';
import { computeGeometry, tabCounts } from '../src/geometry.js';
import type { PanelGeometry, PlacedInstance, Tab } from '../src/geometry.js';
import { dot, edgesOf } from '../src/poly.js';
import type { ResolvedSource } from '../src/resolved.js';
import type { Panel } from '../src/types.js';
import { LIMITS, applyAll, awkwardBoard, panelOf, pentagonBoard, plainBoard, resolved } from './helpers.js';

const WELD = 0.01;
const HOLE_OFF = 0.6 * (0.5 - 1 / 3);

function area(ring: Point[]): number {
  return Math.abs(ring.reduce((s, p, i) => s + p.x * ring[(i + 1) % ring.length]!.y - ring[(i + 1) % ring.length]!.x * p.y, 0)) / 2;
}

/** Area shared by two polygons. */
function common(a: Point[], b: Point[]): number {
  const ring = (pts: Point[]): [number, number][] => pts.map((p) => [p.x, p.y]);
  let s = 0;
  for (const poly of polygonClipping.intersection([ring(a)], [ring(b)])) {
    poly.forEach((r, i) => {
      const a2 = area(r.map(([x, y]) => ({ x, y })));
      s += i === 0 ? a2 : -a2;
    });
  }
  return s;
}

const inst = (g: PanelGeometry, id: string): PlacedInstance => g.instances.find((i) => i.id === id)!;
const between = (g: PanelGeometry, p: string, q: string): Tab[] =>
  g.tabs.filter((t) => (t.a === p && t.b === q) || (t.a === q && t.b === p));

/**
 * Moves instance `id` along x so that its edge facing `toward` (a unit
 * vector, from `fixed`) is `gap` mm from `fixed`'s edge with that normal.
 */
function spaceAlongX(panel: Panel, srcs: ResolvedSource[], fixed: string, id: string, toward: Point, gap: number): Panel {
  const g = computeGeometry(panel, srcs);
  const e = edgesOf(inst(g, fixed).outline).reduce((p, q) => (dot(q.normal, toward) > dot(p.normal, toward) ? q : p));
  const f = edgesOf(inst(g, id).outline).reduce((p, q) => (dot(q.normal, toward) < dot(p.normal, toward) ? q : p));
  const now = dot(f.start, e.normal) - dot(e.start, e.normal);
  const dx = (gap - now) / e.normal.x;
  const target = panel.instances.find((i) => i.id === id)!;
  return applyAll(panel, { op: 'moveInstance', id, at: { x: target.at.x + dx, y: target.at.y } });
}

const fromDeg = (deg: number): Point => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });

/** The tab joins its two ends only by the weld, and its holes sit along the edges. */
function expectWellFormed(g: PanelGeometry, t: Tab): void {
  const a = inst(g, t.a);
  const b = inst(g, t.b);
  const width = 5;
  expect(common(t.polygon, a.outline)).toBeLessThan(width * WELD * 1.5);
  expect(common(t.polygon, b.outline)).toBeLessThan(width * WELD * 1.5);
  expect(common(t.polygon, a.outline)).toBeGreaterThan(0);
  expect(common(t.polygon, b.outline)).toBeGreaterThan(0);
  expect(t.holes).toHaveLength(10);
  // Measured across the gap from the tab centre: hole centres just off each
  // board edge, so a third of each hole bites into the board.
  const across = (p: Point): number => dot({ x: p.x - t.center.x, y: p.y - t.center.y }, t.normal);
  const along = (p: Point): number => dot({ x: p.x - t.center.x, y: p.y - t.center.y }, t.along);
  const rows = t.holes.map(across).sort((p, q) => p - q);
  for (const v of rows.slice(0, 5)) expect(v).toBeCloseTo(-(t.length / 2 - HOLE_OFF), 6);
  for (const v of rows.slice(5)) expect(v).toBeCloseTo(t.length / 2 - HOLE_OFF, 6);
  for (const h of t.holes) expect(Math.abs(along(h))).toBeLessThanOrEqual(2 + 1e-9);
  expect(Math.abs(dot(t.normal, t.along))).toBeLessThan(1e-9);
}

describe('tabs between boards at any angle', () => {
  const p = resolved('P', pentagonBoard('penta', 30));

  it('joins pentagons whose slanted edges face each other', () => {
    // Point up, point down, point up: flat edges on the bottom and top rails,
    // and the middle one faces a slanted edge of each neighbour, 2 mm away.
    let panel = panelOf([p], [
      ['P', 0, 7],
      ['P', 60, 7, { rotation: 180 }],
      ['P', 120, 7],
    ]);
    panel = spaceAlongX(panel, [p], 'P1', 'P2', fromDeg(-18), 2);
    panel = spaceAlongX(panel, [p], 'P2', 'P3', fromDeg(18), 2);
    const g = computeGeometry(panel, [p]);

    for (const [x, y] of [
      ['P1', 'P2'],
      ['P2', 'P3'],
    ] as const) {
      // The facing stretch is about 11 mm: room for one tab, clear of the corners.
      const tabs = between(g, x, y);
      expect(tabs.length, `${x}-${y}`).toBe(1);
      for (const t of tabs) {
        expect(t.length).toBeCloseTo(2, 6);
        // Not along an axis: the slanted edges at 18 degrees off vertical.
        expect(Math.abs(t.normal.x)).toBeCloseTo(Math.cos((18 * Math.PI) / 180), 6);
        expectWellFormed(g, t);
      }
    }
    expect([...tabCounts(g).values()].every((n) => n >= 3)).toBe(true);
    // Their flat edges are tabbed to the rails, as before.
    expect(g.tabs.filter((t) => t.a === 'P1' && t.b === 'rail:bottom')).toHaveLength(2);
    expect(g.tabs.filter((t) => t.a === 'P2' && t.b === 'rail:top')).toHaveLength(2);
    expect(checkPanel(panel, [p], LIMITS).filter((i) => i.severity === 'error').map((i) => i.code)).toEqual([]);
    // One piece with an opening per gap: the profile still unions cleanly.
    expect(g.profile.length).toBeGreaterThan(1);
  });

  it('joins a pentagon at 36 degrees to one at 0 across parallel edges', () => {
    let panel = panelOf([p], [
      ['P', 0, 7],
      ['P', 60, 7, { rotation: 36 }],
    ]);
    panel = spaceAlongX(panel, [p], 'P1', 'P2', fromDeg(-18), 3);
    const g = computeGeometry(panel, [p]);
    const tabs = between(g, 'P1', 'P2');
    expect(tabs.length).toBeGreaterThan(0);
    for (const t of tabs) {
      expect(t.length).toBeCloseTo(3, 6);
      // Across the gap, one way or the other (`a` is the board whose edge faces up).
      expect(Math.abs(dot(t.normal, fromDeg(-18)))).toBeCloseTo(1, 6);
      expectWellFormed(g, t);
    }
  });

  it('a square at 45 degrees gets no tabs to an upright one, and the spacing is measured corner to edge', () => {
    const s = resolved('S', plainBoard('square', 20, 20));
    const half = 10 * Math.SQRT2;
    // B's left corner at (21, 17): 1 mm from A's right edge.
    const close = panelOf([s], [
      ['S', 0, 7],
      ['S', 21, 17 - half, { rotation: 45 }],
    ]);
    const g = computeGeometry(close, [s]);
    expect(between(g, 'S1', 'S2')).toEqual([]);
    const spacing = checkPanel(close, [s], LIMITS).find((i) => i.code === 'spacing')!;
    expect(spacing.message).toContain('1 mm apart; the panel spacing is 2 mm');

    // Corner below A's corner: the boxes are 1 mm apart, the boards 2.83 mm.
    const clear = panelOf([s], [
      ['S', 0, 7],
      ['S', 21, 4 - half, { rotation: 45 }],
    ]);
    expect(checkPanel(clear, [s], LIMITS).map((i) => i.code)).not.toContain('spacing');
    expect(between(computeGeometry(clear, [s]), 'S1', 'S2')).toEqual([]);
  });

  it('puts no tabs on a blocked side of a turned board', () => {
    const w = resolved('W', awkwardBoard()); // 30 x 20; N (keepout) and S (connector) blocked
    const q = resolved('Q', plainBoard('plain', 30, 20));
    const turn = 30;
    const at = (dir: Point, by: number): Point => ({ x: 40 + dir.x * by, y: 40 + dir.y * by });
    const rails = [{ op: 'setSettings', settings: { rails: { top: 0, bottom: 0 } } }] as never[];
    // Q 4 mm off W's N side (turned to 120 degrees), then off its E side (30 degrees).
    const offN = at(fromDeg(90 + turn), 24);
    const onN = panelOf([w, q], [
      ['W', 40, 40, { rotation: turn }],
      ['Q', offN.x, offN.y, { rotation: turn }],
    ], rails);
    const gN = computeGeometry(onN, [w, q]);
    expect(between(gN, 'W1', 'Q1')).toEqual([]);
    // The same spot next to a plain board would be tabbed.
    const plainN = panelOf([q], [
      ['Q', 40, 40, { rotation: turn }],
      ['Q', offN.x, offN.y, { rotation: turn }],
    ], rails);
    expect(between(computeGeometry(plainN, [q]), 'Q1', 'Q2')).toHaveLength(2);

    const offE = at(fromDeg(turn), 34);
    const onE = panelOf([w, q], [
      ['W', 40, 40, { rotation: turn }],
      ['Q', offE.x, offE.y, { rotation: turn }],
    ], rails);
    const gE = computeGeometry(onE, [w, q]);
    const tabs = between(gE, 'W1', 'Q1');
    expect(tabs.length).toBe(2);
    for (const t of tabs) {
      expect(t.length).toBeCloseTo(4, 6);
      const wInst = inst(gE, 'W1');
      const side = t.a === 'W1' ? t.side : null;
      if (side) expect(wInst.edges[side].blocked).toBe(false);
    }
    expect(checkPanel(onE, [w, q], LIMITS).map((i) => i.code)).not.toContain('blocked-edge-tab');
  });

  it('never runs a tab through a third board in the gap', () => {
    const a = resolved('A', plainBoard('alpha', 40, 30));
    const c = resolved('C', plainBoard('chip', 8, 3));
    // A and B 7 mm apart; C sits in the gap, 2 mm from each, where a tab would go.
    const panel = panelOf([a, c], [
      ['A', 0, 7],
      ['A', 0, 44],
      ['C', 6, 39],
    ]);
    const g = computeGeometry(panel, [a, c]);
    const ab = between(g, 'A1', 'A2');
    expect(ab.length).toBeGreaterThan(0);
    for (const t of ab) expect(polyIntersects(t.polygon, inst(g, 'C1').outline)).toBe(false);
    expect(between(g, 'A1', 'C1').length).toBeGreaterThan(0);
    expect(between(g, 'C1', 'A2').length).toBeGreaterThan(0);
    // Without C the same pair gets a tab right where C was.
    const bare = computeGeometry(panelOf([a], [['A', 0, 7], ['A', 0, 44]]), [a]);
    expect(between(bare, 'A1', 'A2').some((t) => Math.abs(t.center.x - 10) < 1e-9)).toBe(true);
  });

  it('a 2 x 2 grid of upright boards gets the tabs it always had', () => {
    const a = resolved('A', plainBoard('alpha', 40, 30));
    const panel = panelOf([a], [
      ['A', 7, 7],
      ['A', 49, 7],
      ['A', 7, 39],
      ['A', 49, 39],
    ], [{ op: 'setSettings', settings: { rails: { left: 5, right: 5 } } }]);
    const g = computeGeometry(panel, [a]);
    // Two tabs on each of the four shared edges, and two on each board edge facing a rail.
    expect(g.tabs).toHaveLength(24);
    for (const n of tabCounts(g).values()) expect(n).toBe(8);
    for (const t of g.tabs) {
      expect(Math.abs(t.normal.x) + Math.abs(t.normal.y)).toBeCloseTo(1, 12);
      expect(t.length).toBeCloseTo(2, 9);
    }
    // Board pairs are tabbed from the lower or left board, as before.
    for (const t of g.tabs.filter((x) => !x.b.startsWith('rail:'))) expect(['N', 'E']).toContain(t.side);
  });
});
