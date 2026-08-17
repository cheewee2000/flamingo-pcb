/**
 * EasyEDA Pro project (.epro) -> Flamingo Board importer.
 *
 * An .epro is a zip: project.json (device/footprint metadata), PCB/<uuid>.epcb
 * (the layout), FOOTPRINT/<uuid>.efoo (footprints), all in the Pro
 * line-oriented format: one JSON array per line, ["RECORD_TYPE", ...fields].
 *
 * UNITS & AXES (verified against the board's own JLC fab exports):
 *   1 Pro canvas unit = 0.0254 mm (1 mil). The canvas is y-UP and rotations
 *   are degrees CCW — identical to the engine, so coordinates and angles
 *   transfer with a pure scale, no y flip, no angle negation. Ground truth:
 *   COMPONENT R17 at (-826.7717, -922.6449) x 0.0254 = (-21.0, -23.435) mm,
 *   exactly the Mid X/Y the project's own pick-and-place CSV records for R17
 *   (and FPC1 rot 90 -> PnP rot 90).
 *
 * Record field layouts below were reverse-engineered from a real editor
 * 2.2.47 project and cross-checked against that project's Gerber/PnP fab
 * exports; they are observations, not a published spec.
 */

import AdmZip from 'adm-zip';
import {
  newBoard,
  padWorld,
  padCopperLayers,
  copperLayersOf,
  type Board,
  type ComponentInst,
  type Footprint,
  type Keepout,
  type MountingHole,
  type Net,
  type Pad,
  type PathSeg,
  type Point,
  type SilkItem,
  type SilkLine,
  type Track,
  type Via,
  type Zone,
} from '@flamingo/engine';

/** 1 EasyEDA Pro canvas unit = 1 mil = 0.0254 mm. */
const UNIT_MM = 0.0254;

/** Scale a canvas ordinate to mm, rounded to 0.1 um to kill float noise. */
function mm(v: number): number {
  return Math.round(v * UNIT_MM * 1e4) / 1e4;
}

function pt(x: number, y: number): Point {
  return { x: mm(x), y: mm(y) };
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

type Rec = unknown[];

/** Parse a Pro document: one JSON array per line, blank/[] lines skipped. */
function parseRecords(text: string): Rec[] {
  const out: Rec[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('["')) continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (Array.isArray(r) && typeof r[0] === 'string') out.push(r);
    } catch {
      // tolerate junk lines; the format has no comments but be safe
    }
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Polyline walker: pts arrays mix numbers and commands:
//   x0 y0 "L" x y [x y ...] "ARC" angleDeg endX endY "CIRCLE" cx cy r
//   "R" x y w h rot cornerRadius   (x,y = top-left in the y-up canvas)
// ---------------------------------------------------------------------------

type PolyPiece =
  | { kind: 'seg'; seg: PathSeg }
  | { kind: 'circle'; center: Point; radius: number };

/** Arc through start->end subtending `angleDeg` (CCW positive, y-up). */
function arcSeg(start: Point, end: Point, angleDeg: number): PathSeg {
  const theta = (Math.abs(angleDeg) * Math.PI) / 180;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (!(chord > 0) || !(theta > 1e-9) || theta >= 2 * Math.PI) {
    return { type: 'line', start, end };
  }
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  // Distance from chord midpoint to the arc center.
  const h = chord / 2 / Math.tan(theta / 2);
  // Left-hand normal of start->end; a CCW arc (< 180 deg) has its center on
  // the left of the chord, a CW arc on the right.
  const nx = -dy / chord;
  const ny = dx / chord;
  const sign = angleDeg > 0 ? 1 : -1;
  const center = { x: mid.x + sign * h * nx, y: mid.y + sign * h * ny };
  return { type: 'arc', start, end, center, cw: angleDeg < 0 };
}

/** Expand an "R" rounded-rect into an outline path (y-up: y is the TOP edge). */
function rectPath(x: number, y: number, w: number, h: number, r: number): PathSeg[] {
  const x0 = mm(x);
  const y1 = mm(y); // top
  const x1 = mm(x + w);
  const y0 = mm(y - h); // bottom
  const rad = Math.min(mm(r), (x1 - x0) / 2, (y1 - y0) / 2);
  if (rad <= 0) {
    // plain rectangle: TL -> TR -> BR -> BL
    return [
      { type: 'line', start: { x: x0, y: y1 }, end: { x: x1, y: y1 } },
      { type: 'line', start: { x: x1, y: y1 }, end: { x: x1, y: y0 } },
      { type: 'line', start: { x: x1, y: y0 }, end: { x: x0, y: y0 } },
      { type: 'line', start: { x: x0, y: y0 }, end: { x: x0, y: y1 } },
    ];
  }
  // Rounded rectangle, CCW arcs at each corner, walking clockwise TL->TR->BR->BL
  // (cw arcs when walking clockwise around the perimeter).
  const segs: PathSeg[] = [];
  const line = (a: Point, b: Point): void => {
    if (a.x !== b.x || a.y !== b.y) segs.push({ type: 'line', start: a, end: b });
  };
  const corner = (s: Point, e: Point, c: Point): void => {
    segs.push({ type: 'arc', start: s, end: e, center: c, cw: true });
  };
  line({ x: x0 + rad, y: y1 }, { x: x1 - rad, y: y1 });
  corner({ x: x1 - rad, y: y1 }, { x: x1, y: y1 - rad }, { x: x1 - rad, y: y1 - rad });
  line({ x: x1, y: y1 - rad }, { x: x1, y: y0 + rad });
  corner({ x: x1, y: y0 + rad }, { x: x1 - rad, y: y0 }, { x: x1 - rad, y: y0 + rad });
  line({ x: x1 - rad, y: y0 }, { x: x0 + rad, y: y0 });
  corner({ x: x0 + rad, y: y0 }, { x: x0, y: y0 + rad }, { x: x0 + rad, y: y0 + rad });
  line({ x: x0, y: y0 + rad }, { x: x0, y: y1 - rad });
  corner({ x: x0, y: y1 - rad }, { x: x0 + rad, y: y1 }, { x: x0 + rad, y: y1 - rad });
  return segs;
}

function walkPoly(pts: unknown[], warn: (m: string) => void): PolyPiece[] {
  const out: PolyPiece[] = [];
  let cur: Point | null = null;
  let i = 0;
  while (i < pts.length) {
    const tok = pts[i];
    if (typeof tok === 'number') {
      cur = pt(tok, num(pts[i + 1]));
      i += 2;
      continue;
    }
    if (tok === 'L') {
      i += 1;
      while (i + 1 < pts.length && typeof pts[i] === 'number' && typeof pts[i + 1] === 'number') {
        const nxt = pt(num(pts[i]), num(pts[i + 1]));
        if (cur) out.push({ kind: 'seg', seg: { type: 'line', start: cur, end: nxt } });
        cur = nxt;
        i += 2;
      }
      continue;
    }
    if (tok === 'ARC') {
      const angle = num(pts[i + 1]);
      const end = pt(num(pts[i + 2]), num(pts[i + 3]));
      if (cur) out.push({ kind: 'seg', seg: arcSeg(cur, end, angle) });
      cur = end;
      i += 4;
      continue;
    }
    if (tok === 'CIRCLE') {
      out.push({ kind: 'circle', center: pt(num(pts[i + 1]), num(pts[i + 2])), radius: mm(num(pts[i + 3])) });
      i += 4;
      continue;
    }
    if (tok === 'R') {
      for (const seg of rectPath(num(pts[i + 1]), num(pts[i + 2]), num(pts[i + 3]), num(pts[i + 4]), num(pts[i + 6]))) {
        out.push({ kind: 'seg', seg });
      }
      i += 7;
      continue;
    }
    warn(`unknown polyline command ${JSON.stringify(tok)} — remainder of shape skipped`);
    break;
  }
  return out;
}

/** Flatten poly pieces into a polygon vertex loop (arcs sampled coarsely). */
function piecesToPolygon(pieces: PolyPiece[]): Point[] {
  const poly: Point[] = [];
  const push = (p: Point): void => {
    const last = poly[poly.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) poly.push(p);
  };
  for (const piece of pieces) {
    if (piece.kind === 'circle') continue;
    const seg = piece.seg;
    push(seg.start);
    if (seg.type === 'arc') {
      // sample the arc every ~15 degrees so the polygon hugs it
      const a0 = Math.atan2(seg.start.y - seg.center.y, seg.start.x - seg.center.x);
      const a1 = Math.atan2(seg.end.y - seg.center.y, seg.end.x - seg.center.x);
      const r = Math.hypot(seg.start.x - seg.center.x, seg.start.y - seg.center.y);
      let sweep = a1 - a0;
      if (seg.cw && sweep > 0) sweep -= 2 * Math.PI;
      if (!seg.cw && sweep < 0) sweep += 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
      for (let s = 1; s < steps; s++) {
        const a = a0 + (sweep * s) / steps;
        push({ x: seg.center.x + r * Math.cos(a), y: seg.center.y + r * Math.sin(a) });
      }
    }
    push(seg.end);
  }
  const first = poly[0];
  const last = poly[poly.length - 1];
  if (poly.length > 1 && first && last && first.x === last.x && first.y === last.y) poly.pop();
  return poly;
}

// ---------------------------------------------------------------------------
// Footprint (.efoo) conversion
// ---------------------------------------------------------------------------

const FP_SILK_LAYERS = new Set([3, 4]);
// Component body / document layers folded into the courtyard bbox.
const FP_BODY_LAYERS = new Set([48, 13, 9, 52]);

/**
 * PAD record (Pro, observed):
 *   [0]"PAD" [1]id [2]? [3]net [4]layer(1 top,2 bottom,12 multi) [5]number
 *   [6]x [7]y [8]rotation [9]hole: null | ["ROUND",d,d] | ["SLOT",len,width]
 *   [10]shape: ["RECT",w,h,corner] | ["OVAL",w,h] | ["ELLIPSE",w,h] | ["POLY",pts]
 */
function parseProPad(r: Rec, warn: (m: string) => void): Pad | null {
  const layerId = num(r[4]);
  const layer: Pad['layer'] = layerId === 2 ? 'bottom' : layerId === 12 ? 'through' : 'top';
  const at = pt(num(r[6]), num(r[7]));
  const rotation = ((num(r[8]) % 360) + 360) % 360;
  const hole = Array.isArray(r[9]) ? (r[9] as unknown[]) : null;
  const shapeSpec = Array.isArray(r[10]) ? (r[10] as unknown[]) : null;
  if (!shapeSpec) {
    warn(`pad ${str(r[5])} has no shape — skipped`);
    return null;
  }
  const kind = str(shapeSpec[0]).toUpperCase();
  let shape: Pad['shape'];
  let size = { w: mm(num(shapeSpec[1])), h: mm(num(shapeSpec[2])) };
  let polygon: Point[] | undefined;
  if (kind === 'RECT') {
    shape = 'rect';
  } else if (kind === 'OVAL') {
    shape = 'oval';
  } else if (kind === 'ELLIPSE') {
    shape = size.w === size.h ? 'circle' : 'oval';
  } else if (kind === 'POLY' || kind === 'POLYGON') {
    shape = 'polygon';
    const raw = (Array.isArray(shapeSpec[1]) ? shapeSpec[1] : shapeSpec.slice(1)) as unknown[];
    const pieces = walkPoly(raw, warn);
    const abs = piecesToPolygon(pieces);
    polygon = abs.map((p) => ({ x: mm((p.x - at.x) / UNIT_MM), y: mm((p.y - at.y) / UNIT_MM) }));
    const xs = polygon.map((p) => p.x);
    const ys = polygon.map((p) => p.y);
    size = {
      w: Math.max(...xs, 0) - Math.min(...xs, 0),
      h: Math.max(...ys, 0) - Math.min(...ys, 0),
    };
    if (polygon.length < 3) {
      warn(`polygon pad ${str(r[5])} outline unparseable — approximated as rect`);
      shape = 'rect';
      polygon = undefined;
      size = { w: mm(num(shapeSpec[1])) || 0.5, h: mm(num(shapeSpec[2])) || 0.5 };
    }
  } else {
    warn(`pad ${str(r[5])} has unknown shape "${kind}" — treated as rect`);
    shape = 'rect';
  }

  let drill: Pad['drill'];
  if (hole) {
    const holeKind = str(hole[0]).toUpperCase();
    if (holeKind === 'ROUND') {
      drill = { diameter: mm(num(hole[1])), plated: true };
    } else if (holeKind === 'SLOT') {
      drill = { diameter: mm(num(hole[2])), slotLength: mm(num(hole[1])), plated: true };
    } else {
      warn(`pad ${str(r[5])} has unknown hole kind "${holeKind}" — treated as SMD`);
    }
  }

  return { number: str(r[5]), shape, at, rotation, size, ...(polygon ? { polygon } : {}), ...(drill ? { drill } : {}), layer };
}

function convertFootprint(name: string, lcsc: string, records: Rec[], warn: (m: string) => void): Footprint {
  const pads: Pad[] = [];
  const silk: SilkItem[] = [];
  const bodyXs: number[] = [];
  const bodyYs: number[] = [];

  const trackBody = (p: Point): void => {
    bodyXs.push(p.x);
    bodyYs.push(p.y);
  };

  for (const r of records) {
    const type = r[0];
    if (type === 'PAD') {
      const pad = parseProPad(r, warn);
      if (pad) {
        pads.push(pad);
        const half = Math.max(pad.size.w, pad.size.h) / 2;
        trackBody({ x: pad.at.x - half, y: pad.at.y - half });
        trackBody({ x: pad.at.x + half, y: pad.at.y + half });
      }
      continue;
    }
    if (type !== 'POLY' && type !== 'FILL') continue;
    // POLY: [4]=layer [5]=strokeWidth [6]=pts ; FILL: [4]=layer [5]=width [7]=pts
    const layer = num(r[4]);
    const ptsField = type === 'POLY' ? r[6] : r[7];
    if (!Array.isArray(ptsField)) continue;
    // FILL points may be nested one level ([[...]]); flatten single wrapper
    const ptsRaw =
      ptsField.length === 1 && Array.isArray(ptsField[0]) ? (ptsField[0] as unknown[]) : (ptsField as unknown[]);
    if (FP_SILK_LAYERS.has(layer) && type === 'POLY') {
      const width = mm(num(r[5])) || 0.15;
      for (const piece of walkPoly(ptsRaw, warn)) {
        if (piece.kind === 'circle') {
          silk.push({ kind: 'circle', center: piece.center, radius: piece.radius, width });
        } else if (piece.seg.type === 'line') {
          silk.push({ kind: 'line', start: piece.seg.start, end: piece.seg.end, width });
        } else {
          silk.push({
            kind: 'arc',
            start: piece.seg.start,
            end: piece.seg.end,
            center: piece.seg.center,
            cw: piece.seg.cw,
            width,
          });
        }
      }
    } else if (FP_BODY_LAYERS.has(layer)) {
      for (const piece of walkPoly(ptsRaw, () => {})) {
        if (piece.kind === 'circle') {
          trackBody({ x: piece.center.x - piece.radius, y: piece.center.y - piece.radius });
          trackBody({ x: piece.center.x + piece.radius, y: piece.center.y + piece.radius });
        } else {
          trackBody(piece.seg.start);
          trackBody(piece.seg.end);
        }
      }
    }
  }

  let courtyard: Point[][] = [];
  if (bodyXs.length >= 2) {
    const x0 = Math.min(...bodyXs);
    const x1 = Math.max(...bodyXs);
    const y0 = Math.min(...bodyYs);
    const y1 = Math.max(...bodyYs);
    courtyard = [
      [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
    ];
  }

  return { name, lcsc, pads, silk, courtyard };
}

// ---------------------------------------------------------------------------
// Project-level import
// ---------------------------------------------------------------------------

export interface EproImportResult {
  board: Board;
  warnings: string[];
}

interface ProjectJson {
  pcbs?: Record<string, string>;
  footprints?: Record<string, { title?: string }>;
  devices?: Record<string, { title?: string; attributes?: Record<string, string> }>;
}

const COPPER_LAYER: Record<number, 'F.Cu' | 'B.Cu'> = { 1: 'F.Cu', 2: 'B.Cu' };
const SILK_LAYER: Record<number, 'F.Silk' | 'B.Silk'> = { 3: 'F.Silk', 4: 'B.Silk' };

/** Strip units/ohm glyphs EasyEDA leaves in values so the BOM Comment stays bare. */
function bareValue(v: string): string {
  return v.replace(/[ΩΩ]$/u, '').trim();
}

export function importEpro(eproPath: string, opts: { pcbName?: string } = {}): EproImportResult {
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
  };

  const zip = new AdmZip(eproPath);
  const readEntry = (name: string): string | null => {
    const e = zip.getEntry(name);
    return e ? e.getData().toString('utf8') : null;
  };

  const projectRaw = readEntry('project.json');
  if (!projectRaw) throw new Error('not an EasyEDA Pro project: project.json missing from archive');
  const project = JSON.parse(projectRaw) as ProjectJson;

  const pcbs = Object.entries(project.pcbs ?? {});
  if (pcbs.length === 0) throw new Error('project has no PCB documents (schematic-only project)');
  let pcbEntry = pcbs[0]!;
  if (opts.pcbName) {
    const found = pcbs.find(([, n]) => n === opts.pcbName);
    if (!found) throw new Error(`PCB "${opts.pcbName}" not found; project has: ${pcbs.map(([, n]) => n).join(', ')}`);
    pcbEntry = found;
  } else if (pcbs.length > 1) {
    warn(`project has ${pcbs.length} PCBs (${pcbs.map(([, n]) => n).join(', ')}); importing "${pcbEntry[1]}"`);
  }
  const [pcbUuid, pcbName] = pcbEntry;
  const pcbRaw = readEntry(`PCB/${pcbUuid}.epcb`);
  if (!pcbRaw) throw new Error(`PCB document PCB/${pcbUuid}.epcb missing from archive`);
  const records = parseRecords(pcbRaw);

  // -- collect PCB records by type ---------------------------------------
  const components: Rec[] = [];
  const attrsByParent = new Map<string, Map<string, Rec>>();
  const lines: Rec[] = [];
  const viaRecs: Rec[] = [];
  const polyRecs: Rec[] = [];
  const pourRecs: Rec[] = [];
  const regionRecs: Rec[] = [];
  const padRecs: Rec[] = [];
  const padNets: Rec[] = [];
  const netNames: string[] = [];
  let physLayers = 0;

  for (const r of records) {
    switch (r[0]) {
      case 'COMPONENT':
        components.push(r);
        break;
      case 'ATTR': {
        const parent = str(r[3]);
        if (!attrsByParent.has(parent)) attrsByParent.set(parent, new Map());
        attrsByParent.get(parent)!.set(str(r[7]), r);
        break;
      }
      case 'LINE':
        lines.push(r);
        break;
      case 'VIA':
        viaRecs.push(r);
        break;
      case 'POLY':
        polyRecs.push(r);
        break;
      case 'POUR':
        pourRecs.push(r);
        break;
      case 'REGION':
        regionRecs.push(r);
        break;
      case 'PAD':
        padRecs.push(r);
        break;
      case 'PAD_NET':
        padNets.push(r);
        break;
      case 'NET':
        if (str(r[1])) netNames.push(str(r[1]));
        break;
      case 'LAYER_PHYS':
        physLayers++;
        break;
      default:
        break;
    }
  }

  // Only 2-layer boards are supported so far: the Pro inner-copper layer ids
  // haven't been verified against a real 4-layer project, and guessing wrong
  // would silently drop inner routing. Tracks on unknown layers warn loudly.
  const board = newBoard(pcbName || 'imported', 2);
  board.name = pcbName || 'imported';
  void physLayers;

  // -- board outline: POLY records on layer 11 ---------------------------
  const outlinePieces: PathSeg[] = [];
  for (const r of polyRecs) {
    if (num(r[4]) !== 11) continue;
    for (const piece of walkPoly(Array.isArray(r[6]) ? (r[6] as unknown[]) : [], warn)) {
      if (piece.kind === 'seg') outlinePieces.push(piece.seg);
      else warn('board outline contains a full circle — not supported, skipped');
    }
  }
  if (outlinePieces.length === 0) warn('no board outline found on layer 11 — set one with set_board_outline');
  board.outline = outlinePieces;

  // -- footprints (lazy, one parse per uuid) ------------------------------
  const fpCache = new Map<string, Footprint>();
  const footprintFor = (fpUuid: string, lcsc: string): Footprint | null => {
    const cached = fpCache.get(fpUuid);
    if (cached) return { ...cached, lcsc: cached.lcsc || lcsc };
    const raw = readEntry(`FOOTPRINT/${fpUuid}.efoo`);
    if (!raw) return null;
    const title = project.footprints?.[fpUuid]?.title ?? fpUuid;
    const fp = convertFootprint(title, lcsc, parseRecords(raw), (m) => warn(`footprint ${title}: ${m}`));
    fpCache.set(fpUuid, fp);
    return fp;
  };

  // -- components ----------------------------------------------------------
  // COMPONENT: [1]=id [3]=layer(1 top,2 bottom) [4]=x [5]=y [6]=rot
  const refdesById = new Map<string, string>();
  const seenRefdes = new Set<string>();
  for (const r of components) {
    const id = str(r[1]);
    const attrs = attrsByParent.get(id) ?? new Map<string, Rec>();
    let refdes = str(attrs.get('Designator')?.[8]);
    if (!refdes) {
      refdes = `X_${id}`;
      warn(`component ${id} has no designator — imported as ${refdes}`);
    }
    if (seenRefdes.has(refdes)) {
      const alt = `${refdes}_${id}`;
      warn(`duplicate designator ${refdes} — imported as ${alt}`);
      refdes = alt;
    }
    seenRefdes.add(refdes);
    refdesById.set(id, refdes);

    const deviceUuid = str(attrs.get('Device')?.[8]);
    const device = project.devices?.[deviceUuid];
    const dAttrs = device?.attributes ?? {};
    const lcsc = dAttrs['Supplier Part'] ?? '';
    const fpUuid = str(attrs.get('Footprint')?.[8]);
    const footprint = fpUuid ? footprintFor(fpUuid, lcsc) : null;
    if (!footprint) {
      warn(`component ${refdes}: footprint ${fpUuid || '(none)'} missing from archive — SKIPPED`);
      continue;
    }

    const side: ComponentInst['side'] = num(r[3]) === 2 ? 'bottom' : 'top';
    const value = bareValue(dAttrs['Value'] ?? device?.title ?? '');
    const inst: ComponentInst = {
      refdes,
      lcsc,
      footprint: { ...footprint, lcsc },
      at: pt(num(r[4]), num(r[5])),
      rotation: ((num(r[6]) % 360) + 360) % 360,
      side,
      fields: {
        ...(value ? { value } : {}),
        ...(dAttrs['Manufacturer'] ? { mfr: dAttrs['Manufacturer'] } : {}),
        ...(dAttrs['Supplier Footprint'] ? { package: dAttrs['Supplier Footprint'] } : {}),
        ...(dAttrs['JLCPCB Part Class']?.startsWith('Basic') ? { basic: true } : {}),
      },
    };
    board.components.push(inst);
  }

  // -- nets ---------------------------------------------------------------
  const netByName = new Map<string, Net>();
  const ensureNet = (name: string): Net => {
    let n = netByName.get(name);
    if (!n) {
      n = { name, class: 'default', pins: [] };
      netByName.set(name, n);
    }
    return n;
  };
  for (const name of netNames) ensureNet(name);
  let orphanPadNets = 0;
  for (const r of padNets) {
    // PAD_NET: [1]=componentId [2]=padNumber [3]=net
    const refdes = refdesById.get(str(r[1]));
    const netName = str(r[3]);
    if (!netName) continue;
    if (!refdes) {
      orphanPadNets++;
      continue;
    }
    ensureNet(netName).pins.push(`${refdes}.${str(r[2])}`);
  }
  if (orphanPadNets > 0) warn(`${orphanPadNets} PAD_NET record(s) referenced unknown components — ignored`);

  // -- tracks: LINE [3]=net [4]=layer [5..8]=x1 y1 x2 y2 [9]=width ---------
  let skippedLines = 0;
  for (const r of lines) {
    const layer = COPPER_LAYER[num(r[4])];
    const width = mm(num(r[9]));
    if (!layer) {
      const silkLayer = SILK_LAYER[num(r[4])];
      if (silkLayer) {
        const sl: SilkLine = {
          id: uuid(),
          layer: silkLayer,
          start: pt(num(r[5]), num(r[6])),
          end: pt(num(r[7]), num(r[8])),
          width: width || 0.15,
        };
        board.silkLines.push(sl);
      } else {
        skippedLines++;
      }
      continue;
    }
    const netName = str(r[3]);
    if (netName) ensureNet(netName);
    const track: Track = {
      id: uuid(),
      layer,
      width,
      net: netName,
      seg: { type: 'line', start: pt(num(r[5]), num(r[6])), end: pt(num(r[7]), num(r[8])) },
    };
    board.tracks.push(track);
  }
  if (skippedLines > 0) warn(`${skippedLines} LINE record(s) on non-copper, non-silk layers — skipped`);

  // -- copper polylines (e.g. drawn antennas): POLY with a net on 1/2 ------
  for (const r of polyRecs) {
    const layer = COPPER_LAYER[num(r[4])];
    if (!layer) continue;
    const netName = str(r[3]);
    if (netName) ensureNet(netName);
    const width = mm(num(r[5]));
    for (const piece of walkPoly(Array.isArray(r[6]) ? (r[6] as unknown[]) : [], warn)) {
      if (piece.kind === 'circle') {
        warn(`copper POLY circle on ${layer} not supported — skipped`);
        continue;
      }
      board.tracks.push({ id: uuid(), layer, width, net: netName, seg: piece.seg });
    }
  }

  // -- vias: VIA [3]=net [5]=x [6]=y [7]=drill dia [8]=outer dia -----------
  for (const r of viaRecs) {
    const netName = str(r[3]);
    if (netName) ensureNet(netName);
    const via: Via = {
      id: uuid(),
      at: pt(num(r[5]), num(r[6])),
      drill: mm(num(r[7])),
      diameter: mm(num(r[8])),
      net: netName,
    };
    board.vias.push(via);
  }

  // -- standalone pads: mounting holes and stitching vias ------------------
  for (const r of padRecs) {
    const pad = parseProPad(r, warn);
    if (!pad) continue;
    const netName = str(r[3]);
    if (pad.drill && !pad.drill.slotLength) {
      if (pad.drill.diameter >= 1.5) {
        const hole: MountingHole = {
          id: uuid(),
          at: pad.at,
          drill: pad.drill.diameter,
          padDiameter: Math.max(pad.size.w, pad.size.h),
          plated: true,
        };
        board.holes.push(hole);
        if (netName)
          warn(`mounting hole at (${pad.at.x}, ${pad.at.y}) was tied to net ${netName} — Flamingo holes carry no net`);
      } else {
        if (netName) ensureNet(netName);
        board.vias.push({
          id: uuid(),
          at: pad.at,
          drill: pad.drill.diameter,
          diameter: Math.max(pad.size.w, pad.size.h),
          net: netName,
        });
      }
    } else {
      warn(`free pad "${pad.number}" at (${pad.at.x}, ${pad.at.y}) is not a simple hole — skipped`);
    }
  }

  // -- pours -> zones: POUR [3]=net [4]=layer [8]=outline ------------------
  for (const r of pourRecs) {
    const layer = COPPER_LAYER[num(r[4])];
    if (!layer) {
      warn(`pour "${str(r[6])}" on unsupported layer ${num(r[4])} — skipped`);
      continue;
    }
    const netName = str(r[3]);
    if (netName) ensureNet(netName);
    const outline = Array.isArray(r[8]) ? (r[8] as unknown[]) : [];
    const ptsRaw = outline.length === 1 && Array.isArray(outline[0]) ? (outline[0] as unknown[]) : outline;
    const polygon = piecesToPolygon(walkPoly(ptsRaw, warn));
    if (polygon.length < 3) {
      warn(`pour "${str(r[6])}" outline unparseable — skipped`);
      continue;
    }
    const zone: Zone = {
      id: uuid(),
      layer,
      net: netName,
      polygon,
      clearance: 0.25,
      minWidth: 0.15,
      thermal: { gap: 0.3, spokeWidth: 0.4 },
    };
    board.zones.push(zone);
  }

  // -- regions -> pour keepouts (flag semantics unknown; least disruptive) -
  for (const r of regionRecs) {
    const outline = Array.isArray(r[6]) ? (r[6] as unknown[]) : [];
    const ptsRaw = outline.length === 1 && Array.isArray(outline[0]) ? (outline[0] as unknown[]) : outline;
    const polygon = piecesToPolygon(walkPoly(ptsRaw, warn));
    if (polygon.length < 3) continue;
    const keepout: Keepout = {
      id: uuid(),
      layers: 'all',
      polygon,
      keepout: { copper: false, via: false, pour: true },
    };
    board.keepouts.push(keepout);
    warn('REGION imported as pour-only keepout (EasyEDA rule-region semantics are richer — review it)');
  }

  board.nets = [...netByName.values()];
  normalizeImportedCopper(board, warn);
  return { board, warnings };
}

// ---------------------------------------------------------------------------
// Copper normalization.
//
// Flamingo's connectivity model unions track ENDPOINTS within 0.01 mm of each
// other or of a pad's center. EasyEDA copper is looser: a track may end
// anywhere inside a pad, and a manual route may tee into the MIDDLE of another
// segment. Both are physically connected copper that the engine would read as
// open, so after importing we normalize:
//   1. split any straight track at points where another same-net endpoint or
//      via lands on its interior (T-junctions), and
//   2. add a short same-net stub from any endpoint/via that lies inside a
//      pad's copper but not at its center, so the pad anchor is reachable.
// ---------------------------------------------------------------------------

/** Distance from p to segment ab, and the projection parameter u in [0,1]. */
function pointSegDist(p: Point, a: Point, b: Point): { d: number; u: number; foot: Point } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const u = len2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
  const uc = Math.max(0, Math.min(1, u));
  const foot = { x: a.x + uc * abx, y: a.y + uc * aby };
  return { d: Math.hypot(p.x - foot.x, p.y - foot.y), u: uc, foot };
}

const JUNCTION_TOL = 0.002; // mm; imported junctions are exact up to rounding
const CONNECT_EPS = 0.01; // engine's connectivity epsilon

function normalizeImportedCopper(board: Board, warn: (m: string) => void): void {
  const cu = copperLayersOf(board);
  let splits = 0;
  let stubs = 0;

  const netNames = new Set<string>();
  for (const t of board.tracks) if (t.net) netNames.add(t.net);
  for (const v of board.vias) if (v.net) netNames.add(v.net);

  // Pad geometry per net, resolved once: world anchor, world rotation, layers.
  const padsByNet = new Map<string, { anchor: Point; rot: number; size: { w: number; h: number }; layers: string[] }[]>();
  for (const net of board.nets) {
    const list: { anchor: Point; rot: number; size: { w: number; h: number }; layers: string[] }[] = [];
    for (const pin of net.pins) {
      const dot = pin.indexOf('.');
      const comp = board.components.find((c) => c.refdes === pin.slice(0, dot));
      const pad = comp?.footprint.pads.find((p) => p.number === pin.slice(dot + 1));
      if (!comp || !pad) continue;
      const w = padWorld(comp, pad);
      list.push({ anchor: w.at, rot: w.rotation, size: pad.size, layers: padCopperLayers(pad, comp.side, cu) });
    }
    if (list.length) padsByNet.set(net.name, list);
  }

  for (const netName of netNames) {
    const tracks = board.tracks.filter((t) => t.net === netName);
    const vias = board.vias.filter((v) => v.net === netName);

    // Junction candidates: every endpoint (with its layer) and via (all layers).
    const points: { at: Point; layer: string | null; width: number }[] = [];
    for (const t of tracks) {
      if (t.seg.type !== 'line') continue;
      points.push({ at: t.seg.start, layer: t.layer, width: t.width });
      points.push({ at: t.seg.end, layer: t.layer, width: t.width });
    }
    for (const v of vias) points.push({ at: v.at, layer: null, width: v.diameter });
    // Pad anchors too: a track routed straight THROUGH a pad without stopping
    // must be split at the pad so the engine sees the connection.
    for (const pad of padsByNet.get(netName) ?? []) {
      points.push({
        at: pad.anchor,
        layer: pad.layers.length === 1 ? (pad.layers[0] as string) : null,
        width: Math.min(pad.size.w, pad.size.h),
      });
    }

    // 1. Overlap junctions: EasyEDA connectivity is copper-shape overlap, so a
    // track end whose round cap overlaps another segment's copper is joined
    // even when the endpoint sits well off that segment's spine. For every
    // such contact, split the segment at the foot of the perpendicular and,
    // if the endpoint isn't within the engine's epsilon of the foot, lay a
    // short connector stub endpoint->foot (all same-net copper inside the
    // overlap region, so it adds nothing electrically or for DRC).
    const connectors: Track[] = [];
    for (const t of tracks) {
      if (t.seg.type !== 'line') continue;
      const cuts: number[] = [];
      for (const p of points) {
        if (p.layer !== null && p.layer !== t.layer) continue;
        const reach = (p.width + t.width) / 2 - 1e-6;
        const { d, u, foot } = pointSegDist(p.at, t.seg.start, t.seg.end);
        if (d > Math.max(JUNCTION_TOL, reach)) continue;
        const endA = Math.hypot(p.at.x - t.seg.start.x, p.at.y - t.seg.start.y);
        const endB = Math.hypot(p.at.x - t.seg.end.x, p.at.y - t.seg.end.y);
        if (endA <= CONNECT_EPS || endB <= CONNECT_EPS) continue; // already unions at the endpoint
        cuts.push(u);
        if (d > CONNECT_EPS) {
          connectors.push({
            id: uuid(),
            layer: t.layer,
            width: Math.min(p.width, t.width),
            net: netName,
            seg: { type: 'line', start: { x: p.at.x, y: p.at.y }, end: foot },
          });
        }
      }
      if (cuts.length === 0) continue;
      cuts.sort((a, b) => a - b);
      const chain: Point[] = [t.seg.start];
      for (const u of cuts) {
        const p = {
          x: t.seg.start.x + u * (t.seg.end.x - t.seg.start.x),
          y: t.seg.start.y + u * (t.seg.end.y - t.seg.start.y),
        };
        const last = chain[chain.length - 1]!;
        if (Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) chain.push(p);
      }
      chain.push(t.seg.end);
      if (chain.length <= 2) continue;
      splits++;
      t.seg = { type: 'line', start: chain[0]!, end: chain[1]! };
      for (let i = 1; i + 1 < chain.length; i++) {
        board.tracks.push({ id: uuid(), layer: t.layer, width: t.width, net: t.net, seg: { type: 'line', start: chain[i]!, end: chain[i + 1]! } });
      }
    }
    board.tracks.push(...connectors);

    // 2. Stubs from in-pad endpoints/vias to the pad anchor.
    const pads = padsByNet.get(netName);
    if (!pads) continue;
    const stubKeys = new Set<string>();
    const contactPoints: { at: Point; layers: string[]; width: number }[] = [];
    for (const t of board.tracks) {
      if (t.net !== netName || t.seg.type !== 'line') continue;
      contactPoints.push({ at: t.seg.start, layers: [t.layer], width: t.width });
      contactPoints.push({ at: t.seg.end, layers: [t.layer], width: t.width });
    }
    for (const v of vias) contactPoints.push({ at: v.at, layers: [...cu], width: 0.25 });

    for (const pad of pads) {
      const cos = Math.cos((-pad.rot * Math.PI) / 180);
      const sin = Math.sin((-pad.rot * Math.PI) / 180);
      const hw = pad.size.w / 2;
      const hh = pad.size.h / 2;
      for (const cp of contactPoints) {
        const sharedLayer = cp.layers.find((l) => pad.layers.includes(l as never));
        if (!sharedLayer) continue;
        const d = Math.hypot(cp.at.x - pad.anchor.x, cp.at.y - pad.anchor.y);
        if (d <= CONNECT_EPS) continue; // engine already sees this contact
        // point-in-rotated-rect (pad bbox) test in the pad frame
        const dx = cp.at.x - pad.anchor.x;
        const dy = cp.at.y - pad.anchor.y;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        // Inflate by half the contact's width: a cap overlapping the pad edge
        // is connected copper even though its center is outside the pad.
        const reach = cp.width / 2;
        if (Math.abs(lx) > hw + reach || Math.abs(ly) > hh + reach) continue;
        const key = `${sharedLayer}:${cp.at.x.toFixed(4)},${cp.at.y.toFixed(4)}->${pad.anchor.x.toFixed(4)},${pad.anchor.y.toFixed(4)}`;
        if (stubKeys.has(key)) continue;
        stubKeys.add(key);
        stubs++;
        board.tracks.push({
          id: uuid(),
          layer: sharedLayer as Track['layer'],
          width: Math.min(cp.width, pad.size.w, pad.size.h),
          net: netName,
          seg: { type: 'line', start: { x: cp.at.x, y: cp.at.y }, end: { x: pad.anchor.x, y: pad.anchor.y } },
        });
      }
    }
  }

  if (splits || stubs) {
    warn(`normalized imported copper: split ${splits} track(s) at T-junctions, added ${stubs} in-pad stub segment(s)`);
  }
}
