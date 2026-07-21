/**
 * 45°/octilinear rubber-band geometry for interactive drag (push-and-shove
 * Phase 1). Pure and DOM-free so it runs both in the engine op layer and live
 * in the UI during a drag. Lines only — arc segments are left untouched.
 */

import type { Board, Point, PathSeg, Track } from './types.js';
import { tracksAtPoint } from './connectivity.js';

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

const add = (p: Point, d: Point): Point => ({ x: p.x + d.x, y: p.y + d.y });

/**
 * Reshape the line tracks named in `moves` so each moved endpoint follows to
 * its `newAt`, re-solving the whole segment on 45° via route45 (far endpoint
 * fixed). Moves are grouped by track, so a segment whose BOTH ends move is
 * solved once from new-start to new-end. Arc tracks are skipped; a degenerate
 * (zero-length) result removes the track and adds nothing.
 */
export function rubberBandReshape(
  b: Board,
  moves: { trackId: string; end: 'start' | 'end'; newAt: Point }[],
): { removeIds: string[]; add: Omit<Track, 'id'>[] } {
  const byTrack = new Map<string, { start?: Point; end?: Point }>();
  for (const m of moves) {
    const e = byTrack.get(m.trackId) ?? {};
    e[m.end] = m.newAt;
    byTrack.set(m.trackId, e);
  }
  const removeIds: string[] = [];
  const added: Omit<Track, 'id'>[] = [];
  for (const [trackId, ends] of byTrack) {
    const t = b.tracks.find((x) => x.id === trackId);
    if (!t || t.seg.type !== 'line') continue; // missing or arc -> skip
    const newStart = ends.start ?? t.seg.start;
    const newEnd = ends.end ?? t.seg.end;
    // When only one endpoint moved, route45 from the fixed (unmoved) endpoint
    // toward the moved one, so the diagonal leg lands adjacent to the anchor.
    // When both (or neither) moved, solve in natural start->end order.
    const onlyStartMoved = ends.start !== undefined && ends.end === undefined;
    const from = onlyStartMoved ? newEnd : newStart;
    const to = onlyStartMoved ? newStart : newEnd;
    removeIds.push(t.id);
    for (const seg of route45(from, to)) {
      added.push({ layer: t.layer, width: t.width, net: t.net, seg });
    }
  }
  return { removeIds, add: added };
}

/**
 * Translate one line track by `delta` and re-solve the neighbor line segments
 * at each of its (pre-move) endpoints so they stay attached, on 45°. Returns
 * the atomic edit (the dragged track is replaced by its translated self, plus
 * the neighbor reshapes). Arc neighbors are left in place.
 */
export function dragSegmentReshape(
  b: Board,
  trackId: string,
  delta: Point,
): { removeIds: string[]; add: Omit<Track, 'id'>[] } {
  const t = b.tracks.find((x) => x.id === trackId);
  if (!t || t.seg.type !== 'line') return { removeIds: [], add: [] };
  const a = t.seg.start;
  const bEnd = t.seg.end;
  const aNew = add(a, delta);
  const bNew = add(bEnd, delta);

  const moves: { trackId: string; end: 'start' | 'end'; newAt: Point }[] = [];
  for (const hit of tracksAtPoint(b, a, t.layer, t.net)) {
    if (hit.trackId !== trackId) moves.push({ ...hit, newAt: aNew });
  }
  for (const hit of tracksAtPoint(b, bEnd, t.layer, t.net)) {
    if (hit.trackId !== trackId) moves.push({ ...hit, newAt: bNew });
  }
  const res = rubberBandReshape(b, moves);
  res.removeIds.push(t.id);
  res.add.push({ layer: t.layer, width: t.width, net: t.net, seg: line(aNew, bNew) });
  return res;
}
