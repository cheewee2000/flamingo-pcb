import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { createParser, GERBER, DRILL, UNIMPLEMENTED } from '@tracespace/parser';
import type { Board, Point } from '@flamingo/engine';
import { fillAllZones, padWorld, parseBoard } from '@flamingo/engine';
import { generateGerbers } from '@flamingo/fab';
import { computeGeometry } from '../src/geometry.js';
import { arrange } from '../src/layout.js';
import { assemblyBoard, mergePanel, mergedRefdes } from '../src/merge.js';
import { buildPanelFab, exportPanelFab } from '../src/node/exportPanelFab.js';
import type { ResolvedSource } from '../src/resolved.js';
import { applyTransform } from '../src/transform.js';
import type { Panel, Rotation } from '../src/types.js';
import { LIMITS, R0603, applyAll, comp, panelOf, plainBoard, resolved } from './helpers.js';
import type { InstanceSpec } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const BLINKER: Board = parseBoard(
  readFileSync(join(here, '..', '..', 'engine', 'test', 'fixtures', 'blinker-routed.flamingo'), 'utf8'),
);

function assertGerberParses(name: string, content: string): void {
  const parser = createParser();
  parser.feed(content);
  const root = parser.results();
  expect(root.filetype, name).toBe(GERBER);
  expect(root.done, name).toBe(true);
  const bad = root.children.filter(
    (c) => c.type === UNIMPLEMENTED && !(c as { value: string }).value.startsWith('%TF'),
  );
  expect(bad, name).toEqual([]);
}

function assertDrillParses(name: string, content: string): void {
  const parser = createParser();
  parser.feed(content);
  const root = parser.results();
  expect(root.filetype, name).toBe(DRILL);
  expect(root.children.filter((c) => c.type === UNIMPLEMENTED), name).toEqual([]);
}

function csvRows(csv: string): string[][] {
  return csv
    .split('\r\n')
    .filter((l) => l !== '')
    .map((l) => {
      const out: string[] = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i]!;
        if (quoted) {
          if (ch === '"' && l[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (ch === '"') quoted = false;
          else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      out.push(cur);
      return out;
    });
}

function arrangedPanel(sources: ResolvedSource[], instances: InstanceSpec[]): Panel {
  const panel = panelOf(sources, instances);
  const r = arrange(panel, sources, LIMITS);
  if (!r.ok) throw new Error(r.reason);
  return applyAll(panel, { op: 'placeInstances', placements: r.placements });
}

function near(a: Point, b: Point): void {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
}

describe('mergePanel: refdes and coordinates', () => {
  const s = resolved('S', BLINKER);
  const m = resolved('M', plainBoard('mini', 18, 12));

  it('prefixes every refdes with its instance', () => {
    const panel = arrangedPanel([s, m], [
      ['S', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0],
    ]);
    const merged = mergePanel(panel, [s, m], LIMITS);
    const names = merged.board.components.map((c) => c.refdes);
    expect(names).toContain('S1_U1');
    expect(names).toContain('S1_J1');
    expect(names).toContain('M3_R1');
    expect(names).toHaveLength(BLINKER.components.length + 3);
    expect(new Set(names).size).toBe(names.length);
    expect(merged.origin.get('M3_R1')).toEqual({ instance: 'M3', source: 'M', refdes: 'R1' });
    expect(mergedRefdes('S1', 'U2')).toBe('S1_U2');
  });

  it.each<Rotation>([0, 90, 180, 270])('moves components, pads, tracks and vias for rotation %i', (rotation) => {
    const panel = panelOf([s], [['S', 12, 9, { rotation }]]);
    const geometry = computeGeometry(panel, [s]);
    const t = geometry.instances[0]!.transform;
    const merged = mergePanel(panel, [s], LIMITS, geometry);

    for (const c of BLINKER.components) {
      const out = merged.board.components.find((x) => x.refdes === `S1_${c.refdes}`)!;
      near(out.at, applyTransform(t, c.at));
      expect(out.rotation).toBeCloseTo((((c.rotation + rotation) % 360) + 360) % 360, 9);
      expect(out.side).toBe(c.side);
      // Every pad lands where the board's own pad lands once moved.
      for (const pad of c.footprint.pads) {
        near(padWorld(out, pad).at, applyTransform(t, padWorld(c, pad).at));
      }
    }
    BLINKER.tracks.forEach((tr, i) => {
      near(merged.board.tracks[i]!.seg.start, applyTransform(t, tr.seg.start));
      near(merged.board.tracks[i]!.seg.end, applyTransform(t, tr.seg.end));
      expect(merged.board.tracks[i]!.layer).toBe(tr.layer);
      expect(merged.board.tracks[i]!.width).toBe(tr.width);
    });
    BLINKER.vias.forEach((v, i) => near(merged.board.vias[i]!.at, applyTransform(t, v.at)));
    BLINKER.holes.forEach((h, i) => near(merged.board.holes[i]!.at, applyTransform(t, h.at)));

    // Everything stays inside the instance's outline box.
    const box = geometry.instances[0]!.bbox;
    for (const v of merged.board.vias) {
      expect(v.at.x).toBeGreaterThan(box.minX);
      expect(v.at.x).toBeLessThan(box.maxX);
      expect(v.at.y).toBeGreaterThan(box.minY);
      expect(v.at.y).toBeLessThan(box.maxY);
    }
  });

  it('places the instance so its outline box corner is at `at`', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const g = computeGeometry(panelOf([s], [['S', 12, 9, { rotation }]]), [s]);
      expect(g.instances[0]!.bbox.minX).toBeCloseTo(12, 9);
      expect(g.instances[0]!.bbox.minY).toBeCloseTo(9, 9);
    }
  });

  it('keeps nets of different instances apart', () => {
    const panel = arrangedPanel([s], [
      ['S', 0, 0],
      ['S', 0, 0],
    ]);
    const merged = mergePanel(panel, [s], LIMITS);
    const names = merged.board.nets.map((n) => n.name);
    expect(names).toContain('S1/GND');
    expect(names).toContain('S2/GND');
    expect(new Set(names).size).toBe(names.length);
    const gnd1 = merged.board.nets.find((n) => n.name === 'S1/GND')!;
    expect(gnd1.pins.every((p) => p.startsWith('S1_'))).toBe(true);
    expect(merged.board.tracks.filter((t) => t.net.startsWith('S1/')).length).toBe(BLINKER.tracks.length);
    // Every net still has a class on the merged board.
    const classes = new Set(merged.board.netClasses.map((c) => c.name));
    expect(merged.board.nets.every((n) => classes.has(n.class))).toBe(true);
  });

  it('moves the pour as filled on the source board instead of pouring again', () => {
    const panel = panelOf([s], [['S', 12, 9, { rotation: 90 }]]);
    const merged = mergePanel(panel, [s], LIMITS);
    const filled = fillAllZones(BLINKER);
    const area = (ring: Point[]): number =>
      ring.reduce((sum, p, i) => sum + p.x * ring[(i + 1) % ring.length]!.y - ring[(i + 1) % ring.length]!.x * p.y, 0) / 2;
    expect(merged.board.zones).toHaveLength(filled.zones.length);
    filled.zones.forEach((z, i) => {
      const out = merged.board.zones[i]!;
      expect(out.fill!.length).toBe(z.fill!.length);
      // Same signed area ring for ring: moved, not mirrored, not re-poured.
      z.fill!.forEach((ring, j) => expect(area(out.fill![j]!)).toBeCloseTo(area(ring), 6));
    });
  });

  it('keeps the legend the board has on its own', () => {
    const panel = panelOf([s], [['S', 12, 9]]);
    const merged = mergePanel(panel, [s], LIMITS);
    expect(merged.labels.get('S1_U1')!.text).toBe('U1');
    expect(merged.labels.size).toBe(BLINKER.components.length);

    // Same strokes on the silkscreen as the single board, only moved.
    const single = generateGerbers(BLINKER).files.get('blinker.GTO')!;
    const panelFiles = buildPanelFab(
      applyAll(panel, { op: 'setSettings', settings: { fiducials: { enabled: false }, toolingHoles: { enabled: false } } }),
      [s],
      LIMITS,
    );
    const draws = (g: string): number => g.split('\n').filter((l) => l.endsWith('D01*')).length;
    expect(draws(panelFiles.gerbers.get('test.GTO')!)).toBe(draws(single));
  });

  it('promotes a 2-layer board onto a 4-layer panel', () => {
    const four = resolved('F', plainBoard('four', 30, 20, 4));
    const panel = applyAll(arrangedPanel([s, four], [
      ['S', 0, 0],
      ['F', 0, 0],
    ]), { op: 'setSettings', settings: { copperLayers: 4 } });
    const merged = mergePanel(panel, [s, four], LIMITS);
    expect(merged.board.copperLayers).toBe(4);
    expect(merged.board.rules).toBe('jlcpcb-4l');
    const files = buildPanelFab(panel, [s, four], LIMITS).gerbers;
    expect([...files.keys()]).toEqual(expect.arrayContaining(['test.GTL', 'test.G1', 'test.G2', 'test.GBL']));
  });

  it('merges a 4l-adv board under jlcpcb-4l-adv and says the quote leaves out the surcharge', () => {
    const adv = plainBoard('adv', 30, 20, 4);
    adv.rules = 'jlcpcb-4l-adv';
    const a = resolved('A', adv);
    const four = resolved('F', plainBoard('four', 30, 20, 4));
    const panel = arrangedPanel([a, four], [
      ['A', 0, 0],
      ['F', 0, 0],
    ]);
    const merged = mergePanel(panel, [a, four], LIMITS);
    expect(merged.board.rules).toBe('jlcpcb-4l-adv');
    expect(merged.notes.some((n) => n.includes('jlcpcb-4l-adv') && n.includes('quote'))).toBe(true);

    // A 4l-adv board that is only listed, not placed, does not loosen the panel.
    const plain = mergePanel(arrangedPanel([a, four], [['F', 0, 0]]), [a, four], LIMITS);
    expect(plain.board.rules).toBe('jlcpcb-4l');
    expect(plain.notes).toEqual([]);
  });

  it('refuses mixed layer counts that were not promoted', () => {
    const four = resolved('F', plainBoard('four', 30, 20, 4));
    const panel = arrangedPanel([s, four], [
      ['S', 0, 0],
      ['F', 0, 0],
    ]);
    expect(() => mergePanel(panel, [s, four], LIMITS)).toThrow('different layer counts');
  });

  it('refuses an empty panel', () => {
    expect(() => mergePanel(panelOf([s], []), [s], LIMITS)).toThrow('no instances');
  });
});

describe('merged BOM and CPL', () => {
  const s = resolved('S', BLINKER);
  const m = resolved('M', plainBoard('mini', 18, 12));

  function panel(): Panel {
    return arrangedPanel([s, m], [
      ['S', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0, { populate: false }],
    ]);
  }

  it('lists prefixed designators grouped by part', () => {
    const rows = csvRows(buildPanelFab(panel(), [s, m], LIMITS).bom);
    expect(rows[0]).toEqual(['Comment', 'Designator', 'Footprint', 'LCSC Part #']);
    const r10k = rows.find((r) => r[3] === 'C25804')!;
    // The blinker's 10k and the two populated minis share one LCSC part.
    expect(r10k[1]!.split(',').sort()).toEqual(['M1_R1', 'M2_R1', 'S1_R1']);
    const all = rows.slice(1).flatMap((r) => r[1]!.split(','));
    expect(all).toHaveLength(BLINKER.components.length + 2);
    expect(all.every((d) => /^(S1|M1|M2)_/.test(d))).toBe(true);
  });

  it('leaves bare instances out of the BOM and the CPL', () => {
    const built = buildPanelFab(panel(), [s, m], LIMITS);
    expect(built.bom).not.toContain('M3_');
    expect(built.cpl).not.toContain('M3_');
    expect(built.placed).toBe(BLINKER.components.length + 2);
    expect(built.skipped).toBe(1);
  });

  it('a bare instance is still fabricated, without paste', () => {
    const p = panel();
    const merged = mergePanel(p, [s, m], LIMITS);
    expect(merged.board.components.some((c) => c.refdes === 'M3_R1')).toBe(true);
    expect(merged.bare).toEqual(new Set(['M3_R1']));
    expect(assemblyBoard(merged).components.some((c) => c.refdes === 'M3_R1')).toBe(false);

    const flashes = (g: string): number => g.split('\n').filter((l) => l.endsWith('D03*')).length;
    const withBare = buildPanelFab(p, [s, m], LIMITS).gerbers;
    const allOn = buildPanelFab(applyAll(p, { op: 'setPopulate', id: 'M3', populate: true }), [s, m], LIMITS).gerbers;
    expect(flashes(allOn.get('test.GTP')!) - flashes(withBare.get('test.GTP')!)).toBe(2); // R1's two pads
    expect(flashes(allOn.get('test.GTL')!)).toBe(flashes(withBare.get('test.GTL')!));
  });

  it('gives CPL positions and rotations in panel coordinates', () => {
    const p = panelOf([m], [
      ['M', 10, 20],
      ['M', 40, 20, { rotation: 90 }],
    ]);
    const rows = csvRows(buildPanelFab(p, [m], LIMITS).cpl);
    expect(rows[0]).toEqual(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation']);
    // R1 sits at the centre of the 18 x 12 board.
    expect(rows[1]).toEqual(['M1_R1', '19.0000', '26.0000', 'Top', '0']);
    // Turned 90 degrees the board is 12 x 18, its centre at (46, 29).
    expect(rows[2]).toEqual(['M2_R1', '46.0000', '29.0000', 'Top', '90']);
  });

  it('keeps the bottom-side rotation rule of the single-board CPL', () => {
    const board = plainBoard('flip', 18, 12);
    board.components.push(comp('R2', R0603, 5, 5, { side: 'bottom', rotation: 270 }));
    const src = resolved('F', board);
    const rows = csvRows(buildPanelFab(panelOf([src], [['F', 0, 7, { rotation: 90 }]]), [src], LIMITS).cpl);
    // Board rotation 270 + 90 = 0 on the panel; bottom side reports (0 + 180) % 360.
    expect(rows.find((r) => r[0] === 'F1_R2')).toEqual(['F1_R2', '7.0000', '12.0000', 'Bottom', '180']);
  });

  it('uses one BOM comment per LCSC part across boards, and says so', () => {
    const other = plainBoard('other', 18, 12);
    other.components[0]!.fields.value = '10K 1%';
    const o = resolved('O', other);
    const p = arrangedPanel([m, o], [
      ['M', 0, 0],
      ['O', 0, 0],
    ]);
    const built = buildPanelFab(p, [m, o], LIMITS);
    const rows = csvRows(built.bom).slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]![1]).toBe('M1_R1,O1_R1');
    expect(built.notes).toEqual([
      'C25804 is called "10K 1%" on O and "R0603" elsewhere; the BOM uses "R0603" for all of them',
    ]);
  });
});

describe('panel gerbers', () => {
  const s = resolved('S', BLINKER);
  const m = resolved('M', plainBoard('mini', 18, 12));
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-fab-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function panel(): Panel {
    return arrangedPanel([s, m], [
      ['S', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0],
    ]);
  }

  it('every file parses with tracespace', () => {
    const { gerbers } = buildPanelFab(panel(), [s, m], LIMITS);
    expect([...gerbers.keys()].sort()).toEqual([
      'test-NPTH.DRL',
      'test-PTH.DRL',
      'test.GBL',
      'test.GBO',
      'test.GBP',
      'test.GBS',
      'test.GKO',
      'test.GTL',
      'test.GTO',
      'test.GTP',
      'test.GTS',
    ]);
    for (const [name, content] of gerbers) {
      if (name.endsWith('.DRL')) assertDrillParses(name, content);
      else assertGerberParses(name, content);
    }
  });

  it('routes the panel profile, not just a rectangle', () => {
    const p = panel();
    const geometry = computeGeometry(p, [s, m]);
    const gko = buildPanelFab(p, [s, m], LIMITS, { geometry }).gerbers.get('test.GKO')!;
    const moves = gko.split('\n').filter((l) => l.endsWith('D02*')).length;
    expect(moves).toBe(geometry.profile.length);
    expect(geometry.profile.length).toBeGreaterThan(3);
    // The panel outline itself is there: its far corner in 4.6 format.
    const { outer } = geometry.frame!;
    expect(gko).toContain(`X${Math.round(outer.maxX * 1e6)}Y${Math.round(outer.maxY * 1e6)}D01*`);
  });

  it('drills the mouse bites and tooling holes, non-plated', () => {
    const p = panel();
    const geometry = computeGeometry(p, [s, m]);
    const npth = buildPanelFab(p, [s, m], LIMITS, { geometry }).gerbers.get('test-NPTH.DRL')!;
    expect(npth).toContain(';TYPE=NON_PLATED');
    expect(npth).toMatch(/T\d+C0\.600/);
    expect(npth).toMatch(/T\d+C2\.000/);
    const bites = geometry.tabs.reduce((n, t) => n + t.holes.length, 0);
    const hits = npth.split('\n').filter((l) => /^X-?[\d.]+Y-?[\d.]+$/.test(l)).length;
    expect(hits).toBeGreaterThanOrEqual(bites + geometry.toolingHoles.length);
    const first = geometry.toolingHoles[0]!.at;
    expect(npth).toContain(`X${first.x.toFixed(3)}Y${first.y.toFixed(3)}`);
  });

  it('puts fiducials on copper and mask, never on paste', () => {
    const p = panel();
    const geometry = computeGeometry(p, [s, m]);
    const { gerbers } = buildPanelFab(p, [s, m], LIMITS, { geometry });
    const f = geometry.fiducials[0]!;
    const flash = `X${Math.round(f.at.x * 1e6)}Y${Math.round(f.at.y * 1e6)}D03*`;
    expect(gerbers.get('test.GTL')).toContain(flash);
    expect(gerbers.get('test.GTS')).toContain(flash);
    expect(gerbers.get('test.GTP')).not.toContain(flash);
    expect(gerbers.get('test.GBL')).not.toContain(flash);
    expect(gerbers.get('test.GTL')).toMatch(/%ADD\d+C,1\*%/);
    expect(gerbers.get('test.GTS')).toMatch(/%ADD\d+C,2\*%/);
  });

  it('carries exactly the copper of its boards', () => {
    const one = applyAll(panelOf([s], [['S', 0, 7]]), {
      op: 'setSettings',
      settings: { fiducials: { enabled: false } },
    });
    const single = generateGerbers(BLINKER).files;
    const merged = buildPanelFab(one, [s], LIMITS).gerbers;
    const count = (g: string, suffix: string): number => g.split('\n').filter((l) => l.endsWith(suffix)).length;
    for (const [ext, name] of [['GTL', 'blinker.GTL'], ['GBL', 'blinker.GBL'], ['GTS', 'blinker.GTS']] as const) {
      expect(count(merged.get(`test.${ext}`)!, 'D03*')).toBe(count(single.get(name)!, 'D03*'));
      expect(count(merged.get(`test.${ext}`)!, 'G36*')).toBe(count(single.get(name)!, 'G36*'));
      // Mask openings of odd-shaped pads are buffered polygons, whose vertex
      // count depends on where they sit; copper is drawn vertex for vertex.
      if (ext !== 'GTS') {
        expect(count(merged.get(`test.${ext}`)!, 'D01*')).toBe(count(single.get(name)!, 'D01*'));
      }
    }
    // Same apertures, too: nothing was resized on the way.
    const apertures = (g: string): string[] => g.split('\n').filter((l) => l.startsWith('%ADD')).map((l) => l.replace(/^%ADD\d+/, '')).sort();
    expect(apertures(merged.get('test.GTL')!)).toEqual(apertures(single.get('blinker.GTL')!));
  });

  it('a silk-divider panel has a plain rectangular profile and silkscreen cut lines', () => {
    let p = panelOf([m], [
      ['M', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0],
    ], [{ op: 'setSettings', settings: { separation: 'silk-divider', rails: { top: 0, bottom: 0 } } }]);
    const r = arrange(p, [m], LIMITS);
    if (!r.ok) throw new Error(r.reason);
    p = applyAll(p, { op: 'placeInstances', placements: r.placements });
    const { gerbers } = buildPanelFab(p, [m], LIMITS);
    const gko = gerbers.get('test.GKO')!;
    expect(gko.split('\n').filter((l) => l.endsWith('D02*'))).toHaveLength(1);
    expect(gko.split('\n').filter((l) => l.endsWith('D01*'))).toHaveLength(4);
    expect(gerbers.has('test-NPTH.DRL')).toBe(false);
    // 3 boards x 4 sides on the top legend, beside the three refdes labels.
    const gto = gerbers.get('test.GTO')!;
    expect(gto.split('\n').filter((l) => l.endsWith('D01*')).length).toBeGreaterThanOrEqual(12);
    for (const [name, content] of gerbers) {
      if (name.endsWith('.DRL')) assertDrillParses(name, content);
      else assertGerberParses(name, content);
    }
  });

  it('exportPanelFab writes the fileset to disk', async () => {
    const result = await exportPanelFab(panel(), [s, m], LIMITS, join(dir, 'fab'));
    expect(result.gerberZip).toBe(join(dir, 'fab', 'gerbers.zip'));
    const zip = new AdmZip(result.gerberZip);
    const names = zip.getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual([...result.gerberFiles].sort());
    for (const e of zip.getEntries()) {
      const content = e.getData().toString('utf8');
      if (e.entryName.endsWith('.DRL')) assertDrillParses(e.entryName, content);
      else assertGerberParses(e.entryName, content);
    }
    expect(await readFile(result.bomCsv, 'utf8')).toContain('S1_U1');
    expect(await readFile(result.cplCsv, 'utf8')).toContain('M5_R1');
    expect(await readFile(result.renderSvg, 'utf8')).toContain('<svg');
    expect(await readFile(result.fabSvg, 'utf8')).toContain('fill-rule="evenodd"');
    expect(result.placed).toBe(BLINKER.components.length + 5);
  });
});
