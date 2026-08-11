/**
 * Flamingo Fab - Gerber X2 + Excellon fabrication output.
 *
 * `generateGerbers` renders a Board to a complete Gerber X2 fileset plus
 * Excellon drill files, keyed by filename. Units mm, coordinate format 4.6
 * (%FSLAX46Y46*%, values = round(mm * 1e6)), absolute, leading zeros omitted.
 * Gerber uses the same y-up coordinate system as the board, so board CW arcs
 * map directly to G02 and CCW to G03.
 *
 * Format decisions (see task-13 report for the full rationale):
 *  - Standard apertures (C/R/O) are deduped and flashed (D03) for unrotated
 *    (0/90/180/270-degree) rect/oval/circle pads; every other pad shape and any
 *    off-axis rotation is drawn as a G36/G37 region of its exact outline.
 *  - Copper zone fills are emitted from their winding-encoded rings: outer
 *    (CCW) rings as %LPD*% regions, hole (CW) rings as %LPC*% regions emitted
 *    immediately after -- order matters and is guaranteed by zonefill.ts.
 *  - Soldermask openings = pads dilated 0.05mm; vias are TENTED (omitted from
 *    the mask). Mask files carry TF.FilePolarity Negative.
 *  - Paste = SMD pads exactly (no expansion), through-hole pads excluded.
 *  - Silk text is stroked with a local vector font (strokefont.ts); every silk
 *    aperture is floored at the ruleset's minSilkWidth (see buildSilk).
 *  - The profile (.GKO) carries the outer outline plus a closed contour for
 *    every non-plated milled slot (see buildEdge).
 */

import type { Board, ComponentInst, LayerId, Pad, PathSeg, Point } from '@flamingo/engine';
import {
  copperLayersOf,
  padCopperLayers,
  padOutline,
  padWorld,
  componentTransformPoints,
  componentTransformRotation,
  componentLabelPlacement,
  fillAllZones,
  bufferPolygon,
  isSlot,
  holeSlotCenterline,
  allHoles,
  capsulePolygon,
  RULESETS,
} from '@flamingo/engine';
import { strokeText } from './strokefont.js';
import { buildDrills } from './excellon.js';

export { buildDrills } from './excellon.js';
export type { Drills } from './excellon.js';

export interface FabFiles {
  files: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Number / coordinate formatting
// ---------------------------------------------------------------------------

/** Coordinate value: mm -> integer in 4.6 format (round(mm * 1e6)). */
function c(n: number): string {
  return String(Math.round(n * 1e6));
}

/** Aperture / size value: trim to <= 6dp, drop trailing zeros. */
function ap(n: number): string {
  return String(parseFloat(n.toFixed(6)));
}

function signedArea(pts: Point[]): number {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

// ---------------------------------------------------------------------------
// Gerber builder (aperture dedupe + lazy state)
// ---------------------------------------------------------------------------

class GerberBuilder {
  private defs: string[] = [];
  private codeByDef = new Map<string, number>();
  private nextCode = 10;
  private body: string[] = [];
  private curAperture: number | null = null;
  private curInterp: 'G01' | 'G02' | 'G03' | null = null;
  private curPolarity: 'D' | 'C' = 'D';
  private cur: Point = { x: 0, y: 0 };

  /** Return the aperture code for a shape def (e.g. "C,0.25"), creating it once. */
  aperture(shape: string): number {
    let code = this.codeByDef.get(shape);
    if (code === undefined) {
      code = this.nextCode++;
      this.codeByDef.set(shape, code);
      this.defs.push(`%ADD${code}${shape}*%`);
    }
    return code;
  }

  select(code: number): void {
    if (this.curAperture !== code) {
      this.body.push(`D${code}*`);
      this.curAperture = code;
    }
  }

  private interp(mode: 'G01' | 'G02' | 'G03'): void {
    if (this.curInterp !== mode) {
      this.body.push(`${mode}*`);
      this.curInterp = mode;
    }
  }

  private polarity(p: 'D' | 'C'): void {
    if (this.curPolarity !== p) {
      this.body.push(p === 'D' ? '%LPD*%' : '%LPC*%');
      this.curPolarity = p;
    }
  }

  flash(at: Point): void {
    this.body.push(`X${c(at.x)}Y${c(at.y)}D03*`);
    this.cur = at;
  }

  move(at: Point): void {
    this.body.push(`X${c(at.x)}Y${c(at.y)}D02*`);
    this.cur = at;
  }

  private lineTo(at: Point): void {
    this.interp('G01');
    this.body.push(`X${c(at.x)}Y${c(at.y)}D01*`);
    this.cur = at;
  }

  private arcTo(end: Point, center: Point, cw: boolean): void {
    this.interp(cw ? 'G02' : 'G03');
    const i = center.x - this.cur.x;
    const j = center.y - this.cur.y;
    this.body.push(`X${c(end.x)}Y${c(end.y)}I${c(i)}J${c(j)}D01*`);
    this.cur = end;
  }

  /** Draw one PathSeg (aperture already selected). */
  drawSeg(seg: PathSeg): void {
    this.move(seg.start);
    if (seg.type === 'line') this.lineTo(seg.end);
    else this.arcTo(seg.end, seg.center, seg.cw);
  }

  /** Draw a polyline (aperture already selected). */
  drawPolyline(pts: Point[]): void {
    if (pts.length < 2) return;
    this.move(pts[0]);
    for (let i = 1; i < pts.length; i++) this.lineTo(pts[i]);
  }

  /** Full circle stroke centered at `center`, radius `r` (aperture selected). */
  drawCircle(center: Point, r: number): void {
    const start = { x: center.x + r, y: center.y };
    this.move(start);
    this.arcTo(start, center, false);
  }

  /** Filled region from a closed ring. `dark` toggles LPD (solid) vs LPC (hole). */
  region(ring: Point[], dark: boolean): void {
    if (ring.length < 3) return;
    this.polarity(dark ? 'D' : 'C');
    this.body.push('G36*');
    this.move(ring[0]);
    for (let i = 1; i < ring.length; i++) this.lineTo(ring[i]);
    this.lineTo(ring[0]);
    this.body.push('G37*');
  }

  /** Ensure subsequent graphics are drawn dark (call after a hole region run). */
  resetDark(): void {
    this.polarity('D');
  }

  assemble(fileFunction: string, filePolarity: 'Positive' | 'Negative'): string {
    const lines = [
      '%TF.GenerationSoftware,CW&T,Flamingo,0.1*%',
      `%TF.FileFunction,${fileFunction}*%`,
      `%TF.FilePolarity,${filePolarity}*%`,
      '%FSLAX46Y46*%',
      '%MOMM*%',
      ...this.defs,
      'G75*',
      '%LPD*%',
      ...this.body,
      'M02*',
    ];
    return lines.join('\n') + '\n';
  }
}

// ---------------------------------------------------------------------------
// Pad geometry / aperture selection
// ---------------------------------------------------------------------------

/** Nearest of 0/90/180/270 if within tolerance, else null. */
function axisAlign(rotationDeg: number): 0 | 90 | 180 | 270 | null {
  const r = ((rotationDeg % 360) + 360) % 360;
  for (const a of [0, 90, 180, 270] as const) {
    if (Math.abs(r - a) < 1e-6 || Math.abs(r - a - 360) < 1e-6) return a;
  }
  return null;
}

/** Aperture def for a flashable pad at `expansion` mm, or null if it needs a region. */
function padAperture(pad: Pad, worldRotation: number, expansion: number): string | null {
  const e2 = 2 * expansion;
  if (pad.shape === 'circle') return `C,${ap(pad.size.w + e2)}`;
  if (pad.shape === 'polygon') return null;
  const a = axisAlign(worldRotation);
  if (a === null) return null;
  const swap = a === 90 || a === 270;
  const w = (swap ? pad.size.h : pad.size.w) + e2;
  const h = (swap ? pad.size.w : pad.size.h) + e2;
  return pad.shape === 'rect' ? `R,${ap(w)}X${ap(h)}` : `O,${ap(w)}X${ap(h)}`;
}

/** Outer rings of a MultiPolygon (buffered pads are convex -> single outer, no holes). */
function outerRings(mp: ReturnType<typeof bufferPolygon>): Point[][] {
  return mp
    .map((poly) => poly[0].map(([x, y]): Point => ({ x, y })))
    .map((r) => {
      const n = r.length;
      if (n > 1 && r[0].x === r[n - 1].x && r[0].y === r[n - 1].y) r.pop();
      return r;
    });
}

/** Flash or region a pad on the current file at the given mask/paste expansion. */
function emitPad(g: GerberBuilder, comp: ComponentInst, pad: Pad, expansion: number): void {
  const world = padWorld(comp, pad);
  const def = padAperture(pad, world.rotation, expansion);
  if (def) {
    g.select(g.aperture(def));
    g.flash(world.at);
    return;
  }
  const rings =
    expansion > 0 ? outerRings(bufferPolygon(padOutline(comp, pad), expansion)) : [padOutline(comp, pad)];
  for (const ring of rings) g.region(ring, true);
  g.resetDark();
}

// ---------------------------------------------------------------------------
// Per-file builders
// ---------------------------------------------------------------------------

function buildCopper(b: Board, filled: Board, layer: LayerId, fileFunction: string): string {
  const g = new GerberBuilder();
  const cu = copperLayersOf(b);

  for (const z of filled.zones) {
    if (z.layer !== layer || !z.fill || z.fill.length === 0) continue;
    for (const ring of z.fill) g.region(ring, signedArea(ring) > 0);
    g.resetDark();
  }

  for (const t of b.tracks) {
    if (t.layer !== layer) continue;
    g.select(g.aperture(`C,${ap(t.width)}`));
    g.drawSeg(t.seg);
  }

  for (const comp of b.components) {
    for (const pad of comp.footprint.pads) {
      if (!padCopperLayers(pad, comp.side, cu).includes(layer)) continue;
      emitPad(g, comp, pad, 0);
    }
  }

  for (const v of b.vias) {
    g.select(g.aperture(`C,${ap(v.diameter)}`));
    g.flash(v.at);
  }

  for (const h of allHoles(b)) {
    if (!h.plated) continue;
    if (isSlot(h)) {
      const { start, end } = holeSlotCenterline(h);
      g.region(capsulePolygon(start, end, h.padDiameter / 2), true);
      g.resetDark();
    } else {
      g.select(g.aperture(`C,${ap(h.padDiameter)}`));
      g.flash(h.at);
    }
  }

  return g.assemble(fileFunction, 'Positive');
}

function buildMask(b: Board, side: 'F' | 'B'): string {
  const layer: LayerId = side === 'F' ? 'F.Cu' : 'B.Cu';
  const g = new GerberBuilder();
  const cu = copperLayersOf(b);
  for (const comp of b.components) {
    for (const pad of comp.footprint.pads) {
      if (!padCopperLayers(pad, comp.side, cu).includes(layer)) continue;
      emitPad(g, comp, pad, 0.05);
    }
  }
  // Plated mounting holes keep a mask opening (exposed ring); vias are tented.
  for (const h of allHoles(b)) {
    if (!h.plated) continue;
    if (isSlot(h)) {
      const { start, end } = holeSlotCenterline(h);
      g.region(capsulePolygon(start, end, (h.padDiameter + 0.1) / 2), true);
      g.resetDark();
    } else {
      g.select(g.aperture(`C,${ap(h.padDiameter + 0.1)}`));
      g.flash(h.at);
    }
  }
  const fn = side === 'F' ? 'Soldermask,Top' : 'Soldermask,Bot';
  return g.assemble(fn, 'Negative');
}

function buildPaste(b: Board, side: 'F' | 'B'): string {
  const layer: LayerId = side === 'F' ? 'F.Cu' : 'B.Cu';
  const g = new GerberBuilder();
  const cu = copperLayersOf(b);
  for (const comp of b.components) {
    for (const pad of comp.footprint.pads) {
      if (pad.layer === 'through') continue;
      if (!padCopperLayers(pad, comp.side, cu).includes(layer)) continue;
      emitPad(g, comp, pad, 0);
    }
  }
  const fn = side === 'F' ? 'Paste,Top' : 'Paste,Bot';
  return g.assemble(fn, 'Positive');
}

function buildSilk(b: Board, side: 'F' | 'B'): string {
  const silkLayer: LayerId = side === 'F' ? 'F.Silk' : 'B.Silk';
  const compSide: 'top' | 'bottom' = side === 'F' ? 'top' : 'bottom';
  const g = new GerberBuilder();

  // Every silk stroke is floored at the fab tier's minimum legend line width
  // (RuleSet.minSilkWidth -- 0.15mm on all JLCPCB tiers). Below it the fab
  // thins or drops the legend outright, which costs exactly the labels needed
  // for bring-up. Applied at the aperture so it covers footprint lines/arcs/
  // circles and board-level silk lines as well as stroked text.
  const minSilk = RULESETS[b.rules].minSilkWidth;
  const silkAperture = (width: number): number => g.aperture(`C,${ap(Math.max(minSilk, width))}`);

  const strokes = (polys: Point[][], width: number): void => {
    g.select(silkAperture(width));
    for (const poly of polys) g.drawPolyline(poly);
  };

  for (const comp of b.components) {
    if (comp.side !== compSide) continue;
    const mirror = comp.side === 'bottom';
    for (const item of comp.footprint.silk) {
      switch (item.kind) {
        case 'line': {
          const [s, e] = componentTransformPoints(comp, [item.start, item.end]);
          g.select(silkAperture(item.width));
          g.drawSeg({ type: 'line', start: s, end: e });
          break;
        }
        case 'arc': {
          const [s, e, ctr] = componentTransformPoints(comp, [item.start, item.end, item.center]);
          g.select(silkAperture(item.width));
          g.drawSeg({ type: 'arc', start: s, end: e, center: ctr, cw: mirror ? !item.cw : item.cw });
          break;
        }
        case 'circle': {
          const [ctr] = componentTransformPoints(comp, [item.center]);
          g.select(silkAperture(item.width));
          g.drawCircle(ctr, item.radius);
          break;
        }
        case 'text': {
          const [at] = componentTransformPoints(comp, [item.at]);
          const rot = componentTransformRotation(comp, item.rotation);
          strokes(strokeText(item.text, at, item.height, rot, mirror), item.height * 0.12);
          break;
        }
      }
    }
    // refdes label (upright, adjacent to the component body, pad-avoiding —
    // anchor shared with the SVG/canvas renderers and DRC)
    const lp = componentLabelPlacement(b, comp);
    strokes(strokeText(comp.refdes, lp.at, lp.height, lp.rotation, mirror), 0.15);
  }

  // Board-level silk text. B.Silk text is mirrored (x -> -x about its anchor,
  // before rotation) like bottom-component text, so it reads correctly on the
  // fabbed board's underside — matching the 3D viewer's B.Silk convention.
  for (const s of b.silk) {
    if (s.layer !== silkLayer) continue;
    strokes(strokeText(s.text, s.at, s.height, s.rotation, side === 'B'), s.height * 0.12);
  }

  // Board-level silk lines (mechanical reference outlines) stroked at their width.
  for (const line of b.silkLines) {
    if (line.layer !== silkLayer) continue;
    g.select(silkAperture(line.width));
    g.drawSeg({ type: 'line', start: line.start, end: line.end });
  }

  const fn = side === 'F' ? 'Legend,Top' : 'Legend,Bot';
  return g.assemble(fn, 'Positive');
}

/**
 * Board profile (.GKO): the outer outline, plus a closed contour for every
 * non-plated milled slot.
 *
 * JLCPCB's capabilities page asks for non-plated slots to be drawn on the
 * mechanical layer ("please draw the slot outline in the mechanical layer (GM1
 * or GKO)"). A slot delivered *only* as an Excellon G85 is at best a CAM query
 * and at worst missed, so it is described twice and consistently: contour here,
 * G85 still in the drill file (excellon.ts).
 *
 * Only non-plated, board-level slots are contoured:
 *  - Plated slots (plated mounting holes, slotted through-hole pads) are
 *    defined by the PTH drill file plus their copper annulus. Drawing one on
 *    the profile layer tells the fab to rout it, which would lose the plating.
 *  - Round holes are conveyed by the drill file alone, as every fab expects;
 *    contouring a round mounting hole risks it being routed rather than drilled.
 *
 * The contour radius is `drill / 2` -- the milled opening, matching the Excellon
 * tool diameter -- not `padDiameter / 2`, which is the copper annulus.
 */
function buildEdge(b: Board): string {
  const g = new GerberBuilder();
  g.select(g.aperture('C,0.1'));
  for (const seg of b.outline) g.drawSeg(seg);
  for (const h of allHoles(b)) {
    if (h.plated || !isSlot(h)) continue;
    const { start, end } = holeSlotCenterline(h);
    const ring = capsulePolygon(start, end, h.drill / 2);
    if (ring.length < 3) continue;
    g.drawPolyline([...ring, ring[0]]); // closed contour
  }
  return g.assemble('Profile,NP', 'Positive');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Gerber file extension for a copper layer, given its ordinal index. */
function copperFilename(name: string, layer: LayerId, index: number): string {
  if (layer === 'F.Cu') return `${name}.GTL`;
  if (layer === 'B.Cu') return `${name}.GBL`;
  return `${name}.G${index}`; // In1.Cu -> .G1, In2.Cu -> .G2, ...
}

/**
 * Filename stem for the fileset: the board name with every run of characters
 * outside [A-Za-z0-9_.-] collapsed to '_' (so a board called "Super Pager"
 * yields `Super_Pager.GTL`). Fabs generally accept spaces, but they are a
 * gratuitous hazard for uploads and shell/CAM scripting. Same sanitizer the
 * server uses for its .step / .zip downloads (packages/server/src/http.ts).
 * `Board.name` itself -- the display name -- is left untouched.
 */
function fileStem(name: string): string {
  return name.replace(/[^\w.-]+/g, '_') || 'board';
}

/** Render `b` to a complete Gerber X2 + Excellon fileset keyed by filename. */
export function generateGerbers(b: Board): FabFiles {
  const filled = fillAllZones(b);
  const name = fileStem(b.name);
  const files = new Map<string, string>();

  const cu = copperLayersOf(b);
  for (let i = 0; i < cu.length; i++) {
    const layer = cu[i];
    const pos = i === 0 ? 'Top' : i === cu.length - 1 ? 'Bot' : 'Inner';
    const fileFunction = `Copper,L${i + 1},${pos}`;
    files.set(copperFilename(name, layer, i), buildCopper(b, filled, layer, fileFunction));
  }

  files.set(`${name}.GTS`, buildMask(b, 'F'));
  files.set(`${name}.GBS`, buildMask(b, 'B'));
  files.set(`${name}.GTO`, buildSilk(b, 'F'));
  files.set(`${name}.GBO`, buildSilk(b, 'B'));
  files.set(`${name}.GTP`, buildPaste(b, 'F'));
  files.set(`${name}.GBP`, buildPaste(b, 'B'));
  if (b.outline.length > 0) files.set(`${name}.GKO`, buildEdge(b));

  const drills = buildDrills(b);
  if (drills.plated) files.set(`${name}-PTH.DRL`, drills.plated);
  if (drills.unplated) files.set(`${name}-NPTH.DRL`, drills.unplated);

  return { files };
}
