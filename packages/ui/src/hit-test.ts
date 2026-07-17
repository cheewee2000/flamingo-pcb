/**
 * Flamingo UI - hit-testing.
 *
 * Two flavors, both operating on world-space (mm) points with a
 * zoom-dependent tolerance (screen-px tolerance / scale, so clicks stay
 * forgiving at low zoom):
 *
 * - `hitTest`: pad/track/via only, used for hover status-bar text and for
 *   the net-highlight-on-click behavior from Task 9 (preserved unchanged --
 *   `tools/select.ts` still calls this so clicking a pad/track/via keeps
 *   toggling `selectedNet` exactly as before editing tools existed).
 * - `hitEditTarget` / `hitTrackOrVia`: broader item-level hit-testing for
 *   the editing tools (select's move/rotate/flip/delete target, ripup's
 *   track/via target). Component hits take priority (a click anywhere on a
 *   pad or inside the courtyard selects the whole component).
 */

import type { Board, ComponentInst, Point, Track, Via } from '@flamingo/engine';
import { componentTransformPoints, dist, padOutline, pointInPolygon, pointSegDistance } from '@flamingo/engine';
import type { HitInfo } from './state.js';

const TOLERANCE_PX = 4;

function findNet(board: Board, refdes: string, padNumber: string): string | undefined {
  const ref = `${refdes}.${padNumber}`;
  return board.nets.find((n) => n.pins.includes(ref))?.name;
}

/** Nearest pad (point-in-polygon) / track (distance-to-segment) / via (distance-to-center) under `world`. */
export function hitTest(board: Board, world: Point, scale: number): HitInfo | null {
  const tolMm = TOLERANCE_PX / scale;
  let best: { score: number; hit: HitInfo } | null = null;

  function consider(score: number, hit: HitInfo): void {
    if (!best || score < best.score) best = { score, hit };
  }

  for (const c of board.components as ComponentInst[]) {
    for (const pad of c.footprint.pads) {
      const outline = padOutline(c, pad);
      const inside = pointInPolygon(world, outline);
      let edgeDist = Infinity;
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i];
        const b = outline[(i + 1) % outline.length];
        edgeDist = Math.min(edgeDist, pointSegDistance(world, { type: 'line', start: a, end: b }));
      }
      if (inside || edgeDist < tolMm) {
        const net = findNet(board, c.refdes, pad.number);
        if (net) consider(inside ? 0 : edgeDist, { kind: 'pad', refdes: c.refdes, padNumber: pad.number, net });
      }
    }
  }

  for (const t of board.tracks as Track[]) {
    const d = pointSegDistance(world, t.seg);
    if (d < t.width / 2 + tolMm) {
      consider(Math.max(0, d - t.width / 2), { kind: 'track', id: t.id, net: t.net });
    }
  }

  for (const v of board.vias as Via[]) {
    const d = dist(world, v.at);
    if (d < v.diameter / 2 + tolMm) {
      consider(Math.max(0, d - v.diameter / 2), { kind: 'via', id: v.id, net: v.net });
    }
  }

  return best ? (best as { score: number; hit: HitInfo }).hit : null;
}

/** Union of every board item the editing tools can select/act on. */
export type EditTarget =
  | { kind: 'component'; refdes: string }
  | { kind: 'track'; id: string; net: string }
  | { kind: 'via'; id: string; net: string }
  | { kind: 'zone'; id: string }
  | { kind: 'keepout'; id: string }
  | { kind: 'hole'; id: string }
  | { kind: 'silk'; id: string };

function componentContains(c: ComponentInst, world: Point): boolean {
  for (const pad of c.footprint.pads) {
    if (pointInPolygon(world, padOutline(c, pad))) return true;
  }
  for (const ring of c.footprint.courtyard) {
    if (ring.length < 3) continue;
    if (pointInPolygon(world, componentTransformPoints(c, ring))) return true;
  }
  return false;
}

/**
 * Broader item-level hit test for the editing tools: component (any pad or
 * courtyard ring contains the point) > track > via > zone > keepout > hole >
 * silk. Component hits intentionally shadow individual pads -- selecting a
 * part for move/rotate/flip/delete operates on the whole component.
 */
export function hitEditTarget(board: Board, world: Point, scale: number): EditTarget | null {
  const tolMm = TOLERANCE_PX / scale;

  for (const c of board.components) {
    if (componentContains(c, world)) return { kind: 'component', refdes: c.refdes };
  }
  const trackOrVia = hitTrackOrVia(board, world, scale);
  if (trackOrVia) return trackOrVia;
  for (const z of board.zones) {
    if (pointInPolygon(world, z.polygon)) return { kind: 'zone', id: z.id };
  }
  for (const k of board.keepouts) {
    if (pointInPolygon(world, k.polygon)) return { kind: 'keepout', id: k.id };
  }
  for (const h of board.holes) {
    if (dist(world, h.at) < h.padDiameter / 2 + tolMm) return { kind: 'hole', id: h.id };
  }
  for (const s of board.silk) {
    if (dist(world, s.at) < Math.max(s.height, 1) + tolMm) return { kind: 'silk', id: s.id };
  }
  return null;
}

/** Track/via-only hit test, used by ripup (which never acts on components/zones/etc). */
export function hitTrackOrVia(
  board: Board,
  world: Point,
  scale: number,
): { kind: 'track'; id: string; net: string } | { kind: 'via'; id: string; net: string } | null {
  const tolMm = TOLERANCE_PX / scale;
  for (const t of board.tracks) {
    const d = pointSegDistance(world, t.seg);
    if (d < t.width / 2 + tolMm) return { kind: 'track', id: t.id, net: t.net };
  }
  for (const v of board.vias) {
    if (dist(world, v.at) < v.diameter / 2 + tolMm) return { kind: 'via', id: v.id, net: v.net };
  }
  return null;
}
