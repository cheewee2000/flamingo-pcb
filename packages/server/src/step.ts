/**
 * STEP (ISO 10303-21, AP214) export of the board as faceted B-rep solids.
 *
 * Geometry model: the board is an extruded prism of the outline (1.6mm)
 * with every drill (mounting holes, slots, through-hole pad drills, vias)
 * cut through it; each component is an extruded courtyard bounding box at
 * the per-package height heuristic shared with the 3D viewer. Faceted
 * B-rep (planar faces bounded by POLY_LOOPs) — mechanically accurate for
 * enclosure work, not a cosmetic model; imports into FreeCAD / Fusion /
 * SolidWorks / Rhino as one part with named bodies.
 */

import earcut from 'earcut';
import type { Board, Point } from '@flamingo/engine';
import { capsulePolygon, holeSlotCenterline, isSlot, outlineToPolygon, padWorld } from '@flamingo/engine';
import { BOARD_T, componentBox } from './viewer3d.js';

interface P3 {
  x: number;
  y: number;
  z: number;
}

interface Solid {
  name: string;
  /** Planar faces, each a single outer loop of ≥3 vertices, outward-wound. */
  faces: P3[][];
}

function signedArea(ring: Point[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/** Drop a duplicated closing point and degenerate rings. */
function cleanRing(ring: Point[]): Point[] {
  const r = ring.slice();
  while (r.length > 1 && Math.hypot(r[0].x - r[r.length - 1].x, r[0].y - r[r.length - 1].y) < 1e-9) r.pop();
  return r.length >= 3 ? r : [];
}

/**
 * Extrude an outer ring with hole rings from z0 to z1 into faceted-brep
 * faces: earcut-triangulated top/bottom + one outward quad per ring edge.
 */
function prismFaces(outerIn: Point[], holesIn: Point[][], z0: number, z1: number): P3[][] {
  const outer = cleanRing(outerIn);
  if (outer.length < 3) return [];
  if (signedArea(outer) < 0) outer.reverse(); // outer CCW
  const holes = holesIn.map(cleanRing).filter((h) => h.length >= 3);
  for (const h of holes) if (signedArea(h) > 0) h.reverse(); // holes CW

  const rings = [outer, ...holes];
  const flat: number[] = [];
  const holeIdx: number[] = [];
  for (const ring of rings) {
    if (ring !== outer) holeIdx.push(flat.length / 2);
    for (const p of ring) flat.push(p.x, p.y);
  }
  const all: Point[] = rings.flat();
  const tris = earcut(flat, holeIdx.length ? holeIdx : undefined);

  const faces: P3[][] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const [ia, ib, ic] = [tris[i], tris[i + 1], tris[i + 2]];
    // earcut emits CCW triangles for a CCW outer ring: +Z normal on top.
    faces.push([
      { x: all[ia].x, y: all[ia].y, z: z1 },
      { x: all[ib].x, y: all[ib].y, z: z1 },
      { x: all[ic].x, y: all[ic].y, z: z1 },
    ]);
    faces.push([
      { x: all[ic].x, y: all[ic].y, z: z0 },
      { x: all[ib].x, y: all[ib].y, z: z0 },
      { x: all[ia].x, y: all[ia].y, z: z0 },
    ]);
  }
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      faces.push([
        { x: p.x, y: p.y, z: z0 },
        { x: q.x, y: q.y, z: z0 },
        { x: q.x, y: q.y, z: z1 },
        { x: p.x, y: p.y, z: z1 },
      ]);
    }
  }
  return faces;
}

/** All drill cutout rings: mounting holes/slots, TH pad drills (incl. pad slots), vias. */
export function drillRings(board: Board): Point[][] {
  const rings: Point[][] = [];
  for (const h of board.holes) {
    const { start, end } = holeSlotCenterline(h);
    rings.push(capsulePolygon(start, end, h.drill / 2));
  }
  for (const c of board.components) {
    for (const pad of c.footprint.pads) {
      if (!pad.drill) continue;
      const { at, rotation } = padWorld(c, pad);
      const d = pad.drill.diameter;
      const slotLen = pad.drill.slotLength ?? 0;
      if (slotLen > d) {
        const rad = (rotation * Math.PI) / 180;
        const half = (slotLen - d) / 2;
        const dx = Math.cos(rad) * half;
        const dy = Math.sin(rad) * half;
        rings.push(capsulePolygon({ x: at.x - dx, y: at.y - dy }, { x: at.x + dx, y: at.y + dy }, d / 2));
      } else {
        rings.push(capsulePolygon(at, at, d / 2));
      }
    }
  }
  for (const v of board.vias) {
    rings.push(capsulePolygon(v.at, v.at, v.drill / 2));
  }
  return rings;
}

function boardSolids(board: Board): Solid[] {
  const solids: Solid[] = [];
  let outer: Point[];
  try {
    outer = outlineToPolygon(board.outline);
  } catch {
    return solids; // no/malformed outline: nothing meaningful to export
  }
  solids.push({ name: board.name, faces: prismFaces(outer, drillRings(board), 0, BOARD_T) });

  for (const c of board.components) {
    const box = componentBox(c);
    if (!box) continue;
    const ring: Point[] = [
      { x: box.x0, y: box.y0 },
      { x: box.x1, y: box.y0 },
      { x: box.x1, y: box.y1 },
      { x: box.x0, y: box.y1 },
    ];
    const z0 = c.side === 'bottom' ? -box.h : BOARD_T;
    const z1 = c.side === 'bottom' ? 0 : BOARD_T + box.h;
    solids.push({ name: c.refdes, faces: prismFaces(ring, [], z0, z1) });
  }
  return solids;
}

// ---------------------------------------------------------------------------
// STEP writer
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  let s = n.toFixed(4);
  if (s.includes('.')) s = s.replace(/0+$/, '');
  if (s === '-0.' || s === '-0') s = '0.';
  if (!s.includes('.')) s += '.';
  return s;
}

function newellNormal(pts: P3[]): P3 {
  let x = 0,
    y = 0,
    z = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    x += (p.y - q.y) * (p.z + q.z);
    y += (p.z - q.z) * (p.x + q.x);
    z += (p.x - q.x) * (p.y + q.y);
  }
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

/** Serialize the board as an AP214 faceted-brep STEP file. */
export function exportStep(board: Board): string {
  const lines: string[] = [];
  let n = 0;
  const id = (entity: string): number => {
    n += 1;
    lines.push(`#${n}=${entity};`);
    return n;
  };

  const appCtx = id(`APPLICATION_CONTEXT('automotive design')`);
  id(`APPLICATION_PROTOCOL_DEFINITION('draft international standard','automotive_design',1998,#${appCtx})`);
  const prodCtx = id(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const name = board.name.replace(/'/g, '');
  const product = id(`PRODUCT('${name}','${name}','',(#${prodCtx}))`);
  const formation = id(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  const defCtx = id(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const prodDef = id(`PRODUCT_DEFINITION('design','',#${formation},#${defCtx})`);
  const prodShape = id(`PRODUCT_DEFINITION_SHAPE('','',#${prodDef})`);

  const lenUnit = id(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const angUnit = id(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const solidAngUnit = id(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const uncertainty = id(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.001),#${lenUnit},'distance_accuracy_value','')`,
  );
  const geomCtx = id(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnit},#${angUnit},#${solidAngUnit}))REPRESENTATION_CONTEXT('',''))`,
  );

  const worldOrigin = id(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const worldZ = id(`DIRECTION('',(0.,0.,1.))`);
  const worldX = id(`DIRECTION('',(1.,0.,0.))`);
  const worldAxis = id(`AXIS2_PLACEMENT_3D('',#${worldOrigin},#${worldZ},#${worldX})`);

  const brepIds: number[] = [];
  for (const solid of boardSolids(board)) {
    if (solid.faces.length === 0) continue;
    const pointIds = new Map<string, number>();
    const pt = (p: P3): number => {
      const key = `${fmt(p.x)},${fmt(p.y)},${fmt(p.z)}`;
      let existing = pointIds.get(key);
      if (existing === undefined) {
        existing = id(`CARTESIAN_POINT('',(${key}))`);
        pointIds.set(key, existing);
      }
      return existing;
    };

    const faceIds: number[] = [];
    for (const face of solid.faces) {
      const nrm = newellNormal(face);
      const e = {
        x: face[1].x - face[0].x,
        y: face[1].y - face[0].y,
        z: face[1].z - face[0].z,
      };
      const eLen = Math.hypot(e.x, e.y, e.z) || 1;
      const origin = id(`CARTESIAN_POINT('',(${fmt(face[0].x)},${fmt(face[0].y)},${fmt(face[0].z)}))`);
      const dirN = id(`DIRECTION('',(${fmt(nrm.x)},${fmt(nrm.y)},${fmt(nrm.z)}))`);
      const dirRef = id(`DIRECTION('',(${fmt(e.x / eLen)},${fmt(e.y / eLen)},${fmt(e.z / eLen)}))`);
      const axis = id(`AXIS2_PLACEMENT_3D('',#${origin},#${dirN},#${dirRef})`);
      const plane = id(`PLANE('',#${axis})`);
      const loop = id(`POLY_LOOP('',(${face.map((p) => `#${pt(p)}`).join(',')}))`);
      const bound = id(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      faceIds.push(id(`FACE_SURFACE('',(#${bound}),#${plane},.T.)`));
    }
    const shell = id(`CLOSED_SHELL('',(${faceIds.map((f) => `#${f}`).join(',')}))`);
    brepIds.push(id(`FACETED_BREP('${solid.name.replace(/'/g, '')}',#${shell})`));
  }

  const shapeRep = id(
    `SHAPE_REPRESENTATION('${name}',(#${worldAxis}${brepIds.map((b) => `,#${b}`).join('')}),#${geomCtx})`,
  );
  id(`SHAPE_DEFINITION_REPRESENTATION(#${prodShape},#${shapeRep})`);

  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('Flamingo PCB export'),'2;1');`,
    `FILE_NAME('${name}.step','',(''),(''),'Flamingo','Flamingo','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`,
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
