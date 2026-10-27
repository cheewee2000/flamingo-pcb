import { describe, it, expect } from 'vitest';
import { newBoard } from '@flamingo/engine';
import { assemblyFit, checkPanel, hasErrors, targetLayers } from '../src/check.js';
import type { IssueCode, PanelIssue } from '../src/check.js';
import { computeGeometry } from '../src/geometry.js';
import { panelRules } from '../src/rules.js';
import { resolveSourceGeometry } from '../src/source.js';
import { EDGE_CONN, LIMITS, awkwardBoard, comp, panelOf, plainBoard, rectOutline, resolved } from './helpers.js';

function codes(issues: PanelIssue[], severity?: PanelIssue['severity']): IssueCode[] {
  return issues.filter((i) => severity === undefined || i.severity === severity).map((i) => i.code);
}

function find(issues: PanelIssue[], code: IssueCode): PanelIssue {
  const hit = issues.find((i) => i.code === code);
  if (!hit) throw new Error(`no ${code} issue in [${codes(issues).join(', ')}]`);
  return hit;
}

describe('blocked-edge detection', () => {
  it('a plain board has four free edges', () => {
    const g = resolveSourceGeometry(plainBoard('p', 30, 20), LIMITS);
    expect(Object.values(g.edges).every((e) => !e.blocked)).toBe(true);
    expect(g.overhangs).toEqual([]);
    expect(g.edgeKeepouts).toEqual([]);
    expect(g.fillRatio).toBeCloseTo(1, 6);
  });

  it('a courtyard past the outline blocks that edge and asks for overhang + margin', () => {
    const g = resolveSourceGeometry(awkwardBoard(), LIMITS);
    expect(g.edges.S.blocked).toBe(true);
    expect(g.edges.S.overhang).toBeCloseTo(1.5, 6);
    expect(g.edges.S.clearance).toBeCloseTo(1.5 + LIMITS.blockedEdges.overhangMargin.value, 6);
    expect(g.edges.S.reasons).toEqual(['J1 overhangs 1.5 mm']);
    expect(g.overhangs).toHaveLength(1);
    expect(g.overhangs[0]).toMatchObject({ refdes: 'J1', side: 'S' });
    expect(g.edges.E.blocked).toBe(false);
    expect(g.edges.W.blocked).toBe(false);
  });

  it('a keepout that reaches the edge blocks it', () => {
    const g = resolveSourceGeometry(awkwardBoard(), LIMITS);
    expect(g.edges.N.blocked).toBe(true);
    expect(g.edges.N.overhang).toBe(0);
    expect(g.edges.N.clearance).toBe(LIMITS.blockedEdges.keepoutClearance.value);
    expect(g.edges.N.reasons).toEqual(['keepout reaches the edge']);
    expect(g.edgeKeepouts).toEqual([expect.objectContaining({ id: 'ant', sides: ['N'] })]);
  });

  it('a keepout in the middle of the board blocks nothing', () => {
    const b = plainBoard('p', 30, 20);
    b.keepouts.push({
      id: 'mid',
      layers: 'all',
      polygon: [
        { x: 10, y: 8 },
        { x: 20, y: 8 },
        { x: 20, y: 12 },
        { x: 10, y: 12 },
      ],
      keepout: { copper: true, via: true },
    });
    const g = resolveSourceGeometry(b, LIMITS);
    expect(Object.values(g.edges).some((e) => e.blocked)).toBe(false);
  });

  it('a courtyard flush with the edge does not block it', () => {
    const b = plainBoard('p', 30, 20);
    b.components.push(comp('J1', EDGE_CONN, 15, 2)); // courtyard bottom at y = 0
    expect(resolveSourceGeometry(b, LIMITS).edges.S.blocked).toBe(false);
  });

  it('pads stand in when a footprint has no courtyard', () => {
    const b = plainBoard('p', 30, 20);
    b.components.push(comp('J1', { ...EDGE_CONN, courtyard: [] }, 29.9, 10));
    const g = resolveSourceGeometry(b, LIMITS);
    expect(g.edges.E.blocked).toBe(true);
    expect(g.edges.E.overhang).toBeGreaterThan(0.5);
  });

  it('a bottom-side part overhangs on the mirrored side', () => {
    const b = plainBoard('p', 30, 20);
    // Courtyard spans x -4..4: at x = 3 it reaches x = -1 either way round.
    b.components.push(comp('J1', EDGE_CONN, 3, 10, { side: 'bottom' }));
    const g = resolveSourceGeometry(b, LIMITS);
    expect(g.edges.W.blocked).toBe(true);
    expect(g.edges.W.overhang).toBeCloseTo(1, 6);
  });

  it('a part in the notch of an L-shaped board overhangs the outline', () => {
    const b = newBoard('ell', 2);
    const pts = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ];
    b.outline = pts.map((start, i) => ({ type: 'line' as const, start, end: pts[(i + 1) % pts.length]! }));
    b.components.push(comp('J1', EDGE_CONN, 20, 9)); // courtyard top at y = 12, in the notch
    const g = resolveSourceGeometry(b, LIMITS);
    // Its two stray corners are nearest to N and to E: both are blocked.
    expect(g.overhangs.map((o) => o.side).sort()).toEqual(['E', 'N']);
    expect(g.edges.N.blocked).toBe(true);
    expect(g.edges.E.blocked).toBe(true);
    expect(g.edges.S.blocked).toBe(false);
    expect(g.edges.N.reasons).toEqual(['J1 overhangs the outline']);
    expect(g.fillRatio).toBeCloseTo(400 / 600, 6);
  });

  it('follows the board when the instance is rotated', () => {
    const src = resolved('A', awkwardBoard());
    const at = (rotation: 0 | 90 | 180 | 270) =>
      computeGeometry(panelOf([src], [['A', 10, 10, { rotation }]]), [src]).instances[0]!;
    // Board S carries the connector, board N the keepout.
    expect(at(0).edges.S.reasons[0]).toContain('J1');
    expect(at(90).edges.E.reasons[0]).toContain('J1');
    expect(at(90).edges.W.reasons[0]).toContain('keepout');
    expect(at(180).edges.N.reasons[0]).toContain('J1');
    expect(at(270).edges.W.reasons[0]).toContain('J1');
    expect(at(90).margins.E).toBeCloseTo(2.5, 6);
    expect(at(90).margins.N).toBe(2);
  });

  it('a board without an outline cannot be resolved', () => {
    const b = plainBoard('p', 30, 20);
    b.outline = [];
    expect(() => resolveSourceGeometry(b, LIMITS)).toThrow('has no outline');
  });
});

describe('checkPanel: sources and stackup', () => {
  const two = resolved('A', plainBoard('alpha', 30, 20, 2));
  const four = resolved('B', plainBoard('beta', 30, 20, 4));

  it('a clean panel has no errors or warnings', () => {
    const panel = panelOf([two], [
      ['A', 0, 7],
      ['A', 32, 7],
    ]);
    const issues = checkPanel(panel, [two], LIMITS);
    expect(codes(issues, 'error')).toEqual([]);
    expect(codes(issues, 'warning')).toEqual(['size-assembly']); // under Standard's 70 x 70 mm
    expect(hasErrors(issues)).toBe(false);
  });

  it('reports a stale source as a warning naming its instances', () => {
    const stale = { ...two, stale: true };
    const issues = checkPanel(panelOf([stale], [['A', 0, 7]]), [stale], LIMITS);
    const issue = find(issues, 'source-stale');
    expect(issue.severity).toBe('warning');
    expect(issue.instances).toEqual(['A1']);
    expect(issue.message).toContain('changed on disk');
  });

  it('reports an unreadable source as an error and leaves its instances unplaced', () => {
    const gone = { ...two, geometry: undefined, board: undefined, error: 'cannot read "alpha.flamingo": ENOENT' };
    const panel = panelOf([gone], [['A', 0, 7]]);
    const issues = checkPanel(panel, [gone], LIMITS);
    expect(find(issues, 'source-missing')).toMatchObject({ severity: 'error', instances: ['A1'] });
    expect(computeGeometry(panel, [gone]).unplaced).toEqual([expect.objectContaining({ id: 'A1' })]);
  });

  it('mixed layer counts are an error that offers promotion', () => {
    const panel = panelOf([two, four], [
      ['A', 0, 7],
      ['B', 32, 7],
    ]);
    const issue = find(checkPanel(panel, [two, four], LIMITS), 'stackup-mismatch');
    expect(issue.severity).toBe('error');
    expect(issue.data).toEqual({ layers: [2, 4], promoteTo: 4 });
    expect(issue.message).toContain('A is 2-layer, B is 4-layer');
    expect(issue.message).toContain('promote the panel to 4 layers');
    expect(issue.instances).toEqual(['A1']);
    expect(targetLayers(panel, [two, four])).toBeNull();
  });

  it('promoting the panel clears the mismatch and says what is promoted', () => {
    const panel = panelOf(
      [two, four],
      [
        ['A', 0, 7],
        ['B', 32, 7],
      ],
      [{ op: 'setSettings', settings: { copperLayers: 4 } }],
    );
    const issues = checkPanel(panel, [two, four], LIMITS);
    expect(codes(issues)).not.toContain('stackup-mismatch');
    expect(find(issues, 'stackup-promoted')).toMatchObject({ severity: 'info', sources: ['A'] });
    expect(hasErrors(issues)).toBe(false);
    expect(targetLayers(panel, [two, four])).toBe(4);
  });

  it('a panel cannot have fewer layers than one of its boards', () => {
    const panel = panelOf([four], [['B', 0, 7]], [{ op: 'setSettings', settings: { copperLayers: 2 } }]);
    const issue = find(checkPanel(panel, [four], LIMITS), 'stackup-too-few');
    expect(issue.severity).toBe('error');
    expect(issue.data).toEqual({ promoteTo: 4 });
  });

  it('a source without instances does not count toward the stackup', () => {
    const panel = panelOf([two, four], [['A', 0, 7]]);
    expect(codes(checkPanel(panel, [two, four], LIMITS))).not.toContain('stackup-mismatch');
  });

  it('a board whose rules are tighter than the panel ruleset is an error', () => {
    const odd = plainBoard('odd', 30, 20, 2);
    odd.rules = 'jlcpcb-4l'; // 0.09 mm tracks allowed, on what will be made as a 2-layer board
    const src = resolved('A', odd);
    const issue = find(checkPanel(panelOf([src], [['A', 0, 7]]), [src], LIMITS), 'rules-mismatch');
    expect(issue.message).toContain('minTrackWidth');
  });

  describe('advanced-via boards', () => {
    const advBoard = (name: string): ReturnType<typeof plainBoard> => {
      const b = plainBoard(name, 30, 20, 4);
      b.rules = 'jlcpcb-4l-adv';
      return b;
    };

    it('a 4l-adv board on a 4-layer panel passes, and the panel takes 4l-adv', () => {
      const adv = resolved('C', advBoard('adv'));
      const panel = panelOf([adv], [['C', 0, 7]]);
      expect(codes(checkPanel(panel, [adv], LIMITS))).not.toContain('rules-mismatch');
      expect(panelRules(4, [adv]).id).toBe('jlcpcb-4l-adv');
    });

    it('4l and 4l-adv boards together make a 4l-adv panel', () => {
      const adv = resolved('C', advBoard('adv'));
      const panel = panelOf([four, adv], [
        ['B', 0, 7],
        ['C', 32, 7],
      ]);
      expect(codes(checkPanel(panel, [four, adv], LIMITS))).not.toContain('rules-mismatch');
      expect(panelRules(4, [four, adv]).id).toBe('jlcpcb-4l-adv');
      expect(panelRules(4, [four]).id).toBe('jlcpcb-4l');
    });

    it('a 4l-adv board on a 6-layer panel is still a mismatch', () => {
      const adv = resolved('C', advBoard('adv'));
      const panel = panelOf([adv], [['C', 0, 7]], [{ op: 'setSettings', settings: { copperLayers: 6 } }]);
      const issue = find(checkPanel(panel, [adv], LIMITS), 'rules-mismatch');
      expect(issue.severity).toBe('error');
      expect(issue.message).toContain('minDrill');
      expect(issue.message).toContain('jlcpcb-6l');
    });
  });

  it('warns when a needed board has no populated instance', () => {
    const panel = panelOf([two, four], [['A', 0, 7]], [{ op: 'setSettings', settings: { copperLayers: 4 } }]);
    expect(find(checkPanel(panel, [two, four], LIMITS), 'no-instances').message).toContain(
      'the panel has no B instance',
    );
    const bare = panelOf([two], [['A', 0, 7, { populate: false }]]);
    expect(find(checkPanel(bare, [two], LIMITS), 'no-instances').message).toContain('is bare');
  });

  it('an empty panel is only an info', () => {
    const issues = checkPanel(panelOf([two], []), [two], LIMITS);
    expect(codes(issues, 'error')).toEqual([]);
    expect(find(issues, 'empty').severity).toBe('info');
  });
});

describe('checkPanel: overlap and spacing', () => {
  const a = resolved('A', plainBoard('alpha', 30, 20));

  it('flags overlapping instances', () => {
    const issues = checkPanel(panelOf([a], [
      ['A', 0, 7],
      ['A', 20, 12],
    ]), [a], LIMITS);
    expect(find(issues, 'overlap')).toMatchObject({ severity: 'error', instances: ['A1', 'A2'] });
  });

  it('flags instances closer than the spacing, side by side and stacked', () => {
    const side = checkPanel(panelOf([a], [
      ['A', 0, 7],
      ['A', 31, 7],
    ]), [a], LIMITS);
    expect(find(side, 'spacing').message).toContain('1 mm apart; the panel spacing is 2 mm');
    const stacked = checkPanel(panelOf([a], [
      ['A', 0, 7],
      ['A', 0, 28.5],
    ]), [a], LIMITS);
    expect(find(stacked, 'spacing').message).toContain('1.5 mm apart');
  });

  it('flags instances too close corner to corner', () => {
    const issues = checkPanel(panelOf([a], [
      ['A', 0, 7],
      ['A', 31, 28],
    ]), [a], LIMITS);
    expect(find(issues, 'spacing').message).toContain('corner to corner');
  });

  it('accepts instances exactly at the spacing', () => {
    const issues = checkPanel(panelOf([a], [
      ['A', 0, 7],
      ['A', 32, 7],
      ['A', 0, 29],
    ]), [a], LIMITS);
    expect(codes(issues, 'error')).toEqual([]);
  });

  it('a blocked edge needs its own clearance, whichever board it belongs to', () => {
    const awk = resolved('B', awkwardBoard()); // S: connector, needs 2.5; N: keepout, needs 3
    // B above A with B's connector edge facing down at A, 2 mm apart.
    const tooClose = panelOf([a, awk], [
      ['A', 0, 7],
      ['B', 0, 29],
    ]);
    const issue = find(checkPanel(tooClose, [a, awk], LIMITS), 'blocked-edge-clearance');
    expect(issue.severity).toBe('error');
    expect(issue.instances).toEqual(['A1', 'B1']);
    expect(issue.message).toContain('needs 2.5 mm');
    expect(issue.message).toContain('B1: J1 overhangs 1.5 mm');

    const ok = panelOf([a, awk], [
      ['A', 0, 7],
      ['B', 0, 29.5],
    ]);
    // Far enough apart now. B is still an error for another reason: with N and
    // S blocked and no side rails, nothing can hold it.
    const issues = checkPanel(ok, [a, awk], LIMITS);
    expect(codes(issues)).not.toContain('blocked-edge-clearance');
    expect(find(issues, 'unsupported-instance')).toMatchObject({ severity: 'error', instances: ['B1'] });
    expect(find(issues, 'unsupported-instance').message).toContain('edges N, S are blocked');
  });

  it('two overhanging parts facing each other must clear each other', () => {
    const awk = resolved('B', awkwardBoard()); // connector on S, overhang 1.5 mm
    // Upper board as it is, lower board turned 180: connector faces connector.
    const at = (gap: number) =>
      panelOf([awk], [
        ['B', 0, 0, { rotation: 180 }],
        ['B', 0, 20 + gap],
      ], [{ op: 'setSettings', settings: { rails: { top: 0, bottom: 0, left: 5, right: 5 } } }]);
    // 2.5 mm satisfies each edge on its own; together they need 1.5 + 1.5 + 1.
    const tight = find(checkPanel(at(3), [awk], LIMITS), 'blocked-edge-clearance');
    expect(tight.message).toContain('needs 4 mm');
    expect(codes(checkPanel(at(4), [awk], LIMITS))).not.toContain('blocked-edge-clearance');
  });

  it('flags an overhanging part that lands on a neighbour or a rail', () => {
    const awk = resolved('B', awkwardBoard());
    const onNeighbour = panelOf([a, awk], [
      ['A', 0, 7],
      ['B', 0, 28], // 1 mm gap, connector reaches 1.5 mm down
    ]);
    const hit = checkPanel(onNeighbour, [a, awk], LIMITS).filter((i) => i.code === 'overhang-collision');
    expect(hit.map((i) => i.instances)).toContainEqual(['B1', 'A1']);
  });

  it('a silk-divider panel lets boards touch but not overlap', () => {
    const silk = [{ op: 'setSettings', settings: { separation: 'silk-divider', rails: { top: 0, bottom: 0 } } }] as const;
    const touching = panelOf([a], [
      ['A', 0, 0],
      ['A', 30, 0],
    ], [...silk]);
    expect(codes(checkPanel(touching, [a], LIMITS), 'error')).toEqual([]);
    const overlapping = panelOf([a], [
      ['A', 0, 0],
      ['A', 29, 0],
    ], [...silk]);
    expect(codes(checkPanel(overlapping, [a], LIMITS), 'error')).toEqual(['overlap']);
  });
});

describe('checkPanel: size limits', () => {
  it('reads its limits from the config, not from code', () => {
    const tight = structuredClone(LIMITS);
    tight.fab.maxSize['2'].value = { width: 50, height: 50 };
    const a = resolved('A', plainBoard('alpha', 60, 20));
    const panel = panelOf([a], [['A', 0, 7]]);
    expect(codes(checkPanel(panel, [a], LIMITS), 'error')).toEqual([]);
    expect(find(checkPanel(panel, [a], tight), 'size-fab').message).toContain('50 x 50 mm');
  });

  it('a panel too large for any assembly service is an error', () => {
    const big = resolved('A', plainBoard('big', 120, 100));
    const panel = panelOf([big], [
      ['A', 0, 7],
      ['A', 122, 7],
      ['A', 244, 7],
    ]);
    const issue = find(checkPanel(panel, [big], LIMITS), 'size-assembly');
    expect(issue.severity).toBe('error');
    expect(issue.message).toContain('exceeds the 250 x 250 mm maximum');
  });

  it('the same panel of bare boards only has to fit the fab', () => {
    const big = resolved('A', plainBoard('big', 120, 100));
    const panel = panelOf([big], [
      ['A', 0, 7, { populate: false }],
      ['A', 122, 7, { populate: false }],
      ['A', 244, 7, { populate: false }],
    ]);
    const issues = checkPanel(panel, [big], LIMITS);
    expect(codes(issues)).not.toContain('size-assembly');
    expect(codes(issues)).not.toContain('size-fab');
  });

  it('a panel beyond the fab maximum is an error even when bare', () => {
    const huge = resolved('A', plainBoard('huge', 400, 300));
    const panel = panelOf([huge], [
      ['A', 0, 7, { populate: false }],
      ['A', 402, 7, { populate: false }],
    ]);
    expect(find(checkPanel(panel, [huge], LIMITS), 'size-fab').message).toContain('670 x 600 mm');
  });

  it('fits in either orientation', () => {
    expect(assemblyFit(240, 100, true, LIMITS).standard.fits).toBe(true);
    expect(assemblyFit(100, 240, true, LIMITS).standard.fits).toBe(true);
    expect(assemblyFit(260, 100, true, LIMITS).standard.fits).toBe(false);
    // A single board may be larger than a panel.
    expect(assemblyFit(260, 100, false, LIMITS).standard.fits).toBe(true);
  });

  it('a small panel is a warning for Standard only', () => {
    const a = resolved('A', plainBoard('alpha', 30, 20));
    const issues = checkPanel(panelOf([a], [
      ['A', 0, 7],
      ['A', 32, 7],
    ]), [a], LIMITS).filter((i) => i.code === 'size-assembly');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.message).toContain('Standard PCBA cannot take this panel');
    expect(issues[0]!.message).toContain('under the 70 x 70 mm minimum');
  });
});

describe('checkPanel: settings', () => {
  const a = resolved('A', plainBoard('alpha', 80, 60));

  it('rejects a spacing the fab will not route', () => {
    const panel = panelOf([a], [['A', 0, 7]], [{ op: 'setSettings', settings: { spacing: 1 } }]);
    expect(find(checkPanel(panel, [a], LIMITS), 'spacing-setting').severity).toBe('error');
  });

  it('rejects mouse-bite holes below the smallest non-plated drill', () => {
    const panel = panelOf([a], [['A', 0, 7]], [{ op: 'setSettings', settings: { tabs: { holeDiameter: 0.4 } } }]);
    expect(find(checkPanel(panel, [a], LIMITS), 'hole-setting').message).toContain('0.5 mm');
  });

  it('warns when rails are missing or too narrow for fiducials', () => {
    const none = panelOf([a], [['A', 0, 0]], [{ op: 'setSettings', settings: { rails: { top: 0, bottom: 0 } } }]);
    const noRails = checkPanel(none, [a], LIMITS);
    expect(noRails.filter((i) => i.code === 'rail-features').map((i) => i.message)).toEqual([
      'no rails: fiducials were not placed',
      'no rails: tooling holes were not placed',
    ]);
    expect(find(noRails, 'rails-required').severity).toBe('warning');

    const narrow = panelOf([a], [['A', 0, 5]], [{ op: 'setSettings', settings: { rails: { top: 3, bottom: 3 } } }]);
    expect(
      checkPanel(narrow, [a], LIMITS).some((i) => i.code === 'rail-features' && /too narrow for fiducials/.test(i.message)),
    ).toBe(true);
  });

  it('flags bottom-side parts as Standard-only', () => {
    const b = plainBoard('two-sided', 80, 60);
    b.components.push(comp('R2', b.components[0]!.footprint, 20, 20, { side: 'bottom' }));
    const src = resolved('A', b);
    expect(find(checkPanel(panelOf([src], [['A', 0, 7]]), [src], LIMITS), 'assembly-sides').severity).toBe('info');
  });

  it("names the parts only Standard PCBA places, from JLCPCB's library", () => {
    const b = plainBoard('faces', 80, 60);
    const src = resolved('F', b);
    const plain = checkPanel(panelOf([src], [['F', 0, 0]]), [src], LIMITS);
    expect(codes(plain)).not.toContain('assembly-standard-only');

    src.geometry!.parts[0]!.jlc = { basic: false, standardOnly: true, prices: [{ from: 1, to: null, price: 0.03 }] };
    const flagged = find(checkPanel(panelOf([src], [['F', 0, 0]]), [src], LIMITS), 'assembly-standard-only');
    expect(flagged.severity).toBe('info');
    expect(flagged.message).toBe("F (C25804): Standard only in JLCPCB's parts library. Economic PCBA cannot place it.");
    expect(flagged.sources).toEqual(['F']);
    expect(flagged.instances).toEqual(['F1']);
  });

  it('limits the designs on a silk-divider panel', () => {
    const tight = structuredClone(LIMITS);
    tight.silkDivider.maxDesigns.value = 1;
    const b = resolved('B', plainBoard('beta', 80, 60));
    const panel = panelOf([a, b], [
      ['A', 0, 0],
      ['B', 80, 0],
    ], [{ op: 'setSettings', settings: { separation: 'silk-divider', rails: { top: 0, bottom: 0 } } }]);
    expect(find(checkPanel(panel, [a, b], tight), 'silk-divider-designs').severity).toBe('error');
    expect(codes(checkPanel(panel, [a, b], LIMITS))).not.toContain('silk-divider-designs');
  });

  it('warns about a board that cannot be cut out with straight cuts', () => {
    const ell = newBoard('ell', 2);
    const pts = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ];
    ell.outline = pts.map((start, i) => ({ type: 'line' as const, start, end: pts[(i + 1) % pts.length]! }));
    const src = resolved('L', ell);
    const panel = panelOf([src], [['L', 0, 0]], [
      { op: 'setSettings', settings: { separation: 'silk-divider', rails: { top: 0, bottom: 0 } } },
    ]);
    expect(find(checkPanel(panel, [src], LIMITS), 'silk-divider-shape').message).toContain('67%');
  });
});

describe('rectOutline helper', () => {
  it('closes', () => {
    const o = rectOutline(3, 2);
    expect(o[3]!.end).toEqual(o[0]!.start);
  });
});
