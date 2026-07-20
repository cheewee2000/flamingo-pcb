import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import polygonClipping from 'polygon-clipping';
import { applyOp, newBoard, parseBoard, pointInPolygon, boardBBox, padOutline, polyGroupDistance, groupFillRings } from '../src/index.js';
import type { Board, ComponentInst, Op, Pad, PathSeg, Point, Zone } from '../src/index.js';
import { fillZone, fillAllZones } from '../src/zonefill.js';

const RECT_OUTLINE_10: PathSeg[] = [
  { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
  { type: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
  { type: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
  { type: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
];

function apply(b: Board, op: Op): Board {
  const r = applyOp(b, op);
  if (!r.ok) throw new Error(`op ${op.op} failed: ${r.error}`);
  return r.board;
}

const zoneRectPoly: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

/** Solid membership under even-odd across all rings (holes are winding-encoded). */
function inFill(fill: Point[][], p: Point): boolean {
  let count = 0;
  for (const ring of fill) if (pointInPolygon(p, ring)) count++;
  return count % 2 === 1;
}

function baseBoard(outline = true): Board {
  let b = newBoard('zt', 2);
  if (outline) b = apply(b, { op: 'setOutline', outline: RECT_OUTLINE_10 });
  // Declare the nets used by tracks/vias below (ops reject unknown nets).
  b = { ...b, nets: [
    { name: 'GND', class: 'default', pins: [] },
    { name: 'SIG', class: 'default', pins: [] },
  ] };
  return b;
}

function zoneOf(b: Board, over: Partial<Zone> = {}): Zone {
  return {
    id: 'z1',
    layer: 'F.Cu',
    net: 'GND',
    polygon: zoneRectPoly,
    clearance: 0.5,
    minWidth: 0.2,
    thermal: { gap: 0.3, spokeWidth: 0.3 },
    ...over,
  };
}

describe('fillZone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('excludes a clearance-buffered corridor around a different-net track', () => {
    let b = baseBoard();
    b = apply(b, {
      op: 'addTrack',
      track: {
        layer: 'F.Cu',
        width: 0.5,
        net: 'SIG',
        seg: { type: 'line', start: { x: 0, y: 5 }, end: { x: 10, y: 5 } },
      },
    });
    const fill = fillZone(b, zoneOf(b));
    expect(fill.length).toBeGreaterThan(0);
    // on the track centerline -> excluded
    expect(inFill(fill, { x: 5, y: 5 })).toBe(false);
    // within clearance band (halfwidth 0.25 + clearance 0.5 = 0.75) -> excluded
    expect(inFill(fill, { x: 5, y: 5.5 })).toBe(false);
    // clear of the band -> filled
    expect(inFill(fill, { x: 5, y: 7 })).toBe(true);
    expect(inFill(fill, { x: 5, y: 3 })).toBe(true);
  });

  it('excludes a clearance-buffered stadium around a slotted mounting hole', () => {
    let b = baseBoard();
    // Slot centered at (5,5), drill 1, slotLength 5 -> centerline (3,5)..(7,5).
    // Exclusion radius = padDiameter/2 (0.5) + clearance (0.5) = 1.0mm.
    b = apply(b, {
      op: 'addHole',
      hole: { at: { x: 5, y: 5 }, drill: 1, padDiameter: 1, plated: false, slotLength: 5 },
    });
    const fill = fillZone(b, zoneOf(b));
    expect(fill.length).toBeGreaterThan(0);
    // on the centerline -> excluded
    expect(inFill(fill, { x: 5, y: 5 })).toBe(false);
    // within the 1.0mm band -> excluded
    expect(inFill(fill, { x: 5, y: 5.5 })).toBe(false);
    // along the long axis, 0.5mm past the slot end (3,5) -> excluded (proves the
    // obstacle is an elongated capsule, not a circle around the center)
    expect(inFill(fill, { x: 2.5, y: 5 })).toBe(false);
    // clear of the band, off the side -> filled
    expect(inFill(fill, { x: 5, y: 6.5 })).toBe(true);
    // clear of the band, past the end -> filled
    expect(inFill(fill, { x: 8.5, y: 5 })).toBe(true);
  });

  it('does not subtract a round mounting hole (existing behavior preserved)', () => {
    let b = baseBoard();
    b = apply(b, {
      op: 'addHole',
      hole: { at: { x: 5, y: 5 }, drill: 3, padDiameter: 5, plated: true },
    });
    const fill = fillZone(b, zoneOf(b));
    // A plain round mounting hole is not a pour obstacle -> copper fills over it.
    expect(inFill(fill, { x: 5, y: 5 })).toBe(true);
  });

  it('does not subtract a same-net track', () => {
    let b = baseBoard();
    b = apply(b, {
      op: 'addTrack',
      track: {
        layer: 'F.Cu',
        width: 0.5,
        net: 'GND',
        seg: { type: 'line', start: { x: 0, y: 2 }, end: { x: 10, y: 2 } },
      },
    });
    const fill = fillZone(b, zoneOf(b));
    expect(inFill(fill, { x: 5, y: 2 })).toBe(true);
  });

  it('respects the board-outline inset', () => {
    const b = baseBoard();
    const fill = fillZone(b, zoneOf(b));
    // within clearance (0.5) of the outline edge -> excluded
    expect(inFill(fill, { x: 0.1, y: 5 })).toBe(false);
    // well inside -> filled
    expect(inFill(fill, { x: 2, y: 5 })).toBe(true);
  });

  it('drops fill islands below minWidth^2 area', () => {
    // A 1x1mm zone (area 1) with no obstacles and no outline inset.
    const smallPoly: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const b = baseBoard(false);
    const kept = fillZone(b, zoneOf(b, { polygon: smallPoly, minWidth: 0.5 }));
    expect(kept.length).toBeGreaterThan(0); // 1 > 0.25
    const dropped = fillZone(b, zoneOf(b, { polygon: smallPoly, minWidth: 2 }));
    expect(dropped.length).toBe(0); // 1 < 4 -> whole island dropped
  });

  it('excludes a clearance-buffered area around an all-layer copper keepout', () => {
    let b = baseBoard(false);
    b = apply(b, {
      op: 'addKeepout',
      keepout: {
        layers: 'all',
        polygon: [
          { x: 4, y: 4 },
          { x: 6, y: 4 },
          { x: 6, y: 6 },
          { x: 4, y: 6 },
        ],
        keepout: { copper: true, via: false },
      },
    });
    const fill = fillZone(b, zoneOf(b));
    expect(fill.length).toBeGreaterThan(0);
    // inside the keepout -> excluded
    expect(inFill(fill, { x: 5, y: 5 })).toBe(false);
    // clear of the keepout (and its clearance buffer) -> filled
    expect(inFill(fill, { x: 1, y: 1 })).toBe(true);
    expect(inFill(fill, { x: 9, y: 9 })).toBe(true);
  });

  it('does not clip the pour for a via-only keepout (copper: false)', () => {
    let b = baseBoard(false);
    b = apply(b, {
      op: 'addKeepout',
      keepout: {
        layers: 'all',
        polygon: [
          { x: 4, y: 4 },
          { x: 6, y: 4 },
          { x: 6, y: 6 },
          { x: 4, y: 6 },
        ],
        keepout: { copper: false, via: true },
      },
    });
    const fill = fillZone(b, zoneOf(b));
    // the via-only keepout must not remove copper here
    expect(inFill(fill, { x: 5, y: 5 })).toBe(true);
  });

  it('clips the pour for a pour-only keepout (copper: false, pour: true)', () => {
    let b = baseBoard(false);
    b = apply(b, {
      op: 'addKeepout',
      keepout: {
        layers: 'all',
        polygon: [
          { x: 4, y: 4 },
          { x: 6, y: 4 },
          { x: 6, y: 6 },
          { x: 4, y: 6 },
        ],
        keepout: { copper: false, via: false, pour: true },
      },
    });
    const fill = fillZone(b, zoneOf(b));
    expect(fill.length).toBeGreaterThan(0);
    // inside the pour-only keepout -> excluded from the pour
    expect(inFill(fill, { x: 5, y: 5 })).toBe(false);
    // clear of the keepout -> filled
    expect(inFill(fill, { x: 1, y: 1 })).toBe(true);
  });

  it('does not clip the pour for a copper keepout on a different layer', () => {
    let b = baseBoard(false);
    b = apply(b, {
      op: 'addKeepout',
      keepout: {
        layers: ['B.Cu'],
        polygon: [
          { x: 4, y: 4 },
          { x: 6, y: 4 },
          { x: 6, y: 6 },
          { x: 4, y: 6 },
        ],
        keepout: { copper: true, via: false },
      },
    });
    const fill = fillZone(b, zoneOf(b, { layer: 'F.Cu' }));
    // the B.Cu-only keepout must not remove F.Cu copper
    expect(inFill(fill, { x: 5, y: 5 })).toBe(true);
  });

  it('winding-encodes holes: outer CCW, hole CW (via an enclosed different-net via)', () => {
    let b = baseBoard(false);
    b = apply(b, {
      op: 'addVia',
      via: { at: { x: 5, y: 5 }, drill: 0.4, diameter: 0.8, net: 'SIG' },
    });
    const fill = fillZone(b, zoneOf(b));
    // point at the via center is a hole -> not solid
    expect(inFill(fill, { x: 5, y: 5 })).toBe(false);
    // surrounding copper is solid
    expect(inFill(fill, { x: 2, y: 2 })).toBe(true);
    // there must be at least one outer (CCW, +area) and one hole (CW, -area) ring
    const areas = fill.map((r) => signedArea(r));
    expect(areas.some((a) => a > 0)).toBe(true);
    expect(areas.some((a) => a < 0)).toBe(true);
  });

  it('quantizes clip inputs to the 10µm grid up front (off-grid coords fill identically to snapped ones)', () => {
    // Autoroute output carries sub-micron vertices that send polygon-clipping's
    // sweepline into multi-second churn (and often a thrown "infinite loop").
    // The fill must therefore snap ALL clip inputs to the 10µm grid before the
    // first attempt — so a board with off-grid coordinates fills exactly like
    // the same board with pre-snapped coordinates.
    const mkBoard = (y0: number, y1: number): Board =>
      apply(baseBoard(false), {
        op: 'addTrack',
        track: {
          layer: 'F.Cu',
          width: 0.5,
          net: 'SIG',
          seg: { type: 'line', start: { x: 0, y: y0 }, end: { x: 10, y: y1 } },
        },
      });
    const offGrid = fillZone(mkBoard(5.0000003, 4.9999997), zoneOf(mkBoard(0, 0)));
    const onGrid = fillZone(mkBoard(5, 5), zoneOf(mkBoard(0, 0)));
    expect(offGrid).toEqual(onGrid);
  });

  it('recovers via the snap retry when the clipper throws once (SweepLine failure)', () => {
    // No board outline so the only polygonClipping.difference call is the one
    // inside robustClip's difference for the obstacles subtraction (the
    // outline-inset uses a separate difference we don't want to trip). A
    // different-net track gives us obstacles.length > 0.
    let b = baseBoard(false);
    b = apply(b, {
      op: 'addTrack',
      track: {
        layer: 'F.Cu',
        width: 0.5,
        net: 'SIG',
        seg: { type: 'line', start: { x: 0, y: 5 }, end: { x: 10, y: 5 } },
      },
    });
    // First difference call throws the real SweepLine failure; every later call
    // (the 10µm snap retry) falls through to the genuine implementation.
    const spy = vi
      .spyOn(polygonClipping, 'difference')
      .mockImplementationOnce(() => {
        throw new Error('Unable to find segment … in SweepLine tree');
      });
    const fill = fillZone(b, zoneOf(b));
    expect(spy).toHaveBeenCalled();
    // Snap-retry result matches the un-mocked happy path at the same samples:
    expect(fill.length).toBeGreaterThan(0);
    expect(inFill(fill, { x: 5, y: 5 })).toBe(false); // on the track centerline -> excluded
    expect(inFill(fill, { x: 5, y: 5.5 })).toBe(false); // within the clearance band -> excluded
    expect(inFill(fill, { x: 5, y: 7 })).toBe(true); // clear of the band -> filled
    expect(inFill(fill, { x: 5, y: 3 })).toBe(true);
    // Winding-encoding invariant still holds: at least one CCW (+area) outer ring.
    const areas = fill.map((r) => signedArea(r));
    expect(areas.some((a) => a > 0)).toBe(true);
  });

  it('degrades to the unobstructed base when the clipper always throws (last resort)', () => {
    // Same fixture, but every difference attempt (direct + 10µm + 20µm snap)
    // throws, so robustClip's difference falls through to `return base`.
    let b = baseBoard(false);
    b = apply(b, {
      op: 'addTrack',
      track: {
        layer: 'F.Cu',
        width: 0.5,
        net: 'SIG',
        seg: { type: 'line', start: { x: 0, y: 5 }, end: { x: 10, y: 5 } },
      },
    });
    vi.spyOn(polygonClipping, 'difference').mockImplementation(() => {
      throw new Error('sweepline failure');
    });
    const fill = fillZone(b, zoneOf(b));
    expect(fill.length).toBeGreaterThan(0);
    // The track corridor is no longer subtracted: a point the happy path would
    // exclude (on the track centerline) is now poured over. Deliberate degrade.
    expect(inFill(fill, { x: 5, y: 5 })).toBe(true);
  });
});

describe('fillAllZones', () => {
  it('returns a board copy with every zone.fill populated', () => {
    let b = baseBoard();
    b = apply(b, {
      op: 'addZone',
      zone: {
        layer: 'F.Cu',
        net: 'GND',
        polygon: zoneRectPoly,
        clearance: 0.5,
        minWidth: 0.2,
        thermal: { gap: 0.3, spokeWidth: 0.3 },
      },
    });
    const filled = fillAllZones(b);
    expect(filled).not.toBe(b);
    expect(b.zones[0].fill).toBeUndefined();
    expect(filled.zones[0].fill).toBeDefined();
    expect(filled.zones[0].fill!.length).toBeGreaterThan(0);
  });
});

describe('degenerate clearance-buffer geometry (regression)', () => {
  it('never pours over a foreign pad whose clearance buffer degenerates (eink-cell TP7)', () => {
    // Exact coordinates from the eink-cell board (2026-07-19): a Ø1.5mm
    // testpoint pad at (62.6, 78.12) with 0.3mm zone clearance produced
    // float-noise micro-segments that made bufferPolygon's internal union
    // throw at every snap grid. The old union fallback passed the raw
    // degenerate geometry downstream, the final difference then threw at
    // every grid too, and the per-subtrahend fallback skipped the pad's
    // obstacle entirely -- pouring GND copper straight over the pad (DRC:
    // clearance 0.00mm against the pad).
    const outline: PathSeg[] = [
      { type: 'line', start: { x: 55, y: 70 }, end: { x: 70, y: 70 } },
      { type: 'line', start: { x: 70, y: 70 }, end: { x: 70, y: 85 } },
      { type: 'line', start: { x: 70, y: 85 }, end: { x: 55, y: 85 } },
      { type: 'line', start: { x: 55, y: 85 }, end: { x: 55, y: 70 } },
    ];
    let b = newBoard('tp7', 2);
    b = apply(b, { op: 'setOutline', outline });
    const pad: Pad = {
      number: '1',
      shape: 'circle',
      at: { x: 0, y: 0 },
      rotation: 0,
      size: { w: 1.5, h: 1.5 },
      layer: 'top',
    };
    const tp7: ComponentInst = {
      refdes: 'TP7',
      lcsc: 'C0',
      footprint: { name: 'tp', lcsc: 'C0', pads: [pad], silk: [], courtyard: [] },
      at: { x: 62.6, y: 78.12 },
      rotation: 0,
      side: 'top',
      fields: {},
    };
    b = {
      ...b,
      components: [tp7],
      nets: [
        { name: 'GND', class: 'default', pins: [] },
        { name: 'SIG', class: 'default', pins: ['TP7.1'] },
      ],
    };
    const zonePoly: Point[] = [
      { x: 55, y: 70 },
      { x: 70, y: 70 },
      { x: 70, y: 85 },
      { x: 55, y: 85 },
    ];
    const fill = fillZone(b, zoneOf(b, { polygon: zonePoly, clearance: 0.3 }));
    expect(fill.length).toBeGreaterThan(0);
    // far corner of the zone still poured
    expect(inFill(fill, { x: 56.5, y: 71.5 })).toBe(true);

    const padPoly = padOutline(tp7, pad);
    let d = Infinity;
    for (const group of groupFillRings(fill)) {
      d = Math.min(d, polyGroupDistance(padPoly, group));
    }
    // 0.02mm tolerance = two snap-grid steps (DRC epsilon is 0.01).
    expect(d).toBeGreaterThanOrEqual(0.3 - 0.02);
  });
});

describe('fillAllZones on a real routed board (regression)', () => {
  // boards/blinker/blinker.flamingo is freerouting output containing ~2µm
  // segments that used to trip polygon-clipping's SweepLine on the
  // unhardened union/intersection call sites in the outline-inset chain and
  // the capsule-obstacle union in bufferPolygon (only the final obstacle
  // difference was hardened before). Regression for that bug.
  it('completes without throwing and fills every zone within the board bbox', () => {
    const json = readFileSync(
      new URL('./fixtures/blinker-routed.flamingo', import.meta.url),
      'utf8',
    );
    const board = parseBoard(json);
    expect(board.zones.length).toBeGreaterThan(0);

    let filled: Board | undefined;
    expect(() => {
      filled = fillAllZones(board);
    }).not.toThrow();

    const bbox = boardBBox(board);
    const tol = 0.01; // mm
    for (const zone of filled!.zones) {
      expect(zone.fill).toBeDefined();
      expect(zone.fill!.length).toBeGreaterThan(0);
      for (const ring of zone.fill!) {
        for (const p of ring) {
          expect(p.x).toBeGreaterThanOrEqual(bbox.minX - tol);
          expect(p.x).toBeLessThanOrEqual(bbox.maxX + tol);
          expect(p.y).toBeGreaterThanOrEqual(bbox.minY - tol);
          expect(p.y).toBeLessThanOrEqual(bbox.maxY + tol);
        }
      }
    }
  });
});

function signedArea(pts: Point[]): number {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
