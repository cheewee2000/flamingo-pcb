/**
 * Flamingo Fab - KiCad `.kicad_pcb` export
 *
 * Writes a board in the KiCad 10 text format so an external router that speaks
 * KiCad files (KiCadRoutingTools) can route it. Like dsn.ts, this is a one-way
 * handoff format: pads, nets, outline, existing copper and pours go out, routed
 * copper comes back through importKiCadRoutes().
 *
 * Coordinates: KiCad is y-down, the engine is y-up, so every y is negated on the
 * way out (and back in). The picture is unchanged -- a y-flip of the numbers plus
 * KiCad's y-down screen is the same view -- so pad rotations pass through as-is.
 *
 * Footprints: one KiCad footprint per component, placed at (0,0) with every pad
 * already in world coordinates (padWorld handles side/rotation/mirroring, the
 * same helper the DRC and DSN export use). No footprint graphics are emitted --
 * the router only needs copper, drills and the board edge.
 */

import type { Board, LayerId, Pad, PathSeg, Point, Track, Via } from '@flamingo/engine';
import { allHoles, copperLayersOf, holeSlotCenterline, outlineToPolygon, padCopperLayers, padWorld } from '@flamingo/engine';

const KICAD_LAYER_NO: Record<string, number> = { 'F.Cu': 0, 'In1.Cu': 4, 'In2.Cu': 6, 'In3.Cu': 8, 'In4.Cu': 10, 'B.Cu': 2 };

const num = (n: number): string => String(Math.round(n * 1e6) / 1e6);
const str = (s: string): string => JSON.stringify(s);
const xy = (p: Point): string => `${num(p.x)} ${num(-p.y)}`;

let uuidCounter = 0;
/** Deterministic, well-formed UUIDs -- the file is a throwaway handoff. */
function uuid(): string {
  uuidCounter += 1;
  const h = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
}

function lineSegs(seg: PathSeg): { start: Point; end: Point }[] {
  if (seg.type === 'line') return [{ start: seg.start, end: seg.end }];
  // Tessellate an arc into short chords (existing arc copper is rare; the router only needs obstacles).
  const r = Math.hypot(seg.start.x - seg.center.x, seg.start.y - seg.center.y);
  const a0 = Math.atan2(seg.start.y - seg.center.y, seg.start.x - seg.center.x);
  let a1 = Math.atan2(seg.end.y - seg.center.y, seg.end.x - seg.center.x);
  if (seg.cw) {
    while (a1 > a0) a1 -= 2 * Math.PI;
  } else {
    while (a1 < a0) a1 += 2 * Math.PI;
  }
  const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 16)));
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: seg.center.x + r * Math.cos(a), y: seg.center.y + r * Math.sin(a) });
  }
  const out: { start: Point; end: Point }[] = [];
  for (let i = 0; i < n; i++) out.push({ start: pts[i]!, end: pts[i + 1]! });
  return out;
}

function padSexpr(refPad: Pad, at: Point, rotation: number, layers: string[], netName: string | undefined, side: 'top' | 'bottom'): string {
  const through = refPad.layer === 'through';
  const plated = refPad.drill?.plated !== false;
  const kind = through ? (plated ? 'thru_hole' : 'np_thru_hole') : 'smd';
  const shape = refPad.shape === 'circle' ? 'circle' : refPad.shape === 'oval' ? 'oval' : 'rect';
  const rot = ((rotation % 360) + 360) % 360;
  const maskSide = side === 'top' ? 'F' : 'B';
  const allLayers = through ? '"*.Cu" "*.Mask"' : `${layers.map(str).join(' ')} "${maskSide}.Mask"${refPad.paste !== false ? ` "${maskSide}.Paste"` : ''}`;
  const parts = [`(pad ${str(refPad.number)} ${kind} ${shape}`, `(at ${xy(at)}${rot ? ` ${num(rot)}` : ''})`, `(size ${num(refPad.size.w)} ${num(refPad.size.h)})`];
  if (through && refPad.drill) {
    const d = refPad.drill;
    parts.push(d.slotLength && d.slotLength > d.diameter ? `(drill oval ${num(d.diameter)} ${num(d.slotLength)})` : `(drill ${num(d.diameter)})`);
  }
  parts.push(`(layers ${allLayers})`);
  if (netName) parts.push(`(net ${str(netName)})`);
  parts.push(`(uuid ${str(uuid())})`);
  return `\t\t${parts.join('\n\t\t\t')}\n\t\t)`;
}

export interface ExportKiCadPcbOptions {
  /** Nets the router will route. Every other net's existing tracks/vias go out as fixed obstacles; the listed nets' own copper is dropped unless `keep`. Omit to route everything (no existing copper written). */
  nets?: string[];
  /** With `nets`: keep the listed nets' existing copper too (hand-placed fanout). */
  keep?: boolean;
  /** Write the board's copper pours (default true). The KiCadRoutingTools backend leaves them out: the router must connect plane nets with real copper, because Flamingo's own pour geometry (thermal relief, clearance) decides plane connectivity, not the router's. */
  zones?: boolean;
}

export function exportKiCadPcb(b: Board, opts: ExportKiCadPcbOptions = {}): string {
  uuidCounter = 0;
  const copper = copperLayersOf(b);
  const pinNet = new Map<string, string>();
  for (const n of b.nets) for (const p of n.pins) pinNet.set(p, n.name);
  const routed = opts.nets ? new Set(opts.nets) : undefined;

  const out: string[] = [];
  out.push('(kicad_pcb', '\t(version 20260206)', '\t(generator "flamingo")', '\t(generator_version "0.1")', '\t(general\n\t\t(thickness 1.6)\n\t\t(legacy_teardrops no)\n\t)', '\t(paper "A3")');
  out.push('\t(layers');
  for (const l of copper) out.push(`\t\t(${KICAD_LAYER_NO[l]} ${str(l)} signal)`);
  out.push('\t\t(9 "F.Adhes" user "F.Adhesive")', '\t\t(11 "B.Adhes" user "B.Adhesive")', '\t\t(13 "F.Paste" user)', '\t\t(15 "B.Paste" user)', '\t\t(5 "F.SilkS" user "F.Silkscreen")', '\t\t(7 "B.SilkS" user "B.Silkscreen")', '\t\t(1 "F.Mask" user)', '\t\t(3 "B.Mask" user)', '\t\t(25 "Edge.Cuts" user)', '\t\t(31 "F.CrtYd" user "F.Courtyard")', '\t\t(29 "B.CrtYd" user "B.Courtyard")', '\t)');
  out.push('\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)');

  // Components -> footprints (pads in world space).
  for (const c of b.components) {
    const fl = c.side === 'bottom' ? 'B.Cu' : 'F.Cu';
    out.push(`\t(footprint ${str(c.footprint.name)}`, `\t\t(layer ${str(fl)})`, `\t\t(uuid ${str(uuid())})`, '\t\t(at 0 0)');
    out.push(`\t\t(property "Reference" ${str(c.refdes)}\n\t\t\t(at 0 0 0)\n\t\t\t(layer ${str(c.side === 'bottom' ? 'B.SilkS' : 'F.SilkS')})\n\t\t\t(hide yes)\n\t\t\t(uuid ${str(uuid())})\n\t\t)`);
    for (const p of c.footprint.pads) {
      const w = padWorld(c, p);
      const layers = padCopperLayers(p, c.side, copper) as LayerId[];
      out.push(padSexpr(p, w.at, w.rotation, layers, pinNet.get(`${c.refdes}.${p.number}`), c.side));
    }
    out.push('\t)');
  }

  // Mounting holes as keep-clear non-plated/plated pads.
  allHoles(b).forEach((h, i) => {
    const cl = holeSlotCenterline(h);
    const mid = { x: (cl.start.x + cl.end.x) / 2, y: (cl.start.y + cl.end.y) / 2 };
    out.push(`\t(footprint "MountingHole_${i}"`, '\t\t(layer "F.Cu")', `\t\t(uuid ${str(uuid())})`, '\t\t(at 0 0)');
    const plated = h.plated !== false;
    out.push(`\t\t(pad "" ${plated ? 'thru_hole' : 'np_thru_hole'} circle\n\t\t\t(at ${xy(mid)})\n\t\t\t(size ${num(h.padDiameter)} ${num(h.padDiameter)})\n\t\t\t(drill ${num(h.drill)})\n\t\t\t(layers "*.Cu" "*.Mask")\n\t\t\t(uuid ${str(uuid())})\n\t\t)`);
    out.push('\t)');
  });

  // Board edge.
  const poly = outlineToPolygon(b.outline);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const z = poly[(i + 1) % poly.length]!;
    out.push(`\t(gr_line\n\t\t(start ${xy(a)})\n\t\t(end ${xy(z)})\n\t\t(stroke\n\t\t\t(width 0.1)\n\t\t\t(type default)\n\t\t)\n\t\t(layer "Edge.Cuts")\n\t\t(uuid ${str(uuid())})\n\t)`);
  }

  // Existing copper.
  const fixedNet = (net: string): boolean => (routed ? (routed.has(net) ? !!opts.keep : true) : false);
  for (const t of b.tracks) {
    if (!fixedNet(t.net)) continue;
    for (const s of lineSegs(t.seg)) {
      out.push(`\t(segment\n\t\t(start ${xy(s.start)})\n\t\t(end ${xy(s.end)})\n\t\t(width ${num(t.width)})\n\t\t(layer ${str(t.layer)})\n\t\t(net ${str(t.net)})\n\t\t(uuid ${str(uuid())})\n\t)`);
    }
  }
  for (const v of b.vias) {
    if (!fixedNet(v.net)) continue;
    out.push(`\t(via\n\t\t(at ${xy(v.at)})\n\t\t(size ${num(v.diameter)})\n\t\t(drill ${num(v.drill)})\n\t\t(layers ${str(copper[0]!)} ${str(copper[copper.length - 1]!)})\n\t\t(net ${str(v.net)})\n\t\t(uuid ${str(uuid())})\n\t)`);
  }

  // Pours (planes): the router welds plane pads into these.
  for (const z of opts.zones === false ? [] : b.zones) {
    const pts = z.polygon.map((p) => `(xy ${xy(p)})`).join(' ');
    out.push(`\t(zone\n\t\t(net ${str(z.net)})\n\t\t(net_name ${str(z.net)})\n\t\t(layer ${str(z.layer)})\n\t\t(uuid ${str(uuid())})\n\t\t(hatch edge 0.5)\n\t\t(connect_pads\n\t\t\t(clearance ${num(z.clearance)})\n\t\t)\n\t\t(min_thickness ${num(z.minWidth)})\n\t\t(filled_areas_thickness no)\n\t\t(fill yes\n\t\t\t(thermal_gap ${num(z.thermal.gap)})\n\t\t\t(thermal_bridge_width ${num(z.thermal.spokeWidth)})\n\t\t)\n\t\t(polygon\n\t\t\t(pts ${pts})\n\t\t)\n\t)`);
  }

  out.push(')');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Import routed copper
// ---------------------------------------------------------------------------

export interface ImportKiCadRoutesResult {
  tracks: Omit<Track, 'id'>[];
  vias: Omit<Via, 'id'>[];
}

const FLOAT = '(-?[0-9]+(?:\\.[0-9]+)?(?:e-?[0-9]+)?)';

/**
 * Read segments and vias back out of a routed `.kicad_pcb` (as written by
 * KiCadRoutingTools). Returns ALL copper in the file, including the fixed
 * copper exportKiCadPcb() wrote in -- the autoroute pipeline already filters
 * to the requested nets and drops what the board already has, exactly as it
 * does for a Freerouting SES. Arc tracks (`(arc ...)`) are not produced by the
 * router's octilinear output; if one appears the import fails loudly rather
 * than silently dropping copper.
 */
export function importKiCadRoutes(pcb: string): ImportKiCadRoutesResult {
  if (/^\s*\(arc\s*$/m.test(pcb) || /\n\t\(arc\n/.test(pcb)) {
    throw new Error('routed KiCad file contains arc tracks, which are not supported yet');
  }
  const tracks: Omit<Track, 'id'>[] = [];
  const vias: Omit<Via, 'id'>[] = [];
  // Extra attributes the router may add between fields, e.g. (capping yes) (filling yes) (locked yes).
  const EXTRA = '(?:\\s*\\((?!net\\b)[a-z_]+(?:\\s+[^()]*)?\\))*';
  const segRe = new RegExp(
    `\\(segment\\s*\\(start ${FLOAT} ${FLOAT}\\)\\s*\\(end ${FLOAT} ${FLOAT}\\)\\s*\\(width ${FLOAT}\\)\\s*\\(layer "([^"]+)"\\)${EXTRA}\\s*\\(net "((?:[^"\\\\]|\\\\.)*)"\\)`,
    'g',
  );
  for (const m of pcb.matchAll(segRe)) {
    const [, x1, y1, x2, y2, w, layer, net] = m;
    tracks.push({
      layer: layer as LayerId,
      width: Number(w),
      net: JSON.parse(`"${net}"`) as string,
      seg: { type: 'line', start: { x: Number(x1), y: -Number(y1) }, end: { x: Number(x2), y: -Number(y2) } },
    });
  }
  const viaRe = new RegExp(
    `\\(via${EXTRA}\\s*\\(at ${FLOAT} ${FLOAT}\\)\\s*\\(size ${FLOAT}\\)\\s*\\(drill ${FLOAT}\\)\\s*\\(layers "[^"]+" "[^"]+"\\)${EXTRA}\\s*\\(net "((?:[^"\\\\]|\\\\.)*)"\\)`,
    'g',
  );
  for (const m of pcb.matchAll(viaRe)) {
    const [, x, y, size, drill, net] = m;
    vias.push({ at: { x: Number(x), y: -Number(y) }, diameter: Number(size), drill: Number(drill), net: JSON.parse(`"${net}"`) as string });
  }
  return { tracks, vias };
}
