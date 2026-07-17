import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newBoard } from '../src/index.js';
import type {
  Board,
  ComponentInst,
  Footprint,
  Keepout,
  Pad,
  PathSeg,
  Point,
  SilkItem,
  Zone,
} from '../src/index.js';
import { runDRC, RULESETS, parseBoard, fillAllZones } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function smdPad(number: string, side: 'top' | 'bottom', at: Point, size = { w: 1, h: 1 }): Pad {
  return { number, shape: 'rect', at, rotation: 0, size, layer: side };
}

function throughPad(number: string, at: Point, drillDiameter = 0.3, padDiameter = 0.8): Pad {
  return {
    number,
    shape: 'circle',
    at,
    rotation: 0,
    size: { w: padDiameter, h: padDiameter },
    drill: { diameter: drillDiameter, plated: true },
    layer: 'through',
  };
}

function makeFootprint(pads: Pad[], overrides: Partial<Footprint> = {}): Footprint {
  return { name: 'fp', lcsc: 'C0', pads, silk: [], courtyard: [], ...overrides };
}

function makeComponent(
  refdes: string,
  at: Point,
  pads: Pad[],
  overrides: Partial<ComponentInst> & { footprintOverrides?: Partial<Footprint> } = {},
): ComponentInst {
  const { footprintOverrides, ...rest } = overrides;
  return {
    refdes,
    lcsc: 'C1',
    footprint: makeFootprint(pads, footprintOverrides),
    at,
    rotation: 0,
    side: 'top',
    fields: {},
    ...rest,
  };
}

function rectOutline(w: number, h: number): PathSeg[] {
  return [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: w, y: 0 } },
    { type: 'line', start: { x: w, y: 0 }, end: { x: w, y: h } },
    { type: 'line', start: { x: w, y: h }, end: { x: 0, y: h } },
    { type: 'line', start: { x: 0, y: h }, end: { x: 0, y: 0 } },
  ];
}

function rectPoly(minX: number, minY: number, w: number, h: number): Point[] {
  return [
    { x: minX, y: minY },
    { x: minX + w, y: minY },
    { x: minX + w, y: minY + h },
    { x: minX, y: minY + h },
  ];
}

function base(): Board {
  return newBoard('t', 2); // rules: 'jlcpcb-2l'
}

function violationsOf(b: Board, rule: string) {
  return runDRC(b).filter((v) => v.rule === rule);
}

// ---------------------------------------------------------------------------
// RULESETS
// ---------------------------------------------------------------------------

describe('RULESETS', () => {
  it('jlcpcb-2l values match the spec', () => {
    expect(RULESETS['jlcpcb-2l']).toEqual({
      id: 'jlcpcb-2l',
      minTrackWidth: 0.127,
      minClearance: 0.127,
      minDrill: 0.3,
      minViaDiameter: 0.5,
      minAnnular: 0.13,
      copperToEdge: 0.3,
      holeToHole: 0.5,
      minSilkWidth: 0.15,
    });
  });

  it('jlcpcb-4l and jlcpcb-6l values match the spec (tighter track/clearance/drill/via)', () => {
    for (const id of ['jlcpcb-4l', 'jlcpcb-6l'] as const) {
      expect(RULESETS[id]).toEqual({
        id,
        minTrackWidth: 0.09,
        minClearance: 0.09,
        minDrill: 0.2,
        minViaDiameter: 0.45,
        minAnnular: 0.13,
        copperToEdge: 0.3,
        holeToHole: 0.5,
        minSilkWidth: 0.15,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Per-check violating fixtures
// ---------------------------------------------------------------------------

describe('runDRC', () => {
  it('clearance: different-net pads 0.05mm apart (< required 0.2mm net-class clearance) violate', () => {
    const b = base();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 1.05, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    b.nets.push({ name: 'N1', class: 'default', pins: ['R1.1'] });
    b.nets.push({ name: 'N2', class: 'default', pins: ['R2.1'] });

    const violations = violationsOf(b, 'clearance');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].items).toEqual(expect.arrayContaining(['R1.1', 'R2.1']));
    expect(violations[0].message).toMatch(/clearance/);
  });

  it('track-width: track narrower than ruleset minimum violates', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.tracks.push({
      id: 'T1',
      layer: 'F.Cu',
      width: 0.05, // < 0.127 minimum
      net: 'N1',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
    });

    const violations = violationsOf(b, 'track-width');
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toEqual(['T1']);
  });

  it('drill: via drill below ruleset minimum violates', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.1, diameter: 0.5, net: 'N1' });

    const violations = violationsOf(b, 'drill');
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toEqual(['V1']);
  });

  it('drill: through-hole pad drill below ruleset minimum violates', () => {
    const b = base();
    b.components.push(makeComponent('J1', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 }, 0.1)]));

    const violations = violationsOf(b, 'drill');
    expect(violations.some((v) => v.items.includes('J1.1'))).toBe(true);
  });

  it('drill: mounting hole drill below ruleset minimum violates', () => {
    const b = base();
    b.holes.push({ id: 'H1', at: { x: 5, y: 5 }, drill: 0.1, padDiameter: 2, plated: true });

    const violations = violationsOf(b, 'drill');
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toEqual(['H1']);
  });

  it('via-annular: annular ring below ruleset minimum violates', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    // annular = (0.5 - 0.3)/2 = 0.1 < 0.13 minimum; drill/diameter each individually pass their own floors.
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.5, net: 'N1' });

    const violations = violationsOf(b, 'via-annular');
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toEqual(['V1']);
  });

  it('via-diameter: via diameter below ruleset minimum violates', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.1, diameter: 0.4, net: 'N1' });

    const violations = violationsOf(b, 'via-diameter');
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toEqual(['V1']);
  });

  it('copper-to-edge: track 0.1mm from board edge (< 0.3mm minimum) violates', () => {
    const b = base();
    b.outline = rectOutline(10, 10);
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    // Track from x=0.2 to x=2 at y=5, width 0.2 (half-width 0.1): the rounded
    // start cap's leftmost point sits at x = 0.2 - 0.1 = 0.1, i.e. 0.1mm from
    // the outline's left edge (x=0).
    b.tracks.push({
      id: 'T1',
      layer: 'F.Cu',
      width: 0.2,
      net: 'N1',
      seg: { type: 'line', start: { x: 0.2, y: 5 }, end: { x: 2, y: 5 } },
    });

    const violations = violationsOf(b, 'copper-to-edge');
    expect(violations.some((v) => v.items.includes('T1'))).toBe(true);
  });

  it('keepout: via center inside a via-keepout polygon violates', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    const keepout: Keepout = {
      id: 'K1',
      layers: 'all',
      polygon: rectPoly(0, 0, 2, 2),
      keepout: { copper: false, via: true },
    };
    b.keepouts.push(keepout);
    b.vias.push({ id: 'V1', at: { x: 1, y: 1 }, drill: 0.3, diameter: 0.6, net: 'N1' });

    const violations = violationsOf(b, 'keepout');
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toEqual(expect.arrayContaining(['V1', 'K1']));
  });

  it('keepout: copper item intersecting a copper-keepout polygon violates', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.keepouts.push({
      id: 'K1',
      layers: ['F.Cu'],
      polygon: rectPoly(0, 0, 4, 4),
      keepout: { copper: true, via: false },
    });
    b.tracks.push({
      id: 'T1',
      layer: 'F.Cu',
      width: 0.3,
      net: 'N1',
      seg: { type: 'line', start: { x: 1, y: 2 }, end: { x: 3, y: 2 } },
    });

    const violations = violationsOf(b, 'keepout');
    expect(violations.some((v) => v.items.includes('T1'))).toBe(true);
  });

  it('hole-to-hole: two same-net vias closer than ruleset minimum spacing violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'N1' });
    b.vias.push({ id: 'V2', at: { x: 0, y: 0.4 }, drill: 0.3, diameter: 0.6, net: 'N1' });

    const violations = violationsOf(b, 'hole-to-hole');
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toEqual(expect.arrayContaining(['V1', 'V2']));
  });

  it('courtyard-overlap: same-side components with overlapping courtyards violate', () => {
    const b = base();
    const courtyard = [[{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]];
    b.components.push(
      makeComponent('R1', { x: 0, y: 0 }, [], { footprintOverrides: { courtyard } }),
    );
    b.components.push(
      makeComponent('R2', { x: 1, y: 0 }, [], { footprintOverrides: { courtyard } }),
    );

    const violations = violationsOf(b, 'courtyard-overlap');
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toEqual(expect.arrayContaining(['R1', 'R2']));
  });

  it('courtyard-overlap: components with empty courtyard are skipped (no violation even when pads coincide)', () => {
    const b = base();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 0, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })]));

    expect(violationsOf(b, 'courtyard-overlap')).toHaveLength(0);
  });

  it('silk-over-pad: silk line crossing an exposed SMD pad on the same side violates', () => {
    const silk: SilkItem[] = [{ kind: 'line', start: { x: -1, y: 0 }, end: { x: 1, y: 0 }, width: 0.2 }];
    const b = base();
    b.components.push(
      makeComponent('R1', { x: 0, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })], {
        footprintOverrides: { silk },
      }),
    );

    const violations = violationsOf(b, 'silk-over-pad');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].items).toEqual(expect.arrayContaining(['R1', 'R1.1']));
  });

  it('unconnected-net: net with two unbridged pads violates', () => {
    const b = base();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 5, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    b.nets.push({ name: 'N1', class: 'default', pins: ['R1.1', 'R2.1'] });

    const violations = violationsOf(b, 'unconnected-net');
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toEqual(['N1']);
  });

  it('missing-outline: board with no outline violates', () => {
    const b = base();
    const violations = violationsOf(b, 'missing-outline');
    expect(violations).toHaveLength(1);
    expect(violations[0].at).toEqual({ x: 0, y: 0 });
  });

  it('missing-outline: an unclosed outline (gap > tolerance) violates', () => {
    const b = base();
    b.outline = [
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 10 } }, // gap: doesn't start where prev ended
    ];
    const violations = violationsOf(b, 'missing-outline');
    expect(violations).toHaveLength(1);
  });

  it('outside-outline: a pad entirely outside the board outline violates', () => {
    const b = base();
    b.outline = rectOutline(10, 10);
    b.components.push(makeComponent('R1', { x: 15, y: 5 }, [smdPad('1', 'top', { x: 0, y: 0 })]));

    const violations = violationsOf(b, 'outside-outline');
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toEqual(['R1.1']);
  });

  // -------------------------------------------------------------------------
  // Clean board
  // -------------------------------------------------------------------------

  it('a clean, fully-routed, in-bounds board has zero violations', () => {
    const b = base();
    b.outline = rectOutline(30, 20);
    b.components.push(makeComponent('R1', { x: 5, y: 10 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 15, y: 10 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    b.nets.push({ name: 'N1', class: 'default', pins: ['R1.1', 'R2.1'] });
    b.tracks.push({
      id: 'T1',
      layer: 'F.Cu',
      width: 0.3,
      net: 'N1',
      seg: { type: 'line', start: { x: 5, y: 10 }, end: { x: 15, y: 10 } },
    });

    expect(runDRC(b)).toEqual([]);
  });

  it('runDRC uses the ruleset matching Board.rules (4-layer board with a track passing 2-layer minimum but failing nothing extra)', () => {
    const b = newBoard('t4', 4); // rules: 'jlcpcb-4l', minTrackWidth 0.09
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.tracks.push({
      id: 'T1',
      layer: 'F.Cu',
      width: 0.1, // >= 0.09 (4L) but < 0.127 (2L) — proves the 4L ruleset, not 2L, is in effect
      net: 'N1',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
    });

    expect(violationsOf(b, 'track-width')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DRC_EPSILON: geometry sitting exactly at a rule minimum must not violate
// (float/tessellation noise tolerance); geometry meaningfully below the
// minimum (minimum - 0.02, well outside the 0.01mm epsilon) still must.
// ---------------------------------------------------------------------------

describe('runDRC — DRC_EPSILON boundary behavior', () => {
  it('clearance: pads exactly at the required 0.2mm clearance do NOT violate', () => {
    const b = base();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    // gap = 1.2 - (0.5 + 0.5) = 0.2, exactly the default net-class clearance.
    b.components.push(makeComponent('R2', { x: 1.2, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    b.nets.push({ name: 'N1', class: 'default', pins: ['R1.1'] });
    b.nets.push({ name: 'N2', class: 'default', pins: ['R2.1'] });

    expect(violationsOf(b, 'clearance')).toHaveLength(0);
  });

  it('clearance: pads at 0.18mm (0.2mm minimum - 0.02) DO violate', () => {
    const b = base();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 1.18, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })]));
    b.nets.push({ name: 'N1', class: 'default', pins: ['R1.1'] });
    b.nets.push({ name: 'N2', class: 'default', pins: ['R2.1'] });

    expect(violationsOf(b, 'clearance').length).toBeGreaterThan(0);
  });

  it('track-width: track exactly at the 0.127mm minimum does NOT violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.tracks.push({
      id: 'T1',
      layer: 'F.Cu',
      width: 0.127,
      net: 'N1',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
    });

    expect(violationsOf(b, 'track-width')).toHaveLength(0);
  });

  it('track-width: track at 0.107mm (minimum - 0.02) DOES violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.tracks.push({
      id: 'T1',
      layer: 'F.Cu',
      width: 0.107,
      net: 'N1',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
    });

    expect(violationsOf(b, 'track-width')).toHaveLength(1);
  });

  it('drill: via drill exactly at the 0.3mm minimum does NOT violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'N1' });

    expect(violationsOf(b, 'drill')).toHaveLength(0);
  });

  it('drill: via drill at 0.28mm (minimum - 0.02) DOES violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.28, diameter: 0.6, net: 'N1' });

    expect(violationsOf(b, 'drill')).toHaveLength(1);
  });

  it('via-annular: ring exactly at the 0.13mm minimum does NOT violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    // annular = (0.56 - 0.3) / 2 = 0.13
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.56, net: 'N1' });

    expect(violationsOf(b, 'via-annular')).toHaveLength(0);
  });

  it('via-annular: ring at 0.11mm (minimum - 0.02) DOES violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    // annular = (0.52 - 0.3) / 2 = 0.11
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.52, net: 'N1' });

    expect(violationsOf(b, 'via-annular')).toHaveLength(1);
  });

  it('via-diameter: via exactly at the 0.5mm minimum does NOT violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.1, diameter: 0.5, net: 'N1' });

    expect(violationsOf(b, 'via-diameter')).toHaveLength(0);
  });

  it('via-diameter: via at 0.48mm (minimum - 0.02) DOES violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.1, diameter: 0.48, net: 'N1' });

    expect(violationsOf(b, 'via-diameter')).toHaveLength(1);
  });

  it('hole-to-hole: gap exactly at the 0.5mm minimum does NOT violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    // gap = dist - (0.3+0.3)/2 = 0.8 - 0.3 = 0.5
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'N1' });
    b.vias.push({ id: 'V2', at: { x: 0, y: 0.8 }, drill: 0.3, diameter: 0.6, net: 'N1' });

    expect(violationsOf(b, 'hole-to-hole')).toHaveLength(0);
  });

  it('hole-to-hole: gap at 0.48mm (minimum - 0.02) DOES violate', () => {
    const b = base();
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'N1' });
    b.vias.push({ id: 'V2', at: { x: 0, y: 0.78 }, drill: 0.3, diameter: 0.6, net: 'N1' });

    expect(violationsOf(b, 'hole-to-hole')).toHaveLength(1);
  });

  it('copper-to-edge: zone exactly at the 0.3mm minimum does NOT violate', () => {
    const b = base();
    b.outline = rectOutline(10, 10);
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    // Zone's left edge sits at x=0.3, exactly 0.3mm from the outline's x=0 edge.
    b.zones.push({
      id: 'Z1',
      layer: 'F.Cu',
      net: 'N1',
      polygon: rectPoly(0.3, 3, 1, 1),
      clearance: 0.2,
      minWidth: 0.2,
      thermal: { gap: 0.3, spokeWidth: 0.3 },
    });

    expect(violationsOf(b, 'copper-to-edge')).toHaveLength(0);
  });

  it('copper-to-edge: zone at 0.28mm (minimum - 0.02) DOES violate', () => {
    const b = base();
    b.outline = rectOutline(10, 10);
    b.nets.push({ name: 'N1', class: 'default', pins: [] });
    b.zones.push({
      id: 'Z1',
      layer: 'F.Cu',
      net: 'N1',
      polygon: rectPoly(0.28, 3, 1, 1),
      clearance: 0.2,
      minWidth: 0.2,
      thermal: { gap: 0.3, spokeWidth: 0.3 },
    });

    expect(violationsOf(b, 'copper-to-edge')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Zone fill: winding-encoded hole rings are copper knockouts, not solid copper.
// Regression guard for the false "clearance 0.00mm" violations that arose from
// treating every fill ring as an independent solid polygon.
// ---------------------------------------------------------------------------

describe('runDRC — zone fill hole rings are copper knockouts', () => {
  // CCW rectPoly is a solid outer; its reverse is a CW hole (winding contract,
  // see zonefill.ts). A GND pour over a 10x10 outer with a 2x2 knockout hole.
  function pourWithKnockout(hole: Point[]): Zone {
    return {
      id: 'z1',
      layer: 'F.Cu',
      net: 'GND',
      polygon: rectPoly(0, 0, 10, 10),
      clearance: 0.2,
      minWidth: 0.2,
      thermal: { gap: 0.3, spokeWidth: 0.3 },
      fill: [rectPoly(0, 0, 10, 10), hole],
    };
  }

  function withNets(b: Board): Board {
    b.nets.push({ name: 'GND', class: 'default', pins: [] });
    b.nets.push({ name: 'SIG', class: 'default', pins: [] });
    return b;
  }

  it('a different-net track inside a fill hole at proper clearance is NOT a clearance violation', () => {
    const b = withNets(base());
    // Track centered in the 2x2 hole [4,6]x[4,6]; nearest hole edge ~0.375mm > 0.2.
    b.tracks.push({
      id: 't1',
      layer: 'F.Cu',
      width: 0.25,
      net: 'SIG',
      seg: { type: 'line', start: { x: 4.5, y: 5 }, end: { x: 5.5, y: 5 } },
    });
    // Hole CW = reversed CCW rectPoly.
    b.zones.push(pourWithKnockout(rectPoly(4, 4, 2, 2).slice().reverse()));

    const zoneVsTrack = runDRC(b).filter(
      (v) => v.rule === 'clearance' && v.items.includes('z1') && v.items.includes('t1'),
    );
    expect(zoneVsTrack).toHaveLength(0);
  });

  it('a different-net track overlapping SOLID fill IS a clearance violation', () => {
    const b = withNets(base());
    // Track in the solid region (no knockout there) => genuinely overlaps copper.
    b.tracks.push({
      id: 't1',
      layer: 'F.Cu',
      width: 0.25,
      net: 'SIG',
      seg: { type: 'line', start: { x: 1, y: 1 }, end: { x: 2, y: 1 } },
    });
    b.zones.push(pourWithKnockout(rectPoly(4, 4, 2, 2).slice().reverse()));

    const zoneVsTrack = runDRC(b).filter(
      (v) => v.rule === 'clearance' && v.items.includes('z1') && v.items.includes('t1'),
    );
    expect(zoneVsTrack.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: the committed blinker-routed fixture, filled + DRC'd, must not
// emit the bogus zone-vs-track clearance violations the hole-ring bug
// produced, nor the copper-to-edge / pad-clearance false positives from
// exact-at-minimum geometry landing a few µm under threshold on float and
// tessellation noise (DRC_EPSILON).
//
// This fixture predates the epsilon fix: its GND pour polygons were filled
// to exactly the 0.30mm copper-to-edge minimum via the differently-
// tessellated inset band, and its J1 (USB-C) pads sit at exactly the
// 0.20mm net-class clearance minimum — both a few µm under threshold before
// the fix, both within DRC_EPSILON after it. Its silk-over-pad violations
// are unrelated to this fix (real R4/R5 silk-over-pad overlaps that were
// only fixed later on the live board, not in this frozen fixture) and are
// expected to remain.
// ---------------------------------------------------------------------------

describe('runDRC — blinker-routed fixture (filled zones)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const board = fillAllZones(
    parseBoard(readFileSync(join(here, 'fixtures', 'blinker-routed.flamingo'), 'utf8')),
  );
  const violations = runDRC(board);

  it('reports ZERO clearance violations between a zone and a different-net item', () => {
    const zoneClearance = violations.filter((v) => {
      if (v.rule !== 'clearance') return false;
      return board.zones.some((z) => v.items.includes(z.id));
    });
    expect(zoneClearance).toHaveLength(0);
  });

  it('reports ZERO copper-to-edge violations (GND pours filled to exactly the 0.30mm minimum now pass)', () => {
    expect(violations.filter((v) => v.rule === 'copper-to-edge')).toHaveLength(0);
  });

  it('reports ZERO clearance violations at all (J1 USB-C pads sitting at exactly the 0.20mm minimum now pass)', () => {
    expect(violations.filter((v) => v.rule === 'clearance')).toHaveLength(0);
  });

  it('still surfaces the board\'s genuine, unrelated violations (silk over pads)', () => {
    const byRule = new Map<string, number>();
    for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
    expect(byRule.get('silk-over-pad') ?? 0).toBeGreaterThan(0);
    // Nothing else should remain: the epsilon fix resolves both the
    // zone-fill and pad-clearance boundary noise in this fixture.
    expect(new Set(violations.map((v) => v.rule))).toEqual(new Set(['silk-over-pad']));
  });
});
