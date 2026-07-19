/**
 * Flamingo 3D viewer — board geometry builder.
 *
 * Ported and adapted from the old server-side standalone viewer
 * (packages/server/src/viewer3d.ts), rebuilt to run *in* the UI against the
 * live `Board` model. Differences from the old page:
 *   - renders a finished-board look: purple solder-mask substrate, copper
 *     (tracks + filled zones) shown as a tinted relief *under* the mask, and
 *     pad copper exposed as bright ENIG gold. No boolean CSG — just layered
 *     thin extrusions and material tinting.
 *   - NO keepouts and NO refdes label sprites (removed by design).
 *
 * Coordinates match the engine: millimetres, y-up, z = height. The camera's up
 * is +z, so world coordinates are used directly (x=x, y=y, z=height).
 */

import * as THREE from 'three';
import type { Board, ComponentInst, PathSeg, Point } from '@flamingo/engine';
import {
  bboxOf,
  componentLabelPlacement,
  componentTransformPoints,
  fillAllZones,
  holeSlotCenterline,
  padOutline,
  pointInPolygon,
} from '@flamingo/engine';
import { boardSilkTextSpec, buildSilkTextMesh, footprintSilkTextSpec } from './silktext.js';

export const BOARD_T = 1.6;

// ---------------------------------------------------------------------------
// Materials (a finished, mask-coated board — purple mask, gold ENIG pads).
// ---------------------------------------------------------------------------

/** Solder-mask coat = the visible top/bottom face of the substrate. */
const MAT_MASK = new THREE.MeshStandardMaterial({ color: 0x4a2340, roughness: 0.55, metalness: 0.12 });
/** Copper (tracks + zone fills) seen *through* the mask: a warmer, lighter
 * purple relief so the routing reads without exposing bare copper. */
const MAT_MASK_COPPER = new THREE.MeshStandardMaterial({ color: 0x7c3a5e, roughness: 0.5, metalness: 0.35 });
/** Exposed pad finish (ENIG gold). */
const MAT_GOLD = new THREE.MeshStandardMaterial({ color: 0xd8b545, roughness: 0.32, metalness: 0.9 });
/** Plated barrels through drilled pads/holes. */
const MAT_BARREL = new THREE.MeshStandardMaterial({ color: 0xb5923a, roughness: 0.4, metalness: 0.82 });
/** Tented via bump (mask-covered, so it reads as mask-colored relief). */
const MAT_VIA = new THREE.MeshStandardMaterial({ color: 0x5c2c48, roughness: 0.55, metalness: 0.2 });

const SILK_TOP = 0xf2eda1;
const SILK_BOT = 0xe8b2a7;

// ---------------------------------------------------------------------------
// Component body height heuristic + courtyard box (fallback when no 3D model).
// Ported verbatim-in-spirit from the old server viewer.
// ---------------------------------------------------------------------------

export function componentHeight(c: ComponentInst): number {
  const r = c.refdes;
  const v = c.fields?.value ?? '';
  const fp = c.footprint.name ?? '';
  if (r.startsWith('H') && /2\.54|WALTER|HDR/i.test(fp + ' ' + v)) return 8.5;
  if (/USB/i.test(fp + ' ' + v)) return 3.2;
  if (/JST|SH-?1|BATT|LRA/i.test(fp + ' ' + v)) return 4.3;
  if (/UFL|U\.FL|IPEX/i.test(fp + ' ' + v)) return 2.5;
  if (/FPC/i.test(fp + ' ' + v)) return 2.0;
  if (/^ANT/.test(r)) return 2.4;
  if (/^BZ/.test(r) || /PIEZO/i.test(v)) return 3.0;
  if (/^SW/.test(r)) return 3.75;
  if (/^L\d/.test(r) && /uH/i.test(v)) return 3.0;
  if (/^U\d/.test(r)) return 1.2;
  if (/^Q\d/.test(r)) return 1.1;
  if (/^LED/.test(r)) return 0.6;
  if (/^C\d/.test(r) && /22u/i.test(v)) return 1.4;
  if (/^[RD]\d/.test(r)) return 0.7;
  return 0.9;
}

const BOX_MATS: Record<string, THREE.Material> = {
  conn: new THREE.MeshStandardMaterial({ color: 0xcfc9b8, roughness: 0.6 }),
  hdr: new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.6 }),
  ant: new THREE.MeshStandardMaterial({ color: 0xb03030, roughness: 0.5 }),
  part: new THREE.MeshStandardMaterial({ color: 0x3a3d45, roughness: 0.55 }),
};

/**
 * Bare-pad footprints (test points, fiducials): a single pad with no silk has
 * no physical body — its gold pad is the whole part, so no box is drawn.
 */
export function isBarePad(c: ComponentInst): boolean {
  return c.footprint.pads.length <= 1 && c.footprint.silk.length === 0;
}

/** Fallback body: extruded courtyard bounding box with the height heuristic. */
export function componentCourtyardBox(c: ComponentInst): THREE.Mesh | null {
  if (isBarePad(c)) return null;
  const pts: Point[] = [];
  for (const ring of c.footprint.courtyard ?? []) pts.push(...componentTransformPoints(c, ring));
  if (pts.length === 0) for (const pad of c.footprint.pads) pts.push(...padOutline(c, pad));
  if (pts.length === 0) return null;
  const bb = bboxOf(pts);
  const w = bb.maxX - bb.minX;
  const h = bb.maxY - bb.minY;
  if (!(w > 0) || !(h > 0)) return null;
  const height = componentHeight(c);
  const kind = /^(J|H)/.test(c.refdes) ? (c.refdes.startsWith('H') ? 'hdr' : 'conn') : c.refdes === 'ANT1' ? 'ant' : 'part';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, height), BOX_MATS[kind] ?? BOX_MATS.part);
  const z = c.side === 'bottom' ? -0.06 - height / 2 : BOARD_T + 0.06 + height / 2;
  mesh.position.set((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, z);
  return mesh;
}

// ---------------------------------------------------------------------------
// Arc / path tessellation (shared with the substrate outline + silk arcs).
// ---------------------------------------------------------------------------

function arcPoints(start: Point, end: Point, center: Point, cw: boolean): Point[] {
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  if (r < 1e-6) return [start, end];
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const twoPi = 2 * Math.PI;
  let sweep = cw ? (((a0 - a1) % twoPi) + twoPi) % twoPi : (((a1 - a0) % twoPi) + twoPi) % twoPi;
  if (sweep < 1e-9) sweep = twoPi;
  const steps = Math.max(4, Math.min(64, Math.ceil(sweep / (2 * Math.acos(Math.max(0.2, 1 - 0.03 / r))))));
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = cw ? a0 - (sweep * i) / steps : a0 + (sweep * i) / steps;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

function circleRing(at: Point, radius: number): Point[] {
  const pts = arcPoints({ x: at.x + radius, y: at.y }, { x: at.x + radius, y: at.y }, at, false);
  return pts.slice(0, -1);
}

function capsuleRing(start: Point, end: Point, radius: number): Point[] {
  if (start.x === end.x && start.y === end.y) return circleRing(start, radius);
  const rot = Math.atan2(end.y - start.y, end.x - start.x);
  return [
    ...arcPoints(
      { x: end.x + radius * Math.cos(rot - Math.PI / 2), y: end.y + radius * Math.sin(rot - Math.PI / 2) },
      { x: end.x + radius * Math.cos(rot + Math.PI / 2), y: end.y + radius * Math.sin(rot + Math.PI / 2) },
      end,
      false,
    ),
    ...arcPoints(
      { x: start.x + radius * Math.cos(rot + Math.PI / 2), y: start.y + radius * Math.sin(rot + Math.PI / 2) },
      { x: start.x + radius * Math.cos(rot - Math.PI / 2), y: start.y + radius * Math.sin(rot - Math.PI / 2) },
      start,
      false,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Thin flat plates (pads, tracks, zone islands) as extruded polygons.
// ---------------------------------------------------------------------------

function shapeFrom(ring: Point[]): THREE.Shape {
  return new THREE.Shape(ring.map((p) => new THREE.Vector2(p.x, p.y)));
}

function plate(ring: Point[], z0: number, depth: number, mat: THREE.Material, holes?: Point[][]): THREE.Mesh {
  const shape = shapeFrom(ring);
  if (holes) {
    for (const h of holes) {
      const path = new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y)));
      path.closePath();
      shape.holes.push(path);
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  const m = new THREE.Mesh(geo, mat);
  m.position.z = z0;
  return m;
}

/** Oriented flat box for a straight track segment (like the old InstancedMesh). */
function trackPlate(a: Point, b: Point, width: number, z: number): THREE.Mesh {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 0.001;
  const geo = new THREE.BoxGeometry(len + width * 0.6, width, 0.03);
  const m = new THREE.Mesh(geo, MAT_MASK_COPPER);
  m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, z);
  m.rotation.z = Math.atan2(dy, dx);
  return m;
}

function segPieces(seg: PathSeg): Point[] {
  if (seg.type === 'line') return [seg.start, seg.end];
  return arcPoints(seg.start, seg.end, seg.center, seg.cw);
}

export interface BoardGeometry {
  /** Everything except the movable silk group. */
  group: THREE.Group;
  /** Silk lines (toggled independently). Already added to `group`. */
  silk: THREE.Group;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Build the whole static board: mask substrate (with drills/slots punched),
 * copper relief (tracks + filled zones), exposed gold pads, plated barrels,
 * tented vias, and silkscreen. Returns groups so the viewer can toggle silk
 * and dispose geometry on rebuild.
 */
export function buildBoardGroup(board: Board): BoardGeometry {
  const group = new THREE.Group();

  // ---- substrate outline shape, with drills/slots punched out ----
  const shape = new THREE.Shape();
  board.outline.forEach((s, i) => {
    if (i === 0) shape.moveTo(s.start.x, s.start.y);
    if (s.type === 'line') {
      shape.lineTo(s.end.x, s.end.y);
    } else {
      const r = Math.hypot(s.start.x - s.center.x, s.start.y - s.center.y);
      const a0 = Math.atan2(s.start.y - s.center.y, s.start.x - s.center.x);
      const a1 = Math.atan2(s.end.y - s.center.y, s.end.x - s.center.x);
      shape.absarc(s.center.x, s.center.y, r, a0, a1, s.cw);
    }
  });

  const cutouts: Point[][] = [];
  const barrels: { at: Point; r: number }[] = [];

  // Mounting holes / slots (board.holes) are cut through the WHOLE stack —
  // substrate here, and the copper coats below (zone fills span the board and
  // would otherwise tent them shut). Kept separate so the copper loop can reuse
  // the same rings. `at` is the containment probe for which island to punch.
  const holeCuts: { ring: Point[]; at: Point }[] = [];
  for (const h of board.holes) {
    const { start, end } = holeSlotCenterline(h);
    holeCuts.push({ ring: capsuleRing(start, end, h.drill / 2), at: h.at });
    if (h.plated && start.x === end.x && start.y === end.y) barrels.push({ at: h.at, r: h.drill / 2 + 0.2 });
  }

  for (const c of board.components) {
    for (const pad of c.footprint.pads) {
      if (pad.drill) {
        const [at] = componentTransformPoints(c, [pad.at]);
        const rr = pad.drill.diameter / 2;
        cutouts.push(circleRing(at, rr));
        barrels.push({ at, r: rr + 0.15 });
      }
    }
  }
  for (const ring of [...cutouts, ...holeCuts.map((h) => h.ring)]) {
    const path = new THREE.Path(ring.map((p) => new THREE.Vector2(p.x, p.y)));
    path.closePath();
    shape.holes.push(path);
  }

  // A hole's ring is punched into a copper island only when the island FULLY
  // contains it (its centre is inside AND every ring point is inside), so the
  // three.js hole never pokes past the island contour — no triangulation
  // artifacts. Islands that merely straddle a hole are left alone. Verified
  // against the eink-cell board: every covering island fully contains its hole.
  const holesInIsland = (poly: Point[]): Point[][] =>
    holeCuts.filter((h) => pointInPolygon(h.at, poly) && h.ring.every((p) => pointInPolygon(p, poly))).map((h) => h.ring);

  const substrate = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: BOARD_T, bevelEnabled: false, curveSegments: 32 }),
    MAT_MASK,
  );
  group.add(substrate);

  // ---- copper relief: filled zones then tracks (under the mask tint) ----
  const filled = fillAllZones(board);
  for (const z of filled.zones) {
    if (z.layer !== 'F.Cu' && z.layer !== 'B.Cu') continue;
    const top = z.layer === 'F.Cu';
    const islands = z.fill && z.fill.length > 0 ? z.fill : [z.polygon];
    for (const poly of islands) {
      if (poly.length < 3) continue;
      group.add(plate(poly, top ? BOARD_T : -0.02, 0.02, MAT_MASK_COPPER, holesInIsland(poly)));
    }
  }
  for (const t of board.tracks) {
    if (t.layer !== 'F.Cu' && t.layer !== 'B.Cu') continue;
    const z = t.layer === 'F.Cu' ? BOARD_T + 0.015 : -0.015;
    const pts = segPieces(t.seg);
    for (let i = 0; i < pts.length - 1; i++) group.add(trackPlate(pts[i], pts[i + 1], t.width, z));
  }

  // ---- exposed gold pads + plated barrels + tented vias ----
  for (const c of board.components) {
    for (const pad of c.footprint.pads) {
      const ring = padOutline(c, pad);
      if (ring.length < 3) continue;
      if (pad.layer === 'through') {
        group.add(plate(ring, BOARD_T, 0.06, MAT_GOLD));
        group.add(plate(ring, -0.06, 0.06, MAT_GOLD));
      } else {
        // A 'top' pad on a bottom-side component lands on the bottom face (XOR).
        const onTop = (pad.layer === 'top') !== (c.side === 'bottom');
        group.add(plate(ring, onTop ? BOARD_T : -0.06, 0.06, MAT_GOLD));
      }
    }
  }
  for (const b of barrels) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(b.r, b.r, BOARD_T + 0.1, 24, 1, true), MAT_BARREL);
    tube.rotation.x = Math.PI / 2;
    tube.position.set(b.at.x, b.at.y, BOARD_T / 2);
    group.add(tube);
  }
  for (const v of board.vias) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(v.diameter / 2, v.diameter / 2, 0.05, 20), MAT_VIA);
    disc.rotation.x = Math.PI / 2;
    disc.position.set(v.at.x, v.at.y, BOARD_T + 0.02);
    group.add(disc);
    const disc2 = disc.clone();
    disc2.position.z = -0.02;
    group.add(disc2);
  }

  // ---- silkscreen (footprint items + board silk lines/text), its own group ----
  const silk = buildSilkGroup(board);
  group.add(silk);

  const outlinePts: Point[] = [];
  for (const s of board.outline) outlinePts.push(s.start, s.end);
  const bbox = outlinePts.length ? bboxOf(outlinePts) : { minX: 0, minY: 0, maxX: 50, maxY: 50 };

  return { group, silk, bbox };
}

/**
 * Silk line work is stroked at its REAL width — flat capsule plates, one shape
 * per segment (round caps double as round joints on polylines) merged into a
 * single extrusion per side. Hairline `LineSegments` were invisible at board
 * zoom (1px regardless of zoom), which read as "silk missing" on small parts.
 * Unlit material: silk is matte paint and must stay legible from any angle.
 */
function buildSilkGroup(board: Board): THREE.Group {
  const silk = new THREE.Group();
  const topShapes: THREE.Shape[] = [];
  const botShapes: THREE.Shape[] = [];
  const stroke = (a: Point, b: Point, width: number, top: boolean): void => {
    const ring = capsuleRing(a, b, Math.max(width, 0.1) / 2);
    (top ? topShapes : botShapes).push(shapeFrom(ring));
  };

  for (const c of board.components) {
    const top = c.side !== 'bottom';
    const mirror = c.side === 'bottom';
    for (const item of c.footprint.silk) {
      if (item.kind === 'line') {
        const [a, b] = componentTransformPoints(c, [item.start, item.end]);
        stroke(a, b, item.width, top);
      } else if (item.kind === 'arc') {
        const [ws, we, wc] = componentTransformPoints(c, [item.start, item.end, item.center]);
        const pts = arcPoints(ws, we, wc, mirror ? !item.cw : item.cw);
        for (let i = 0; i < pts.length - 1; i++) stroke(pts[i], pts[i + 1], item.width, top);
      } else if (item.kind === 'circle') {
        const [wc] = componentTransformPoints(c, [item.center]);
        const pts = arcPoints({ x: wc.x + item.radius, y: wc.y }, { x: wc.x + item.radius, y: wc.y }, wc, false);
        for (let i = 0; i < pts.length - 1; i++) stroke(pts[i], pts[i + 1], item.width, top);
      } else if (item.kind === 'text') {
        const mesh = buildSilkTextMesh(footprintSilkTextSpec(c, item), top ? SILK_TOP : SILK_BOT, BOARD_T);
        if (mesh) silk.add(mesh);
      }
    }
    // Refdes label — same pad-avoiding anchor as the Gerber legend / 2D
    // renderer (most footprints carry no text silk of their own, so without
    // this caps/resistors show no text at all in 3D).
    const lp = componentLabelPlacement(board, c);
    const label = buildSilkTextMesh(
      { text: c.refdes, height: lp.height, at: lp.at, rotationDeg: lp.rotation, side: top ? 'top' : 'bottom' },
      top ? SILK_TOP : SILK_BOT,
      BOARD_T,
    );
    if (label) silk.add(label);
  }
  for (const line of board.silkLines) {
    stroke(line.start, line.end, line.width, line.layer !== 'B.Silk');
  }
  for (const s of board.silk) {
    const top = s.layer !== 'B.Silk';
    const mesh = buildSilkTextMesh(boardSilkTextSpec(s), top ? SILK_TOP : SILK_BOT, BOARD_T);
    if (mesh) silk.add(mesh);
  }

  for (const [shapes, color, z0] of [
    [topShapes, SILK_TOP, BOARD_T + 0.065],
    [botShapes, SILK_BOT, -0.08],
  ] as const) {
    if (!shapes.length) continue;
    const geo = new THREE.ExtrudeGeometry(shapes as THREE.Shape[], { depth: 0.015, bevelEnabled: false });
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    mesh.position.z = z0;
    silk.add(mesh);
  }
  return silk;
}

/** Recursively dispose geometries (materials — including the silk-text
 * texture/material caches in silktext.ts — are shared module singletons). */
export function disposeGroup(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}
