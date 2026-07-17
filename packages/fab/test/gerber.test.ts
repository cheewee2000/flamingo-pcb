import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createParser, GERBER, DRILL, UNIMPLEMENTED } from '@tracespace/parser';
import { newBoard, parseBoard, fillZone, fillAllZones, pointInPolygon } from '@flamingo/engine';
import type { Board, Point } from '@flamingo/engine';
import { generateGerbers, buildDrills } from '../src/gerber.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Validate a Gerber string with the independent tracespace parser. The parser
 * (@tracespace/parser 5.0.0-next.0) does not model X2 attribute commands, so
 * %TF.* lines surface as `Unimplemented` nodes; those are the ONLY tolerated
 * unimplemented nodes -- anything else is a real syntax the parser rejected.
 */
function assertGerberParses(content: string): void {
  const parser = createParser();
  parser.feed(content);
  const root = parser.results();
  expect(root.filetype).toBe(GERBER);
  expect(root.done).toBe(true);
  const bad = root.children.filter(
    (c) => c.type === UNIMPLEMENTED && !(c as { value: string }).value.startsWith('%TF'),
  );
  expect(bad).toEqual([]);
}

/**
 * Validate a drill string. This parser version does not flip `done` for NC
 * drill files even on valid KiCad output, so we assert the filetype plus zero
 * unimplemented nodes (every token recognized).
 */
function assertDrillParses(content: string): void {
  const parser = createParser();
  parser.feed(content);
  const root = parser.results();
  expect(root.filetype).toBe(DRILL);
  const unimpl = root.children.filter((c) => c.type === UNIMPLEMENTED);
  expect(unimpl).toEqual([]);
}

/** Minimal board built directly: one SMD rect pad + one F.Cu track. */
function oneTrackOnePad(): Board {
  const b = newBoard('t1', 2);
  b.components.push({
    refdes: 'R1',
    lcsc: 'X',
    at: { x: 5, y: 5 },
    rotation: 0,
    side: 'top',
    fields: {},
    footprint: {
      name: 'P',
      lcsc: 'X',
      courtyard: [],
      silk: [],
      pads: [
        { number: '1', shape: 'rect', at: { x: 0, y: 0 }, rotation: 0, size: { w: 1, h: 0.6 }, layer: 'top' },
      ],
    },
  });
  b.tracks.push({
    id: 't',
    layer: 'F.Cu',
    width: 0.25,
    net: '',
    seg: { type: 'line', start: { x: 5, y: 5 }, end: { x: 8, y: 5 } },
  });
  return b;
}

const GTL_GOLDEN =
  '%TF.GenerationSoftware,CW&T,Flamingo,0.1*%\n' +
  '%TF.FileFunction,Copper,L1,Top*%\n' +
  '%TF.FilePolarity,Positive*%\n' +
  '%FSLAX46Y46*%\n' +
  '%MOMM*%\n' +
  '%ADD10C,0.25*%\n' +
  '%ADD11R,1X0.6*%\n' +
  'G75*\n' +
  '%LPD*%\n' +
  'D10*\n' +
  'X5000000Y5000000D02*\n' +
  'G01*\n' +
  'X8000000Y5000000D01*\n' +
  'D11*\n' +
  'X5000000Y5000000D03*\n' +
  'M02*\n';

describe('generateGerbers', () => {
  it('produces the exact golden GTL for a 1-track 1-pad board', () => {
    const { files } = generateGerbers(oneTrackOnePad());
    expect(files.get('t1.GTL')).toBe(GTL_GOLDEN);
  });

  it('emits the expected D01/D03 op counts (one draw, one flash)', () => {
    const gtl = generateGerbers(oneTrackOnePad()).files.get('t1.GTL')!;
    expect((gtl.match(/D01\*/g) ?? []).length).toBe(1);
    expect((gtl.match(/D03\*/g) ?? []).length).toBe(1);
  });

  it('dedupes apertures across identical-width tracks', () => {
    const b = oneTrackOnePad();
    b.tracks.push({
      id: 't2',
      layer: 'F.Cu',
      width: 0.25,
      net: '',
      seg: { type: 'line', start: { x: 5, y: 6 }, end: { x: 8, y: 6 } },
    });
    const gtl = generateGerbers(b).files.get('t1.GTL')!;
    // one circle aperture for width 0.25 despite two tracks
    expect((gtl.match(/%ADD\d+C,0\.25\*%/g) ?? []).length).toBe(1);
    // two draws now
    expect((gtl.match(/D01\*/g) ?? []).length).toBe(2);
  });

  it('every generated Gerber file parses cleanly (tracespace)', () => {
    const { files } = generateGerbers(oneTrackOnePad());
    for (const [name, content] of files) {
      if (name.endsWith('.DRL')) continue;
      assertGerberParses(content);
    }
  });

  it('names inner copper files .G1/.G2 on a 4-layer board', () => {
    const b = newBoard('m4', 4);
    const names = [...generateGerbers(b).files.keys()];
    expect(names).toContain('m4.GTL');
    expect(names).toContain('m4.G1');
    expect(names).toContain('m4.G2');
    expect(names).toContain('m4.GBL');
  });
});

describe('buildDrills', () => {
  function drillBoard(): Board {
    const b = newBoard('d', 2);
    b.nets.push({ name: 'N', class: 'default', pins: [] });
    b.vias.push({ id: 'v1', at: { x: 2, y: 2 }, drill: 0.3, diameter: 0.6, net: 'N' });
    b.vias.push({ id: 'v2', at: { x: 4, y: 2 }, drill: 0.3, diameter: 0.6, net: 'N' });
    b.components.push({
      refdes: 'J1',
      lcsc: 'X',
      at: { x: 6, y: 6 },
      rotation: 0,
      side: 'top',
      fields: {},
      footprint: {
        name: 'P',
        lcsc: 'X',
        courtyard: [],
        silk: [],
        pads: [
          {
            number: '1',
            shape: 'circle',
            at: { x: 0, y: 0 },
            rotation: 0,
            size: { w: 1.4, h: 1.4 },
            drill: { diameter: 0.8, plated: true },
            layer: 'through',
          },
        ],
      },
    });
    b.holes.push({ id: 'h1', at: { x: 1, y: 1 }, drill: 3.2, padDiameter: 3.2, plated: false });
    return b;
  }

  it('builds a PTH file with the right tool table and hole count', () => {
    const d = buildDrills(drillBoard());
    expect(d.plated).not.toBeNull();
    assertDrillParses(d.plated!);
    // vias (0.3) + THT pad (0.8) -> two tools
    expect(d.plated).toContain('T1C0.300');
    expect(d.plated).toContain('T2C0.800');
    // three plated holes total
    expect((d.plated!.match(/^X/gm) ?? []).length).toBe(3);
  });

  it('builds an NPTH file for the unplated mounting hole only', () => {
    const d = buildDrills(drillBoard());
    expect(d.unplated).not.toBeNull();
    assertDrillParses(d.unplated!);
    expect(d.unplated).toContain('T1C3.200');
    expect((d.unplated!.match(/^X/gm) ?? []).length).toBe(1);
  });

  it('emits slotted pads as G85 routed slots', () => {
    const b = newBoard('s', 2);
    b.components.push({
      refdes: 'U1',
      lcsc: 'X',
      at: { x: 5, y: 5 },
      rotation: 0,
      side: 'top',
      fields: {},
      footprint: {
        name: 'P',
        lcsc: 'X',
        courtyard: [],
        silk: [],
        pads: [
          {
            number: '1',
            shape: 'oval',
            at: { x: 0, y: 0 },
            rotation: 0,
            size: { w: 2, h: 1 },
            drill: { diameter: 0.6, slotLength: 1.6, plated: true },
            layer: 'through',
          },
        ],
      },
    });
    const d = buildDrills(b);
    expect(d.plated).toContain('G85');
    assertDrillParses(d.plated!);
    // slot centerline is 1.0mm long (slotLength 1.6 - diameter 0.6), centered at (5,5)
    expect(d.plated).toMatch(/X4\.500Y5\.000G85X5\.500Y5\.000/);
  });
});

describe('generateGerbers - zone coverage', () => {
  /** GND zone overlapping one SIG track and a copper keepout, all on F.Cu. */
  function zoneKeepoutBoard(): Board {
    const b = newBoard('zk', 2);
    b.nets.push({ name: 'GND', class: 'default', pins: [] });
    b.nets.push({ name: 'SIG', class: 'default', pins: [] });
    b.tracks.push({
      id: 't1',
      layer: 'F.Cu',
      width: 0.3,
      net: 'SIG',
      seg: { type: 'line', start: { x: 0, y: 3 }, end: { x: 10, y: 3 } },
    });
    b.keepouts.push({
      id: 'k1',
      layers: 'all',
      polygon: [
        { x: 7, y: 7 },
        { x: 9, y: 7 },
        { x: 9, y: 9 },
        { x: 7, y: 9 },
      ],
      keepout: { copper: true, via: false },
    });
    b.zones.push({
      id: 'z1',
      layer: 'F.Cu',
      net: 'GND',
      polygon: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      clearance: 0.3,
      minWidth: 0.2,
      thermal: { gap: 0.3, spokeWidth: 0.3 },
    });
    return b;
  }

  it('renders a filled GND zone (clipped by a track + a copper keepout) into a clean, correctly-ordered GTL', () => {
    const b = zoneKeepoutBoard();
    const { files } = generateGerbers(b);
    const gtl = files.get('zk.GTL')!;

    // (a) tracespace-parses clean
    assertGerberParses(gtl);

    // (b) at least one %LPD + G36/G37 region present (the zone fill)
    expect(/%LPD\*%\nG36\*[\s\S]*?G37\*/.test(gtl)).toBe(true);

    // (c) if the fill produced holes (%LPC), each one is preceded by an
    // earlier %LPD -- fillZone always emits an outer (dark) ring before any
    // hole (clear) ring it contains, so a %LPC can never appear as the first
    // polarity command.
    const lines = gtl.split('\n');
    const lpdIdx: number[] = [];
    const lpcIdx: number[] = [];
    lines.forEach((line, i) => {
      if (line === '%LPD*%') lpdIdx.push(i);
      if (line === '%LPC*%') lpcIdx.push(i);
    });
    for (const idx of lpcIdx) {
      expect(lpdIdx.some((d) => d < idx)).toBe(true);
    }

    // (d) the keepout is actually excluded from the fill: a point at the
    // keepout's center is not solid copper under even-odd winding.
    const filled = fillAllZones(b);
    const zone = filled.zones.find((z) => z.id === 'z1')!;
    expect(zone.fill).toBeDefined();
    expect(zone.fill!.length).toBeGreaterThan(0);
    const keepoutCenter: Point = { x: 8, y: 8 };
    let count = 0;
    for (const ring of zone.fill!) if (pointInPolygon(keepoutCenter, ring)) count++;
    expect(count % 2 === 1).toBe(false);

    // sanity: a point well clear of the track and keepout IS solid copper.
    const clearFillZone = fillZone(b, b.zones[0]);
    let clearCount = 0;
    for (const ring of clearFillZone) if (pointInPolygon({ x: 1, y: 8 }, ring)) clearCount++;
    expect(clearCount % 2 === 1).toBe(true);
  });
});

describe('generateGerbers - demo board integration', () => {
  it('renders the full demo board fileset and every file parses', () => {
    const boardPath = join(here, '..', '..', '..', '.superpowers', 'sdd', 'demo', 'board.flamingo');
    const b = parseBoard(readFileSync(boardPath, 'utf8'));
    const { files } = generateGerbers(b);
    // core fileset present
    for (const ext of ['GTL', 'GBL', 'GTS', 'GBS', 'GTO', 'GBO', 'GTP', 'GBP', 'GKO']) {
      expect(files.has(`${b.name}.${ext}`)).toBe(true);
    }
    for (const [name, content] of files) {
      if (name.endsWith('.DRL')) assertDrillParses(content);
      else assertGerberParses(content);
    }
  });
});
