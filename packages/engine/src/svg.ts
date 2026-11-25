/**
 * Flamingo Engine - SVG -> silk artwork.
 *
 * A small, dependency-free SVG reader (runs in Node and the browser) that
 * turns vector artwork into SilkGroup contents:
 *
 *  - Filled shapes become even-odd ring sets (`fills`). Curves and arcs are
 *    flattened, then simplified to `tolerance` mm.
 *  - Stroked shapes become line segments (`lines`) at their stroke width.
 *  - Supported: <path> (all commands, absolute + relative, arcs), <rect>
 *    (incl. rounded), <circle>, <ellipse>, <line>, <polyline>, <polygon>,
 *    nested <g>/<svg> with `transform` (matrix/translate/scale/rotate/skew),
 *    presentation attributes, inline `style`, and simple `<style>` class /
 *    type rules (`.a, .b { fill: … }`).
 *  - Skipped with a warning: <text> (convert to outlines first), <image>,
 *    <use>, gradients/patterns used as the only paint are treated as ink.
 *  - White fills (#fff / white / rgb(255,255,255)) are dropped with a warning:
 *    silkscreen has one colour, so "white" in source art is background.
 *
 * Output is in mm, y-up (SVG is y-down), centred on (0, 0), scaled so the
 * artwork's bounding box matches the requested width or height.
 */

import type { Point, SilkGroupLine } from './types.js';

export interface SvgToSilkOptions {
  /** Target bounding-box width in mm (takes precedence over height). */
  width?: number;
  /** Target bounding-box height in mm. Default 10 when neither is given. */
  height?: number;
  /** Simplification tolerance in mm (default 0.01). */
  tolerance?: number;
  /** Minimum stroke width in mm for converted strokes (default 0). */
  minStrokeWidth?: number;
}

export interface SvgToSilkResult {
  fills: Point[][][];
  lines: SilkGroupLine[];
  /** Final artwork size in mm. */
  width: number;
  height: number;
  warnings: string[];
}

type Matrix = [number, number, number, number, number, number]; // a b c d e f

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Mean linear scale of a matrix (for stroke widths). */
function matrixScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

function nums(s: string): number[] {
  return (s.match(NUM_RE) ?? []).map(Number);
}

export function parseTransform(s: string | undefined): Matrix {
  let m = IDENTITY;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(s))) {
    const v = nums(hit[2]!);
    let t: Matrix = IDENTITY;
    switch (hit[1]) {
      case 'matrix':
        if (v.length >= 6) t = [v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!];
        break;
      case 'translate':
        t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case 'scale':
        t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const r: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        if (v.length >= 3) {
          const cx = v[1]!;
          const cy = v[2]!;
          t = mul(mul([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
        } else t = r;
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, t);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Path data
// ---------------------------------------------------------------------------

interface SubPath {
  pts: Point[];
  closed: boolean;
}

const CURVE_STEPS = 24;

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, out: Point[]): void {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
}

function quad(p0: Point, p1: Point, p2: Point, out: Point[]): void {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    out.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
  }
}

/** SVG elliptical arc (endpoint parameterisation, SVG 1.1 F.6.5) flattened into `out`. */
function arc(
  p0: Point,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Point,
  out: Point[],
): void {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (p0.x === p1.x && p0.y === p1.y)) {
    out.push(p1);
    return;
  }
  const phi = (phiDeg * Math.PI) / 180;
  const cphi = Math.cos(phi);
  const sphi = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1 = cphi * dx + sphi * dy;
  const y1 = -sphi * dx + cphi * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let k = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) k = -k;
  const cxp = (k * rx * y1) / ry;
  const cyp = (-k * ry * x1) / rx;
  const cx = cphi * cxp - sphi * cyp + (p0.x + p1.x) / 2;
  const cy = sphi * cxp + cphi * cyp + (p0.y + p1.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil((Math.abs(dt) / (2 * Math.PI)) * 96));
  for (let i = 1; i <= steps; i++) {
    const t = t1 + (dt * i) / steps;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push(i === steps ? p1 : { x: cphi * ex - sphi * ey + cx, y: sphi * ex + cphi * ey + cy });
  }
}

/** Parse SVG path data into flattened sub-paths (user units, untransformed). */
export function parsePathData(d: string): SubPath[] {
  const subs: SubPath[] = [];
  let cur: SubPath | null = null;
  let pos: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let lastCtrl: Point | null = null;
  let lastCmd = '';
  let i = 0;
  const n = d.length;

  const skipSep = (): void => {
    while (i < n && /[\s,]/.test(d[i]!)) i++;
  };
  const readNum = (): number | null => {
    skipSep();
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(d);
    if (!m || m.index !== i) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const readFlag = (): boolean | null => {
    skipSep();
    const ch = d[i];
    if (ch === '0' || ch === '1') {
      i++;
      return ch === '1';
    }
    return null;
  };
  const begin = (p: Point): void => {
    if (cur && cur.pts.length > 1) subs.push(cur);
    cur = { pts: [p], closed: false };
    start = p;
  };
  const ensure = (): SubPath => {
    if (!cur) begin(pos);
    return cur!;
  };

  while (i < n) {
    skipSep();
    if (i >= n) break;
    let cmd = d[i]!;
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(cmd)) i++;
    else if (lastCmd && lastCmd !== 'Z' && lastCmd !== 'z') {
      // Implicit repeat. A repeated moveto is a lineto.
      cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd;
    } else {
      i++; // garbage: skip a character rather than loop forever
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const R = (p: Point): Point => (rel ? { x: pos.x + p.x, y: pos.y + p.y } : p);
    const pt = (): Point | null => {
      const x = readNum();
      if (x === null) return null;
      const y = readNum();
      if (y === null) return null;
      return { x, y };
    };

    switch (cmd.toUpperCase()) {
      case 'M': {
        const p = pt();
        if (!p) break;
        pos = R(p);
        begin(pos);
        lastCtrl = null;
        break;
      }
      case 'L': {
        const p = pt();
        if (!p) break;
        pos = R(p);
        ensure().pts.push(pos);
        lastCtrl = null;
        break;
      }
      case 'H': {
        const x = readNum();
        if (x === null) break;
        pos = { x: rel ? pos.x + x : x, y: pos.y };
        ensure().pts.push(pos);
        lastCtrl = null;
        break;
      }
      case 'V': {
        const y = readNum();
        if (y === null) break;
        pos = { x: pos.x, y: rel ? pos.y + y : y };
        ensure().pts.push(pos);
        lastCtrl = null;
        break;
      }
      case 'C': {
        const a = pt();
        const b = a && pt();
        const e = b && pt();
        if (!a || !b || !e) break;
        const c1 = R(a);
        const c2 = R(b);
        const end = R(e);
        cubic(pos, c1, c2, end, ensure().pts);
        lastCtrl = c2;
        pos = end;
        break;
      }
      case 'S': {
        const b = pt();
        const e = b && pt();
        if (!b || !e) break;
        const c1 =
          lastCtrl && /[CcSs]/.test(lastCmd) ? { x: 2 * pos.x - lastCtrl.x, y: 2 * pos.y - lastCtrl.y } : pos;
        const c2 = R(b);
        const end = R(e);
        cubic(pos, c1, c2, end, ensure().pts);
        lastCtrl = c2;
        pos = end;
        break;
      }
      case 'Q': {
        const a = pt();
        const e = a && pt();
        if (!a || !e) break;
        const c = R(a);
        const end = R(e);
        quad(pos, c, end, ensure().pts);
        lastCtrl = c;
        pos = end;
        break;
      }
      case 'T': {
        const e = pt();
        if (!e) break;
        const c: Point =
          lastCtrl && /[QqTt]/.test(lastCmd) ? { x: 2 * pos.x - lastCtrl.x, y: 2 * pos.y - lastCtrl.y } : pos;
        const end = R(e);
        quad(pos, c, end, ensure().pts);
        lastCtrl = c;
        pos = end;
        break;
      }
      case 'A': {
        const rx = readNum();
        const ry = rx !== null ? readNum() : null;
        const rot = ry !== null ? readNum() : null;
        const large = rot !== null ? readFlag() : null;
        const sweep = large !== null ? readFlag() : null;
        const e = sweep !== null ? pt() : null;
        if (rx === null || ry === null || rot === null || large === null || sweep === null || !e) break;
        const end = R(e);
        arc(pos, rx, ry, rot, large, sweep, end, ensure().pts);
        pos = end;
        lastCtrl = null;
        break;
      }
      case 'Z': {
        if (cur) {
          (cur as SubPath).closed = true;
          if ((cur as SubPath).pts.length > 1) subs.push(cur);
          cur = null;
        }
        pos = start;
        lastCtrl = null;
        break;
      }
    }
    lastCmd = cmd;
  }
  if (cur && (cur as SubPath).pts.length > 1) subs.push(cur);
  return subs;
}

// ---------------------------------------------------------------------------
// XML + styles
// ---------------------------------------------------------------------------

interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Element[];
  text: string;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Minimal XML tree builder: elements, attributes, and text (CDATA kept). */
export function parseXml(src: string): Element {
  const root: Element = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: Element[] = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[3] !== undefined) {
      const name = m[3].replace(/^.*:/, ''); // drop namespace prefixes (svg:path)
      if (m[2] === '/') {
        // Close the nearest matching element (tolerant of sloppy nesting).
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k]!.name === name) {
            stack.length = k;
            break;
          }
        }
      } else {
        const el: Element = { name, attrs: parseAttrs(m[4] ?? ''), children: [], text: '' };
        top.children.push(el);
        if (m[5] !== '/') stack.push(el);
      }
    } else if (m[6] !== undefined) {
      top.text += m[6];
    }
  }
  return root;
}

interface CssRule {
  selector: { tag?: string; cls?: string; id?: string };
  decls: Record<string, string>;
}

function parseDecls(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(';')) {
    const k = part.indexOf(':');
    if (k < 0) continue;
    const key = part.slice(0, k).trim().toLowerCase();
    const val = part
      .slice(k + 1)
      .replace(/!important/i, '')
      .trim();
    if (key) out[key] = val;
  }
  return out;
}

function parseCss(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const decls = parseDecls(m[2]!);
    for (const raw of m[1]!.split(',')) {
      const sel = raw.trim();
      const simple = /^([A-Za-z][\w-]*)?(?:\.([\w-]+))?(?:#([\w-]+))?$/.exec(sel);
      if (!simple || sel === '') continue;
      rules.push({ selector: { tag: simple[1], cls: simple[2], id: simple[3] }, decls });
    }
  }
  return rules;
}

const STYLE_PROPS = [
  'fill',
  'stroke',
  'stroke-width',
  'fill-rule',
  'display',
  'visibility',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
] as const;
type StyleProp = (typeof STYLE_PROPS)[number];
type Style = Partial<Record<StyleProp, string>>;

/** Inheritable properties (display and opacity are applied per element, not inherited). */
const INHERITED: StyleProp[] = ['fill', 'stroke', 'stroke-width', 'fill-rule', 'visibility', 'fill-opacity', 'stroke-opacity'];

function elementStyle(el: Element, css: CssRule[]): Style {
  const s: Style = {};
  const set = (decls: Record<string, string>): void => {
    for (const p of STYLE_PROPS) if (decls[p] !== undefined) s[p] = decls[p];
  };
  // Precedence: presentation attributes < stylesheet < inline style.
  set(el.attrs);
  const classes = (el.attrs.class ?? '').split(/\s+/).filter(Boolean);
  for (const r of css) {
    const { tag, cls, id } = r.selector;
    if (tag && tag !== el.name) continue;
    if (cls && !classes.includes(cls)) continue;
    if (id && el.attrs.id !== id) continue;
    set(r.decls);
  }
  if (el.attrs.style) set(parseDecls(el.attrs.style));
  return s;
}

function isNone(v: string | undefined): boolean {
  return v === undefined || v.trim() === 'none' || v.trim() === 'transparent';
}

function isWhite(v: string): boolean {
  const c = v.trim().toLowerCase().replace(/\s+/g, '');
  return c === '#fff' || c === '#ffffff' || c === 'white' || c === 'rgb(255,255,255)' || c === '#ffff' || c === '#ffffffff';
}

function length(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Shapes -> sub-paths
// ---------------------------------------------------------------------------

function ellipsePts(cx: number, cy: number, rx: number, ry: number): Point[] {
  const pts: Point[] = [];
  const steps = 96;
  for (let k = 0; k < steps; k++) {
    const t = (2 * Math.PI * k) / steps;
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return pts;
}

function shapeSubPaths(el: Element): SubPath[] | null {
  const a = el.attrs;
  switch (el.name) {
    case 'path':
      return parsePathData(a.d ?? '');
    case 'rect': {
      const x = length(a.x);
      const y = length(a.y);
      const w = length(a.width);
      const h = length(a.height);
      if (w <= 0 || h <= 0) return [];
      let rx = a.rx !== undefined ? length(a.rx) : a.ry !== undefined ? length(a.ry) : 0;
      let ry = a.ry !== undefined ? length(a.ry) : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx <= 0 || ry <= 0) {
        return [{ pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true }];
      }
      const d =
        `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} ` +
        `A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} ` +
        `V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
      return parsePathData(d);
    }
    case 'circle': {
      const r = length(a.r);
      return r > 0 ? [{ pts: ellipsePts(length(a.cx), length(a.cy), r, r), closed: true }] : [];
    }
    case 'ellipse': {
      const rx = length(a.rx);
      const ry = length(a.ry);
      return rx > 0 && ry > 0 ? [{ pts: ellipsePts(length(a.cx), length(a.cy), rx, ry), closed: true }] : [];
    }
    case 'line':
      return [
        {
          pts: [
            { x: length(a.x1), y: length(a.y1) },
            { x: length(a.x2), y: length(a.y2) },
          ],
          closed: false,
        },
      ];
    case 'polyline':
    case 'polygon': {
      const v = nums(a.points ?? '');
      const pts: Point[] = [];
      for (let k = 0; k + 1 < v.length; k += 2) pts.push({ x: v[k]!, y: v[k + 1]! });
      return pts.length >= 2 ? [{ pts, closed: el.name === 'polygon' }] : [];
    }
    default:
      return null;
  }
}

/** Douglas-Peucker on an open polyline. */
function simplify(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = pts[s]!;
    const b = pts[e]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let bestD = tol;
    for (let k = s + 1; k < e; k++) {
      const p = pts[k]!;
      const d = len < 1e-12 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

function simplifyRing(pts: Point[], tol: number): Point[] {
  if (pts.length < 4) return pts;
  // Split at the vertex farthest from the first so both halves are open polylines.
  let far = 0;
  let farD = -1;
  for (let k = 1; k < pts.length; k++) {
    const d = Math.hypot(pts[k]!.x - pts[0]!.x, pts[k]!.y - pts[0]!.y);
    if (d > farD) {
      farD = d;
      far = k;
    }
  }
  const a = simplify(pts.slice(0, far + 1), tol);
  const b = simplify([...pts.slice(far), pts[0]!], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

const SKIP_SUBTREE = new Set([
  'defs',
  'clipPath',
  'mask',
  'symbol',
  'marker',
  'pattern',
  'linearGradient',
  'radialGradient',
  'filter',
  'title',
  'desc',
  'metadata',
  'style',
  'script',
  'foreignObject',
]);

/**
 * Convert SVG source to silk artwork (mm, y-up, centred on the origin).
 * Throws on input with no drawable geometry.
 */
export function svgToSilk(src: string, opts: SvgToSilkOptions = {}): SvgToSilkResult {
  const root = parseXml(src);
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (msg: string): void => {
    if (!warned.has(msg)) {
      warned.add(msg);
      warnings.push(msg);
    }
  };

  const css: CssRule[] = [];
  const collectCss = (el: Element): void => {
    if (el.name === 'style') css.push(...parseCss(el.text));
    for (const c of el.children) collectCss(c);
  };
  collectCss(root);

  // Raw output in SVG user units (y-down), before normalisation.
  const fills: Point[][][] = [];
  const strokes: { pts: Point[]; width: number }[] = [];
  let droppedWhite = 0;

  const walk = (el: Element, ctm: Matrix, inherited: Style): void => {
    if (SKIP_SUBTREE.has(el.name)) return;
    const own = elementStyle(el, css);
    if (own.display?.trim() === 'none') return;
    if (own.opacity !== undefined && parseFloat(own.opacity) === 0) return;
    const style: Style = { ...inherited };
    for (const p of INHERITED) if (own[p] !== undefined) style[p] = own[p];

    let m = ctm;
    if (el.name === 'svg' && el !== root.children.find((c) => c.name === 'svg')) {
      m = mul(m, [1, 0, 0, 1, length(el.attrs.x), length(el.attrs.y)]);
    }
    if (el.attrs.transform) m = mul(m, parseTransform(el.attrs.transform));

    if (el.name === 'text' || el.name === 'tspan') {
      warn('Skipped <text>: convert text to outlines/paths before importing.');
      return;
    }
    if (el.name === 'image') {
      warn('Skipped <image>: embedded bitmaps are not supported; use vector art.');
      return;
    }
    if (el.name === 'use') {
      warn('Skipped <use>: expand symbol references (e.g. "Object > Expand") before importing.');
      return;
    }

    const subs = shapeSubPaths(el);
    if (subs) {
      if (style.visibility?.trim() === 'hidden' || style.visibility?.trim() === 'collapse') return;
      const fill = style.fill ?? '#000';
      const fillOpacity = style['fill-opacity'] !== undefined ? parseFloat(style['fill-opacity']) : 1;
      const canFill = el.name !== 'line'; // per SVG, polylines fill too
      if (canFill && !isNone(fill) && fillOpacity > 0) {
        if (isWhite(fill)) droppedWhite++;
        else {
          const rings = subs.map((s) => s.pts.map((p) => apply(m, p))).filter((r) => r.length >= 3);
          if (rings.length) fills.push(rings);
          if (style['fill-rule']?.trim() === 'nonzero') {
            warn('Shapes using fill-rule "nonzero" are imported with even-odd filling; overlapping sub-paths may show holes.');
          }
        }
      }
      const stroke = style.stroke;
      const strokeOpacity = style['stroke-opacity'] !== undefined ? parseFloat(style['stroke-opacity']) : 1;
      if (!isNone(stroke) && strokeOpacity > 0) {
        if (isWhite(stroke!)) droppedWhite++;
        else {
          const w = length(style['stroke-width'], 1) * matrixScale(m);
          for (const s of subs) {
            const pts = s.pts.map((p) => apply(m, p));
            if (s.closed && pts.length > 1) pts.push(pts[0]!);
            strokes.push({ pts, width: w });
          }
        }
      }
      return;
    }
    for (const c of el.children) walk(c, m, style);
  };
  for (const c of root.children) walk(c, IDENTITY, {});

  if (droppedWhite > 0) {
    warn(`Dropped ${droppedWhite} white shape${droppedWhite === 1 ? '' : 's'} (treated as background).`);
  }

  // Bounds in user units (strokes include their width).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (p: Point, r = 0): void => {
    minX = Math.min(minX, p.x - r);
    minY = Math.min(minY, p.y - r);
    maxX = Math.max(maxX, p.x + r);
    maxY = Math.max(maxY, p.y + r);
  };
  for (const f of fills) for (const r of f) for (const p of r) grow(p);
  for (const s of strokes) for (const p of s.pts) grow(p, s.width / 2);
  if (!Number.isFinite(minX) || maxX - minX <= 0 || maxY - minY <= 0) {
    throw new Error(`SVG has no drawable filled or stroked geometry${warnings.length ? ` (${warnings.join(' ')})` : ''}`);
  }

  const srcW = maxX - minX;
  const srcH = maxY - minY;
  const k = opts.width ? opts.width / srcW : (opts.height ?? 10) / srcH;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const tol = opts.tolerance ?? 0.01;
  const toMm = (p: Point): Point => ({
    x: Math.round((p.x - cx) * k * 1e4) / 1e4,
    y: Math.round(-(p.y - cy) * k * 1e4) / 1e4,
  });

  const outFills = fills
    .map((rings) => rings.map((r) => simplifyRing(r.map(toMm), tol)).filter((r) => r.length >= 3))
    .filter((rings) => rings.length > 0);
  const outLines: SilkGroupLine[] = [];
  for (const s of strokes) {
    const pts = simplify(s.pts.map(toMm), tol);
    const width = Math.max(opts.minStrokeWidth ?? 0, Math.round(s.width * k * 1e4) / 1e4);
    for (let j = 0; j + 1 < pts.length; j++) outLines.push({ start: pts[j]!, end: pts[j + 1]!, width });
  }
  return { fills: outFills, lines: outLines, width: srcW * k, height: srcH * k, warnings };
}
