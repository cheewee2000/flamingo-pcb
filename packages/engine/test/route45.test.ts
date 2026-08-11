import { describe, it, expect } from 'vitest';
import { route45 } from '../src/reroute.js';

const L = (x0: number, y0: number, x1: number, y1: number) =>
  ({ type: 'line', start: { x: x0, y: y0 }, end: { x: x1, y: y1 } });

describe('route45', () => {
  it('is empty for a degenerate move', () => {
    expect(route45({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([]);
  });
  it('is one segment for a horizontal move', () => {
    expect(route45({ x: 0, y: 0 }, { x: 5, y: 0 })).toEqual([L(0, 0, 5, 0)]);
  });
  it('is one segment for a vertical move', () => {
    expect(route45({ x: 0, y: 0 }, { x: 0, y: -3 })).toEqual([L(0, 0, 0, -3)]);
  });
  it('is one segment for an exact diagonal', () => {
    expect(route45({ x: 0, y: 0 }, { x: 4, y: 4 })).toEqual([L(0, 0, 4, 4)]);
  });
  it('diag-first elbow: wider-than-tall goes diagonal then horizontal', () => {
    // dx=5, dy=2 -> diagonal covers 2, then horizontal covers 3
    expect(route45({ x: 0, y: 0 }, { x: 5, y: 2 }, { diagFirst: true })).toEqual([
      L(0, 0, 2, 2), L(2, 2, 5, 2),
    ]);
  });
  it('axis-first elbow: wider-than-tall goes horizontal then diagonal', () => {
    // dx=5, dy=2 -> horizontal covers 3, then diagonal covers 2
    expect(route45({ x: 0, y: 0 }, { x: 5, y: 2 }, { diagFirst: false })).toEqual([
      L(0, 0, 3, 0), L(3, 0, 5, 2),
    ]);
  });
  it('handles negative directions (taller-than-wide, diag-first)', () => {
    // dx=-2, dy=-5 -> diagonal covers 2, then vertical covers 3
    expect(route45({ x: 0, y: 0 }, { x: -2, y: -5 }, { diagFirst: true })).toEqual([
      L(0, 0, -2, -2), L(-2, -2, -2, -5),
    ]);
  });
  it('axis-first elbow: taller-than-wide goes vertical then diagonal', () => {
    // dx=2, dy=5, diagFirst:false -> vertical covers 3, then diagonal covers 2
    expect(route45({ x: 0, y: 0 }, { x: 2, y: 5 }, { diagFirst: false })).toEqual([
      L(0, 0, 0, 3), L(0, 3, 2, 5),
    ]);
  });
  it('axis-first elbow: taller-than-wide, negative directions', () => {
    // dx=-2, dy=-5, diagFirst:false -> vertical covers -3, then diagonal covers -2
    expect(route45({ x: 0, y: 0 }, { x: -2, y: -5 }, { diagFirst: false })).toEqual([
      L(0, 0, 0, -3), L(0, -3, -2, -5),
    ]);
  });
});
