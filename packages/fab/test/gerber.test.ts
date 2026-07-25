import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createParser, GERBER, DRILL, UNIMPLEMENTED } from '@tracespace/parser';
import {
  newBoard,
  parseBoard,
  fillZone,
  fillAllZones,
  pointInPolygon,
  componentLabelPlacement,
  RULESETS,
} from '@flamingo/engine';
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

  it('emits an unplated slotted mounting hole as a G85 routed slot in the NPTH file', () => {
    const b = newBoard('ms', 2);
    b.holes.push({ id: 'H1', at: { x: 5, y: 5 }, drill: 2, padDiameter: 2, plated: false, slotLength: 10 });
    const d = buildDrills(b);
    expect(d.unplated).not.toBeNull();
    assertDrillParses(d.unplated!);
    expect(d.unplated).toContain('T1C2.000');
    // centerline half = (slotLength 10 - drill 2)/2 = 4 -> (1,5)..(9,5)
    expect(d.unplated).toMatch(/X1\.000Y5\.000G85X9\.000Y5\.000/);
  });

  it('orients a slotted mounting hole along its rotation', () => {
    const b = newBoard('ms', 2);
    b.holes.push({
      id: 'H1',
      at: { x: 5, y: 5 },
      drill: 2,
      padDiameter: 2,
      plated: false,
      slotLength: 10,
      rotation: 90,
    });
    const d = buildDrills(b);
    // rotated 90deg -> centerline runs along +y: (5,1)..(5,9)
    expect(d.unplated).toMatch(/X5\.000Y1\.000G85X5\.000Y9\.000/);
  });
});

describe('generateGerbers - board-level silk lines', () => {
  it('strokes an F.Silk line into the top legend (GTO) at its width', () => {
    const b = newBoard('sl', 2);
    b.silkLines.push({ id: 'SL1', layer: 'F.Silk', start: { x: 1, y: 1 }, end: { x: 11, y: 1 }, width: 0.15 });
    const { files } = generateGerbers(b);
    const gto = files.get('sl.GTO')!;
    assertGerberParses(gto);
    // A 0.15mm round aperture is defined and a segment is drawn (D01) with it.
    expect(gto).toMatch(/%ADD\d+C,0\.15\*%/);
    expect(gto).toContain('D01*');
  });

  it('routes a B.Silk line into the bottom legend (GBO), not the top', () => {
    const b = newBoard('sl', 2);
    b.silkLines.push({ id: 'SL1', layer: 'B.Silk', start: { x: 0, y: 0 }, end: { x: 5, y: 5 }, width: 0.2 });
    const { files } = generateGerbers(b);
    const gbo = files.get('sl.GBO')!;
    const gto = files.get('sl.GTO')!;
    assertGerberParses(gbo);
    expect(gbo).toMatch(/%ADD\d+C,0\.2\*%/);
    expect(gto).not.toContain('D01*'); // nothing drawn on the top legend
  });
});

/** All draw/move coordinates (integer 4.6-format) in a Gerber, in emit order. */
function drawCoords(gerber: string): [number, number][] {
  return [...gerber.matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe('generateGerbers - silk text (legend)', () => {
  it('mirrors B.Silk board text about its anchor, like bottom-component text', () => {
    const at = { x: 10, y: 5 };
    const mk = (layer: 'F.Silk' | 'B.Silk'): Board => {
      const b = newBoard('st', 2);
      b.silk.push({ id: 'S1', layer, at, text: 'F2', height: 1, rotation: 0 });
      return b;
    };
    const gto = generateGerbers(mk('F.Silk')).files.get('st.GTO')!;
    const gbo = generateGerbers(mk('B.Silk')).files.get('st.GBO')!;
    assertGerberParses(gbo);
    const top = drawCoords(gto);
    const bot = drawCoords(gbo);
    expect(top.length).toBeGreaterThan(0);
    expect(bot.length).toBe(top.length);
    // Bottom text is the x-mirror of top text about the anchor: x -> 2*ax - x.
    const ax = Math.round(at.x * 1e6);
    for (let i = 0; i < top.length; i++) {
      expect(bot[i][0]).toBe(2 * ax - top[i][0]);
      expect(bot[i][1]).toBe(top[i][1]);
    }
    // Asymmetric glyphs ('F', '2') really are mirrored, not identical.
    expect(bot.map(String)).not.toEqual(top.map(String));
  });

  it('strokes the refdes label at the shared componentLabelPlacement anchor (below the body)', () => {
    const b = oneTrackOnePad(); // R1 at (5,5): pad box x 4.5..5.5, y 4.7..5.3
    const lp = componentLabelPlacement(b, b.components[0]);
    expect(lp.position).toBe('below');
    const gto = generateGerbers(b).files.get('t1.GTO')!;
    assertGerberParses(gto);
    const pts = drawCoords(gto);
    expect(pts.length).toBeGreaterThan(0);
    // Glyph ink spans exactly [at.y - h/2, at.y + h/2] vertically ('R','1' are
    // full cap-height glyphs) and stays within the label's advance width.
    const ys = pts.map((p) => p[1]);
    const xs = pts.map((p) => p[0]);
    expect(Math.min(...ys)).toBe(Math.round((lp.at.y - lp.height / 2) * 1e6));
    expect(Math.max(...ys)).toBe(Math.round((lp.at.y + lp.height / 2) * 1e6));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(Math.round((lp.at.x - lp.width / 2) * 1e6));
    expect(Math.max(...xs)).toBeLessThanOrEqual(Math.round((lp.at.x + lp.width / 2) * 1e6));
    // And the whole label sits BELOW the component body (pad bottom y=4.7).
    expect(Math.max(...ys)).toBeLessThan(Math.round(4.7 * 1e6));
  });
});

describe('generateGerbers - slotted mounting hole annulus', () => {
  it('draws a plated slotted mounting hole annulus as a stadium region on copper and mask', () => {
    const b = newBoard('mh', 2);
    b.holes.push({ id: 'H1', at: { x: 5, y: 5 }, drill: 2, padDiameter: 3, plated: true, slotLength: 10 });
    const { files } = generateGerbers(b);

    const gtl = files.get('mh.GTL')!;
    assertGerberParses(gtl);
    // The annulus is drawn as a G36/G37 filled region (a flashed circle would be a D03).
    expect(/G36\*[\s\S]*?G37\*/.test(gtl)).toBe(true);
    expect(gtl).not.toContain('D03*');

    // The soldermask opening is likewise a stadium region.
    const gts = files.get('mh.GTS')!;
    assertGerberParses(gts);
    expect(/G36\*[\s\S]*?G37\*/.test(gts)).toBe(true);

    // And the plated slot still drills as a G85 routed slot.
    const drl = files.get('mh-PTH.DRL')!;
    expect(drl).toMatch(/X1\.000Y5\.000G85X9\.000Y5\.000/);
  });
});

/** Every circle-aperture diameter (mm) defined in a Gerber file. */
function apertureDiameters(gerber: string): number[] {
  return [...gerber.matchAll(/%ADD\d+C,([\d.]+)\*%/g)].map((m) => Number(m[1]));
}

describe('generateGerbers - silk line width floor', () => {
  /** Board + footprint silk, all authored below JLCPCB's 0.15mm legend minimum. */
  function thinSilkBoard(): Board {
    const b = newBoard('thin', 2);
    b.silk.push({ id: 'S1', layer: 'F.Silk', at: { x: 5, y: 5 }, text: 'TP1', height: 0.8, rotation: 0 });
    b.silkLines.push({ id: 'SL1', layer: 'F.Silk', start: { x: 0, y: 0 }, end: { x: 9, y: 0 }, width: 0.1 });
    b.components.push({
      refdes: 'R1',
      lcsc: 'X',
      at: { x: 2, y: 2 },
      rotation: 0,
      side: 'top',
      fields: {},
      footprint: {
        name: 'P',
        lcsc: 'X',
        courtyard: [],
        silk: [
          { kind: 'line', start: { x: -1, y: 0 }, end: { x: 1, y: 0 }, width: 0.1 },
          { kind: 'circle', center: { x: 0, y: 1 }, radius: 0.3, width: 0.08 },
          { kind: 'text', at: { x: 0, y: 2 }, text: 'A', height: 0.6, rotation: 0 },
        ],
        pads: [
          { number: '1', shape: 'rect', at: { x: 0, y: 0 }, rotation: 0, size: { w: 1, h: 0.6 }, layer: 'top' },
        ],
      },
    });
    return b;
  }

  it('never emits a legend aperture below the ruleset minSilkWidth (0.15mm)', () => {
    const gto = generateGerbers(thinSilkBoard()).files.get('thin.GTO')!;
    assertGerberParses(gto);
    const diameters = apertureDiameters(gto);
    expect(diameters.length).toBeGreaterThan(0);
    for (const d of diameters) expect(d).toBeGreaterThanOrEqual(RULESETS['jlcpcb-2l'].minSilkWidth);
    // Nothing at the old 0.12mm floor, or at the authored sub-minimum widths.
    expect(gto).not.toMatch(/%ADD\d+C,0\.(0\d+|1[0-4]\d*)\*%/);
  });

  it('leaves silk already at or above the floor untouched', () => {
    const b = newBoard('wide', 2);
    // height 2.0 -> stroke 2.0 * 0.12 = 0.24mm, well over the floor
    b.silk.push({ id: 'S1', layer: 'F.Silk', at: { x: 5, y: 5 }, text: 'X', height: 2, rotation: 0 });
    b.silkLines.push({ id: 'SL1', layer: 'F.Silk', start: { x: 0, y: 0 }, end: { x: 9, y: 0 }, width: 0.3 });
    const gto = generateGerbers(b).files.get('wide.GTO')!;
    expect(apertureDiameters(gto).sort((x, y) => x - y)).toEqual([0.24, 0.3]);
  });
});

describe('generateGerbers - board profile (GKO)', () => {
  /** 60x30 rectangular outline, plus whatever holes the caller pushes. */
  function outlineBoard(name = 'gko'): Board {
    const b = newBoard(name, 2);
    b.outline = [
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 60, y: 0 } },
      { type: 'line', start: { x: 60, y: 0 }, end: { x: 60, y: 30 } },
      { type: 'line', start: { x: 60, y: 30 }, end: { x: 0, y: 30 } },
      { type: 'line', start: { x: 0, y: 30 }, end: { x: 0, y: 0 } },
    ];
    return b;
  }

  /** The 49x3mm display-FPC slot: centerline (7,15)..(53,15), radius 1.5. */
  const fpcSlot = {
    id: 'H1',
    at: { x: 30, y: 15 },
    drill: 3,
    padDiameter: 3,
    plated: false,
    slotLength: 49,
  } as const;

  it('emits a closed contour for a non-plated milled slot, not just the outer profile', () => {
    const bare = generateGerbers(outlineBoard()).files.get('gko.GKO')!;

    const b = outlineBoard();
    b.holes.push({ ...fpcSlot });
    const gko = generateGerbers(b).files.get('gko.GKO')!;
    assertGerberParses(gko);

    // buildEdge emits the outline first, then each slot contour, so everything
    // past the bare board's coordinate list is the slot.
    const bareCoords = drawCoords(bare);
    const coords = drawCoords(gko);
    expect(coords.length).toBeGreaterThan(bareCoords.length);
    expect(coords.slice(0, bareCoords.length)).toEqual(bareCoords);
    const contour = coords.slice(bareCoords.length);

    // The contour is closed (returns to its first point).
    expect(contour.length).toBeGreaterThan(3);
    expect(contour[contour.length - 1]).toEqual(contour[0]);

    // ...and traces the capsule of the milled opening: centerline (7,15)..(53,15)
    // swept by drill/2 = 1.5 -> x 5.5..54.5, y 13.5..16.5. The straight sides
    // land the y extremes exactly; the end caps are tessellated, so x is close.
    const xs = contour.map((p) => p[0] / 1e6);
    const ys = contour.map((p) => p[1] / 1e6);
    expect(Math.min(...ys)).toBe(13.5);
    expect(Math.max(...ys)).toBe(16.5);
    expect(Math.min(...xs)).toBeCloseTo(5.5, 2);
    expect(Math.max(...xs)).toBeCloseTo(54.5, 2);

    // Belt and braces: the G85 stays in the drill file too.
    expect(generateGerbers(b).files.get('gko-NPTH.DRL')).toMatch(/X7\.000Y15\.000G85X53\.000Y15\.000/);
  });

  it('leaves plated slots and round holes to the drill file (no contour)', () => {
    const bare = generateGerbers(outlineBoard()).files.get('gko.GKO')!;

    // A plated slot would be routed (losing its plating) if drawn on the profile.
    const plated = outlineBoard();
    plated.holes.push({ ...fpcSlot, plated: true });
    expect(generateGerbers(plated).files.get('gko.GKO')).toBe(bare);

    // A round mounting hole is conveyed by the drill file alone.
    const round = outlineBoard();
    round.holes.push({ id: 'H2', at: { x: 5, y: 5 }, drill: 2.2, padDiameter: 2.2, plated: false });
    expect(generateGerbers(round).files.get('gko.GKO')).toBe(bare);
  });
});

describe('generateGerbers - filename sanitization', () => {
  it('collapses spaces in the board name to underscores without touching board.name', () => {
    const b = newBoard('Super Pager', 2);
    const { files } = generateGerbers(b);
    for (const name of files.keys()) expect(name).not.toMatch(/\s/);
    expect(files.has('Super_Pager.GTL')).toBe(true);
    expect(files.has('Super_Pager.GBL')).toBe(true);
    expect(b.name).toBe('Super Pager'); // display name untouched
  });

  it('replaces each run of unsafe characters with a single underscore', () => {
    const names = [...generateGerbers(newBoard('a b/c:d', 2)).files.keys()];
    expect(names).toContain('a_b_c_d.GTL');
  });

  it('falls back to "board" for an unnamed board', () => {
    const names = [...generateGerbers(newBoard('', 2)).files.keys()];
    expect(names).toContain('board.GTL');
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
