import { describe, it, expect } from 'vitest';
import { applyOp, newBoard, pointInPolygon } from '../src/index.js';
import type { Board, Op, PathSeg, Point, Zone } from '../src/index.js';
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
