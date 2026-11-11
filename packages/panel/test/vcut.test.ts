import { describe, it, expect } from 'vitest';
import { createParser, GERBER, UNIMPLEMENTED } from '@tracespace/parser';
import type { Board, PathSeg } from '@flamingo/engine';
import { newBoard } from '@flamingo/engine';
import { checkPanel, hasErrors } from '../src/check.js';
import type { IssueCode, PanelIssue } from '../src/check.js';
import { computeGeometry } from '../src/geometry.js';
import { mergePanel } from '../src/merge.js';
import { buildPanelFab } from '../src/node/exportPanelFab.js';
import { renderPanelSVG } from '../src/node/render.js';
import { applyPanelOp } from '../src/ops.js';
import { assemblyEligibility } from '../src/order.js';
import { DEFAULT_SETTINGS, newPanel, parsePanel, serializePanel } from '../src/panel.js';
import { quoteOrder } from '../src/scenarios.js';
import type { PanelOp } from '../src/ops.js';
import { FEES, LIMITS, R0603, comp, panelOf, plainBoard, resolved } from './helpers.js';
import type { InstanceSpec } from './helpers.js';

const VCUT: PanelOp = { op: 'setSettings', settings: { separation: 'v-cut' } };
const A = resolved('A', plainBoard('alpha', 40, 30));

function codes(issues: PanelIssue[], severity?: PanelIssue['severity']): IssueCode[] {
  return issues.filter((i) => severity === undefined || i.severity === severity).map((i) => i.code);
}

/** 2 x 2 grid of 40 x 30 boards between the default 5 mm top and bottom rails: 80 x 70 mm. */
function grid(extra: PanelOp[] = [VCUT]) {
  const specs: InstanceSpec[] = [
    ['A', 0, 5],
    ['A', 40, 5],
    ['A', 0, 35],
    ['A', 40, 35],
  ];
  const panel = panelOf([A], specs, extra);
  return { panel, geometry: computeGeometry(panel, [A]) };
}

/** 40 x 30 outline with one corner rounded (r = 3). */
function roundedBoard(): Board {
  const b = newBoard('rounded', 2);
  const r = 3;
  const segs: PathSeg[] = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
    { type: 'line', start: { x: 40, y: 0 }, end: { x: 40, y: 30 - r } },
    { type: 'arc', start: { x: 40, y: 30 - r }, end: { x: 40 - r, y: 30 }, center: { x: 40 - r, y: 30 - r }, cw: false },
    { type: 'line', start: { x: 40 - r, y: 30 }, end: { x: 0, y: 30 } },
    { type: 'line', start: { x: 0, y: 30 }, end: { x: 0, y: 0 } },
  ];
  b.outline = segs;
  b.components.push(comp('R1', R0603, 20, 15));
  return b;
}

describe('v-cut settings', () => {
  it('is accepted by the settings validator and survives a save and load', () => {
    const r = applyPanelOp(newPanel('p'), VCUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.panel.settings.separation).toBe('v-cut');
    expect(parsePanel(serializePanel(r.panel)).settings.separation).toBe('v-cut');
  });

  it('names v-cut when it rejects an unknown separation', () => {
    const r = applyPanelOp(newPanel('p'), { op: 'setSettings', settings: { separation: 'scored' as never } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('"v-cut"');
  });

  it('leaves mouse bites the default', () => {
    expect(newPanel('p').settings.separation).toBe('mouse-bite');
  });
});

describe('v-cut geometry', () => {
  it('abuts the boards, keeps rails, fiducials and tooling holes, and routes only the frame', () => {
    const { geometry: g } = grid();
    expect(g.frame!.outer).toEqual({ minX: 0, minY: 0, maxX: 80, maxY: 70 });
    expect(g.tabs).toEqual([]);
    expect(g.rails.map((r) => r.side).sort()).toEqual(['bottom', 'top']);
    expect(g.fiducials.length).toBeGreaterThan(0);
    expect(g.toolingHoles.length).toBeGreaterThan(0);
    expect(g.profile).toHaveLength(1);
    expect(g.profile[0]).toHaveLength(4);
  });

  it('scores every shared edge, board to board and board to rail, from one side of the panel to the other', () => {
    const { geometry: g } = grid();
    const h = g.scores.filter((s) => s.axis === 'h');
    const v = g.scores.filter((s) => s.axis === 'v');
    expect(h.map((s) => s.level)).toEqual([5, 35, 65]);
    expect(v.map((s) => s.level)).toEqual([40]);
    for (const s of h) {
      expect(s.start).toEqual({ x: 0, y: s.level });
      expect(s.end).toEqual({ x: 80, y: s.level });
    }
    expect(v[0]!.start).toEqual({ x: 40, y: 0 });
    expect(v[0]!.end).toEqual({ x: 40, y: 70 });
    expect(h.find((s) => s.level === 35)!.instances.sort()).toEqual(['A1', 'A2', 'A3', 'A4']);
  });

  it('puts no score on an edge that is the panel edge', () => {
    const { geometry: g } = grid([VCUT, { op: 'setSettings', settings: { rails: { top: 0, bottom: 0 } } }]);
    expect(g.scores.filter((s) => s.axis === 'h').map((s) => s.level)).toEqual([35]);
  });

  it('has no scores on a mouse-bite panel', () => {
    const { geometry: g } = grid([]);
    expect(g.scores).toEqual([]);
    expect(g.tabs.length).toBeGreaterThan(0);
  });
});

describe('v-cut checks', () => {
  it('passes an aligned grid of rectangles', () => {
    const { panel, geometry } = grid();
    const issues = checkPanel(panel, [A], LIMITS, geometry);
    expect(codes(issues, 'error')).toEqual([]);
    expect(codes(issues).filter((c) => c.startsWith('v-cut'))).toEqual([]);
    // Touching boards are what V-cut wants: no spacing or tab complaints.
    expect(codes(issues)).not.toContain('spacing');
    expect(codes(issues)).not.toContain('spacing-setting');
    expect(codes(issues)).not.toContain('unsupported-instance');
  });

  it('reports a line that would run through a board', () => {
    const tall = resolved('T', plainBoard('tall', 40, 40));
    const panel = panelOf([A, tall], [
      ['A', 0, 5],
      ['T', 40, 5],
    ], [VCUT]);
    const issues = checkPanel(panel, [A, tall], LIMITS);
    const bad = issues.filter((i) => i.code === 'v-cut-misaligned');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe('error');
    expect(bad[0]!.instances).toEqual(['A1', 'T1']);
    expect(bad[0]!.message).toContain('runs through T1');
    expect(hasErrors(issues)).toBe(true);
  });

  it('rejects a board that is not a plain rectangle', () => {
    const r = resolved('R', roundedBoard());
    const panel = panelOf([r], [
      ['R', 0, 5],
      ['R', 40, 5],
    ], [VCUT]);
    const issues = checkPanel(panel, [r], LIMITS);
    const shape = issues.find((i) => i.code === 'v-cut-shape');
    expect(shape).toMatchObject({ severity: 'error', instances: ['R1', 'R2'], sources: ['R'] });
  });

  it('enforces the minimum V-cut panel size', () => {
    const small = resolved('S', plainBoard('small', 20, 20));
    const panel = panelOf([small], [
      ['S', 0, 5],
      ['S', 20, 5],
    ], [VCUT]);
    const issues = checkPanel(panel, [small], LIMITS);
    expect(issues.find((i) => i.code === 'v-cut-size')).toMatchObject({ severity: 'error' });
  });

  it('flags parallel scores closer than JLCPCB allows', () => {
    // A 1 mm gap between columns gives two vertical scores 1 mm apart.
    const panel = panelOf([A], [
      ['A', 0, 5],
      ['A', 41, 5],
      ['A', 0, 35],
      ['A', 41, 35],
    ], [VCUT]);
    const issues = checkPanel(panel, [A], LIMITS);
    expect(issues.some((i) => i.code === 'v-cut-lines' && i.severity === 'error' && /1 mm apart/.test(i.message))).toBe(true);
  });

  it('warns about copper close to a score', () => {
    const b = plainBoard('edgy', 40, 30);
    b.components.push(comp('R2', R0603, 1.2, 15)); // pad 1 reaches x = 0.05
    const e = resolved('E', b);
    const panel = panelOf([e], [
      ['E', 0, 5],
      ['E', 40, 5],
    ], [VCUT]);
    const issues = checkPanel(panel, [e], LIMITS);
    expect(issues.find((i) => i.code === 'v-cut-near-copper')).toMatchObject({ severity: 'warning', instances: ['E2'] });
  });

  it('is turned away by Economic PCBA and taken by Standard', () => {
    const piece = { width: 80, height: 70, layers: 2 as const, boards: 4, designs: 1, separation: 'v-cut' as const };
    const eco = assemblyEligibility('economic', piece, 1, 20, true, LIMITS, FEES);
    expect(eco.eligible).toBe(false);
    expect(eco.reason).toBe('Economic PCBA takes panels separated by mouse-bite, not v-cut');
    expect(assemblyEligibility('standard', piece, 1, 20, true, LIMITS, FEES).eligible).toBe(true);
  });
});

describe('v-cut fab output', () => {
  function gko(files: Map<string, string>): string {
    const name = [...files.keys()].find((n) => n.endsWith('.GKO'));
    if (!name) throw new Error('no GKO');
    return files.get(name)!;
  }

  it('passes the score lines through the merge', () => {
    const { panel, geometry } = grid();
    const merged = mergePanel(panel, [A], LIMITS, geometry);
    expect(merged.scores).toHaveLength(4);
    expect(merged.scores[0]).toEqual({ start: { x: 0, y: 5 }, end: { x: 80, y: 5 } });
  });

  it('draws each score edge to edge on the profile layer, with a V-CUT label, and nothing more for mouse bites', () => {
    const { panel, geometry } = grid();
    const out = gko(buildPanelFab(panel, [A], LIMITS, { geometry }).gerbers);
    // Horizontal score at y = 35 and vertical at x = 40, as open strokes.
    expect(out).toContain('X0Y35000000D02*');
    expect(out).toContain('X80000000Y35000000D01*');
    expect(out).toContain('X40000000Y0D02*');
    expect(out).toContain('X40000000Y70000000D01*');
    // The label is stroked text: its own aperture, 0.12 x the 1.5 mm text height.
    expect(out).toMatch(/%ADD\d+C,0\.18\*%/);
    const parser = createParser();
    parser.feed(out);
    const root = parser.results();
    expect(root.filetype).toBe(GERBER);
    expect(root.done).toBe(true);
    expect(root.children.filter((c) => c.type === UNIMPLEMENTED && !(c as { value: string }).value.startsWith('%TF'))).toEqual([]);

    // The label sits outside the panel: below it for vertical lines, left of it for horizontal ones.
    const ys = [...out.matchAll(/Y(-?\d+)D0[12]\*/g)].map((m) => Number(m[1]) / 1e6);
    const xs = [...out.matchAll(/X(-?\d+)Y/g)].map((m) => Number(m[1]) / 1e6);
    expect(Math.min(...ys)).toBeLessThan(0);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.min(...ys)).toBeGreaterThan(-3);

    const plain = grid([]);
    const mb = gko(buildPanelFab(plain.panel, [A], LIMITS, { geometry: plain.geometry }).gerbers);
    expect(mb).not.toMatch(/C,0\.18\*%/);
  });

  it('draws the scores in the SVG render as dashed lines', () => {
    const { panel, geometry } = grid();
    const svg = renderPanelSVG(panel, [A], geometry);
    const dashed = svg.match(/<line [^>]*stroke-dasharray="1.2 0.6"/g) ?? [];
    expect(dashed).toHaveLength(4);
    expect(renderPanelSVG(grid([]).panel, [A], grid([]).geometry)).not.toContain('stroke-dasharray="1.2 0.6"');
  });
});

describe('v-cut scenarios', () => {
  const src = { key: 'A', path: A.path, hash: 'h', name: A.name, needed: 20 };
  const request = (separation: 'mouse-bite' | 'v-cut') => ({
    name: 'q',
    sources: [src],
    resolved: [A],
    settings: { ...DEFAULT_SETTINGS, separation },
    limits: LIMITS,
    fees: FEES,
  });

  it('keeps V-cut for the panels of a panel set to V-cut', () => {
    const r = quoteOrder(request('v-cut'));
    const panels = r.scenarios.filter((s) => s.layout !== null);
    expect(panels.length).toBeGreaterThan(0);
    for (const s of panels) {
      expect(s.layout!.settings.separation).toBe('v-cut');
      // Only Standard PCBA takes a V-cut panel.
      expect(s.orders[0]!.priced.order.assembly?.type).toBe('standard');
    }
  });

  it('never proposes V-cut on its own', () => {
    const r = quoteOrder(request('mouse-bite'));
    for (const s of r.scenarios) expect(s.layout?.settings.separation).not.toBe('v-cut');
  });
});
