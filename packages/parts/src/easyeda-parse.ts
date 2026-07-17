/**
 * EasyEDA footprint parser.
 *
 * Source: `GET https://easyeda.com/api/products/{LCSC}/components` returns
 *   { success, code, result }
 * where the PCB footprint lives at `result.packageDetail.dataStr` and the
 * schematic symbol (which carries the richest part metadata) at
 * `result.dataStr`.
 *
 * UNIT CONVERSION (binding, verified against real fixtures):
 *   1 EasyEDA unit = 10 mil = 0.254 mm.
 *   All shape coordinates are absolute canvas coords; the footprint origin is
 *   `packageDetail.dataStr.head.x / .y`. Subtract the origin, then negate Y
 *   (EasyEDA canvas is y-down; our engine is y-up), then multiply by 0.254.
 *
 *   Verified with C25804 (0603): pads at raw x=3997.034 / 4002.966 around
 *   origin x=4000 give ±0.7534 mm => 1.507 mm center-to-center, correct for
 *   a 0603 land pattern. Corner-set of the rotated RP2040 pad 56 matches the
 *   fixture's ground-truth POLYGON points exactly under this transform.
 */

import type { Footprint, Pad, SilkItem, Point } from '@flamingo/engine';

export interface PartInfo {
  lcsc: string;
  mfr: string;
  mpn: string;
  description: string;
  package: string;
  basic: boolean;
  stock?: number;
  price?: number;
  datasheet?: string;
}

/** 1 EasyEDA unit = 10 mil = 0.254 mm. */
const UNIT_MM = 0.254;

/** EasyEDA PCB layer ids we care about. */
const LAYER_TOP = 1;
const LAYER_BOTTOM = 2;
const LAYER_MULTI = 11; // through-hole / multi-layer pads
const SILK_LAYERS = new Set([3, 4]); // 3 = F.Silk (TopSilk), 4 = B.Silk
// Component body / lead-shape / document layers we fold into the courtyard.
const COURTYARD_LAYERS = new Set([99, 100, 12]);

function num(s: string | undefined): number {
  if (s === undefined) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** Normalize an angle into [0, 360). */
function normAngle(a: number): number {
  return ((a % 360) + 360) % 360;
}

/** Parse "x y x y ..." into absolute canvas point pairs. */
function parsePairs(s: string | undefined): Array<[number, number]> {
  if (!s) return [];
  const t = s.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < t.length; i += 2) out.push([t[i]!, t[i + 1]!]);
  return out;
}

type Convert = (x: number, y: number) => Point;

function makeConvert(ox: number, oy: number): Convert {
  return (x, y) => ({ x: (x - ox) * UNIT_MM, y: -(y - oy) * UNIT_MM });
}

/**
 * PAD shape string (EasyEDA editor 6.5.x, observed field layout):
 *   [0]  "PAD"
 *   [1]  shape: ELLIPSE | RECT | OVAL | POLYGON
 *   [2]  x        (center, canvas units)
 *   [3]  y
 *   [4]  width
 *   [5]  height
 *   [6]  layerId  (1=top, 2=bottom, 11=multi/through)
 *   [7]  net       (often empty)
 *   [8]  number    (pad name / pin number)
 *   [9]  holeRadius (0 for SMD; >0 = plated through-hole)
 *   [10] points    (space-separated absolute-coord polygon outline)
 *   [11] rotation  (degrees, canvas frame; see note below)
 *   [12] id        ("gge..." / "rep...")
 *   [13] holeLength (slot length; 0 for a round hole)
 *   [14] slotPoints (present only for slotted holes)
 *   [15] plated     ("Y" / "N")
 *   ... trailing version-specific fields, then a "cx,cy" echo of the center.
 *
 * ROTATION SENSE: EasyEDA rotation is degrees in the y-down canvas. Our engine
 * is y-up / CCW. The point transform (x,y)->(x,-y) maps an angle theta to
 * -theta, so our pad rotation = normalize(-rawRotation). RECT/OVAL pads are
 * 180-degree symmetric so the sign is only observable on POLYGON pads; verified
 * that the corner geometry of RP2040 pad 56 (raw rot 270 -> stored 90) matches
 * the fixture's ground-truth outline.
 */
function parsePad(fields: string[], conv: Convert): Pad {
  const rawShape = (fields[1] ?? '').toUpperCase();
  const x = num(fields[2]);
  const y = num(fields[3]);
  const w = num(fields[4]);
  const h = num(fields[5]);
  const layerId = Math.round(num(fields[6]));
  const number = (fields[8] ?? '').trim();
  const holeR = num(fields[9]);
  const rawRot = num(fields[11]);
  const holeLen = num(fields[13]);
  const platedFlag = (fields[15] ?? 'Y').trim().toUpperCase();

  let shape: Pad['shape'];
  switch (rawShape) {
    case 'ELLIPSE':
      shape = Math.abs(w - h) < 1e-6 ? 'circle' : 'oval';
      break;
    case 'RECT':
      shape = 'rect';
      break;
    case 'OVAL':
      shape = 'oval';
      break;
    case 'POLYGON':
      shape = 'polygon';
      break;
    default:
      shape = 'rect';
      break;
  }

  const at = conv(x, y);
  const through = holeR > 0 || layerId === LAYER_MULTI;
  const layer: Pad['layer'] = through
    ? 'through'
    : layerId === LAYER_BOTTOM
      ? 'bottom'
      : 'top';

  const pad: Pad = {
    number,
    shape,
    at,
    rotation: normAngle(-rawRot),
    size: { w: w * UNIT_MM, h: h * UNIT_MM },
    layer,
  };

  if (shape === 'polygon') {
    // POLYGON outline points are absolute canvas coords; store relative to `at`.
    pad.polygon = parsePairs(fields[10]).map(([px, py]) => {
      const p = conv(px, py);
      return { x: p.x - at.x, y: p.y - at.y };
    });
  }

  if (holeR > 0) {
    pad.drill = {
      diameter: 2 * holeR * UNIT_MM,
      plated: platedFlag !== 'N',
    };
    if (holeLen > 0) pad.drill.slotLength = holeLen * UNIT_MM;
  }

  return pad;
}

/**
 * TRACK: [0]"TRACK" [1]strokeWidth [2]layerId [3]net [4]points [5]id ...
 * On silk layers, a polyline of N points becomes N-1 line segments.
 */
function parseTrack(fields: string[], conv: Convert): SilkItem[] {
  const layerId = Math.round(num(fields[2]));
  if (!SILK_LAYERS.has(layerId)) return [];
  const width = num(fields[1]) * UNIT_MM;
  const pts = parsePairs(fields[4]).map(([x, y]) => conv(x, y));
  const out: SilkItem[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    out.push({ kind: 'line', start: pts[i]!, end: pts[i + 1]!, width });
  }
  return out;
}

/** CIRCLE: [0]"CIRCLE" [1]cx [2]cy [3]radius [4]strokeWidth [5]layerId [6]id */
function parseCircle(fields: string[], conv: Convert): SilkItem[] {
  const layerId = Math.round(num(fields[5]));
  if (!SILK_LAYERS.has(layerId)) return [];
  return [
    {
      kind: 'circle',
      center: conv(num(fields[1]), num(fields[2])),
      radius: num(fields[3]) * UNIT_MM,
      width: num(fields[4]) * UNIT_MM,
    },
  ];
}

/**
 * ARC: [0]"ARC" [1]strokeWidth [2]layerId [3]net [4]pathStr [5]? [6]id ...
 * pathStr is an SVG path: "M sx sy A rx ry xRot largeArc sweep ex ey".
 * We compute the arc center from the SVG endpoint parameters (see spec
 * "Conversion from endpoint to center parameterization"), convert start/end/
 * center to our frame, and set `cw` from the sweep flag. A sweep-flag of 1
 * draws in the positive-angle direction of the y-down canvas frame, which
 * reads visually clockwise on screen; our y-up frame renders the same visual
 * picture (the conv() y-flip and the renderer's y-down screen flip cancel),
 * and `cw` means visually-clockwise in that picture, so cw = (sweep === 1).
 * Silk arcs are cosmetic; on any parse failure we skip.
 */
function parseArc(fields: string[], conv: Convert): SilkItem[] {
  const layerId = Math.round(num(fields[2]));
  if (!SILK_LAYERS.has(layerId)) return [];
  const path = fields[4] ?? '';
  const m = path.match(
    /M\s*([-\d.]+)[ ,]+([-\d.]+)\s*A\s*([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)[ ,]+([01])[ ,]+([01])[ ,]+([-\d.]+)[ ,]+([-\d.]+)/i,
  );
  if (!m) return [];
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  let rx = Math.abs(Number(m[3]));
  let ry = Math.abs(Number(m[4]));
  const phi = (Number(m[5]) * Math.PI) / 180;
  const fA = m[6] === '1';
  const fS = m[7] === '1';
  const x2 = Number(m[8]);
  const y2 = Number(m[9]);
  if (rx === 0 || ry === 0) return [];

  // SVG endpoint -> center parameterization (canvas coords).
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  // Ensure radii are large enough.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const numr =
    rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, numr / den));
  if (fA === fS) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

  return [
    {
      kind: 'arc',
      start: conv(x1, y1),
      end: conv(x2, y2),
      center: conv(cx, cy),
      cw: fS,
      width: num(fields[1]) * UNIT_MM,
    },
  ];
}

/** Number of parameters each SVG path command consumes per coordinate set. */
const SVG_PARAM_COUNT: Record<string, number> = {
  M: 2, L: 2, T: 2, H: 1, V: 1, Q: 4, S: 4, C: 6, A: 7, Z: 0,
};

/**
 * Parse an SVG path ("M x y L x y A rx ry rot laf sf x y ... Z") into the
 * ordered polygon vertices it visits. Commands are walked properly — only each
 * command's *endpoint* becomes a vertex (arcs are chord-approximated by their
 * endpoint), so an 'A' command's rx/ry/rotation/large-arc/sweep parameters are
 * NOT mistaken for coordinates. Handles absolute and relative commands and the
 * SVG rule that extra coordinate sets after an M/m implicitly repeat as L/l.
 *
 * The old parser blindly paired every number in the string, which folded the
 * five non-coordinate parameters of every arc in as bogus vertices and blew the
 * courtyard bbox hundreds of mm away from the part.
 */
function parseRegionPath(path: string): Array<[number, number]> {
  const tokens = path.match(/[MLHVCSQTAZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const out: Array<[number, number]> = [];
  let i = 0;
  let cmd = '';
  let cx = 0; // current point
  let cy = 0;
  let sx = 0; // subpath start (for Z)
  let sy = 0;

  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i]!)) {
      cmd = tokens[i]!;
      i++;
    }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const n = SVG_PARAM_COUNT[up];
    if (n === undefined) {
      i++; // unrecognized command letter; skip it
      continue;
    }
    if (up === 'Z') {
      cx = sx;
      cy = sy;
      continue;
    }
    if (i + n > tokens.length) break; // truncated / malformed
    const p = tokens.slice(i, i + n).map(Number);
    i += n;
    // Endpoint (last two params), except H/V which move along one axis only.
    if (up === 'H') {
      cx = rel ? cx + p[0]! : p[0]!;
    } else if (up === 'V') {
      cy = rel ? cy + p[0]! : p[0]!;
    } else {
      const ex = p[n - 2]!;
      const ey = p[n - 1]!;
      cx = rel ? cx + ex : ex;
      cy = rel ? cy + ey : ey;
    }
    out.push([cx, cy]);
    if (up === 'M') {
      sx = cx;
      sy = cy;
      cmd = rel ? 'l' : 'L'; // implicit lineto for subsequent coordinate sets
    }
  }
  return out;
}

/**
 * SOLIDREGION: [0]"SOLIDREGION" [1]layerId [2]net [3]pathStr [4]fillStyle ...
 * On component-body / lead / document layers we treat the filled region as a
 * courtyard polygon.
 */
function parseSolidRegion(fields: string[], conv: Convert): Point[] | null {
  const layerId = Math.round(num(fields[1]));
  if (!COURTYARD_LAYERS.has(layerId)) return null;
  const pts = parseRegionPath(fields[3] ?? '').map(([x, y]) => conv(x, y));
  return pts.length >= 3 ? pts : null;
}

/**
 * RECT (top-level, not PAD): [0]"RECT" [1]x [2]y [3]w [4]h [5]? ... [layerId]
 * Rare; when it sits on a courtyard layer we emit its 4 corners as a polygon.
 * Layer id position varies by version, so we scan for a courtyard layer id.
 */
function parseRect(fields: string[], conv: Convert): Point[] | null {
  // Layer-id field position varies by version; match an exact integer token
  // (not a fractional coordinate that merely rounds to a courtyard id).
  const onCourtyard = fields
    .slice(5)
    .some((f) => COURTYARD_LAYERS.has(Number(f.trim())) && /^\d+$/.test(f.trim()));
  if (!onCourtyard) return null;
  const x = num(fields[1]);
  const y = num(fields[2]);
  const w = num(fields[3]);
  const h = num(fields[4]);
  return [
    conv(x, y),
    conv(x + w, y),
    conv(x + w, y + h),
    conv(x, y + h),
  ];
}

interface RawResult {
  title?: string;
  description?: string;
  lcsc?: { number?: string; stock?: number; price?: number };
  szlcsc?: { number?: string; stock?: number; price?: number };
  dataStr?: { head?: { c_para?: Record<string, string> } };
  packageDetail?: {
    title?: string;
    dataStr?: {
      head?: { x?: number; y?: number; c_para?: Record<string, string> };
      shape?: string[];
    };
  };
}

/** Unwrap the { success, result } envelope, or accept a bare result object. */
function unwrap(apiJson: unknown): RawResult {
  if (apiJson && typeof apiJson === 'object') {
    const o = apiJson as Record<string, unknown>;
    if (o.result && typeof o.result === 'object') return o.result as RawResult;
    return o as RawResult;
  }
  throw new Error('parseEasyedaFootprint: expected an object');
}

/** Derive PartInfo from a component result (works for full parts and search hits). */
export function deriveInfo(root: RawResult): Partial<PartInfo> {
  const sym = root.dataStr?.head?.c_para ?? {};
  const pkg = root.packageDetail?.dataStr?.head?.c_para ?? {};
  const lcscObj = root.lcsc ?? root.szlcsc ?? {};
  const lcsc = lcscObj.number ?? sym['Supplier Part'] ?? '';
  const partClass = sym['JLCPCB Part Class'] ?? '';
  const datasheet = pkg['link'] ?? sym['link'];

  const info: Partial<PartInfo> = {
    lcsc,
    mpn: sym['Manufacturer Part'] ?? root.title ?? '',
    mfr: sym['Manufacturer'] ?? '',
    package: sym['package'] ?? pkg['package'] ?? '',
    description: root.description ?? '',
    basic: partClass === 'Basic Part',
  };
  if (datasheet && /^https?:\/\//i.test(datasheet)) info.datasheet = datasheet;
  const stock = root.lcsc?.stock ?? root.szlcsc?.stock;
  const price = root.lcsc?.price ?? root.szlcsc?.price;
  if (typeof stock === 'number') info.stock = stock;
  if (typeof price === 'number') info.price = price;
  return info;
}

/**
 * Parse an EasyEDA component API response into our Footprint + partial PartInfo.
 * Throws only when the footprint itself is unusable (missing dataStr/shape).
 * Cosmetic unknown shape types are logged once and skipped, never thrown.
 */
export function parseEasyedaFootprint(
  apiJson: unknown,
): { footprint: Footprint; info: Partial<PartInfo> } {
  const root = unwrap(apiJson);
  const ds = root.packageDetail?.dataStr;
  const head = ds?.head;
  const shapes = ds?.shape;
  if (!head || !Array.isArray(shapes)) {
    throw new Error('parseEasyedaFootprint: missing packageDetail.dataStr.shape');
  }
  const conv = makeConvert(num(String(head.x ?? 0)), num(String(head.y ?? 0)));

  const pads: Pad[] = [];
  const silk: SilkItem[] = [];
  const courtyard: Point[][] = [];
  const warned = new Set<string>();
  const warnOnce = (type: string): void => {
    if (!warned.has(type)) {
      warned.add(type);
      console.warn(`parseEasyedaFootprint: skipping unsupported shape "${type}"`);
    }
  };

  for (const line of shapes) {
    if (typeof line !== 'string') continue;
    const fields = line.split('~');
    const type = fields[0];
    try {
      switch (type) {
        case 'PAD':
          pads.push(parsePad(fields, conv));
          break;
        case 'TRACK':
          silk.push(...parseTrack(fields, conv));
          break;
        case 'CIRCLE':
          silk.push(...parseCircle(fields, conv));
          break;
        case 'ARC':
          silk.push(...parseArc(fields, conv));
          break;
        case 'SOLIDREGION': {
          const poly = parseSolidRegion(fields, conv);
          if (poly) courtyard.push(poly);
          break;
        }
        case 'RECT': {
          const poly = parseRect(fields, conv);
          if (poly) courtyard.push(poly);
          break;
        }
        // Known-but-ignored cosmetic / mechanical / metadata shapes.
        case 'HOLE':
        case 'SVGNODE':
        case 'TEXT':
        case 'VIA':
          break;
        default:
          warnOnce(type ?? '?');
          break;
      }
    } catch (err) {
      if (type === 'PAD') throw err; // pad geometry is load-bearing
      warnOnce(type ?? '?'); // cosmetic parse failure: skip
    }
  }

  const info = deriveInfo(root);
  const name =
    root.packageDetail?.dataStr?.head?.c_para?.['package'] ??
    root.packageDetail?.title ??
    root.title ??
    '';

  const footprint: Footprint = {
    name,
    lcsc: info.lcsc ?? '',
    pads,
    silk,
    courtyard,
  };
  return { footprint, info };
}
