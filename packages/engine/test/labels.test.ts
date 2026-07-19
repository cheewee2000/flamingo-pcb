import { describe, it, expect } from 'vitest';
import type { Board, ComponentInst, Footprint, Pad, Point } from '../src/index.js';
import {
  newBoard,
  componentBodyBBox,
  componentLabelPlacement,
  componentLabelRect,
  COMPONENT_LABEL_GAP_MM,
  COMPONENT_LABEL_HEIGHT_MM,
  COMPONENT_LABEL_CHAR_ADVANCE,
  pointInPolygon,
} from '../src/index.js';

function smdPad(number: string, at: Point, size = { w: 1, h: 1 }): Pad {
  return { number, shape: 'rect', at, rotation: 0, size, layer: 'top' };
}

function comp(
  refdes: string,
  at: Point,
  pads: Pad[],
  overrides: Partial<ComponentInst> & { footprintOverrides?: Partial<Footprint> } = {},
): ComponentInst {
  const { footprintOverrides, ...rest } = overrides;
  const footprint: Footprint = { name: 'fp', lcsc: 'C0', pads, silk: [], courtyard: [], ...footprintOverrides };
  return { refdes, lcsc: 'C1', footprint, at, rotation: 0, side: 'top', fields: {}, ...rest };
}

/** 0603-style landscape part: pads at x = ±0.75, 0.8x0.8 -> body 2.3 x 0.8. */
function landscape(refdes = 'R1', at: Point = { x: 10, y: 10 }): ComponentInst {
  return comp(refdes, at, [
    smdPad('1', { x: -0.75, y: 0 }, { w: 0.8, h: 0.8 }),
    smdPad('2', { x: 0.75, y: 0 }, { w: 0.8, h: 0.8 }),
  ]);
}

/** Portrait part: pads at y = ±2, 0.8x0.8 -> body 0.8 wide x 4.8 tall. */
function portrait(refdes = 'U9', at: Point = { x: 5, y: 5 }): ComponentInst {
  return comp(refdes, at, [
    smdPad('1', { x: 0, y: -2 }, { w: 0.8, h: 0.8 }),
    smdPad('2', { x: 0, y: 2 }, { w: 0.8, h: 0.8 }),
  ]);
}

describe('componentBodyBBox', () => {
  it('unions courtyard, pads, and silk extents in world space', () => {
    const c = comp('C1', { x: 3, y: 4 }, [smdPad('1', { x: 0, y: 0 })], {
      footprintOverrides: {
        courtyard: [
          [
            { x: -2, y: -1 },
            { x: 2, y: -1 },
            { x: 2, y: 1 },
            { x: -2, y: 1 },
          ],
        ],
        silk: [{ kind: 'line', start: { x: 0, y: -3 }, end: { x: 0, y: 3 }, width: 0.15 }],
      },
    });
    expect(componentBodyBBox(c)).toEqual({ minX: 1, minY: 1, maxX: 5, maxY: 7 });
  });

  it('falls back to the component origin for an empty footprint', () => {
    const c = comp('X1', { x: 7, y: 8 }, []);
    expect(componentBodyBBox(c)).toEqual({ minX: 7, minY: 8, maxX: 7, maxY: 8 });
  });
});

describe('componentLabelPlacement', () => {
  it('places a landscape part label BELOW the body, horizontally centered, with the gap', () => {
    const p = componentLabelPlacement(landscape());
    // body: x 8.85..11.15, y 9.6..10.4
    expect(p.position).toBe('below');
    expect(p.at.x).toBeCloseTo(10);
    expect(p.at.y).toBeCloseTo(9.6 - COMPONENT_LABEL_GAP_MM - COMPONENT_LABEL_HEIGHT_MM / 2);
    expect(p.rotation).toBe(0);
    expect(p.height).toBe(COMPONENT_LABEL_HEIGHT_MM);
  });

  it('places a portrait part (h > 1.5w) label to the RIGHT, vertically centered', () => {
    const p = componentLabelPlacement(portrait());
    // body: x 4.6..5.4, y 2.6..7.4; label width = 2 chars * advance * height
    const w = 2 * COMPONENT_LABEL_CHAR_ADVANCE * COMPONENT_LABEL_HEIGHT_MM;
    expect(p.position).toBe('right');
    expect(p.at.x).toBeCloseTo(5.4 + COMPONENT_LABEL_GAP_MM + w / 2);
    expect(p.at.y).toBeCloseTo(5);
    expect(p.width).toBeCloseTo(w);
  });

  it('mirrors a bottom-side portrait label to the world LEFT (reads right in bottom view)', () => {
    const p = componentLabelPlacement(portrait('U9', { x: 5, y: 5 }));
    const pb = componentLabelPlacement({ ...portrait('U9', { x: 5, y: 5 }), side: 'bottom' });
    const w = 2 * COMPONENT_LABEL_CHAR_ADVANCE * COMPONENT_LABEL_HEIGHT_MM;
    expect(pb.position).toBe('left');
    expect(pb.at.x).toBeCloseTo(4.6 - COMPONENT_LABEL_GAP_MM - w / 2);
    expect(pb.at.y).toBeCloseTo(p.at.y);
  });

  it('keeps a bottom-side landscape label below (below is x-mirror invariant)', () => {
    const p = componentLabelPlacement({ ...landscape(), side: 'bottom' });
    expect(p.position).toBe('below');
    expect(p.at.x).toBeCloseTo(10);
    expect(p.at.y).toBeCloseTo(9.6 - COMPONENT_LABEL_GAP_MM - COMPONENT_LABEL_HEIGHT_MM / 2);
  });

  it('follows the world-space box of a rotated part (landscape rotated 90 becomes portrait)', () => {
    const p = componentLabelPlacement({ ...landscape(), rotation: 90 });
    // rotated body: x 9.6..10.4, y 8.85..11.15 -> portrait -> right
    expect(p.position).toBe('right');
    expect(p.at.y).toBeCloseTo(10);
    expect(p.at.x).toBeGreaterThan(10.4);
  });

  it('never overlaps the component body box', () => {
    for (const c of [landscape(), portrait(), { ...landscape(), rotation: 45 }]) {
      const box = componentBodyBBox(c);
      const rect = componentLabelRect(c);
      const rMaxY = Math.max(...rect.map((q) => q.y));
      const rMinX = Math.min(...rect.map((q) => q.x));
      const rMaxX = Math.max(...rect.map((q) => q.x));
      const outside = rMaxY <= box.minY || rMinX >= box.maxX || rMaxX <= box.minX;
      expect(outside).toBe(true);
    }
  });
});

describe('componentLabelPlacement - board-aware collision avoidance', () => {
  function boardWith(...comps: ComponentInst[]): Board {
    const b = newBoard('t', 2);
    b.components.push(...comps);
    return b;
  }

  it('keeps the label below when nothing is in the way (agrees with the c-only overload)', () => {
    const c = landscape();
    const p = componentLabelPlacement(boardWith(c), c);
    expect(p).toEqual(componentLabelPlacement(c));
    expect(p.position).toBe('below');
  });

  it('a neighbor pad below forces the label to the RIGHT', () => {
    const c = landscape('R1', { x: 10, y: 10 }); // below-label rect: x 9.1..10.9, y 8.3..9.3
    const blocker = comp('C9', { x: 10, y: 8.8 }, [smdPad('1', { x: 0, y: 0 })]);
    const p = componentLabelPlacement(boardWith(c, blocker), c);
    expect(p.position).toBe('right');
    // right candidate: x = bodyMaxX + gap + width/2, vertically centered
    expect(p.at.x).toBeCloseTo(11.15 + COMPONENT_LABEL_GAP_MM + p.width / 2);
    expect(p.at.y).toBeCloseTo(10);
  });

  it('falls back to the geometric default (below) when every candidate collides', () => {
    const c = landscape('R1', { x: 10, y: 10 });
    // A big courtyard that swallows R1 and every candidate label position, so
    // no side/gap escapes it: all candidates score equal and the least-bad
    // pick is the preferred geometric default (below).
    const blocker = comp('U8', { x: 10, y: 10 }, [smdPad('1', { x: 0, y: 0 })], {
      footprintOverrides: {
        courtyard: [
          [
            { x: -5, y: -5 },
            { x: 5, y: -5 },
            { x: 5, y: 5 },
            { x: -5, y: 5 },
          ],
        ],
      },
    });
    const p = componentLabelPlacement(boardWith(c, blocker), c);
    expect(p.position).toBe('below');
    expect(p).toEqual(componentLabelPlacement(c));
  });

  it('pushes a label back inside the board outline when the default leaves it', () => {
    // Landscape part hugging the bottom edge: its default "below" label would
    // hang off the board. The solver must pick a candidate whose rect stays in.
    const b = newBoard('t', 2);
    b.outline = [
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
      { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
      { type: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 } },
      { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
    ];
    const c = landscape('R1', { x: 10, y: 0.9 }); // body y 0.5..1.3, near bottom edge
    b.components.push(c);
    const poly = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    const rect = componentLabelRect(b, c);
    for (const corner of rect) {
      expect(pointInPolygon(corner, poly)).toBe(true);
    }
    // The plain default would sit below the edge (outside).
    const naive = componentLabelRect(c);
    expect(naive.some((p) => !pointInPolygon(p, poly))).toBe(true);
  });

  it('gives two adjacent components non-overlapping label rects', () => {
    // Two landscape parts stacked close vertically: both default to "below",
    // which would collide. Label-label dodging must separate them.
    const a = landscape('R1', { x: 10, y: 10 });
    const d = landscape('R2', { x: 10, y: 8.5 });
    const b = boardWith(a, d);
    const ra = componentLabelRect(b, a);
    const rb = componentLabelRect(b, d);
    const bbA = { minX: Math.min(...ra.map((p) => p.x)), maxX: Math.max(...ra.map((p) => p.x)), minY: Math.min(...ra.map((p) => p.y)), maxY: Math.max(...ra.map((p) => p.y)) };
    const bbB = { minX: Math.min(...rb.map((p) => p.x)), maxX: Math.max(...rb.map((p) => p.x)), minY: Math.min(...rb.map((p) => p.y)), maxY: Math.max(...rb.map((p) => p.y)) };
    const overlap = bbA.minX < bbB.maxX && bbA.maxX > bbB.minX && bbA.minY < bbB.maxY && bbA.maxY > bbB.minY;
    expect(overlap).toBe(false);
  });

  it('does not place a label over a neighboring component courtyard', () => {
    // Neighbor with a courtyard sitting just below R1, where R1's default
    // "below" label would land. The label must move off that courtyard.
    const c = landscape('R1', { x: 10, y: 10 });
    const neighbor = comp('U2', { x: 10, y: 8.6 }, [smdPad('1', { x: 0, y: 0 })], {
      footprintOverrides: {
        courtyard: [
          [
            { x: -1.5, y: -0.8 },
            { x: 1.5, y: -0.8 },
            { x: 1.5, y: 0.8 },
            { x: -1.5, y: 0.8 },
          ],
        ],
      },
    });
    const b = boardWith(c, neighbor);
    const rect = componentLabelRect(b, c);
    const rb = { minX: Math.min(...rect.map((p) => p.x)), maxX: Math.max(...rect.map((p) => p.x)), minY: Math.min(...rect.map((p) => p.y)), maxY: Math.max(...rect.map((p) => p.y)) };
    // Neighbor courtyard world box: x 8.5..11.5, y 7.8..9.4.
    const court = { minX: 8.5, maxX: 11.5, minY: 7.8, maxY: 9.4 };
    const overlap = rb.minX < court.maxX && rb.maxX > court.minX && rb.minY < court.maxY && rb.maxY > court.minY;
    expect(overlap).toBe(false);
  });

  it('board-aware rect matches the board-aware placement', () => {
    const c = landscape('R1', { x: 10, y: 10 });
    const blocker = comp('C9', { x: 10, y: 8.8 }, [smdPad('1', { x: 0, y: 0 })]);
    const b = boardWith(c, blocker);
    const p = componentLabelPlacement(b, c);
    const rect = componentLabelRect(b, c);
    expect(Math.min(...rect.map((q) => q.x))).toBeCloseTo(p.at.x - p.width / 2);
    expect(Math.max(...rect.map((q) => q.y))).toBeCloseTo(p.at.y + p.height / 2);
  });
});

describe('componentLabelRect', () => {
  it('is the axis-aligned width x height box centered on the placement anchor', () => {
    const c = landscape('R15'); // 3 chars
    const p = componentLabelPlacement(c);
    const rect = componentLabelRect(c);
    const w = 3 * COMPONENT_LABEL_CHAR_ADVANCE * COMPONENT_LABEL_HEIGHT_MM;
    expect(rect).toHaveLength(4);
    expect(Math.min(...rect.map((q) => q.x))).toBeCloseTo(p.at.x - w / 2);
    expect(Math.max(...rect.map((q) => q.x))).toBeCloseTo(p.at.x + w / 2);
    expect(Math.min(...rect.map((q) => q.y))).toBeCloseTo(p.at.y - COMPONENT_LABEL_HEIGHT_MM / 2);
    expect(Math.max(...rect.map((q) => q.y))).toBeCloseTo(p.at.y + COMPONENT_LABEL_HEIGHT_MM / 2);
  });
});
