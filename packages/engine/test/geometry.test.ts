import { describe, it, expect } from 'vitest';
import {
  rotate,
  add,
  dist,
  segSegDistance,
  pointSegDistance,
  padWorld,
  padOutline,
  outlineToPolygon,
  bboxOf,
  boardBBox,
  polyIntersects,
  pointInPolygon,
  expandTrack,
} from '../src/index.js';
import type { ComponentInst, Pad, Footprint, PathSeg, Board, Track } from '../src/index.js';
import { newBoard } from '../src/index.js';

function makeFootprint(pads: Pad[]): Footprint {
  return { name: 'test-fp', lcsc: 'C0', pads, silk: [], courtyard: [] };
}

function makeComponent(overrides: Partial<ComponentInst> & { footprint: Footprint }): ComponentInst {
  return {
    refdes: 'U1',
    lcsc: 'C0',
    at: { x: 0, y: 0 },
    rotation: 0,
    side: 'top',
    fields: {},
    ...overrides,
  };
}

describe('rotate', () => {
  it('rotates (1,0) by 90deg CCW to (0,1)', () => {
    const r = rotate({ x: 1, y: 0 }, 90);
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(1, 9);
  });

  it('rotates (0,1) by 90deg CCW to (-1,0)', () => {
    const r = rotate({ x: 0, y: 1 }, 90);
    expect(r.x).toBeCloseTo(-1, 9);
    expect(r.y).toBeCloseTo(0, 9);
  });

  it('rotates (1,1) by 90deg CCW to (-1,1)', () => {
    const r = rotate({ x: 1, y: 1 }, 90);
    expect(r.x).toBeCloseTo(-1, 9);
    expect(r.y).toBeCloseTo(1, 9);
  });

  it('rotate by 0 is identity', () => {
    const r = rotate({ x: 3, y: -4 }, 0);
    expect(r.x).toBeCloseTo(3, 9);
    expect(r.y).toBeCloseTo(-4, 9);
  });
});

describe('add', () => {
  it('adds two points', () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
  });
});

describe('dist', () => {
  it('computes 3-4-5 distance', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 9);
  });
});

describe('pointSegDistance', () => {
  const line: PathSeg = { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };

  it('perpendicular distance to a point above the middle of the segment', () => {
    expect(pointSegDistance({ x: 5, y: 3 }, line)).toBeCloseTo(3, 9);
  });

  it('distance to a point beyond the start clamps to the endpoint', () => {
    expect(pointSegDistance({ x: -2, y: 0 }, line)).toBeCloseTo(2, 9);
  });

  it('distance to a point beyond the end clamps to the endpoint', () => {
    expect(pointSegDistance({ x: 12, y: 4 }, line)).toBeCloseTo(Math.sqrt(2 * 2 + 4 * 4), 9);
  });
});

describe('segSegDistance', () => {
  it('parallel horizontal lines 3mm apart', () => {
    const a: PathSeg = { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };
    const b: PathSeg = { type: 'line', start: { x: 0, y: 3 }, end: { x: 10, y: 3 } };
    expect(segSegDistance(a, b)).toBeCloseTo(3, 6);
  });

  it('crossing segments have zero distance', () => {
    const a: PathSeg = { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 10 } };
    const b: PathSeg = { type: 'line', start: { x: 0, y: 10 }, end: { x: 10, y: 0 } };
    expect(segSegDistance(a, b)).toBeCloseTo(0, 6);
  });
});

describe('padWorld', () => {
  it('top-side, no rotation: world = component.at + pad.at, rotation = pad.rotation', () => {
    const fp = makeFootprint([]);
    const c = makeComponent({ at: { x: 10, y: 5 }, rotation: 0, side: 'top', footprint: fp });
    const pad: Pad = {
      number: '1',
      shape: 'rect',
      at: { x: 2, y: 1 },
      rotation: 30,
      size: { w: 1, h: 1 },
      layer: 'top',
    };
    const w = padWorld(c, pad);
    expect(w.at.x).toBeCloseTo(12, 9);
    expect(w.at.y).toBeCloseTo(6, 9);
    expect(w.rotation).toBeCloseTo(30, 9);
  });

  it('bottom side + rotated component: mirror x before rotation, negate pad rotation', () => {
    // Hand-computed: pad.at=(2,1), mirror -> (-2,1); rotate 90deg CCW ->
    // (x'=-y=-1, y'=x=-2) -> (-1,-2); translate by c.at=(10,5) -> (9,3).
    // rotation = -pad.rotation(30) + c.rotation(90) = 60.
    const fp = makeFootprint([]);
    const c = makeComponent({ at: { x: 10, y: 5 }, rotation: 90, side: 'bottom', footprint: fp });
    const pad: Pad = {
      number: '1',
      shape: 'rect',
      at: { x: 2, y: 1 },
      rotation: 30,
      size: { w: 1, h: 1 },
      layer: 'bottom',
    };
    const w = padWorld(c, pad);
    expect(w.at.x).toBeCloseTo(9, 9);
    expect(w.at.y).toBeCloseTo(3, 9);
    expect(w.rotation).toBeCloseTo(60, 9);
  });
});

describe('padOutline', () => {
  it('rect pad on a bottom-side component (no component rotation): mirrors x', () => {
    // Local rect (w=2,h=1) centered at pad.at=(1,0), rotation 0:
    // corners (0,-0.5),(2,-0.5),(2,0.5),(0,0.5).
    // Mirror x (bottom side): (0,-0.5),(-2,-0.5),(-2,0.5),(0,0.5).
    // No component rotation/translation (c.at=0,0 rotation=0).
    const fp = makeFootprint([]);
    const c = makeComponent({ at: { x: 0, y: 0 }, rotation: 0, side: 'bottom', footprint: fp });
    const pad: Pad = {
      number: '1',
      shape: 'rect',
      at: { x: 1, y: 0 },
      rotation: 0,
      size: { w: 2, h: 1 },
      layer: 'bottom',
    };
    const outline = padOutline(c, pad);
    expect(outline).toHaveLength(4);
    const expected = [
      { x: 0, y: -0.5 },
      { x: -2, y: -0.5 },
      { x: -2, y: 0.5 },
      { x: 0, y: 0.5 },
    ];
    outline.forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i].x, 9);
      expect(p.y).toBeCloseTo(expected[i].y, 9);
    });
  });

  it('top-side rect pad is not mirrored', () => {
    const fp = makeFootprint([]);
    const c = makeComponent({ at: { x: 0, y: 0 }, rotation: 0, side: 'top', footprint: fp });
    const pad: Pad = {
      number: '1',
      shape: 'rect',
      at: { x: 1, y: 0 },
      rotation: 0,
      size: { w: 2, h: 1 },
      layer: 'top',
    };
    const bbox = bboxOf(padOutline(c, pad));
    expect(bbox).toEqual({ minX: 0, minY: -0.5, maxX: 2, maxY: 0.5 });
  });

  it('circle pad tessellates to at least 16 points', () => {
    const fp = makeFootprint([]);
    const c = makeComponent({ at: { x: 0, y: 0 }, rotation: 0, side: 'top', footprint: fp });
    const pad: Pad = {
      number: '1',
      shape: 'circle',
      at: { x: 0, y: 0 },
      rotation: 0,
      size: { w: 1, h: 1 },
      layer: 'top',
    };
    const outline = padOutline(c, pad);
    expect(outline.length).toBeGreaterThanOrEqual(16);
    // all points should lie ~0.5mm from origin
    for (const p of outline) {
      expect(dist(p, { x: 0, y: 0 })).toBeCloseTo(0.5, 6);
    }
  });
});

describe('outlineToPolygon', () => {
  // 10x10 square, corner at (10,10) rounded off with a radius-2 arc.
  const outline: PathSeg[] = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { type: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 8 } },
    {
      type: 'arc',
      start: { x: 10, y: 8 },
      end: { x: 8, y: 10 },
      center: { x: 8, y: 8 },
      cw: false,
    },
    { type: 'line', start: { x: 8, y: 10 }, end: { x: 0, y: 10 } },
    { type: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
  ];

  it('produces a closed polygon with the expected bbox', () => {
    const poly = outlineToPolygon(outline);
    const bbox = bboxOf(poly);
    expect(bbox.minX).toBeCloseTo(0, 6);
    expect(bbox.minY).toBeCloseTo(0, 6);
    expect(bbox.maxX).toBeCloseTo(10, 6);
    expect(bbox.maxY).toBeCloseTo(10, 6);
  });

  it('tessellates the arc corner through its 45deg midpoint', () => {
    const poly = outlineToPolygon(outline);
    const expectedMid = { x: 8 + 2 * Math.cos(Math.PI / 4), y: 8 + 2 * Math.sin(Math.PI / 4) };
    const closest = poly.reduce((best, p) =>
      dist(p, expectedMid) < dist(best, expectedMid) ? p : best,
    );
    expect(dist(closest, expectedMid)).toBeLessThan(0.05);
  });

  it('throws when the loop does not close within tolerance', () => {
    const broken: PathSeg[] = [
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { type: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      { type: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
      { type: 'line', start: { x: 0, y: 10 }, end: { x: 0.1, y: 0 } }, // 0.1mm gap to first seg start
    ];
    expect(() => outlineToPolygon(broken)).toThrow();
  });

  it('does not throw when the gap is within 0.01mm tolerance', () => {
    const almostClosed: PathSeg[] = [
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { type: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      { type: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
      { type: 'line', start: { x: 0, y: 10 }, end: { x: 0.005, y: 0 } },
    ];
    expect(() => outlineToPolygon(almostClosed)).not.toThrow();
  });
});

describe('bboxOf', () => {
  it('computes min/max over a point set', () => {
    const pts = [
      { x: 1, y: 2 },
      { x: -3, y: 5 },
      { x: 4, y: -1 },
    ];
    expect(bboxOf(pts)).toEqual({ minX: -3, minY: -1, maxX: 4, maxY: 5 });
  });

  it('throws on an empty point list', () => {
    expect(() => bboxOf([])).toThrow();
  });
});

describe('boardBBox', () => {
  it('uses the outline when present', () => {
    const board = newBoard('test', 2);
    board.outline = [
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
      { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
      { type: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 } },
      { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
    ];
    expect(boardBBox(board)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 });
  });

  it('falls back to content bbox (pads) when no outline', () => {
    const board = newBoard('test', 2);
    const pad: Pad = {
      number: '1',
      shape: 'rect',
      at: { x: 0, y: 0 },
      rotation: 0,
      size: { w: 2, h: 2 },
      layer: 'top',
    };
    const fp = makeFootprint([pad]);
    const c = makeComponent({ at: { x: 5, y: 5 }, rotation: 0, side: 'top', footprint: fp });
    board.components.push(c);
    const bbox = boardBBox(board);
    expect(bbox.minX).toBeCloseTo(4, 9);
    expect(bbox.minY).toBeCloseTo(4, 9);
    expect(bbox.maxX).toBeCloseTo(6, 9);
    expect(bbox.maxY).toBeCloseTo(6, 9);
  });

  it('returns a zero bbox for a fully empty board', () => {
    const board = newBoard('empty', 2);
    expect(boardBBox(board)).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe('polyIntersects', () => {
  const squareA = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ];

  it('true for overlapping squares', () => {
    const squareB = [
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ];
    expect(polyIntersects(squareA, squareB)).toBe(true);
  });

  it('false for disjoint squares', () => {
    const squareC = [
      { x: 5, y: 5 },
      { x: 7, y: 5 },
      { x: 7, y: 7 },
      { x: 5, y: 7 },
    ];
    expect(polyIntersects(squareA, squareC)).toBe(false);
  });

  it('false for merely touching squares (zero-area intersection)', () => {
    const squareD = [
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
    ];
    expect(polyIntersects(squareA, squareD)).toBe(false);
  });
});

describe('pointInPolygon', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];

  it('true for a point inside', () => {
    expect(pointInPolygon({ x: 2, y: 2 }, square)).toBe(true);
  });

  it('false for a point outside', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(false);
  });
});

describe('expandTrack', () => {
  it('capsule bbox for a horizontal line track', () => {
    const track: Track = {
      id: 'T1',
      layer: 'F.Cu',
      width: 2, // half-width 1
      net: 'GND',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    };
    const poly = expandTrack(track);
    const bbox = bboxOf(poly);
    expect(bbox.minX).toBeCloseTo(-1, 6);
    expect(bbox.minY).toBeCloseTo(-1, 6);
    expect(bbox.maxX).toBeCloseTo(11, 6);
    expect(bbox.maxY).toBeCloseTo(1, 6);
  });

  it('capsule bbox for a vertical line track', () => {
    const track: Track = {
      id: 'T2',
      layer: 'F.Cu',
      width: 4, // half-width 2
      net: 'GND',
      seg: { type: 'line', start: { x: 5, y: 5 }, end: { x: 5, y: 15 } },
    };
    const poly = expandTrack(track);
    const bbox = bboxOf(poly);
    expect(bbox.minX).toBeCloseTo(3, 6);
    expect(bbox.minY).toBeCloseTo(3, 6);
    expect(bbox.maxX).toBeCloseTo(7, 6);
    expect(bbox.maxY).toBeCloseTo(17, 6);
  });
});
