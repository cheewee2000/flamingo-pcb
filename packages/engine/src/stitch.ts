/**
 * Zone-island stitching: find copper-pour islands that are electrically
 * orphaned (no same-net pad, via, or track touches them) and plan stitching
 * vias that reconnect them through the opposite layer's *connected* pour.
 *
 * Placement safety comes from the pours themselves: a filled island already
 * respects clearance to every other-net item on its layer, so a via whose
 * copper stays ≥ its own radius inside BOTH islands' boundaries (the orphan
 * and the opposite-layer connected island) clears everything except other
 * vias — which are checked explicitly. Runs in rounds so an island that
 * becomes connected in round N can carry its neighbours in round N+1.
 */

import type { Board, ComponentInst, Pad, PathSeg, Point, Via } from './types.js';
import { componentTransformPoints } from './geometry.js';
import { fillAllZones } from './zonefill.js';
import { pointInPolygon } from './geometry.js';
import { RULESETS } from './drc/rules.js';

export interface StitchOptions {
  /** Orphan islands smaller than this (mm²) are left alone. Default 2. */
  minIslandArea?: number;
  /** Candidate grid pitch inside an island's bbox, mm. Default 0.6. */
  gridPitch?: number;
  /** Extra copper margin between via edge and island boundary, mm. Default 0.1. */
  extraMargin?: number;
}

export interface StitchPlan {
  /** Vias to add (net-class drill/diameter, deterministic ids). */
  vias: Via[];
  /** Orphan islands ≥ minIslandArea that no safe via location could reconnect. */
  unfixed: { layer: string; net: string; area: number; at: Point }[];
  /** Orphan islands below minIslandArea, left as-is. */
  ignoredSlivers: number;
}

interface Island {
  outer: Point[];
  holes: Point[][];
  area: number;
  connected: boolean;
}

function ringArea(r: Point[]): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function inIsland(p: Point, isl: Island): boolean {
  return pointInPolygon(p, isl.outer) && !isl.holes.some((h) => pointInPolygon(p, h));
}

/** Distance from a point to the island's boundary (outer ring + hole rings). */
function boundaryMargin(p: Point, isl: Island): number {
  let d = Infinity;
  for (const ring of [isl.outer, ...isl.holes]) {
    for (let i = 0; i < ring.length; i++) {
      d = Math.min(d, segDist(p, ring[i], ring[(i + 1) % ring.length]));
    }
  }
  return d;
}

/** Group a zone's flat fill-ring list (CCW outers, CW holes) into islands. */
function decompose(fill: Point[][]): Island[] {
  const islands: Island[] = [];
  for (const ring of fill) {
    if (ringArea(ring) > 0) islands.push({ outer: ring, holes: [], area: 0, connected: false });
    else if (islands.length) islands[islands.length - 1].holes.push(ring);
  }
  for (const isl of islands) {
    isl.area = Math.abs(ringArea(isl.outer)) - isl.holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
  }
  return islands;
}

/** Sample points along a track segment (arcs included) for contact probing. */
function segSamples(seg: PathSeg, n = 6): Point[] {
  if (seg.type === 'line') {
    return Array.from({ length: n }, (_, i) => ({
      x: seg.start.x + ((seg.end.x - seg.start.x) * i) / (n - 1),
      y: seg.start.y + ((seg.end.y - seg.start.y) * i) / (n - 1),
    }));
  }
  const r = Math.hypot(seg.start.x - seg.center.x, seg.start.y - seg.center.y);
  const a0 = Math.atan2(seg.start.y - seg.center.y, seg.start.x - seg.center.x);
  const a1 = Math.atan2(seg.end.y - seg.center.y, seg.end.x - seg.center.x);
  const twoPi = 2 * Math.PI;
  const sweep = seg.cw ? (((a0 - a1) % twoPi) + twoPi) % twoPi : (((a1 - a0) % twoPi) + twoPi) % twoPi;
  return Array.from({ length: n }, (_, i) => {
    const a = seg.cw ? a0 - (sweep * i) / (n - 1) : a0 + (sweep * i) / (n - 1);
    return { x: seg.center.x + r * Math.cos(a), y: seg.center.y + r * Math.sin(a) };
  });
}

function ringPts(at: Point, r: number, n = 8): Point[] {
  return Array.from({ length: n }, (_, i) => ({
    x: at.x + r * Math.cos((2 * Math.PI * i) / n),
    y: at.y + r * Math.sin((2 * Math.PI * i) / n),
  }));
}

function padFace(c: ComponentInst, pad: Pad): 'F.Cu' | 'B.Cu' | 'both' {
  if (pad.layer === 'through') return 'both';
  return (pad.layer === 'top') !== (c.side === 'bottom') ? 'F.Cu' : 'B.Cu';
}

/** Same-net copper probe points per layer (pads, vias, track samples). */
function contactProbes(board: Board, net: string, layer: string, extraVias: Via[]): Point[][] {
  const probes: Point[][] = [];
  const netPins = new Set(board.nets.find((n) => n.name === net)?.pins ?? []);
  for (const c of board.components) {
    for (const pad of c.footprint.pads) {
      if (!netPins.has(`${c.refdes}.${pad.number}`)) continue;
      const face = padFace(c, pad);
      if (face !== 'both' && face !== layer) continue;
      const [at] = componentTransformPoints(c, [pad.at]);
      probes.push([at, ...ringPts(at, Math.min(pad.size.w, pad.size.h) * 0.35)]);
    }
  }
  for (const v of [...board.vias, ...extraVias]) {
    if (v.net === net) probes.push([v.at, ...ringPts(v.at, (v.drill / 2 + v.diameter / 2) / 2)]);
  }
  for (const t of board.tracks) {
    if (t.net === net && t.layer === layer) probes.push(segSamples(t.seg));
  }
  return probes;
}

function viaSizeFor(board: Board, net: string): { drill: number; diameter: number } {
  const className = board.nets.find((n) => n.name === net)?.class ?? 'default';
  const nc = board.netClasses.find((k) => k.name === className) ?? board.netClasses.find((k) => k.name === 'default');
  return { drill: nc?.viaDrill ?? 0.3, diameter: nc?.viaDiameter ?? 0.6 };
}

interface Node {
  layer: 'F.Cu' | 'B.Cu';
  net: string;
  isl: Island;
  bbox: { x0: number; x1: number; y0: number; y1: number };
}

function bboxOfIsland(isl: Island): Node['bbox'] {
  const xs = isl.outer.map((p) => p.x);
  const ys = isl.outer.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/**
 * Plan stitching vias for every zone net on the board (F.Cu/B.Cu zones).
 * Pure — returns the vias to add; apply them with the addTracks op
 * (tracks: []).
 *
 * Method: build a graph whose nodes are pour islands (both layers) and whose
 * edges are viable via spots in the geometric overlap of an F island and a
 * B island of the same net. Islands already touching same-net copper are
 * roots; every island in a graph component that reaches a root gets stitched
 * along a BFS spanning tree — so chains of orphans (orphan-over-orphan, as
 * routing channels carve both layers the same way) connect through each
 * other. Components with no root stay dead copper and are reported unfixed.
 */
export function planZoneStitching(board: Board, opts: StitchOptions = {}): StitchPlan {
  const minArea = opts.minIslandArea ?? 2;
  const pitch = opts.gridPitch ?? 0.6;
  const extraMargin = opts.extraMargin ?? 0.1;

  const filled = fillAllZones(board);
  const zones = filled.zones.filter((z) => (z.layer === 'F.Cu' || z.layer === 'B.Cu') && z.net);

  const nodes: Node[] = [];
  for (const z of zones) {
    for (const isl of decompose(z.fill ?? [])) {
      nodes.push({ layer: z.layer as Node['layer'], net: z.net, isl, bbox: bboxOfIsland(isl) });
    }
  }
  for (const n of nodes) {
    const probes = contactProbes(board, n.net, n.layer, []);
    n.isl.connected = probes.some((pr) => pr.some((p) => inIsland(p, n.isl)));
  }

  // Via sizes: net class size, with the ruleset minimum as a small fallback
  // for channels where the class via doesn't fit.
  const rules = RULESETS[board.rules];
  const sizesFor = (net: string): { drill: number; diameter: number }[] => {
    const cls = viaSizeFor(board, net);
    // Fallback small via: ruleset minimums, with the diameter grown so the
    // annular ring stays legal (minViaDiameter alone can violate minAnnular).
    const min = {
      drill: rules.minDrill,
      diameter: Math.max(rules.minViaDiameter, rules.minDrill + 2 * rules.minAnnular),
    };
    return min.diameter < cls.diameter - 1e-6 ? [cls, min] : [cls];
  };

  const planned: Via[] = [];
  const viaClear = (p: Point, diameter: number): boolean => {
    for (const v of [...board.vias, ...planned]) {
      if (Math.hypot(v.at.x - p.x, v.at.y - p.y) < (v.diameter + diameter) / 2 + 0.2) return false;
    }
    return true;
  };

  /** Best via spot inside both islands (max combined boundary margin). */
  const bestSpot = (a: Node, b: Node, diameter: number): { at: Point; margin: number } | null => {
    const x0 = Math.max(a.bbox.x0, b.bbox.x0);
    const x1 = Math.min(a.bbox.x1, b.bbox.x1);
    const y0 = Math.max(a.bbox.y0, b.bbox.y0);
    const y1 = Math.min(a.bbox.y1, b.bbox.y1);
    if (x1 <= x0 || y1 <= y0) return null;
    const need = diameter / 2 + extraMargin;
    const scan = (step: number): { at: Point; margin: number } | null => {
      let best: { at: Point; margin: number } | null = null;
      for (let x = x0 + step / 2; x <= x1; x += step) {
        for (let y = y0 + step / 2; y <= y1; y += step) {
          const p = { x, y };
          if (!inIsland(p, a.isl) || !inIsland(p, b.isl)) continue;
          const m = Math.min(boundaryMargin(p, a.isl), boundaryMargin(p, b.isl));
          if (m < need) continue;
          if (!viaClear(p, diameter)) continue;
          if (!best || m > best.margin) best = { at: p, margin: m };
        }
      }
      return best;
    };
    const coarse = Math.max(pitch, Math.sqrt(Math.max(0.01, (x1 - x0) * (y1 - y0)) / 2500));
    const found = scan(coarse);
    if (found) return found;
    // Narrow channel strips can slip between coarse samples — retry finer
    // when the overlap box is small enough to keep the sample count sane.
    return (x1 - x0) * (y1 - y0) < 150 ? scan(coarse / 3) : null;
  };

  // Edges: island pairs (F×B, same net) whose bboxes overlap. Spots are
  // found lazily during BFS so via-separation accounts for planned vias.
  const edges = new Map<number, number[]>(); // node index -> neighbor indices
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (a.net !== b.net || a.layer === b.layer) continue;
      if (a.bbox.x1 < b.bbox.x0 || b.bbox.x1 < a.bbox.x0 || a.bbox.y1 < b.bbox.y0 || b.bbox.y1 < a.bbox.y0) continue;
      (edges.get(i) ?? edges.set(i, []).get(i)!).push(j);
      (edges.get(j) ?? edges.set(j, []).get(j)!).push(i);
    }
  }

  // BFS from every already-connected island; crossing an edge plants a via.
  // Islands below minArea still act as bridges only if a via already reached
  // them (we never spend a via *just* to feed a sliver — BFS visits them last
  // by processing big islands first from the queue).
  const reached = nodes.map((n) => n.isl.connected);
  const queue: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (reached[i]) queue.push(i);
  while (queue.length > 0) {
    const u = queue.shift()!;
    // Prefer stitching big orphans first for stable, useful via placement.
    const neighbors = (edges.get(u) ?? []).filter((v) => !reached[v]).sort((x, y) => nodes[y].isl.area - nodes[x].isl.area);
    for (const v of neighbors) {
      if (reached[v]) continue;
      if (nodes[v].isl.area < minArea) continue; // slivers: not worth a via
      let placed = false;
      for (const size of sizesFor(nodes[v].net)) {
        const spot = bestSpot(nodes[u], nodes[v], size.diameter);
        if (!spot) continue;
        planned.push({
          id: `stitch-${planned.length}-${spot.at.x.toFixed(1)}x${spot.at.y.toFixed(1)}`,
          at: { x: Math.round(spot.at.x * 100) / 100, y: Math.round(spot.at.y * 100) / 100 },
          drill: size.drill,
          diameter: size.diameter,
          net: nodes[v].net,
        });
        placed = true;
        break;
      }
      if (placed) {
        reached[v] = true;
        queue.push(v);
      }
    }
  }

  const unfixed: StitchPlan['unfixed'] = [];
  let ignoredSlivers = 0;
  nodes.forEach((n, i) => {
    if (reached[i]) return;
    if (n.isl.area < minArea) {
      ignoredSlivers++;
      return;
    }
    unfixed.push({
      layer: n.layer,
      net: n.net,
      area: Math.round(n.isl.area * 10) / 10,
      at: { x: Math.round(((n.bbox.x0 + n.bbox.x1) / 2) * 10) / 10, y: Math.round(((n.bbox.y0 + n.bbox.y1) / 2) * 10) / 10 },
    });
  });

  return { vias: planned, unfixed, ignoredSlivers };
}
