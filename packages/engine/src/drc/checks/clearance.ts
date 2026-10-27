/**
 * DRC check: net-to-net copper clearance.
 *
 * Pairwise different-net copper items on the same layer; distance is the
 * polygon-to-polygon minimum boundary distance (polyPolyDistance). Required
 * clearance is max(ruleset floor, either item's net-class clearance). A
 * cheap bbox prefilter (expanded by the required clearance) skips the exact
 * polygon math for pairs that can't possibly violate.
 */
import type { Board, Point } from '../../types.js';
import { BoxGrid, bboxOf, pointInPolygon, polyPolyDistance, polyGroupDistance, segToSegDistance } from '../../geometry.js';
import type { Box, PolyGroup } from '../../geometry.js';
import { DRC_EPSILON } from '../rules.js';
import type { RuleSet } from '../rules.js';
import type { CopperItem, DrcViolation } from '../types.js';
import type { CheckProgress } from '../drc.js';

/**
 * Distance between two copper items, honoring zone holes. When an item carries
 * a decoded `group` (outer+holes), the other item's outline is measured against
 * the solid (outer minus holes) so a track sitting inside a knockout reports
 * its true distance to the hole boundary instead of a false 0.
 */
function itemDistance(a: CopperItem, c: CopperItem): number {
  if (a.group) return polyGroupDistance(c.polygon, a.group);
  if (c.group) return polyGroupDistance(a.polygon, c.group);
  return polyPolyDistance(a.polygon, c.polygon);
}

function netClearance(b: Board, net: string): number {
  if (!net) return 0;
  const n = b.nets.find((x) => x.name === net);
  if (!n) return 0;
  const cls = b.netClasses.find((c) => c.name === n.class);
  return cls ? cls.clearance : 0;
}

function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-18) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Approximate representative point for a violation: midpoint of the closest vertex/edge pair found. */
function closestApproach(a: Point[], b: Point[]): Point {
  let best = Infinity;
  let at = a[0];
  for (const pa of a) {
    for (let j = 0; j < b.length; j++) {
      const cp = closestPointOnSegment(pa, b[j], b[(j + 1) % b.length]);
      const d = Math.hypot(pa.x - cp.x, pa.y - cp.y);
      if (d < best) {
        best = d;
        at = { x: (pa.x + cp.x) / 2, y: (pa.y + cp.y) / 2 };
      }
    }
  }
  for (const pb of b) {
    for (let i = 0; i < a.length; i++) {
      const cp = closestPointOnSegment(pb, a[i], a[(i + 1) % a.length]);
      const d = Math.hypot(pb.x - cp.x, pb.y - cp.y);
      if (d < best) {
        best = d;
        at = { x: (pb.x + cp.x) / 2, y: (pb.y + cp.y) / 2 };
      }
    }
  }
  return at;
}

/** A pour island's rings as an edge list under a grid index. */
interface ZoneIndex {
  edges: [Point, Point][];
  grid: BoxGrid;
  box: Box;
  outer0: Point;
}

function indexGroup(g: PolyGroup): ZoneIndex {
  const edges: [Point, Point][] = [];
  for (const ring of [g.outer, ...g.holes]) {
    for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length]]);
  }
  const grid = new BoxGrid(1);
  edges.forEach(([p, q], i) =>
    grid.insert(i, { minX: Math.min(p.x, q.x), minY: Math.min(p.y, q.y), maxX: Math.max(p.x, q.x), maxY: Math.max(p.y, q.y) }),
  );
  return { edges, grid, box: bboxOf(g.outer), outer0: g.outer[0] };
}

/** Even-odd +x ray cast through the indexed rings: is `p` in the island's solid? */
function insideZone(z: ZoneIndex, p: Point): boolean {
  let inside = false;
  z.grid.query({ minX: p.x, minY: p.y, maxX: z.box.maxX, maxY: p.y }, (i) => {
    const [a, b] = z.edges[i];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  });
  return inside;
}

/**
 * Distance from simple polygon `poly` to a pour island (0 on overlap), same
 * contract as polyGroupDistance but only visiting island edges within
 * `reach` of `poly` -- Infinity when none are and there is no overlap.
 */
function zoneDistance(poly: Point[], z: ZoneIndex, reach: number): { d: number; at: Point } {
  const bb = bboxOf(poly);
  let d = Infinity;
  let at = poly[0];
  z.grid.query({ minX: bb.minX - reach, minY: bb.minY - reach, maxX: bb.maxX + reach, maxY: bb.maxY + reach }, (i) => {
    const [p, q] = z.edges[i];
    for (let k = 0; k < poly.length; k++) {
      const u = poly[k];
      const v = poly[(k + 1) % poly.length];
      const e = segToSegDistance(u, v, p, q);
      if (e < d) {
        d = e;
        at = { x: (u.x + v.x + p.x + q.x) / 4, y: (u.y + v.y + p.y + q.y) / 4 };
      }
    }
  });
  if (d === 0) return { d, at };
  // No boundary crossing: overlap iff poly sits in the solid, or the whole
  // island sits inside poly.
  if (insideZone(z, poly[0])) return { d: 0, at: poly[0] };
  if (pointInPolygon(z.outer0, poly)) return { d: 0, at: z.outer0 };
  return { d, at };
}

export function check(b: Board, rules: RuleSet, items: CopperItem[], progress?: CheckProgress): DrcViolation[] {
  const violations: DrcViolation[] = [];
  const boxes = items.map((it) => bboxOf(it.polygon));
  // Candidate pairs come from a grid over item boxes grown by the largest
  // clearance any pair can require; everything else is provably clear.
  const reach = Math.max(rules.minClearance, ...b.netClasses.map((c) => c.clearance));
  const grid = new BoxGrid(2);
  boxes.forEach((box, i) => grid.insert(i, box));
  const zoneIdx = new Map<number, ZoneIndex>();
  const zoneOf = (i: number): ZoneIndex => {
    let z = zoneIdx.get(i);
    if (!z) zoneIdx.set(i, (z = indexGroup(items[i].group!)));
    return z;
  };

  for (let i = 0; i < items.length; i++) {
    if (progress && i % 64 === 0) progress(i / items.length);
    const bi = boxes[i];
    const near: number[] = [];
    grid.query({ minX: bi.minX - reach, minY: bi.minY - reach, maxX: bi.maxX + reach, maxY: bi.maxY + reach }, (j) => {
      if (j > i) near.push(j);
    });
    near.sort((x, y) => x - y); // deterministic violation order
    for (const j of near) {
      const a = { it: items[i], bbox: bi };
      const c = { it: items[j], bbox: boxes[j] };
      if (a.it.layer !== c.it.layer) continue;
      // Same net is one conductor. Net '' (NC pads, holes) is never "the same
      // net" as another item -- only the same pad (identical ref) is.
      if (a.it.net ? a.it.net === c.it.net : a.it.ref === c.it.ref) continue;
      if (a.it.kind === 'hole' && c.it.kind === 'hole') continue; // hole-to-hole's job

      // Net-class clearance is net-to-net spacing; a bare NPTH drill isn't a
      // net, so copper-to-NPTH is held to the fab floor only.
      const npth = (a.it.kind === 'hole' && !a.it.plated) || (c.it.kind === 'hole' && !c.it.plated);
      const required = npth
        ? rules.minClearance
        : Math.max(rules.minClearance, netClearance(b, a.it.net), netClearance(b, c.it.net));

      if (
        a.bbox.minX - required > c.bbox.maxX ||
        c.bbox.minX - required > a.bbox.maxX ||
        a.bbox.minY - required > c.bbox.maxY ||
        c.bbox.minY - required > a.bbox.maxY
      ) {
        continue; // bbox prefilter: can't possibly be closer than `required`
      }

      let d: number;
      let at: Point | undefined;
      if (a.it.group && c.it.group) {
        d = itemDistance(a.it, c.it); // pour vs pour: rare, exact path
      } else if (a.it.group || c.it.group) {
        const [zi, other] = a.it.group ? [i, c.it] : [j, a.it];
        ({ d, at } = zoneDistance(other.polygon, zoneOf(zi), required));
      } else {
        d = itemDistance(a.it, c.it);
      }
      if (d < required - DRC_EPSILON) {
        violations.push({
          rule: 'clearance',
          message:
            `${a.it.kind} ${a.it.ref} (net "${a.it.net}") and ${c.it.kind} ${c.it.ref} ` +
            `(net "${c.it.net}") on ${a.it.layer}: clearance ${d.toFixed(2)}mm is below required ${required.toFixed(2)}mm`,
          at: at ?? closestApproach(a.it.polygon, c.it.polygon),
          items: [a.it.ref, c.it.ref],
        });
      }
    }
  }

  return violations;
}
