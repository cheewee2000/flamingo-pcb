import { describe, it, expect } from 'vitest';
import {
  applyOp,
  fillShapes,
  newBoard,
  rotateSilkGroup,
  scaleSilkGroupFromCorner,
  silkGroupCenter,
  silkGroupCorners,
  silkGroupSize,
  silkGroupToLocal,
  silkGroupToWorld,
  svgToSilk,
} from '../src/index.js';
import type { Board, OpResult, Point, SilkGroup } from '../src/index.js';

const sq = (cx: number, cy: number, h: number): Point[] => [
  { x: cx - h, y: cy - h },
  { x: cx + h, y: cy - h },
  { x: cx + h, y: cy + h },
  { x: cx - h, y: cy + h },
];

function group(over: Partial<SilkGroup> = {}): SilkGroup {
  return {
    id: 'G',
    name: 'g',
    layer: 'F.Silk',
    at: { x: 10, y: 20 },
    rotation: 30,
    scale: 2,
    mirror: true,
    fills: [[sq(0, 0, 2)]],
    lines: [],
    texts: [],
    ...over,
  };
}

const close = (a: Point, b: Point, eps = 1e-6): void => {
  expect(a.x).toBeCloseTo(b.x, 5);
  expect(a.y).toBeCloseTo(b.y, 5);
  void eps;
};

function apply(b: Board, op: Parameters<typeof applyOp>[1]): OpResult {
  const r = applyOp(b, op);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('silk group transform', () => {
  it('toLocal inverts toWorld under rotation, scale and mirror', () => {
    const g = group();
    for (const p of [{ x: 1, y: 2 }, { x: -3, y: 0.5 }]) close(silkGroupToLocal(g, silkGroupToWorld(g, p)), p);
  });

  it('mirror flips local x before scaling and rotating', () => {
    const g = group({ rotation: 0, scale: 1, at: { x: 0, y: 0 } });
    close(silkGroupToWorld(g, { x: 1, y: 0 }), { x: -1, y: 0 });
  });

  it('size and centre follow scale and position', () => {
    const g = group({ rotation: 0, mirror: false });
    expect(silkGroupSize(g)).toEqual({ width: 8, height: 8 });
    close(silkGroupCenter(g), { x: 10, y: 20 });
  });
});

describe('silk group gestures', () => {
  it('corner resize keeps the opposite corner fixed and locks aspect', () => {
    const g = group();
    const before = silkGroupCorners(g);
    const grabbed = before[2]!;
    const anchor = before[0]!;
    // Drag the grabbed corner to twice its distance from the anchor.
    const target = { x: anchor.x + 2 * (grabbed.x - anchor.x), y: anchor.y + 2 * (grabbed.y - anchor.y) };
    const t = scaleSilkGroupFromCorner(g, 2, target);
    expect(t.scale).toBeCloseTo(4);
    const after = silkGroupCorners({ ...g, ...t });
    close(after[0]!, anchor);
    close(after[2]!, target);
  });

  it('rotate turns about the bounding-box centre', () => {
    const g = group({ fills: [[sq(3, 1, 1)]] });
    const c = silkGroupCenter(g);
    const from = { x: c.x + 5, y: c.y };
    const to = { x: c.x, y: c.y + 5 };
    const t = rotateSilkGroup(g, from, to);
    expect(t.rotation).toBeCloseTo(120);
    close(silkGroupCenter({ ...g, ...t }), c);
    expect(rotateSilkGroup(g, from, { x: c.x + 5, y: c.y + 0.6 }, 15).rotation).toBeCloseTo(30);
  });
});

describe('fillShapes (even-odd nesting)', () => {
  it('turns square / hole / island into two solid shapes, outermost first', () => {
    const shapes = fillShapes([sq(0, 0, 1), sq(0, 0, 5), sq(0, 0, 3)]);
    expect(shapes).toHaveLength(2);
    expect(shapes[0]!.depth).toBe(0);
    expect(shapes[0]!.holes).toHaveLength(1);
    expect(shapes[1]!.depth).toBe(2);
    expect(shapes[1]!.holes).toHaveLength(0);
  });
});

describe('svgToSilk', () => {
  it('reads a compound path as one even-odd fill, scaled to width and flipped to y-up', () => {
    const svg = '<svg viewBox="0 0 20 10"><path d="M0 0H20V10H0Z M5 2h10v6h-10z"/><rect x="0" y="0" width="1" height="1" fill="#fff"/></svg>';
    const r = svgToSilk(svg, { width: 40 });
    expect(r.width).toBeCloseTo(40);
    expect(r.height).toBeCloseTo(20);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]).toHaveLength(2);
    expect(r.warnings.join(' ')).toMatch(/white/);
    // The SVG's top edge (y=0) is the board's +y side.
    const ys = r.fills[0]![0]!.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(10);
  });

  it('applies group transforms, class styles, and turns strokes into lines', () => {
    const svg = `<svg><style>.ink{fill:none;stroke:#000;stroke-width:2}</style>
      <g transform="translate(10 0) scale(2)"><line class="ink" x1="0" y1="0" x2="5" y2="0"/></g>
      <circle cx="0" cy="20" r="5" fill="black"/></svg>`;
    const r = svgToSilk(svg, { height: 10 });
    expect(r.lines.length).toBe(1);
    expect(r.fills.length).toBe(1);
    const l = r.lines[0]!;
    // Line is 10 user units long (5 * scale 2) and 4 wide (2 * scale 2). The
    // drawing spans y -2 (stroke half-width) .. 25 (circle bottom) = 27 units,
    // scaled to 10 mm.
    expect(Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y)).toBeCloseTo(100 / 27, 3);
    expect(l.width).toBeCloseTo(40 / 27, 3);
  });

  it('flattens arcs and relative/implicit commands', () => {
    const r = svgToSilk('<svg><path d="M0 0 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 z"/></svg>', { width: 10 });
    const ring = r.fills[0]![0]!;
    expect(ring.length).toBeGreaterThan(16);
    for (const p of ring) expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 1);
  });

  it('warns about text and throws when nothing is drawable', () => {
    expect(() => svgToSilk('<svg><text x="0" y="0">hi</text></svg>')).toThrow(/convert text to outlines/);
  });
});

describe('silk group ops', () => {
  function board(): Board {
    const b = newBoard('t', 2);
    b.silk.push({ id: 'T', layer: 'F.Silk', at: { x: 4, y: 4 }, text: 'HI', height: 1, rotation: 0 });
    b.silkLines.push({ id: 'L', layer: 'F.Silk', start: { x: 0, y: 0 }, end: { x: 8, y: 0 }, width: 0.2 });
    b.silkLines.push({ id: 'B', layer: 'B.Silk', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 0.2 });
    return b;
  }

  it('groupSilk combines loose items around their centre; ungroupSilk restores them in place', () => {
    const r = apply(board(), { op: 'groupSilk', ids: ['T', 'L'], name: 'badge' });
    const g = r.board.silkGroups![0]!;
    expect(r.board.silk).toHaveLength(0);
    expect(r.board.silkLines.map((l) => l.id)).toEqual(['B']);
    expect(g.name).toBe('badge');
    const moved = apply(r.board, { op: 'editSilkGroup', id: g.id, group: { at: { x: g.at.x + 1, y: g.at.y } } });
    const u = apply(moved.board, { op: 'ungroupSilk', id: g.id });
    expect(u.board.silkGroups).toHaveLength(0);
    close(u.board.silk[0]!.at, { x: 5, y: 4 });
    const line = u.board.silkLines.find((l) => l.id !== 'B')!;
    close(line.start, { x: 1, y: 0 });
    close(line.end, { x: 9, y: 0 });
  });

  it('refuses to group across layers, and rejects bad edits', () => {
    expect(applyOp(board(), { op: 'groupSilk', ids: ['L', 'B'] }).ok).toBe(false);
    const r = apply(board(), { op: 'groupSilk', ids: ['T'] });
    const id = r.board.silkGroups![0]!.id;
    expect(applyOp(r.board, { op: 'editSilkGroup', id, group: { scale: 0 } }).ok).toBe(false);
    expect(applyOp(r.board, { op: 'editSilkGroup', id, group: { texts: [{ text: ' ', at: { x: 0, y: 0 }, height: 1, rotation: 0 }] } }).ok).toBe(false);
  });

  it('removeItem deletes a group, and ungrouping a fill keeps it as its own group', () => {
    const b = newBoard('t', 2);
    const added = apply(b, {
      op: 'addSilkGroup',
      group: { name: 'art', layer: 'F.Silk', at: { x: 0, y: 0 }, rotation: 0, scale: 1, fills: [[sq(0, 0, 1)], [sq(5, 0, 1)]], lines: [], texts: [] },
    });
    const id = added.createdIds[0]!;
    const split = apply(added.board, { op: 'ungroupSilk', id });
    expect(split.board.silkGroups).toHaveLength(2);
    expect(apply(added.board, { op: 'removeItem', id }).board.silkGroups).toHaveLength(0);
  });
});
