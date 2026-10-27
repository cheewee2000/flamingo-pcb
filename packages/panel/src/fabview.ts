/**
 * Flamingo Panel - the fabricated view.
 *
 * What comes back from the fab, drawn from the geometry: the laminate that is
 * left once the router has cut the profile, the holes drilled through it
 * (mouse bites, tooling holes), the bare-copper fiducials, the V-cut scores
 * and silkscreen dividers. Colour here means material, not design.
 *
 * `fabScene` reduces a geometry to those primitives, in panel mm; the SVG
 * render (node/render.ts) and the browser canvas (ui/src/panel/draw.ts) both
 * draw from it, so the two pictures cannot drift apart.
 */

import type { Point } from '@flamingo/engine';
import type { PanelGeometry } from './geometry.js';
import type { Box, PanelSettings } from './types.js';

/** Colours of the fabricated view. */
export const FAB_COLORS = {
  /** Green solder mask over the laminate: boards, tabs and rails alike. */
  mask: '#1f6b3d',
  /** Rails: the same laminate, a shade lighter so the waste reads as waste. */
  rail: '#2b7a4b',
  /** Hairline along each board's own edge, where it meets tabs or a neighbour. */
  edge: '#0c2f1a',
  /** V-cut score: a groove in the laminate. */
  score: '#0c2f1a',
  /** Silkscreen (silk-divider lines). */
  silk: '#f2f2ea',
  /** Fiducial copper and the bare laminate the mask opening shows. */
  copper: '#d2a24c',
  substrate: '#b8ae78',
  /** Instance labels on the mask. */
  label: '#ffffff',
  /** Issue markers: the one thing that is not material. */
  error: '#d42a2a',
  warning: '#e6a019',
} as const;

export interface FabRing {
  points: Point[];
  /** Unsigned area, mm². */
  area: number;
  /**
   * How many other rings enclose this one. Even: the outer edge of a piece of
   * material. Odd: the edge of an opening the router cuts out of it.
   */
  depth: number;
}

export interface FabDrill {
  at: Point;
  diameter: number;
  kind: 'mouse-bite' | 'tooling';
}

export interface FabFiducial {
  at: Point;
  copperDiameter: number;
  maskDiameter: number;
}

export interface FabOutline {
  id: string;
  source: string;
  outline: Point[];
  bbox: Box;
  populate: boolean;
  pinned: boolean;
}

export interface FabScene {
  /** The routed profile with each ring's role. Fill them all even-odd to get the material. */
  rings: FabRing[];
  /** Rail rectangles, drawn over the material in the rail shade. */
  rails: Box[];
  drills: FabDrill[];
  /** One per position (a top and a bottom mark at the same spot are one). */
  fiducials: FabFiducial[];
  scores: Array<{ start: Point; end: Point }>;
  /** Silkscreen divider polylines. */
  dividers: Point[][];
  outlines: FabOutline[];
}

function signedArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function boxOfPts(pts: Point[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const s = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(a.x + dx * s - p.x, a.y + dy * s - p.y) < 1e-6;
}

/** 1 inside, -1 outside, 0 on the boundary. */
function where(p: Point, ring: Point[]): number {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (onSegment(p, a, b)) return 0;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside ? 1 : -1;
}

/**
 * Which rings are the outside of material and which are openings, found by
 * containment rather than by order or winding: profile rings never cross, so
 * a ring lies inside another when most of its vertices do (vertices that
 * touch the other ring are not counted).
 */
export function classifyRings(rings: Point[][]): FabRing[] {
  const boxes = rings.map(boxOfPts);
  return rings.map((ring, i) => {
    const bi = boxes[i]!;
    let depth = 0;
    rings.forEach((other, j) => {
      if (j === i || other.length < 3) return;
      const bj = boxes[j]!;
      if (bi.minX < bj.minX - 1e-9 || bi.maxX > bj.maxX + 1e-9 || bi.minY < bj.minY - 1e-9 || bi.maxY > bj.maxY + 1e-9) return;
      let vote = 0;
      for (const p of ring) vote += where(p, other);
      if (vote > 0) depth++;
    });
    return { points: ring, area: Math.abs(signedArea(ring)), depth };
  });
}

/** Reduce a panel's geometry to what the fab makes. */
export function fabScene(settings: Pick<PanelSettings, 'tabs'>, geometry: PanelGeometry): FabScene {
  const drills: FabDrill[] = [];
  for (const t of geometry.tabs) {
    for (const at of t.holes) drills.push({ at, diameter: settings.tabs.holeDiameter, kind: 'mouse-bite' });
  }
  for (const h of geometry.toolingHoles) drills.push({ at: h.at, diameter: h.diameter, kind: 'tooling' });
  const seen = new Set<string>();
  const fiducials: FabFiducial[] = [];
  for (const f of geometry.fiducials) {
    const key = `${f.at.x},${f.at.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fiducials.push({ at: f.at, copperDiameter: f.copperDiameter, maskDiameter: f.maskDiameter });
  }
  return {
    rings: classifyRings(geometry.profile.filter((r) => r.length >= 3)),
    rails: geometry.rails.map((r) => r.box),
    drills,
    fiducials,
    scores: (geometry.scores ?? []).map((s) => ({ start: s.start, end: s.end })),
    dividers: geometry.dividers,
    outlines: geometry.instances.map((i) => ({
      id: i.id,
      source: i.source,
      outline: i.outline,
      bbox: i.bbox,
      populate: i.populate,
      pinned: i.pinned,
    })),
  };
}
