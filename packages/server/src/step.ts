/**
 * STEP (ISO 10303-21, AP214) export of the board as faceted B-rep solids,
 * in two flavours:
 *
 * `exportStep` (blocks): the board is an extruded prism of the outline
 * (1.6mm) with every drill (mounting holes, slots, through-hole pad drills,
 * vias) cut through it; each component is an extruded courtyard bounding box
 * at the per-package height heuristic shared with the 3D viewer —
 * mechanically accurate for enclosure work, not a cosmetic model.
 *
 * `exportStepDetail`: the same drilled board plus the real fab detail —
 * copper tracks/zone fills/pads/plated barrels, stroked silkscreen (line
 * work AND text via the Gerber legend stroke font), and each component's
 * real EasyEDA OBJ mesh (per-material solids, Kd colors), falling back to
 * the courtyard block when a part has no model.
 *
 * All solids are faceted B-rep (planar faces bounded by POLY_LOOPs) with
 * AP214 per-solid presentation colors; imports into FreeCAD / Fusion /
 * SolidWorks / Rhino as one part with named bodies.
 */

import earcut from 'earcut';
import type { Board, ComponentInst, Point } from '@flamingo/engine';
import {
  capsulePolygon,
  componentLabelPlacement,
  componentTransformPoints,
  componentTransformRotation,
  fillAllZones,
  holeSlotCenterline,
  outlineToPolygon,
  padOutline,
  padWorld,
  pointInPolygon,
} from '@flamingo/engine';
import { strokeText } from '@flamingo/fab';
import { arcPoints, BOARD_T, componentBox } from './viewer3d.js';
import type { MeshGroup } from './objmesh.js';

interface P3 {
  x: number;
  y: number;
  z: number;
}

type RGB = [number, number, number];

interface Solid {
  name: string;
  /** Planar faces, each a single outer loop of ≥3 vertices, outward-wound. */
  faces: P3[][];
  color?: RGB;
}

const CU_T = 0.035; // 1oz copper
const SILK_T = 0.012;

const COL_MASK: RGB = [0.29, 0.137, 0.251]; // purple solder mask
const COL_GOLD: RGB = [0.847, 0.71, 0.271]; // exposed pad finish (ENIG)
const COL_COPPER: RGB = [0.71, 0.573, 0.227]; // mask-side copper (tracks/zones)
const COL_SILK: RGB = [0.95, 0.93, 0.85];
const COL_BODY: RGB = [0.227, 0.239, 0.271]; // model-less component block
const BOX_COLORS: Record<string, RGB> = {
  conn: [0.812, 0.788, 0.722],
  hdr: [0.133, 0.133, 0.149],
  ant: [0.69, 0.188, 0.188],
};

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

function boardPrism(board: Board): Solid | null {
  let outer: Point[];
  try {
    outer = outlineToPolygon(board.outline);
  } catch {
    return null; // no/malformed outline: nothing meaningful to export
  }
  return { name: board.name, faces: prismFaces(outer, drillRings(board), 0, BOARD_T), color: COL_MASK };
}

function componentBlock(c: ComponentInst): Solid | null {
  const box = componentBox(c);
  if (!box) return null;
  const ring: Point[] = [
    { x: box.x0, y: box.y0 },
    { x: box.x1, y: box.y0 },
    { x: box.x1, y: box.y1 },
    { x: box.x0, y: box.y1 },
  ];
  const z0 = c.side === 'bottom' ? -box.h : BOARD_T;
  const z1 = c.side === 'bottom' ? 0 : BOARD_T + box.h;
  const kind = /^(J|H)/.test(c.refdes) ? (c.refdes.startsWith('H') ? 'hdr' : 'conn') : c.refdes === 'ANT1' ? 'ant' : 'part';
  return { name: c.refdes, faces: prismFaces(ring, [], z0, z1), color: BOX_COLORS[kind] ?? COL_BODY };
}

function boardSolids(board: Board): Solid[] {
  const solids: Solid[] = [];
  const prism = boardPrism(board);
  if (!prism) return solids;
  solids.push(prism);
  for (const c of board.components) {
    const block = componentBlock(c);
    if (block) solids.push(block);
  }
  return solids;
}

// ---------------------------------------------------------------------------
// Detail-mode solids: copper, silkscreen, real component meshes.
// ---------------------------------------------------------------------------

function circleRing(at: Point, radius: number): Point[] {
  return capsulePolygon(at, at, radius);
}

/**
 * Cap a tessellated ring's point count for STEP output — the engine's
 * chord-error tessellation (≥16 pts per circle) is screen detail that turns
 * into tens of MB across thousands of tiny stroke capsules. Keeps every k-th
 * point (rings are convex-ish and closed, so thinning stays well-formed).
 */
function thinRing(ring: Point[], maxPts: number): Point[] {
  if (ring.length <= maxPts) return ring;
  const k = Math.ceil(ring.length / maxPts);
  const out: Point[] = [];
  for (let i = 0; i < ring.length; i += k) out.push(ring[i]);
  return out;
}

/**
 * Copper + silk + component solids for the detail export. `models` maps
 * refdes → world-placed per-material mesh groups (see objmesh.ts); parts
 * without an entry fall back to their courtyard block.
 */
function detailSolids(board: Board, models: Map<string, MeshGroup[]>): Solid[] {
  const solids: Solid[] = [];
  const prism = boardPrism(board);
  if (!prism) return solids;
  solids.push(prism);

  const pushPrism = (name: string, ring: Point[], holes: Point[][], z0: number, z1: number, color: RGB): void => {
    const faces = prismFaces(ring, holes, z0, z1);
    if (faces.length) solids.push({ name, faces, color });
  };

  // ---- copper: tracks, zone fills, pads, plated barrels ----
  for (const t of board.tracks) {
    if (t.layer !== 'F.Cu' && t.layer !== 'B.Cu') continue;
    const top = t.layer === 'F.Cu';
    const z0 = top ? BOARD_T : -CU_T;
    const pts = t.seg.type === 'line' ? [t.seg.start, t.seg.end] : arcPoints(t.seg.start, t.seg.end, t.seg.center, t.seg.cw);
    for (let i = 0; i < pts.length - 1; i++) {
      pushPrism(t.layer, thinRing(capsulePolygon(pts[i], pts[i + 1], t.width / 2), 14), [], z0, z0 + CU_T, COL_COPPER);
    }
  }

  // Zone fills, with mounting holes punched where an island fully contains
  // them (same containment rule as the 3D viewer).
  const holeCuts = board.holes.map((h) => {
    const { start, end } = holeSlotCenterline(h);
    return { ring: capsulePolygon(start, end, h.drill / 2), at: h.at };
  });
  const filled = fillAllZones(board);
  for (const z of filled.zones) {
    if (z.layer !== 'F.Cu' && z.layer !== 'B.Cu') continue;
    const top = z.layer === 'F.Cu';
    const islands = z.fill && z.fill.length > 0 ? z.fill : [z.polygon];
    for (const poly of islands) {
      if (poly.length < 3) continue;
      const holes = holeCuts
        .filter((h) => pointInPolygon(h.at, poly) && h.ring.every((p) => pointInPolygon(p, poly)))
        .map((h) => h.ring);
      pushPrism(z.layer, poly, holes, top ? BOARD_T : -CU_T, top ? BOARD_T + CU_T : 0, COL_COPPER);
    }
  }

  const barrels: { at: Point; r: number; drill: number }[] = [];
  for (const c of board.components) {
    for (const pad of c.footprint.pads) {
      const ring = thinRing(padOutline(c, pad), 20);
      if (ring.length >= 3) {
        if (pad.layer === 'through') {
          pushPrism(`${c.refdes}.${pad.number}`, ring, [], BOARD_T, BOARD_T + CU_T + 0.01, COL_GOLD);
          pushPrism(`${c.refdes}.${pad.number}`, ring, [], -CU_T - 0.01, 0, COL_GOLD);
        } else {
          const onTop = (pad.layer === 'top') !== (c.side === 'bottom');
          pushPrism(`${c.refdes}.${pad.number}`, ring, [], onTop ? BOARD_T : -CU_T - 0.01, onTop ? BOARD_T + CU_T + 0.01 : 0, COL_GOLD);
        }
      }
      if (pad.drill && (pad.drill.slotLength ?? 0) <= pad.drill.diameter) {
        const [at] = componentTransformPoints(c, [pad.at]);
        barrels.push({ at, r: pad.drill.diameter / 2 + 0.15, drill: pad.drill.diameter / 2 });
      }
    }
  }
  for (const h of board.holes) {
    const { start, end } = holeSlotCenterline(h);
    if (h.plated && start.x === end.x && start.y === end.y) {
      barrels.push({ at: h.at, r: h.drill / 2 + 0.2, drill: h.drill / 2 });
    }
  }
  for (const v of board.vias) {
    barrels.push({ at: v.at, r: v.diameter / 2, drill: v.drill / 2 });
  }
  for (const b of barrels) {
    pushPrism('barrel', thinRing(circleRing(b.at, b.r), 14), [thinRing(circleRing(b.at, b.drill), 12)], -CU_T, BOARD_T + CU_T, COL_GOLD);
  }

  // ---- silkscreen: stroked line work + stroke-font text ----
  const silkStroke = (a: Point, b: Point, width: number, top: boolean): void => {
    const ring = thinRing(capsulePolygon(a, b, Math.max(width, 0.1) / 2), 10);
    pushPrism(top ? 'F.Silk' : 'B.Silk', ring, [], top ? BOARD_T : -CU_T - SILK_T, top ? BOARD_T + CU_T + SILK_T : 0, COL_SILK);
  };
  const silkPolys = (polys: Point[][], width: number, top: boolean): void => {
    for (const poly of polys) {
      for (let i = 0; i < poly.length - 1; i++) silkStroke(poly[i], poly[i + 1], width, top);
    }
  };
  for (const c of board.components) {
    const top = c.side !== 'bottom';
    const mirror = c.side === 'bottom';
    for (const item of c.footprint.silk) {
      if (item.kind === 'line') {
        const [a, b] = componentTransformPoints(c, [item.start, item.end]);
        silkStroke(a, b, item.width, top);
      } else if (item.kind === 'arc') {
        const [ws, we, wc] = componentTransformPoints(c, [item.start, item.end, item.center]);
        const pts = arcPoints(ws, we, wc, mirror ? !item.cw : item.cw);
        for (let i = 0; i < pts.length - 1; i++) silkStroke(pts[i], pts[i + 1], item.width, top);
      } else if (item.kind === 'circle') {
        const [wc] = componentTransformPoints(c, [item.center]);
        const pts = arcPoints({ x: wc.x + item.radius, y: wc.y }, { x: wc.x + item.radius, y: wc.y }, wc, false);
        for (let i = 0; i < pts.length - 1; i++) silkStroke(pts[i], pts[i + 1], item.width, top);
      } else if (item.kind === 'text') {
        const [at] = componentTransformPoints(c, [item.at]);
        const rot = componentTransformRotation(c, item.rotation);
        silkPolys(strokeText(item.text, at, item.height, rot, mirror), Math.max(0.12, item.height * 0.12), top);
      }
    }
    // Refdes label, same anchor + stroke width as the Gerber legend.
    const lp = componentLabelPlacement(board, c);
    silkPolys(strokeText(c.refdes, lp.at, lp.height, lp.rotation, mirror), 0.15, top);
  }
  for (const line of board.silkLines) {
    silkStroke(line.start, line.end, line.width, line.layer !== 'B.Silk');
  }
  for (const s of board.silk) {
    const top = s.layer !== 'B.Silk';
    silkPolys(strokeText(s.text, s.at, s.height, s.rotation, !top), Math.max(0.12, s.height * 0.12), top);
  }

  // ---- components: real meshes (per-material solids), else courtyard block ----
  for (const c of board.components) {
    const groups = models.get(c.refdes);
    if (groups && groups.length > 0) {
      for (const g of groups) {
        if (g.tris.length === 0) continue;
        solids.push({
          name: c.refdes,
          faces: g.tris.map((t) => t.map((p) => ({ x: p.x, y: p.y, z: p.z }))),
          color: g.color ?? COL_BODY,
        });
      }
    } else {
      const block = componentBlock(c);
      if (block) solids.push(block);
    }
  }

  return solids;
}

// ---------------------------------------------------------------------------
// STEP writer
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  let s = n.toFixed(3); // 1µm — resolution noise beyond that just bloats the file
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

/** Serialize solids as an AP214 faceted-brep STEP file with per-solid colors. */
function writeStep(name: string, solids: Solid[]): string {
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
  const styledIds: number[] = [];
  // One shared presentation style per distinct color.
  const styleCache = new Map<string, number>();
  const styleFor = (c: RGB): number => {
    const key = c.map(fmt).join(',');
    let psa = styleCache.get(key);
    if (psa === undefined) {
      const col = id(`COLOUR_RGB('',${key})`);
      const fasc = id(`FILL_AREA_STYLE_COLOUR('',#${col})`);
      const fas = id(`FILL_AREA_STYLE('',(#${fasc}))`);
      const sfa = id(`SURFACE_STYLE_FILL_AREA(#${fas})`);
      const sss = id(`SURFACE_SIDE_STYLE('',(#${sfa}))`);
      const ssu = id(`SURFACE_STYLE_USAGE(.BOTH.,#${sss})`);
      psa = id(`PRESENTATION_STYLE_ASSIGNMENT((#${ssu}))`);
      styleCache.set(key, psa);
    }
    return psa;
  };

  for (const solid of solids) {
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
    const dirIds = new Map<string, number>();
    const dir = (x: number, y: number, z: number): number => {
      const key = `${fmt(x)},${fmt(y)},${fmt(z)}`;
      let existing = dirIds.get(key);
      if (existing === undefined) {
        existing = id(`DIRECTION('',(${key}))`);
        dirIds.set(key, existing);
      }
      return existing;
    };

    const faceIds: number[] = [];
    for (const face of solid.faces) {
      const nrm = newellNormal(face);
      if (!Number.isFinite(nrm.x + nrm.y + nrm.z)) continue;
      const e = {
        x: face[1].x - face[0].x,
        y: face[1].y - face[0].y,
        z: face[1].z - face[0].z,
      };
      const eLen = Math.hypot(e.x, e.y, e.z) || 1;
      const axis = id(
        `AXIS2_PLACEMENT_3D('',#${pt(face[0])},#${dir(nrm.x, nrm.y, nrm.z)},#${dir(e.x / eLen, e.y / eLen, e.z / eLen)})`,
      );
      const plane = id(`PLANE('',#${axis})`);
      const loop = id(`POLY_LOOP('',(${face.map((p) => `#${pt(p)}`).join(',')}))`);
      const bound = id(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      faceIds.push(id(`FACE_SURFACE('',(#${bound}),#${plane},.T.)`));
    }
    if (faceIds.length === 0) continue;
    const shell = id(`CLOSED_SHELL('',(${faceIds.map((f) => `#${f}`).join(',')}))`);
    const brep = id(`FACETED_BREP('${solid.name.replace(/'/g, '')}',#${shell})`);
    brepIds.push(brep);
    if (solid.color) {
      styledIds.push(id(`STYLED_ITEM('',(#${styleFor(solid.color)}),#${brep})`));
    }
  }

  const shapeRep = id(
    `SHAPE_REPRESENTATION('${name}',(#${worldAxis}${brepIds.map((b) => `,#${b}`).join('')}),#${geomCtx})`,
  );
  id(`SHAPE_DEFINITION_REPRESENTATION(#${prodShape},#${shapeRep})`);
  if (styledIds.length > 0) {
    id(
      `MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styledIds.map((s) => `#${s}`).join(',')}),#${geomCtx})`,
    );
  }

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

/** Blocks flavour: drilled board prism + courtyard-box component bodies. */
export function exportStep(board: Board): string {
  return writeStep(board.name.replace(/'/g, ''), boardSolids(board));
}

/**
 * Detail flavour: drilled board + copper + silkscreen + real component
 * meshes. `models` maps refdes → world-placed mesh groups (objmesh.ts);
 * pass an empty map to fall back to blocks for every part.
 */
export function exportStepDetail(board: Board, models: Map<string, MeshGroup[]>): string {
  return writeStep(board.name.replace(/'/g, ''), detailSolids(board, models));
}
