/**
 * 45°/octilinear rubber-band geometry for interactive drag (push-and-shove
 * Phase 1). Pure and DOM-free so it runs both in the engine op layer and live
 * in the UI during a drag. Lines only — arc segments are left untouched.
 */

import type { Point, PathSeg } from './types.js';

const line = (start: Point, end: Point): PathSeg => ({ type: 'line', start, end });
const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

/**
 * A ≤2-segment 45° line path from `from` to `to`:
 *  - from≈to           -> [] (caller drops the zero-length track)
 *  - axis-aligned/exact diagonal -> one segment
 *  - otherwise         -> an elbow (diagonal leg + axis leg). `diagFirst`
 *    (default true) puts the 45° leg adjacent to `from`.
 */
export function route45(from: Point, to: Point, opts?: { diagFirst?: boolean }): PathSeg[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return [];
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (dx === 0 || dy === 0 || adx === ady) return [line(from, to)];

  const sx = sign(dx);
  const sy = sign(dy);
  const diagLen = Math.min(adx, ady);
  const diagFirst = opts?.diagFirst ?? true;

  let corner: Point;
  if (diagFirst) {
    corner = { x: from.x + sx * diagLen, y: from.y + sy * diagLen };
  } else if (adx > ady) {
    corner = { x: from.x + sx * (adx - ady), y: from.y }; // horizontal leg first
  } else {
    corner = { x: from.x, y: from.y + sy * (ady - adx) }; // vertical leg first
  }
  return [line(from, corner), line(corner, to)];
}
