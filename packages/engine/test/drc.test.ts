import { describe, it, expect } from 'vitest';
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
} from '../src/index.js';
import { runDRC, RULESETS } from '../src/index.js';

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
