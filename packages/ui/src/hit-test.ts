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
import {
  componentTransformPoints,
  copperLayersOf,
  dist,
  padCopperLayers,
  padOutline,
  pointInPolygon,
  pointSegDistance,
  holeSlotCenterline,
  silkGroupContains,
  silkGroupSize,
} from '@flamingo/engine';
import type { HitInfo, LayerKey } from './state.js';
import { DIMS_KEY, SILK_KEY, ZONES_KEY } from './state.js';
import { dimensionLine } from './renderer.js';

const TOLERANCE_PX = 4;

/**
 * Layer visibility (`AppState.layerVisibility`). When given, items on a
 * hidden or ghosted layer are not hit: what the viewer cannot see, they
 * cannot select, rip up or start a route from. Mirrors renderer.ts: tracks,
 * SMD pads and zones follow their copper layer; vias and through pads show
 * while any copper layer does; silk and dimensions follow their overlay.
 */
export type Visibility = Record<LayerKey, boolean>;

function shows(vis: Visibility | undefined, key: LayerKey): boolean {
  return !vis || vis[key] !== false;
}

function visibilityOf(board: Board, vis: Visibility | undefined) {
  // No visibility given: everything is hittable (and boards from tests may
  // lack a layer count), so skip the copper lookup.
  const copper = vis ? copperLayersOf(board) : [];
  const anyCopper = !vis || copper.some((l) => shows(vis, l));
  return {
    track: (t: Track) => shows(vis, t.layer),
    via: () => anyCopper,
    pad: (c: ComponentInst, pad: ComponentInst['footprint']['pads'][number]) =>
      !vis || padCopperLayers(pad, c.side, copper).some((l) => shows(vis, l)),
    zone: (layer: string) => shows(vis, ZONES_KEY) && shows(vis, layer),
    silk: shows(vis, SILK_KEY),
    dimension: shows(vis, DIMS_KEY),
  };
}

function findNet(board: Board, refdes: string, padNumber: string): string | undefined {
  const ref = `${refdes}.${padNumber}`;
  return board.nets.find((n) => n.pins.includes(ref))?.name;
}

/** Nearest pad (point-in-polygon) / track (distance-to-segment) / via (distance-to-center) under `world`. */
export function hitTest(board: Board, world: Point, scale: number, vis?: Visibility): HitInfo | null {
  const tolMm = TOLERANCE_PX / scale;
  const shown = visibilityOf(board, vis);
  let best: { score: number; hit: HitInfo } | null = null;

  function consider(score: number, hit: HitInfo): void {
    if (!best || score < best.score) best = { score, hit };
  }

  for (const c of board.components as ComponentInst[]) {
    for (const pad of c.footprint.pads) {
      if (!shown.pad(c, pad)) continue;
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
    if (!shown.track(t)) continue;
    const d = pointSegDistance(world, t.seg);
    if (d < t.width / 2 + tolMm) {
      consider(Math.max(0, d - t.width / 2), { kind: 'track', id: t.id, net: t.net });
    }
  }

  for (const v of board.vias as Via[]) {
    if (!shown.via()) break;
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
  | { kind: 'silk'; id: string }
  | { kind: 'silkLine'; id: string }
  | { kind: 'silkGroup'; id: string }
  | { kind: 'dimension'; id: string };

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
 * courtyard ring contains the point) > track > via > hole > silk > dimension
 * > keepout > zone. Small/point-like items come before area items on purpose:
 * a full-board copper pour or a keepout rectangle would otherwise shadow
 * every hole, slot, and annotation inside it. Component hits intentionally
 * shadow individual pads -- selecting a part for move/rotate/flip/delete
 * operates on the whole component.
 */
export function hitEditTarget(board: Board, world: Point, scale: number, vis?: Visibility): EditTarget | null {
  return hitEditTargets(board, world, scale, vis)[0] ?? null;
}

/**
 * ALL edit targets under `world`, in priority order. The select tool cycles
 * through this list on repeated clicks, so items stacked under a bigger item
 * (a keepout under its slot, a zone under everything) stay reachable.
 */
export function hitEditTargets(board: Board, world: Point, scale: number, vis?: Visibility): EditTarget[] {
  const tolMm = TOLERANCE_PX / scale;
  const shown = visibilityOf(board, vis);
  const hits: EditTarget[] = [];

  for (const c of board.components) {
    if (componentContains(c, world)) hits.push({ kind: 'component', refdes: c.refdes });
  }
  for (const t of board.tracks) {
    if (!shown.track(t)) continue;
    if (pointSegDistance(world, t.seg) < t.width / 2 + tolMm) hits.push({ kind: 'track', id: t.id, net: t.net });
  }
  for (const v of shown.via() ? board.vias : []) {
    if (dist(world, v.at) < v.diameter / 2 + tolMm) hits.push({ kind: 'via', id: v.id, net: v.net });
  }
  for (const h of board.holes) {
    const { start, end } = holeSlotCenterline(h);
    if (pointSegDistance(world, { type: 'line', start, end }) < Math.max(h.padDiameter, h.drill) / 2 + tolMm) {
      hits.push({ kind: 'hole', id: h.id });
    }
  }
  for (const s of shown.silk ? board.silk : []) {
    if (dist(world, s.at) < Math.max(s.height, 1) + tolMm) hits.push({ kind: 'silk', id: s.id });
  }
  for (const l of shown.silk ? (board.silkLines ?? []) : []) {
    if (pointSegDistance(world, { type: 'line', start: l.start, end: l.end }) < l.width / 2 + tolMm) {
      hits.push({ kind: 'silkLine', id: l.id });
    }
  }
  // Groups hit anywhere inside their (rotated) bounding box, smallest first so
  // a small graphic sitting on a big one stays reachable.
  const groups = shown.silk ? [...(board.silkGroups ?? [])] : [];
  groups.sort((a, b) => groupArea(a) - groupArea(b));
  for (const g of groups) {
    if (silkGroupContains(g, world, tolMm)) hits.push({ kind: 'silkGroup', id: g.id });
  }
  for (const dim of shown.dimension ? board.dimensions : []) {
    const line = dimensionLine(dim.a, dim.b, dim.offset);
    if (!line) continue;
    if (pointSegDistance(world, { type: 'line', start: line.A, end: line.B }) < 0.5 + tolMm) {
      hits.push({ kind: 'dimension', id: dim.id });
    }
  }
  for (const k of board.keepouts) {
    if (pointInPolygon(world, k.polygon)) hits.push({ kind: 'keepout', id: k.id });
  }
  // Zones hit on their outline only. A pour is usually a board-sized
  // rectangle, so containment would make every click on empty board select
  // a pour -- and Delete then silently removes the plane (lost three pours on
  // rt-v3.1, 2026-10-15).
  for (const z of board.zones) {
    if (!shown.zone(z.layer)) continue;
    if (nearPolygonEdge(world, z.polygon, tolMm)) hits.push({ kind: 'zone', id: z.id });
  }
  return hits;
}

function groupArea(g: NonNullable<Board['silkGroups']>[number]): number {
  const { width, height } = silkGroupSize(g);
  return width * height;
}

/** True when `p` is within `tol` of any edge of the polygon. */
function nearPolygonEdge(p: Point, poly: Point[], tol: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const start = poly[i]!;
    const end = poly[(i + 1) % poly.length]!;
    if (pointSegDistance(p, { type: 'line', start, end }) < tol) return true;
  }
  return false;
}

/** True when two edit targets refer to the same board item. */
export function sameEditTarget(a: EditTarget, b: EditTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'component') return b.kind === 'component' && a.refdes === b.refdes;
  return 'id' in b && a.id === b.id;
}

/** Track/via-only hit test, used by ripup (which never acts on components/zones/etc). */
export function hitTrackOrVia(
  board: Board,
  world: Point,
  scale: number,
  vis?: Visibility,
): { kind: 'track'; id: string; net: string } | { kind: 'via'; id: string; net: string } | null {
  const tolMm = TOLERANCE_PX / scale;
  const shown = visibilityOf(board, vis);
  for (const t of board.tracks) {
    if (!shown.track(t)) continue;
    const d = pointSegDistance(world, t.seg);
    if (d < t.width / 2 + tolMm) return { kind: 'track', id: t.id, net: t.net };
  }
  for (const v of shown.via() ? board.vias : []) {
    if (dist(world, v.at) < v.diameter / 2 + tolMm) return { kind: 'via', id: v.id, net: v.net };
  }
  return null;
}
