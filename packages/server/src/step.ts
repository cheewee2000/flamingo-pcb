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
 * All solids are true B-rep (MANIFOLD_SOLID_BREP of ADVANCED_FACEs with
 * shared vertex/edge topology): drills, vias, round pads, track ends and
 * arcs are real CIRCLE edges on CYLINDRICAL_SURFACEs, caps are single
 * planar faces with hole bounds — not triangle soups. Component OBJ meshes
 * are the one exception: they are triangle meshes at the source and stay
 * triangle-faced (but still topologically stitched solids). AP214 per-solid
 * presentation colors; imports into FreeCAD / Fusion / SolidWorks / Rhino
 * as one part with named solid bodies.
 */

import type { Board, ComponentInst, Pad, Point } from "@flamingo/engine";
import {
  bboxOf,
  capsulePolygon,
  componentLabelPlacement,
  componentLabelHidden,
  componentSilkHidden,
  componentTransformPoints,
  componentTransformRotation,
  fillAllZones,
  holeSlotCenterline,
  allHoles,
  outlineToPolygon,
  padOutline,
  padWorld,
  pointInPolygon,
} from "@flamingo/engine";
import { strokeText } from "@flamingo/fab";
import type { MeshGroup } from "./objmesh.js";
import type { ExportInclude, ExportSide } from "./export-opts.js";
import { INCLUDE_ALL } from "./export-opts.js";

/**
 * Which elements to emit. Omitted fields default to everything, both sides —
 * the output before options existed. A hole class that is off is not cut
 * through the board (and gets no plated barrel in the detail flavour);
 * `side` limits the component bodies to parts on that side.
 */
export interface StepOptions {
  include?: Partial<ExportInclude>;
  side?: ExportSide;
}

function resolveOptions(opts: StepOptions): {
  inc: ExportInclude;
  side: ExportSide;
} {
  return { inc: { ...INCLUDE_ALL, ...opts.include }, side: opts.side ?? "both" };
}

function onSide(c: ComponentInst, side: ExportSide): boolean {
  return side === "both" || (c.side === "bottom") === (side === "bottom");
}

export const BOARD_T = 1.6;

function componentHeight(c: ComponentInst): number {
  const r = c.refdes;
  const v = c.fields?.value ?? "";
  const fp = c.footprint.name ?? "";
  if (r.startsWith("H") && /2\.54|WALTER|HDR/i.test(fp + " " + v)) return 8.5;
  if (/USB/i.test(fp + " " + v)) return 3.2;
  if (/JST|SH-?1|BATT|LRA/i.test(fp + " " + v)) return 4.3;
  if (/UFL|U\.FL|IPEX/i.test(fp + " " + v)) return 2.5;
  if (/FPC/i.test(fp + " " + v)) return 2.0;
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

/**
 * World-space axis-aligned body box for a component: courtyard rings (or pad
 * outlines when the footprint has no courtyard) through the full component
 * transform (mirror + rotation + translation), plus the height heuristic.
 */
export function componentBox(
  c: ComponentInst,
): { x0: number; y0: number; x1: number; y1: number; h: number } | null {
  // Bare-pad footprints (test points, fiducials) have no physical body — the
  // pad itself is the whole part. No body box in STEP.
  if (c.footprint.pads.length <= 1 && c.footprint.silk.length === 0)
    return null;
  const pts: Point[] = [];
  for (const ring of c.footprint.courtyard ?? [])
    pts.push(...componentTransformPoints(c, ring));
  if (pts.length === 0)
    for (const pad of c.footprint.pads) pts.push(...padOutline(c, pad));
  if (pts.length === 0) return null;
  const bb = bboxOf(pts);
  if (!(bb.maxX > bb.minX) || !(bb.maxY > bb.minY)) return null;
  return {
    x0: bb.minX,
    y0: bb.minY,
    x1: bb.maxX,
    y1: bb.maxY,
    h: componentHeight(c),
  };
}

// ---------------------------------------------------------------------------
// 2D loops with true arcs
// ---------------------------------------------------------------------------

interface Arc {
  center: Point;
  cw: boolean;
}
/** One loop vertex; `arc` makes the edge to the NEXT vertex a circular arc. */
interface Seg {
  a: Point;
  arc?: Arc;
}
/** Closed loop; the last vertex's edge returns to the first. */
type Loop = Seg[];

interface P3 {
  x: number;
  y: number;
  z: number;
}

type RGB = [number, number, number];

type Surface =
  | { kind: "plane"; origin: P3; normal: P3; ref: P3 }
  | {
      kind: "cylinder";
      center: Point;
      z: number;
      r: number;
      sameSense: boolean;
    };
/** 3D face loop vertex; `arc` (horizontal, about `center` at this z) applies to the edge to the next vertex. */
interface FV {
  p: P3;
  arc?: Arc;
}
interface Face {
  /** loops[0] is the outer bound; the rest are holes. */
  loops: FV[][];
  surface: Surface;
}

interface Solid {
  name: string;
  faces: Face[];
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

const TWO_PI = 2 * Math.PI;

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}
function dist2(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Sweep angle (0, 2π] from a to b about center in the arc's direction; a≈b is a full circle. */
function arcSweep(a: Point, b: Point, arc: Arc): number {
  const a0 = Math.atan2(a.y - arc.center.y, a.x - arc.center.x);
  const a1 = Math.atan2(b.y - arc.center.y, b.x - arc.center.x);
  const sweep = (((arc.cw ? a0 - a1 : a1 - a0) % TWO_PI) + TWO_PI) % TWO_PI;
  return sweep < 1e-9 ? TWO_PI : sweep;
}

function arcMid(a: Point, b: Point, arc: Arc): Point {
  const r = dist2(a, arc.center);
  const ang =
    Math.atan2(a.y - arc.center.y, a.x - arc.center.x) +
    (arc.cw ? -1 : 1) * (arcSweep(a, b, arc) / 2);
  return {
    x: arc.center.x + r * Math.cos(ang),
    y: arc.center.y + r * Math.sin(ang),
  };
}

function lineLoop(pts: Point[]): Loop {
  return pts.map((a) => ({ a }));
}

/** Circle as two CCW semicircles (a full-circle edge would share its two vertices). */
function circleLoop(c: Point, r: number): Loop {
  const ccw = { center: c, cw: false };
  return [
    { a: { x: c.x + r, y: c.y }, arc: ccw },
    { a: { x: c.x - r, y: c.y }, arc: ccw },
  ];
}

/** Stadium: two straight sides + two semicircular caps (CCW). */
function capsuleLoop(s: Point, e: Point, r: number): Loop {
  const len = dist2(s, e);
  if (len < 1e-9) return circleLoop(s, r);
  const d = { x: (e.x - s.x) / len, y: (e.y - s.y) / len };
  const n = { x: -d.y * r, y: d.x * r };
  return [
    { a: sub(s, n) },
    { a: sub(e, n), arc: { center: e, cw: false } },
    { a: { x: e.x + n.x, y: e.y + n.y } },
    { a: { x: s.x + n.x, y: s.y + n.y }, arc: { center: s, cw: false } },
  ];
}

/** Stroked circular arc: outer arc, end cap, inner arc, start cap. */
function arcStrokeLoop(
  start: Point,
  end: Point,
  center: Point,
  cw: boolean,
  hw: number,
): Loop {
  const r = dist2(start, center);
  if (r - hw <= 0.02) return circleLoop(center, r + hw); // stroke (nearly) wider than the arc radius: the disk is the stroke
  // Normalize to a CCW arc S→E about center.
  const [S, E] = cw ? [end, start] : [start, end];
  const u = (p: Point, k: number): Point => ({
    x: center.x + (p.x - center.x) * k,
    y: center.y + (p.y - center.y) * k,
  });
  const ko = (r + hw) / r;
  const ki = (r - hw) / r;
  return [
    { a: u(S, ko), arc: { center, cw: false } }, // outer arc S→E
    { a: u(E, ko), arc: { center: E, cw: false } }, // end cap
    { a: u(E, ki), arc: { center, cw: true } }, // inner arc E→S
    { a: u(S, ki), arc: { center: S, cw: false } }, // start cap
  ];
}

/** Board outline PathSegs → loop (arcs kept; >180° arcs split so no edge is a near-full circle). */
function outlineLoop(outline: Board["outline"]): Loop {
  const loop: Loop = [];
  for (const seg of outline) {
    if (seg.type === "line") {
      loop.push({ a: seg.start });
      continue;
    }
    const arc = { center: seg.center, cw: seg.cw };
    if (arcSweep(seg.start, seg.end, arc) > Math.PI + 1e-9) {
      loop.push(
        { a: seg.start, arc },
        { a: arcMid(seg.start, seg.end, arc), arc },
      );
    } else {
      loop.push({ a: seg.start, arc });
    }
  }
  return loop;
}

/** Footprint-local loop through the component transform (mirror flips arc direction). */
function transformLoop(c: ComponentInst, loop: Loop): Loop {
  const mirror = c.side === "bottom";
  const pts = componentTransformPoints(
    c,
    loop.map((s) => s.a),
  );
  const centers = componentTransformPoints(
    c,
    loop.map((s) => s.arc?.center ?? s.a),
  );
  return loop.map((s, i) =>
    s.arc
      ? {
          a: pts[i],
          arc: { center: centers[i], cw: mirror ? !s.arc.cw : s.arc.cw },
        }
      : { a: pts[i] },
  );
}

/** World-space pad loop with true circle/oval arcs (rect/polygon stay line loops). */
function padLoop(c: ComponentInst, pad: Pad): Loop {
  let local: Loop;
  const { w, h } = pad.size;
  if (pad.shape === "circle") local = circleLoop({ x: 0, y: 0 }, w / 2);
  else if (pad.shape === "oval") {
    const r = Math.min(w, h) / 2;
    const half = (Math.max(w, h) - Math.min(w, h)) / 2;
    local =
      w >= h
        ? capsuleLoop({ x: -half, y: 0 }, { x: half, y: 0 }, r)
        : capsuleLoop({ x: 0, y: -half }, { x: 0, y: half }, r);
  } else local = lineLoop(padOutline(c, pad)); // already world-space
  if (pad.shape === "rect" || pad.shape === "polygon") return local;
  const rad = (pad.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const xf = (p: Point): Point => ({
    x: p.x * cos - p.y * sin + pad.at.x,
    y: p.x * sin + p.y * cos + pad.at.y,
  });
  return transformLoop(
    c,
    local.map((s) =>
      s.arc
        ? { a: xf(s.a), arc: { center: xf(s.arc.center), cw: s.arc.cw } }
        : { a: xf(s.a) },
    ),
  );
}

/** Signed area (CCW positive), arcs' circular segments included. */
function loopArea(loop: Loop): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    s += p.a.x * q.a.y - q.a.x * p.a.y;
    if (p.arc) {
      const r = dist2(p.a, p.arc.center);
      const th = arcSweep(p.a, q.a, p.arc);
      s += (p.arc.cw ? -1 : 1) * r * r * (th - Math.sin(th));
    }
  }
  return s / 2;
}

function reverseLoop(loop: Loop): Loop {
  const n = loop.length;
  return loop.map((_, i) => {
    const s = loop[(n - i) % n]; // vertex
    const prev = loop[(n - i - 1) % n]; // edge that led into it, now leaving it
    return prev.arc
      ? { a: s.a, arc: { center: prev.arc.center, cw: !prev.arc.cw } }
      : { a: s.a };
  });
}

/** Drop consecutive duplicate vertices (incl. a repeated closing point) and degenerate loops. */
function cleanLoop(loop: Loop): Loop {
  const out: Loop = [];
  for (const s of loop) {
    if (out.length && dist2(out[out.length - 1].a, s.a) < 1e-6) continue;
    out.push(s);
  }
  while (out.length > 1 && dist2(out[0].a, out[out.length - 1].a) < 1e-6)
    out.pop();
  const minVerts = out.some((s) => s.arc) ? 2 : 3;
  return out.length >= minVerts ? out : [];
}

// ---------------------------------------------------------------------------
// Solids
// ---------------------------------------------------------------------------

const UP: P3 = { x: 0, y: 0, z: 1 };
const XD: P3 = { x: 1, y: 0, z: 0 };

/**
 * Extrude an outer loop with hole loops from z0 to z1: one planar cap per
 * end (holes as inner bounds), one wall face per edge — a plane for a line
 * edge, a cylinder patch for an arc edge.
 */
function prismFaces(
  outerIn: Loop,
  holesIn: Loop[],
  z0: number,
  z1: number,
): Face[] {
  let outer = cleanLoop(outerIn);
  if (outer.length === 0) return [];
  if (loopArea(outer) < 0) outer = reverseLoop(outer); // outer CCW, material on the left
  const holes = holesIn
    .map(cleanLoop)
    .filter((h) => h.length > 0)
    .map((h) => (loopArea(h) > 0 ? reverseLoop(h) : h));
  const rings = [outer, ...holes];
  const at = (s: Seg, z: number): FV =>
    s.arc
      ? { p: { x: s.a.x, y: s.a.y, z }, arc: s.arc }
      : { p: { x: s.a.x, y: s.a.y, z } };

  const faces: Face[] = [
    {
      loops: rings.map((r) => r.map((s) => at(s, z1))),
      surface: {
        kind: "plane",
        origin: { ...outer[0].a, z: z1 },
        normal: UP,
        ref: XD,
      },
    },
    {
      loops: rings.map((r) => reverseLoop(r).map((s) => at(s, z0))),
      surface: {
        kind: "plane",
        origin: { ...outer[0].a, z: z0 },
        normal: { x: 0, y: 0, z: -1 },
        ref: XD,
      },
    },
  ];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const loop: FV[] = [
        at(a, z0),
        { p: { x: b.a.x, y: b.a.y, z: z0 } },
        a.arc
          ? {
              p: { x: b.a.x, y: b.a.y, z: z1 },
              arc: { center: a.arc.center, cw: !a.arc.cw },
            }
          : { p: { x: b.a.x, y: b.a.y, z: z1 } },
        { p: { x: a.a.x, y: a.a.y, z: z1 } },
      ];
      if (a.arc) {
        faces.push({
          loops: [loop],
          surface: {
            kind: "cylinder",
            center: a.arc.center,
            z: z0,
            r: dist2(a.a, a.arc.center),
            sameSense: !a.arc.cw,
          },
        });
      } else {
        const len = dist2(a.a, b.a);
        const d = { x: (b.a.x - a.a.x) / len, y: (b.a.y - a.a.y) / len };
        faces.push({
          loops: [loop],
          surface: {
            kind: "plane",
            origin: { ...a.a, z: z0 },
            normal: { x: d.y, y: -d.x, z: 0 },
            ref: { ...d, z: 0 },
          },
        });
      }
    }
  }
  return faces;
}

/**
 * Drill cutout loops: mounting holes/slots (`mnt`), TH pad drills incl. pad
 * slots (`pth`), vias (`vias`). Each class is cut only when it is included.
 */
function drillLoops(board: Board, inc: ExportInclude): Loop[] {
  const loops: Loop[] = [];
  for (const h of inc.mnt ? allHoles(board) : []) {
    const { start, end } = holeSlotCenterline(h);
    loops.push(capsuleLoop(start, end, h.drill / 2));
  }
  for (const c of inc.pth ? board.components : []) {
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
        loops.push(
          capsuleLoop(
            { x: at.x - dx, y: at.y - dy },
            { x: at.x + dx, y: at.y + dy },
            d / 2,
          ),
        );
      } else {
        loops.push(circleLoop(at, d / 2));
      }
    }
  }
  for (const v of inc.vias ? board.vias : [])
    loops.push(circleLoop(v.at, v.drill / 2));
  return loops;
}

/** True when the board has a closed outline the exports can use. */
function hasOutline(board: Board): boolean {
  try {
    return outlineToPolygon(board.outline).length >= 3; // validates closure/gaps
  } catch {
    return false;
  }
}

function boardPrism(board: Board, inc: ExportInclude): Solid | null {
  try {
    outlineToPolygon(board.outline); // validates closure/gaps
  } catch {
    return null; // no/malformed outline: nothing meaningful to export
  }
  return {
    name: board.name,
    faces: prismFaces(
      outlineLoop(board.outline),
      drillLoops(board, inc),
      0,
      BOARD_T,
    ),
    color: COL_MASK,
  };
}

function componentBlock(c: ComponentInst): Solid | null {
  const box = componentBox(c);
  if (!box) return null;
  const ring = lineLoop([
    { x: box.x0, y: box.y0 },
    { x: box.x1, y: box.y0 },
    { x: box.x1, y: box.y1 },
    { x: box.x0, y: box.y1 },
  ]);
  const z0 = c.side === "bottom" ? -box.h : BOARD_T;
  const z1 = c.side === "bottom" ? 0 : BOARD_T + box.h;
  const kind = /^(J|H)/.test(c.refdes)
    ? c.refdes.startsWith("H")
      ? "hdr"
      : "conn"
    : c.refdes === "ANT1"
      ? "ant"
      : "part";
  return {
    name: c.refdes,
    faces: prismFaces(ring, [], z0, z1),
    color: BOX_COLORS[kind] ?? COL_BODY,
  };
}

function boardSolids(board: Board, opts: StepOptions): Solid[] {
  const { inc, side } = resolveOptions(opts);
  const solids: Solid[] = [];
  if (!hasOutline(board)) return solids;
  if (inc.board) {
    const prism = boardPrism(board, inc);
    if (prism) solids.push(prism);
  }
  for (const c of inc.comps ? board.components : []) {
    if (!onSide(c, side)) continue;
    const block = componentBlock(c);
    if (block) solids.push(block);
  }
  return solids;
}

// ---------------------------------------------------------------------------
// Detail-mode solids: copper, silkscreen, real component meshes.
// ---------------------------------------------------------------------------

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
  const len = Math.hypot(x, y, z);
  return { x: x / len, y: y / len, z: z / len };
}

/** Triangle soup → planar faces (edges get stitched by the writer's vertex/edge dedupe). */
function meshFaces(tris: { x: number; y: number; z: number }[][]): Face[] {
  const faces: Face[] = [];
  for (const t of tris) {
    const nrm = newellNormal(t);
    if (!Number.isFinite(nrm.x + nrm.y + nrm.z)) continue; // degenerate
    const e = { x: t[1].x - t[0].x, y: t[1].y - t[0].y, z: t[1].z - t[0].z };
    const eLen = Math.hypot(e.x, e.y, e.z);
    if (eLen < 1e-6) continue;
    faces.push({
      loops: [t.map((p) => ({ p: { x: p.x, y: p.y, z: p.z } }))],
      surface: {
        kind: "plane",
        origin: { x: t[0].x, y: t[0].y, z: t[0].z },
        normal: nrm,
        ref: { x: e.x / eLen, y: e.y / eLen, z: e.z / eLen },
      },
    });
  }
  return faces;
}

/**
 * Copper + silk + component solids for the detail export. `models` maps
 * refdes → world-placed per-material mesh groups (see objmesh.ts); parts
 * without an entry fall back to their courtyard block.
 */
function detailSolids(
  board: Board,
  models: Map<string, MeshGroup[]>,
  opts: StepOptions,
): Solid[] {
  const { inc, side } = resolveOptions(opts);
  const solids: Solid[] = [];
  if (!hasOutline(board)) return solids;
  if (inc.board) {
    const prism = boardPrism(board, inc);
    if (prism) solids.push(prism);
  }

  const pushPrism = (
    name: string,
    outer: Loop,
    holes: Loop[],
    z0: number,
    z1: number,
    color: RGB,
  ): void => {
    const faces = prismFaces(outer, holes, z0, z1);
    if (faces.length) solids.push({ name, faces, color });
  };
  const strokeLoop = (seg: Board["tracks"][number]["seg"], hw: number): Loop =>
    seg.type === "line"
      ? capsuleLoop(seg.start, seg.end, hw)
      : arcStrokeLoop(seg.start, seg.end, seg.center, seg.cw, hw);

  // ---- copper: tracks, zone fills, pads (with the board), plated barrels (per hole class) ----
  for (const t of inc.board ? board.tracks : []) {
    if (t.layer !== "F.Cu" && t.layer !== "B.Cu") continue;
    const z0 = t.layer === "F.Cu" ? BOARD_T : -CU_T;
    pushPrism(
      t.layer,
      strokeLoop(t.seg, t.width / 2),
      [],
      z0,
      z0 + CU_T,
      COL_COPPER,
    );
  }

  // Zone fills, with mounting holes punched where an island fully contains
  // them (same containment rule as the 3D viewer).
  const holeCuts = (inc.mnt ? allHoles(board) : []).map((h) => {
    const { start, end } = holeSlotCenterline(h);
    return {
      ring: capsulePolygon(start, end, h.drill / 2),
      loop: capsuleLoop(start, end, h.drill / 2),
      at: h.at,
    };
  });
  for (const z of inc.board ? fillAllZones(board).zones : []) {
    if (z.layer !== "F.Cu" && z.layer !== "B.Cu") continue;
    const top = z.layer === "F.Cu";
    const islands = z.fill && z.fill.length > 0 ? z.fill : [z.polygon];
    for (const poly of islands) {
      if (poly.length < 3) continue;
      const holes = holeCuts
        .filter(
          (h) =>
            pointInPolygon(h.at, poly) &&
            h.ring.every((p) => pointInPolygon(p, poly)),
        )
        .map((h) => h.loop);
      pushPrism(
        z.layer,
        lineLoop(poly),
        holes,
        top ? BOARD_T : -CU_T,
        top ? BOARD_T + CU_T : 0,
        COL_COPPER,
      );
    }
  }

  const barrels: { at: Point; r: number; drill: number }[] = [];
  for (const c of board.components) {
    for (const pad of c.footprint.pads) {
      const ring = padLoop(c, pad);
      if (!inc.board) {
        // no copper without the board
      } else if (pad.layer === "through") {
        pushPrism(
          `${c.refdes}.${pad.number}`,
          ring,
          [],
          BOARD_T,
          BOARD_T + CU_T + 0.01,
          COL_GOLD,
        );
        pushPrism(
          `${c.refdes}.${pad.number}`,
          ring,
          [],
          -CU_T - 0.01,
          0,
          COL_GOLD,
        );
      } else {
        const onTop = (pad.layer === "top") !== (c.side === "bottom");
        pushPrism(
          `${c.refdes}.${pad.number}`,
          ring,
          [],
          onTop ? BOARD_T : -CU_T - 0.01,
          onTop ? BOARD_T + CU_T + 0.01 : 0,
          COL_GOLD,
        );
      }
      if (
        inc.pth &&
        pad.drill &&
        (pad.drill.slotLength ?? 0) <= pad.drill.diameter
      ) {
        const [at] = componentTransformPoints(c, [pad.at]);
        barrels.push({
          at,
          r: pad.drill.diameter / 2 + 0.15,
          drill: pad.drill.diameter / 2,
        });
      }
    }
  }
  for (const h of inc.mnt ? allHoles(board) : []) {
    const { start, end } = holeSlotCenterline(h);
    if (h.plated && start.x === end.x && start.y === end.y) {
      barrels.push({ at: h.at, r: h.drill / 2 + 0.2, drill: h.drill / 2 });
    }
  }
  for (const v of inc.vias ? board.vias : []) {
    barrels.push({ at: v.at, r: v.diameter / 2, drill: v.drill / 2 });
  }
  for (const b of barrels) {
    pushPrism(
      "barrel",
      circleLoop(b.at, b.r),
      [circleLoop(b.at, b.drill)],
      -CU_T,
      BOARD_T + CU_T,
      COL_GOLD,
    );
  }

  // ---- silkscreen: stroked line work + stroke-font text ----
  const silkZ = (top: boolean): [number, number] =>
    top ? [BOARD_T, BOARD_T + CU_T + SILK_T] : [-CU_T - SILK_T, 0];
  const silk = (
    name: string,
    loop: Loop,
    holes: Loop[],
    top: boolean,
  ): void => {
    const [z0, z1] = silkZ(top);
    pushPrism(name, loop, holes, z0, z1, COL_SILK);
  };
  const silkStroke = (a: Point, b: Point, width: number, top: boolean): void =>
    silk(
      top ? "F.Silk" : "B.Silk",
      capsuleLoop(a, b, Math.max(width, 0.1) / 2),
      [],
      top,
    );
  const silkPolys = (polys: Point[][], width: number, top: boolean): void => {
    for (const poly of polys) {
      for (let i = 0; i < poly.length - 1; i++)
        silkStroke(poly[i], poly[i + 1], width, top);
    }
  };
  for (const c of inc.board ? board.components : []) {
    const top = c.side !== "bottom";
    const mirror = c.side === "bottom";
    const name = top ? "F.Silk" : "B.Silk";
    for (const item of componentSilkHidden(c) ? [] : c.footprint.silk) {
      if (item.kind === "line") {
        const [a, b] = componentTransformPoints(c, [item.start, item.end]);
        silkStroke(a, b, item.width, top);
      } else if (item.kind === "arc") {
        const [ws, we, wc] = componentTransformPoints(c, [
          item.start,
          item.end,
          item.center,
        ]);
        silk(
          name,
          arcStrokeLoop(
            ws,
            we,
            wc,
            mirror ? !item.cw : item.cw,
            Math.max(item.width, 0.1) / 2,
          ),
          [],
          top,
        );
      } else if (item.kind === "circle") {
        const [wc] = componentTransformPoints(c, [item.center]);
        const hw = Math.max(item.width, 0.1) / 2;
        silk(
          name,
          circleLoop(wc, item.radius + hw),
          item.radius - hw > 1e-3 ? [circleLoop(wc, item.radius - hw)] : [],
          top,
        );
      } else if (item.kind === "text") {
        const [at] = componentTransformPoints(c, [item.at]);
        const rot = componentTransformRotation(c, item.rotation);
        silkPolys(
          strokeText(item.text, at, item.height, rot, mirror),
          Math.max(0.12, item.height * 0.12),
          top,
        );
      }
    }
    // Refdes label, same anchor + stroke width as the Gerber legend.
    if (componentLabelHidden(c)) continue;
    const lp = componentLabelPlacement(board, c);
    silkPolys(
      strokeText(c.refdes, lp.at, lp.height, lp.rotation, mirror),
      0.15,
      top,
    );
  }
  for (const line of inc.board ? board.silkLines : []) {
    silkStroke(line.start, line.end, line.width, line.layer !== "B.Silk");
  }
  for (const s of inc.board ? board.silk : []) {
    const top = s.layer !== "B.Silk";
    silkPolys(
      strokeText(s.text, s.at, s.height, s.rotation, !top),
      Math.max(0.12, s.height * 0.12),
      top,
    );
  }

  // ---- components: real meshes (per-material solids), else courtyard block ----
  for (const c of inc.comps ? board.components : []) {
    if (!onSide(c, side)) continue;
    const groups = models.get(c.refdes);
    if (groups && groups.length > 0) {
      for (const g of groups) {
        const faces = meshFaces(g.tris);
        if (faces.length)
          solids.push({ name: c.refdes, faces, color: g.color ?? COL_BODY });
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
  let s = n.toFixed(4); // 0.1µm — keeps arc end vertices inside the 1µm uncertainty
  if (s.includes(".")) s = s.replace(/0+$/, "");
  if (s === "-0." || s === "-0") s = "0.";
  if (!s.includes(".")) s += ".";
  return s;
}

/** Serialize solids as an AP214 advanced-brep STEP file with per-solid colors. */
function writeStep(name: string, solids: Solid[]): string {
  const lines: string[] = [];
  let n = 0;
  const id = (entity: string): number => {
    n += 1;
    lines.push(`#${n}=${entity};`);
    return n;
  };

  const appCtx = id(`APPLICATION_CONTEXT('automotive design')`);
  id(
    `APPLICATION_PROTOCOL_DEFINITION('draft international standard','automotive_design',1998,#${appCtx})`,
  );
  const prodCtx = id(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const product = id(`PRODUCT('${name}','${name}','',(#${prodCtx}))`);
  const formation = id(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  const defCtx = id(
    `PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`,
  );
  const prodDef = id(
    `PRODUCT_DEFINITION('design','',#${formation},#${defCtx})`,
  );
  const prodShape = id(`PRODUCT_DEFINITION_SHAPE('','',#${prodDef})`);

  const lenUnit = id(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const angUnit = id(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const solidAngUnit = id(
    `(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`,
  );
  const uncertainty = id(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.001),#${lenUnit},'distance_accuracy_value','')`,
  );
  const geomCtx = id(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnit},#${angUnit},#${solidAngUnit}))REPRESENTATION_CONTEXT('',''))`,
  );

  const worldOrigin = id(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const worldZ = id(`DIRECTION('',(0.,0.,1.))`);
  const worldX = id(`DIRECTION('',(1.,0.,0.))`);
  const worldAxis = id(
    `AXIS2_PLACEMENT_3D('',#${worldOrigin},#${worldZ},#${worldX})`,
  );

  const brepIds: number[] = [];
  const styledIds: number[] = [];
  // One shared presentation style per distinct color.
  const styleCache = new Map<string, number>();
  const styleFor = (c: RGB): number => {
    const key = c.map(fmt).join(",");
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
    // Per-solid topology: vertices keyed by rounded position, edges by
    // (vertex pair, curve) — so caps and walls share the same edge entities.
    const verts = new Map<string, { v: number; pt: number; p: P3 }>();
    const vertex = (p: P3): { v: number; pt: number; p: P3 } => {
      const key = `${fmt(p.x)},${fmt(p.y)},${fmt(p.z)}`;
      let e = verts.get(key);
      if (e === undefined) {
        const pt = id(`CARTESIAN_POINT('',(${key}))`);
        e = { v: id(`VERTEX_POINT('',#${pt})`), pt, p };
        verts.set(key, e);
      }
      return e;
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
    const edges = new Map<string, number>();
    /** Edge from `from` to `to`; returns null for a zero-length edge. */
    const edge = (from: FV, to: FV): { id: number; fwd: boolean } | null => {
      const A = vertex(from.p);
      const B = vertex(to.p);
      if (A.v === B.v) return null;
      const fwd = A.v < B.v;
      const [lo, hi] = fwd ? [A, B] : [B, A];
      const arc = from.arc && {
        center: from.arc.center,
        cw: fwd ? from.arc.cw : !from.arc.cw,
      };
      const key = arc
        ? `${lo.v}-${hi.v}:${fmt(arc.center.x)},${fmt(arc.center.y)},${arc.cw}`
        : `${lo.v}-${hi.v}`;
      let e = edges.get(key);
      if (e === undefined) {
        let curve: number;
        if (arc) {
          const r = dist2(lo.p, arc.center);
          const c = id(
            `CARTESIAN_POINT('',(${fmt(arc.center.x)},${fmt(arc.center.y)},${fmt(lo.p.z)}))`,
          );
          const ax = id(
            `AXIS2_PLACEMENT_3D('',#${c},#${dir(0, 0, arc.cw ? -1 : 1)},#${dir((lo.p.x - arc.center.x) / r, (lo.p.y - arc.center.y) / r, 0)})`,
          );
          curve = id(`CIRCLE('',#${ax},${fmt(r)})`);
        } else {
          const d = {
            x: hi.p.x - lo.p.x,
            y: hi.p.y - lo.p.y,
            z: hi.p.z - lo.p.z,
          };
          const len = Math.hypot(d.x, d.y, d.z);
          const vec = id(
            `VECTOR('',#${dir(d.x / len, d.y / len, d.z / len)},1.)`,
          );
          curve = id(`LINE('',#${lo.pt},#${vec})`);
        }
        e = id(`EDGE_CURVE('',#${lo.v},#${hi.v},#${curve},.T.)`);
        edges.set(key, e);
      }
      return { id: e, fwd };
    };

    const faceIds: number[] = [];
    for (const face of solid.faces) {
      const bounds: string[] = [];
      for (let li = 0; li < face.loops.length; li++) {
        const loop = face.loops[li];
        const oriented: number[] = [];
        for (let i = 0; i < loop.length; i++) {
          const e = edge(loop[i], loop[(i + 1) % loop.length]);
          if (e)
            oriented.push(
              id(`ORIENTED_EDGE('',*,*,#${e.id},${e.fwd ? ".T." : ".F."})`),
            );
        }
        if (oriented.length < 2) continue;
        const el = id(
          `EDGE_LOOP('',(${oriented.map((o) => `#${o}`).join(",")}))`,
        );
        bounds.push(
          `#${id(`${li === 0 ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',#${el},.T.)`)}`,
        );
      }
      if (bounds.length === 0) continue;
      const s = face.surface;
      let surf: number;
      let sameSense = true;
      if (s.kind === "plane") {
        const o = id(
          `CARTESIAN_POINT('',(${fmt(s.origin.x)},${fmt(s.origin.y)},${fmt(s.origin.z)}))`,
        );
        const ax = id(
          `AXIS2_PLACEMENT_3D('',#${o},#${dir(s.normal.x, s.normal.y, s.normal.z)},#${dir(s.ref.x, s.ref.y, s.ref.z)})`,
        );
        surf = id(`PLANE('',#${ax})`);
      } else {
        const o = id(
          `CARTESIAN_POINT('',(${fmt(s.center.x)},${fmt(s.center.y)},${fmt(s.z)}))`,
        );
        const ax = id(
          `AXIS2_PLACEMENT_3D('',#${o},#${dir(0, 0, 1)},#${dir(1, 0, 0)})`,
        );
        surf = id(`CYLINDRICAL_SURFACE('',#${ax},${fmt(s.r)})`);
        sameSense = s.sameSense;
      }
      faceIds.push(
        id(
          `ADVANCED_FACE('',(${bounds.join(",")}),#${surf},${sameSense ? ".T." : ".F."})`,
        ),
      );
    }
    if (faceIds.length === 0) continue;
    const shell = id(
      `CLOSED_SHELL('',(${faceIds.map((f) => `#${f}`).join(",")}))`,
    );
    const brep = id(
      `MANIFOLD_SOLID_BREP('${solid.name.replace(/'/g, "")}',#${shell})`,
    );
    brepIds.push(brep);
    if (solid.color) {
      styledIds.push(
        id(`STYLED_ITEM('',(#${styleFor(solid.color)}),#${brep})`),
      );
    }
  }

  const shapeRep = id(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('${name}',(#${worldAxis}${brepIds.map((b) => `,#${b}`).join("")}),#${geomCtx})`,
  );
  id(`SHAPE_DEFINITION_REPRESENTATION(#${prodShape},#${shapeRep})`);
  if (styledIds.length > 0) {
    id(
      `MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styledIds.map((s) => `#${s}`).join(",")}),#${geomCtx})`,
    );
  }

  return [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('Flamingo PCB export'),'2;1');`,
    `FILE_NAME('${name}.step','',(''),(''),'Flamingo','Flamingo','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`,
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

/** Blocks flavour: drilled board prism + courtyard-box component bodies. */
export function exportStep(board: Board, opts: StepOptions = {}): string {
  return writeStep(board.name.replace(/'/g, ""), boardSolids(board, opts));
}

/**
 * Detail flavour: drilled board + copper + silkscreen + real component
 * meshes. `models` maps refdes → world-placed mesh groups (objmesh.ts);
 * pass an empty map to fall back to blocks for every part.
 */
export function exportStepDetail(
  board: Board,
  models: Map<string, MeshGroup[]>,
  opts: StepOptions = {},
): string {
  return writeStep(
    board.name.replace(/'/g, ""),
    detailSolids(board, models, opts),
  );
}

/** True when a written STEP file holds at least one solid. */
export function stepHasSolids(step: string): boolean {
  return step.includes("MANIFOLD_SOLID_BREP(");
}
