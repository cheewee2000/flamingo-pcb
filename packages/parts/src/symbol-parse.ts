/**
 * EasyEDA schematic symbol parser.
 *
 * The component API response carries the part's schematic symbol at
 * `result.dataStr.shape` (multi-unit parts keep one symbol per unit under
 * `result.subparts[].dataStr.shape`). Each entry is a `~`-separated string:
 *
 *   R~x~y~rx~ry~w~h~stroke~width~style~fill~id        rectangle
 *   E~cx~cy~rx~ry~stroke~width~style~fill~id          ellipse
 *   C~cx~cy~r~stroke~width~style~fill~id              circle
 *   L~x1~y1~x2~y2~stroke~width~style~fill~id          line
 *   PL~x y x y ...~stroke~width~style~fill~id         polyline
 *   PG~x y x y ...~stroke~width~style~fill~id         polygon
 *   PT~<svg path>~stroke~width~style~fill~id          path
 *   A~<svg path>~helper~stroke~width~style~fill~id    arc
 *   T~mark~x~y~rot~color~font~size~...~text~visible~anchor~id
 *   P~show~elec~number~x~y~rot~id~locked ^^ dot ^^ <path>~color
 *     ^^ visible~x~y~rot~NAME~anchor~... ^^ visible~x~y~rot~NUMBER~anchor~...
 *     ^^ visible~x~y (inversion dot) ^^ visible~<path> (clock wedge)
 *
 * Coordinates are 10 units per 0.1 inch with y down, and are kept as they
 * are (the schematic uses the same space); a symbol's origin is wherever its
 * author drew it. A pin's `x~y` is its connection point and its path is the
 * line between there and the body (drawn from either end), which is what
 * gives the pin its direction: the `rot` field is empty on some library parts.
 */

import { symbolBBox } from '@flamingo/engine';
import type { SchematicSymbol, SchematicSymbolPin, SymbolPinText, SymbolShape } from '@flamingo/engine';

interface RawSymbolRoot {
  dataStr?: { shape?: unknown[] };
  subparts?: Array<{ dataStr?: { shape?: unknown[] } }>;
}

const num = (s: string | undefined): number => {
  const v = Number((s ?? '').trim());
  return Number.isFinite(v) ? v : NaN;
};

function pointList(s: string | undefined): number[] {
  const out = (s ?? '').trim().split(/[\s,]+/).map(Number);
  return out.length >= 4 && out.length % 2 === 0 && out.every(Number.isFinite) ? out : [];
}

/** A solid fill: the fill colour is set and is the stroke colour. Tints are drawn hollow. */
function solid(fill: string | undefined, stroke: string | undefined): boolean {
  const f = (fill ?? '').trim().toLowerCase();
  return f !== '' && f !== 'none' && f === (stroke ?? '').trim().toLowerCase();
}

function anchorOf(s: string | undefined): 'start' | 'middle' | 'end' {
  return s === 'end' || s === 'middle' ? s : 'start';
}

function pinTextOf(seg: string | undefined): { text: string; at?: SymbolPinText } {
  const f = (seg ?? '').split('~');
  const text = (f[4] ?? '').trim();
  const x = num(f[1]);
  const y = num(f[2]);
  if (Number.isNaN(x) || Number.isNaN(y)) return { text };
  return { text, at: { x, y, rotation: num(f[3]) || 0, anchor: anchorOf(f[5]), visible: f[0] === '1' } };
}

/** The two ends of a pin path (a single straight segment). */
function pinEnds(d: string): { x0: number; y0: number; x1: number; y1: number } | null {
  const t = d.match(/[a-zA-Z]|-?\d*\.?\d+/g) ?? [];
  if (t[0] !== 'M' && t[0] !== 'm') return null;
  const x0 = Number(t[1]);
  const y0 = Number(t[2]);
  const cmd = t[3];
  const a = Number(t[4]);
  const b = Number(t[5]);
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(a)) return null;
  switch (cmd) {
    case 'h':
      return { x0, y0, x1: x0 + a, y1: y0 };
    case 'H':
      return { x0, y0, x1: a, y1: y0 };
    case 'v':
      return { x0, y0, x1: x0, y1: y0 + a };
    case 'V':
      return { x0, y0, x1: x0, y1: a };
    case 'l':
      return Number.isFinite(b) ? { x0, y0, x1: x0 + a, y1: y0 + b } : null;
    case 'L':
      return Number.isFinite(b) ? { x0, y0, x1: a, y1: b } : null;
    default:
      return null;
  }
}

function parsePin(s: string): SchematicSymbolPin | null {
  const segs = s.split('^^');
  const head = segs[0]!.split('~');
  const x = num(head[4]);
  const y = num(head[5]);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  const name = pinTextOf(segs[3]);
  const number = pinTextOf(segs[4]);
  const id = (head[3] ?? '').trim() || number.text;
  if (!id) return null;

  let dir: SchematicSymbolPin['dir'];
  let length = 10;
  const ends = pinEnds((segs[2] ?? '').split('~')[0] ?? '');
  // The path is drawn from either end; the end away from the connection point is the body end.
  const startIsPin = ends ? Math.hypot(ends.x0 - x, ends.y0 - y) <= Math.hypot(ends.x1 - x, ends.y1 - y) : true;
  const step = ends ? { dx: (startIsPin ? ends.x1 : ends.x0) - x, dy: (startIsPin ? ends.y1 : ends.y0) - y } : null;
  if (step && (step.dx !== 0 || step.dy !== 0)) {
    // The step runs inward, so the pin points the other way.
    if (Math.abs(step.dx) >= Math.abs(step.dy)) dir = step.dx > 0 ? 'left' : 'right';
    else dir = step.dy > 0 ? 'up' : 'down';
    length = Math.max(Math.abs(step.dx), Math.abs(step.dy));
  } else {
    const rot = ((num(head[6]) || 0) % 360 + 360) % 360;
    dir = rot === 180 ? 'left' : rot === 90 ? 'up' : rot === 270 ? 'down' : 'right';
  }

  const pin: SchematicSymbolPin = { number: id, name: name.text || id, at: { x, y }, dir, length };
  if (name.at) pin.nameText = name.at;
  if (number.at) pin.numberText = number.at;
  const dot = (segs[5] ?? '').split('~');
  if (dot[0] === '1' && !Number.isNaN(num(dot[1])) && !Number.isNaN(num(dot[2]))) pin.dot = { x: num(dot[1]), y: num(dot[2]) };
  const clock = (segs[6] ?? '').split('~');
  if (clock[0] === '1' && clock[1]) pin.clock = clock[1];
  return pin;
}

function parseShape(s: string): SymbolShape | null {
  const f = s.split('~');
  switch (f[0]) {
    case 'R': {
      const [x, y, w, h] = [num(f[1]), num(f[2]), num(f[5]), num(f[6])];
      if ([x, y, w, h].some(Number.isNaN)) return null;
      const rx = num(f[3]);
      return { kind: 'rect', x, y, w, h, ...(rx > 0 ? { rx } : {}) };
    }
    case 'E': {
      const [cx, cy, rx, ry] = [num(f[1]), num(f[2]), num(f[3]), num(f[4])];
      if ([cx, cy, rx, ry].some(Number.isNaN)) return null;
      return { kind: 'ellipse', cx, cy, rx, ry, filled: solid(f[8], f[5]) };
    }
    case 'C': {
      const [cx, cy, r] = [num(f[1]), num(f[2]), num(f[3])];
      if ([cx, cy, r].some(Number.isNaN)) return null;
      return { kind: 'ellipse', cx, cy, rx: r, ry: r, filled: solid(f[7], f[4]) };
    }
    case 'L': {
      const pts = [num(f[1]), num(f[2]), num(f[3]), num(f[4])];
      return pts.some(Number.isNaN) ? null : { kind: 'polyline', points: pts };
    }
    case 'PL':
    case 'PG': {
      const points = pointList(f[1]);
      if (points.length === 0) return null;
      return { kind: 'polyline', points, closed: f[0] === 'PG', filled: f[0] === 'PG' && solid(f[5], f[2]) };
    }
    case 'PT':
      return f[1] ? { kind: 'path', d: f[1], filled: solid(f[5], f[2]) } : null;
    case 'A':
      return f[1] ? { kind: 'path', d: f[1], filled: solid(f[6], f[3]) } : null;
    case 'T': {
      // Mark L is a free comment; P and N are the refdes and name placeholders, which the sheet writes itself.
      if (f[1] !== 'L' || f[13] === '0') return null;
      const [x, y] = [num(f[2]), num(f[3])];
      const text = (f[12] ?? '').trim();
      if (Number.isNaN(x) || Number.isNaN(y) || !text) return null;
      const size = parseFloat(f[7] ?? '') || 7;
      return { kind: 'text', x, y, text, anchor: anchorOf(f[14]), size, rotation: num(f[4]) || 0 };
    }
    default:
      return null;
  }
}

/** Shift an SVG path: absolute coordinates move, relative ones stay. */
function shiftPath(d: string, dy: number): string {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let cmd = '';
  let k = 0;
  for (const t of tokens) {
    if (/^[a-zA-Z]$/.test(t)) {
      cmd = t;
      k = 0;
      out.push(t);
      continue;
    }
    let v = Number(t);
    const isY =
      cmd === 'V' ||
      (cmd === 'A' ? k % 7 === 6 : cmd === 'M' || cmd === 'L' || cmd === 'C' || cmd === 'S' || cmd === 'Q' || cmd === 'T' ? k % 2 === 1 : false);
    if (isY) v += dy;
    out.push(String(v));
    k++;
  }
  return out.join(' ');
}

function shiftDown(shapes: SymbolShape[], pins: SchematicSymbolPin[], dy: number): void {
  for (const s of shapes) {
    if (s.kind === 'rect' || s.kind === 'text') s.y += dy;
    else if (s.kind === 'ellipse') s.cy += dy;
    else if (s.kind === 'polyline') s.points = s.points.map((v, i) => (i % 2 === 1 ? v + dy : v));
    else s.d = shiftPath(s.d, dy);
  }
  for (const p of pins) {
    p.at.y += dy;
    if (p.nameText) p.nameText.y += dy;
    if (p.numberText) p.numberText.y += dy;
    if (p.dot) p.dot.y += dy;
    if (p.clock) p.clock = shiftPath(p.clock, dy);
  }
}

function parseUnit(raw: unknown[]): { shapes: SymbolShape[]; pins: SchematicSymbolPin[] } {
  const shapes: SymbolShape[] = [];
  const pins: SchematicSymbolPin[] = [];
  for (const s of raw) {
    if (typeof s !== 'string') continue;
    if (s.startsWith('P~')) {
      const pin = parsePin(s);
      if (pin) pins.push(pin);
    } else {
      const shape = parseShape(s);
      if (shape) shapes.push(shape);
    }
  }
  return { shapes, pins };
}

/**
 * The schematic symbol of a part, from its raw component API response. The
 * units of a multi-unit part are stacked into one symbol, top to bottom.
 * Never throws: a response with no readable symbol yields null.
 */
export function parseEasyedaSymbol(apiJson: unknown): SchematicSymbol | null {
  if (!apiJson || typeof apiJson !== 'object') return null;
  const o = apiJson as { result?: unknown };
  const root = (o.result && typeof o.result === 'object' ? o.result : apiJson) as RawSymbolRoot;
  const subs = (root.subparts ?? []).map((s) => s?.dataStr?.shape).filter((s): s is unknown[] => Array.isArray(s) && s.length > 0);
  const units = subs.length > 0 ? subs : Array.isArray(root.dataStr?.shape) ? [root.dataStr!.shape!] : [];

  const shapes: SymbolShape[] = [];
  const pins: SchematicSymbolPin[] = [];
  let nextTop: number | null = null;
  for (const raw of units) {
    const unit = parseUnit(raw);
    if (unit.pins.length === 0 && unit.shapes.length === 0) continue;
    const box = symbolBBox(unit.shapes, unit.pins);
    if (nextTop !== null) shiftDown(unit.shapes, unit.pins, nextTop - box.y0);
    nextTop = (nextTop ?? box.y0) + (box.y1 - box.y0) + 20;
    shapes.push(...unit.shapes);
    pins.push(...unit.pins);
  }
  if (pins.length === 0) return null;
  return { shapes, pins, bbox: symbolBBox(shapes, pins) };
}
