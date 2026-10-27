import { describe, it, expect } from 'vitest';
import { checkPanel } from '../src/check.js';
import { computeGeometry } from '../src/geometry.js';
import { arrange } from '../src/layout.js';
import { boardColorAt, tint } from '../src/colors.js';
import { renderPanelSVG } from '../src/node/render.js';
import type { PanelIssue } from '../src/check.js';
import { FAB_COLORS, classifyRings } from '../src/fabview.js';
import { LIMITS, applyAll, awkwardBoard, panelOf, plainBoard, resolved } from './helpers.js';

describe('renderPanelSVG', () => {
  const a = resolved('A', plainBoard('alpha', 40, 30));
  const w = resolved('W', awkwardBoard());

  function scene() {
    let panel = panelOf([a, w], [
      ['A', 0, 0],
      ['A', 0, 0, { populate: false }],
      ['W', 0, 0],
      ['W', 0, 0],
    ], [{ op: 'setSettings', settings: { rails: { left: 5, right: 5 } } }]);
    const r = arrange(panel, [a, w], LIMITS);
    if (!r.ok) throw new Error(r.reason);
    panel = applyAll(panel, { op: 'placeInstances', placements: r.placements }, { op: 'setPinned', id: 'A1', pinned: true });
    const geometry = computeGeometry(panel, [a, w]);
    return { panel, geometry, issues: checkPanel(panel, [a, w], LIMITS, geometry) };
  }

  it('is a well-formed SVG whose only colours are the boards\'', () => {
    const { panel, geometry, issues } = scene();
    const svg = renderPanelSVG(panel, [a, w], geometry, { issues, limits: [{ width: 250, height: 250, label: 'assembly max' }] });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    const colours = new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1]));
    // Ink, paper, and for each of the two boards its colour and its tint.
    expect([...colours].sort()).toEqual(
      ['#000', '#fff', boardColorAt(0), tint(boardColorAt(0)), boardColorAt(1), tint(boardColorAt(1))].sort(),
    );
    expect(svg).not.toContain('<text');
    expect(svg).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('draws every outline, tab and hole', () => {
    const { panel, geometry } = scene();
    const svg = renderPanelSVG(panel, [a, w], geometry, { labels: false });
    const holes = geometry.tabs.reduce((n, t) => n + t.holes.length, 0);
    const marks = new Set(geometry.fiducials.map((f) => `${f.at.x},${f.at.y}`)).size;
    expect((svg.match(/<circle/g) ?? []).length).toBe(holes + geometry.toolingHoles.length + 2 * marks);
    expect(geometry.tabs.length).toBeGreaterThan(0);
    expect((svg.match(/fill="#000" stroke="#000" stroke-width="0.100"/g) ?? []).length).toBeGreaterThanOrEqual(geometry.tabs.length);
  });

  it('marks bare boards, blocked edges and size limits by line style', () => {
    const { panel, geometry } = scene();
    const bare = renderPanelSVG(panel, [a, w], geometry, { labels: false });
    const allPopulated = renderPanelSVG(
      applyAll(panel, { op: 'setPopulate', id: 'A2', populate: true }),
      [a, w],
      geometry.instances.some((i) => !i.populate)
        ? computeGeometry(applyAll(panel, { op: 'setPopulate', id: 'A2', populate: true }), [a, w])
        : geometry,
      { labels: false },
    );
    expect(bare).toContain('stroke-dasharray="2 1"');
    expect(allPopulated).not.toContain('stroke-dasharray="2 1"');
    expect(bare).toContain('stroke-width="0.700"'); // blocked edge
    const limited = renderPanelSVG(panel, [a, w], geometry, { limits: [{ width: 250, height: 250, label: 'asm' }] });
    expect(limited).toContain('stroke-dasharray="4 2"');
  });

  it('gives every instance of a board that board\'s colour', () => {
    const { panel, geometry } = scene();
    const svg = renderPanelSVG(panel, [a, w], geometry, { labels: false });
    const fills = (c: string): number => (svg.match(new RegExp(`fill="${tint(c)}"`, 'g')) ?? []).length;
    expect(fills(boardColorAt(0))).toBe(panel.instances.filter((i) => i.source === 'A').length);
    expect(fills(boardColorAt(1))).toBe(panel.instances.filter((i) => i.source === 'W').length);
  });

  it('scales to the requested width', () => {
    const { panel, geometry } = scene();
    expect(renderPanelSVG(panel, [a, w], geometry, { widthPx: 640 })).toContain('width="640"');
  });

  it('renders an empty panel', () => {
    const panel = panelOf([a], []);
    const svg = renderPanelSVG(panel, [a], computeGeometry(panel, [a]));
    expect(svg).toContain('<svg');
    expect(svg).not.toMatch(/NaN/);
  });
});

describe('renderPanelSVG, fabricated view', () => {
  const a = resolved('A', plainBoard('alpha', 40, 30));

  /** A 2 x 2 panel of `a` with the given separation, rails top and bottom. */
  function grid(separation: 'mouse-bite' | 'v-cut' | 'silk-divider') {
    const gap = separation === 'mouse-bite' ? 2 : 0;
    const panel = panelOf(
      [a],
      [
        ['A', 0, 0],
        ['A', 40 + gap, 0],
        ['A', 0, 30 + gap],
        ['A', 40 + gap, 30 + gap],
      ],
      [{ op: 'setSettings', settings: { separation, rails: { top: 5, bottom: 5, left: 0, right: 0 } } }],
    );
    return { panel, geometry: computeGeometry(panel, [a]) };
  }

  /** The rings of the one even-odd material path. */
  function materialRings(svg: string): string[] {
    const paths = [...svg.matchAll(/<path d="([^"]+)" fill="[^"]+" fill-rule="evenodd"/g)];
    expect(paths).toHaveLength(1);
    return paths[0]![1]!.split('M').filter((r) => r.trim() !== '');
  }

  it('fills a mouse-bite panel as one even-odd piece with a ring per opening', () => {
    const { panel, geometry } = grid('mouse-bite');
    const rings = classifyRings(geometry.profile);
    // One piece: the frame. The gaps between boards and rails, cut up by the tabs, are openings in it.
    const outer = rings.filter((r) => r.depth === 0);
    expect(outer).toHaveLength(1);
    // Spans the frame (with no side rails its sides are notched where the gaps open out).
    const xs = outer[0]!.points.map((p) => p.x);
    const ys = outer[0]!.points.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(geometry.frame!.width, 3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(geometry.frame!.height, 3);
    const openings = rings.filter((r) => r.depth === 1);
    expect(openings.length).toBe(rings.length - 1);
    expect(openings.length).toBeGreaterThan(1);

    const svg = renderPanelSVG(panel, [a], geometry, { view: 'fab' });
    expect(materialRings(svg)).toHaveLength(rings.length);
    expect(svg).toContain(`fill="${FAB_COLORS.mask}" fill-rule="evenodd"`);
    expect(svg).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('tells material from openings by containment, not order or winding', () => {
    const sq = (x0: number, s: number) => [
      { x: x0, y: x0 },
      { x: x0 + s, y: x0 },
      { x: x0 + s, y: x0 + s },
      { x: x0, y: x0 + s },
    ];
    // An island inside an opening, listed first; then a separate piece touching nothing.
    const rings = classifyRings([sq(4, 2), [...sq(2, 6)].reverse(), sq(0, 10), sq(20, 3)]);
    expect(rings.map((r) => r.depth)).toEqual([2, 1, 0, 0]);
    expect(rings.map((r) => r.area)).toEqual([4, 36, 100, 9]);
  });

  it('punches every mouse-bite and tooling hole at its true size and place', () => {
    const { panel, geometry } = grid('mouse-bite');
    const svg = renderPanelSVG(panel, [a], geometry, { view: 'fab' });
    const holes = geometry.tabs.flatMap((t) => t.holes);
    expect(holes.length).toBeGreaterThan(0);
    const drilled = [...svg.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([\d.]+)" fill="#fff"\/>/g)];
    expect(drilled).toHaveLength(holes.length + geometry.toolingHoles.length);
    const r = (panel.settings.tabs.holeDiameter / 2).toFixed(3);
    expect(drilled.filter((m) => m[3] === r)).toHaveLength(holes.length);
    // SVG x is panel x less the view's left edge: the frame less a 6 mm margin.
    const x0 = geometry.frame!.outer.minX - 6;
    const xs = new Set(drilled.map((m) => m[1]));
    for (const h of holes) expect(xs.has((h.x - x0).toFixed(3))).toBe(true);
  });

  it('draws material only: no tab bars, limits or board colours', () => {
    const { panel, geometry } = grid('mouse-bite');
    const svg = renderPanelSVG(panel, [a], geometry, { view: 'fab', limits: [{ width: 250, height: 250, label: 'asm' }] });
    expect(svg).not.toContain('stroke-dasharray');
    expect(svg).not.toContain(`"${boardColorAt(0)}"`);
    expect(svg).not.toContain(`"${tint(boardColorAt(0))}"`);
  });

  it('shows a V-cut panel as one rectangle scored edge to edge', () => {
    const { panel, geometry } = grid('v-cut');
    const svg = renderPanelSVG(panel, [a], geometry, { view: 'fab' });
    const rings = materialRings(svg);
    expect(rings).toHaveLength(1);
    expect(rings[0]!.match(/L/g)).toHaveLength(3);
    expect(geometry.scores.length).toBeGreaterThan(0);
    expect(svg.match(new RegExp(`<line [^>]*stroke="${FAB_COLORS.score}"`, 'g'))).toHaveLength(geometry.scores.length);
  });

  it('shows a silk-divider panel as one rectangle with silkscreen lines', () => {
    const { panel, geometry } = grid('silk-divider');
    const svg = renderPanelSVG(panel, [a], geometry, { view: 'fab' });
    expect(materialRings(svg)).toHaveLength(1);
    expect(svg.match(new RegExp(`stroke="${FAB_COLORS.silk}"`, 'g'))).toHaveLength(geometry.dividers.length);
    expect(svg).not.toContain(`<line`);
  });

  it('marks issues with a badge, not an outline', () => {
    const { panel, geometry } = grid('mouse-bite');
    const issues: PanelIssue[] = [{ code: 'overlap', severity: 'error', message: 'x', instances: ['A1'] } as PanelIssue];
    expect(renderPanelSVG(panel, [a], geometry, { view: 'fab', issues })).toContain(`fill="${FAB_COLORS.error}"`);
    expect(renderPanelSVG(panel, [a], geometry, { view: 'fab' })).not.toContain(`fill="${FAB_COLORS.error}"`);
  });
});
