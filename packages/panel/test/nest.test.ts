import { describe, expect, it } from 'vitest';
import { arrange } from '../src/layout.js';
import { computeGeometry } from '../src/geometry.js';
import { checkPanel } from '../src/check.js';
import { applyPanelOp } from '../src/ops.js';
import { newPanel } from '../src/panel.js';
import { shapesOverlap, nestOption, growOutline } from '../src/nest.js';
import { LIMITS, pentagonBoard, pentagonPoints, plainBoard, resolved } from './helpers.js';
import type { Panel } from '../src/types.js';

function withInstances(panel: Panel, key: string, n: number): Panel {
  let p = panel;
  for (let i = 0; i < n; i++) {
    const r = applyPanelOp(p, { op: 'addInstance', source: key });
    if (!r.ok) throw new Error(r.error);
    p = r.panel;
  }
  return p;
}

describe('nesting', () => {
  const pent = pentagonBoard('face', 47.6);
  const sources = [resolved('F', pent)];
  const base = (() => {
    const r = applyPanelOp(newPanel('dodeca'), { op: 'addSource', source: { key: 'F', path: 'face.flamingo', hash: 'h', name: 'face', needed: 11 } });
    if (!r.ok) throw new Error(r.error);
    return r.panel;
  })();

  it('grows a pentagon outward on every edge', () => {
    const pts = pentagonPoints(20);
    const grown = growOutline(pts, 0, { N: 1, E: 1, S: 1, W: 1 });
    expect(grown).toHaveLength(1);
    const ring = grown[0]!;
    const minY = Math.min(...ring.map((p) => p.y));
    const maxY = Math.max(...ring.map((p) => p.y));
    expect(minY).toBeCloseTo(-1, 3); // flat bottom edge, grown by 1
    expect(maxY).toBeGreaterThan(Math.max(...pts.map((p) => p.y)) + 0.99);
  });

  it('two grown pentagons may touch but not cross', () => {
    const edges = resolved('F', pent).geometry!.edges;
    const a = nestOption(pentagonPoints(20), edges, 0, 2, 1);
    const at = (o: typeof a, x: number, y: number) => ({
      rings: o.rings.map((r) => r.map((p) => ({ x: p.x + x, y: p.y + y }))),
      bbox: { minX: x, minY: y, maxX: x + o.w, maxY: y + o.h },
    });
    expect(shapesOverlap(at(a, 0, 0), at(a, a.w, 0))).toBe(false);
    expect(shapesOverlap(at(a, 0, 0), at(a, a.w - 1, 0))).toBe(true);
  });

  it('nests eight pentagons on a 250 x 250 assembly panel at 36 degree steps, every one held by tabs', () => {
    let panel = withInstances(base, 'F', 8);
    const set = applyPanelOp(panel, { op: 'setSettings', settings: { rotationStep: 36 } });
    if (!set.ok) throw new Error(set.error);
    panel = set.panel;
    const t0 = performance.now();
    const r = arrange(panel, sources, LIMITS);
    const ms = performance.now() - t0;
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(ms).toBeLessThan(20000);
    const placed = applyPanelOp(panel, { op: 'placeInstances', placements: r.placements });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const g = computeGeometry(placed.panel, sources);
    const errors = checkPanel(placed.panel, sources, LIMITS, g).filter((i) => i.severity === 'error');
    expect(errors.map((i) => `${i.code}: ${i.message}`)).toEqual([]);
    expect(r.width).toBeLessThanOrEqual(250.001);
    expect(r.height).toBeLessThanOrEqual(250.001);
    // Quarter turns alone manage six: the tilted ones interlock.
    const rotations = new Set(r.placements.map((p) => p.rotation));
    expect([...rotations].some((rot) => rot! % 90 !== 0)).toBe(true);
  });

  it('still packs rectangles as before at a 90 degree step', () => {
    const rect = plainBoard('r', 30, 20);
    const src = [resolved('R', rect)];
    let p = applyPanelOp(newPanel('x'), { op: 'addSource', source: { key: 'R', path: 'r.flamingo', hash: 'h', name: 'r', needed: 4 } });
    if (!p.ok) throw new Error(p.error);
    const panel = withInstances(p.panel, 'R', 4);
    const r = arrange(panel, src, LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.placements.every((pl) => [0, 90, 180, 270].includes(pl.rotation!))).toBe(true);
  });
});
