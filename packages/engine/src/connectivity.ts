/**
 * Flamingo Engine - Connectivity + Ratsnest
 * Units: mm
 *
 * Per-net connectivity model: nodes are the net's pins (pad world anchors)
 * plus the net's tracks and vias, which act as glue but are never returned
 * as group members. Two nodes are unioned when they touch within EPSILON_MM
 * on a shared copper layer (see union rules below). `connectedGroups`
 * collapses this to groups of pin refs only.
 *
 * Epsilon: 0.01mm, "exact-ish" contact — no added tolerance for track width.
 * Freerouting output snaps track/via endpoints to pad centers, so a plain
 * distance-based epsilon is sufficient without also inflating by half the
 * track width.
 */

import type { Board, ComponentInst, Net, Pad, Point, Track, LayerId } from './types.js';
import { padWorld, dist } from './geometry.js';
import { copperLayersOf } from './layers.js';

const EPSILON_MM = 0.01;

export interface RatLine {
  net: string;
  from: Point;
  to: Point;
}

/** World-space center of a pad, given a "REFDES.PADNUMBER" pin ref. */
export function padAnchor(b: Board, pinRef: string): Point {
  const dot = pinRef.indexOf('.');
  if (dot === -1) {
    throw new Error(`padAnchor: invalid pin ref "${pinRef}" (expected REFDES.PADNUMBER)`);
  }
  const refdes = pinRef.slice(0, dot);
  const padNumber = pinRef.slice(dot + 1);
  const comp = b.components.find((c) => c.refdes === refdes);
  if (!comp) throw new Error(`padAnchor: unknown refdes "${refdes}" (in pin "${pinRef}")`);
  const pad = comp.footprint.pads.find((p) => p.number === padNumber);
  if (!pad) {
    throw new Error(`padAnchor: pad "${padNumber}" not found on "${refdes}" (in pin "${pinRef}")`);
  }
  return padWorld(comp, pad).at;
}

/**
 * The copper layer(s) a pad occupies in world space, honoring the
 * bottom-side flip: a footprint-local 'top' pad on a bottom-side component
 * is physically on B.Cu, and vice versa. A 'through' pad occupies every
 * copper layer on the board.
 */
function padLayers(b: Board, comp: ComponentInst, pad: Pad): LayerId[] {
  if (pad.layer === 'through') return copperLayersOf(b);
  const physicalSide: 'top' | 'bottom' =
    comp.side === 'bottom' ? (pad.layer === 'top' ? 'bottom' : 'top') : pad.layer;
  return [physicalSide === 'top' ? 'F.Cu' : 'B.Cu'];
}

interface PinNode {
  kind: 'pin';
  ref: string;
  at: Point;
  layers: LayerId[];
}

interface TrackEndNode {
  kind: 'trackEnd';
  trackIdx: number;
  which: 'start' | 'end';
  at: Point;
  layer: LayerId;
}

interface ViaNode {
  kind: 'via';
  viaIdx: number;
  at: Point;
}

type Node = PinNode | TrackEndNode | ViaNode;

function segEndpoints(t: Track): { start: Point; end: Point } {
  return { start: t.seg.start, end: t.seg.end };
}

function sharesLayer(a: LayerId[], b: LayerId[]): boolean {
  return a.some((l) => b.includes(l));
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * Union-find over a net's pins (world pad anchors), tracks, and vias.
 * Returns groups of pin refs only (tracks/vias are glue, not group members).
 * A net with 0 or 1 pins is a single group (or empty), never unrouted.
 */
export function connectedGroups(b: Board, net: Net): string[][] {
  if (net.pins.length <= 1) {
    return net.pins.length === 1 ? [[...net.pins]] : [];
  }

  const nodes: Node[] = [];
  const pinNodeIdx: number[] = [];

  for (const ref of net.pins) {
    const dot = ref.indexOf('.');
    const refdes = ref.slice(0, dot);
    const padNumber = ref.slice(dot + 1);
    const comp = b.components.find((c) => c.refdes === refdes);
    if (!comp) throw new Error(`connectedGroups: unknown refdes "${refdes}" (in pin "${ref}")`);
    const pad = comp.footprint.pads.find((p) => p.number === padNumber);
    if (!pad) {
      throw new Error(`connectedGroups: pad "${padNumber}" not found on "${refdes}" (pin "${ref}")`);
    }
    const at = padWorld(comp, pad).at;
    const layers = padLayers(b, comp, pad);
    pinNodeIdx.push(nodes.length);
    nodes.push({ kind: 'pin', ref, at, layers });
  }

  const netTracks = b.tracks.filter((t) => t.net === net.name);
  const trackNodeIdx: { startIdx: number; endIdx: number }[] = [];
  for (let i = 0; i < netTracks.length; i++) {
    const t = netTracks[i];
    const { start, end } = segEndpoints(t);
    const startIdx = nodes.length;
    nodes.push({ kind: 'trackEnd', trackIdx: i, which: 'start', at: start, layer: t.layer });
    const endIdx = nodes.length;
    nodes.push({ kind: 'trackEnd', trackIdx: i, which: 'end', at: end, layer: t.layer });
    trackNodeIdx.push({ startIdx, endIdx });
  }

  const netVias = b.vias.filter((v) => v.net === net.name);
  for (let i = 0; i < netVias.length; i++) {
    nodes.push({ kind: 'via', viaIdx: i, at: netVias[i].at });
  }

  const uf = new UnionFind(nodes.length);

  // A track's own two endpoints are always connected (it's one continuous
  // piece of copper), regardless of the endpoint-to-endpoint distance.
  for (const { startIdx, endIdx } of trackNodeIdx) {
    uf.union(startIdx, endIdx);
  }

  function layersOf(n: Node): LayerId[] {
    if (n.kind === 'pin') return n.layers;
    if (n.kind === 'trackEnd') return [n.layer];
    return copperLayersOf(b); // via joins any copper layer
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const bNode = nodes[j];
      if (a.kind === 'pin' && bNode.kind === 'pin') continue; // pins never touch each other directly
      if (dist(a.at, bNode.at) > EPSILON_MM) continue;
      if (!sharesLayer(layersOf(a), layersOf(bNode))) continue;
      uf.union(i, j);
    }
  }

  const groupsByRoot = new Map<number, string[]>();
  for (const idx of pinNodeIdx) {
    const root = uf.find(idx);
    const ref = (nodes[idx] as PinNode).ref;
    const arr = groupsByRoot.get(root);
    if (arr) arr.push(ref);
    else groupsByRoot.set(root, [ref]);
  }

  return Array.from(groupsByRoot.values());
}

/** Minimum distance between any pin anchor in group a vs group b, plus the closest pair. */
function closestPair(
  b: Board,
  groupA: string[],
  groupB: string[],
): { d: number; from: Point; to: Point } {
  let best = { d: Infinity, from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
  for (const refA of groupA) {
    const pa = padAnchor(b, refA);
    for (const refB of groupB) {
      const pb = padAnchor(b, refB);
      const d = dist(pa, pb);
      if (d < best.d) best = { d, from: pa, to: pb };
    }
  }
  return best;
}

/**
 * For each net with >1 connected group, compute a minimum spanning tree over
 * the groups (complete graph, edge weight = min pairwise distance between
 * any two pins' anchors across the two groups). RatLine endpoints are the
 * actual closest pin anchors of that edge (Prim's algorithm).
 */
export function ratsnest(b: Board): RatLine[] {
  const lines: RatLine[] = [];

  for (const net of b.nets) {
    const groups = connectedGroups(b, net);
    if (groups.length <= 1) continue;

    const n = groups.length;
    const inTree = new Array(n).fill(false);
    inTree[0] = true;
    let remaining = n - 1;

    // best[j] = best known connection from tree to group j (or undefined)
    const best: ({ d: number; from: Point; to: Point } | undefined)[] = new Array(n).fill(
      undefined,
    );

    function updateBestFrom(i: number): void {
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        const pair = closestPair(b, groups[i], groups[j]);
        if (!best[j] || pair.d < best[j]!.d) {
          best[j] = { d: pair.d, from: pair.from, to: pair.to };
        }
      }
    }

    updateBestFrom(0);

    while (remaining > 0) {
      let bestJ = -1;
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        if (bestJ === -1 || best[j]!.d < best[bestJ]!.d) bestJ = j;
      }
      const edge = best[bestJ]!;
      lines.push({ net: net.name, from: edge.from, to: edge.to });
      inTree[bestJ] = true;
      remaining--;
      updateBestFrom(bestJ);
    }
  }

  return lines;
}

/** Nets with >1 connected group, reporting groups.length - 1 as `unconnected`. */
export function isFullyRouted(b: Board): { net: string; unconnected: number }[] {
  const result: { net: string; unconnected: number }[] = [];
  for (const net of b.nets) {
    const groups = connectedGroups(b, net);
    if (groups.length > 1) {
      result.push({ net: net.name, unconnected: groups.length - 1 });
    }
  }
  return result;
}
