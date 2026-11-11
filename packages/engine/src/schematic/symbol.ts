/**
 * Flamingo Engine - schematic symbol helpers: bounds, the generic fallback
 * symbol, and quarter-turn placement.
 */

import type { SchematicSymbol, SymbolPin, SymbolShape } from './types.js';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function emptyBox(): Box {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

export function growBox(b: Box, x: number, y: number): void {
  if (x < b.x0) b.x0 = x;
  if (y < b.y0) b.y0 = y;
  if (x > b.x1) b.x1 = x;
  if (y > b.y1) b.y1 = y;
}

/**
 * Points an SVG path passes through or is controlled by. Good enough for a
 * bounding box: curve control points and arc end points stand in for the
 * exact extent.
 */
export function pathPoints(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const num = (): number => Number(tokens[i++]);
  const more = (): boolean => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]!);
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i]!)) cmd = tokens[i++]!;
    else if (cmd === '') break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      x = startX;
      y = startY;
      continue;
    }
    if (!more()) continue;
    if (C === 'H') {
      x = (rel ? x : 0) + num();
    } else if (C === 'V') {
      y = (rel ? y : 0) + num();
    } else if (C === 'A') {
      i += 5;
      const ex = num();
      const ey = num();
      x = (rel ? x : 0) + ex;
      y = (rel ? y : 0) + ey;
    } else {
      const pairs = C === 'C' ? 3 : C === 'S' || C === 'Q' ? 2 : 1;
      let nx = x;
      let ny = y;
      for (let p = 0; p < pairs; p++) {
        nx = (rel ? x : 0) + num();
        ny = (rel ? y : 0) + num();
        if (p < pairs - 1) out.push([nx, ny]);
      }
      x = nx;
      y = ny;
      if (C === 'M') {
        startX = x;
        startY = y;
        cmd = rel ? 'l' : 'L';
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) break;
    out.push([x, y]);
  }
  return out;
}

/** The body end of a pin: its connection point moved `length` back inward. */
export function pinInner(pin: SymbolPin): { x: number; y: number } {
  const [dx, dy] = DIR_VEC[pin.dir];
  return { x: pin.at.x - dx * pin.length, y: pin.at.y - dy * pin.length };
}

export const DIR_VEC: Record<SymbolPin['dir'], [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

/** Bounds of the body shapes and pin lines. Texts are left out. */
export function symbolBBox(shapes: SymbolShape[], pins: SymbolPin[]): Box {
  const b = emptyBox();
  for (const s of shapes) {
    if (s.kind === 'rect') {
      growBox(b, s.x, s.y);
      growBox(b, s.x + s.w, s.y + s.h);
    } else if (s.kind === 'ellipse') {
      growBox(b, s.cx - s.rx, s.cy - s.ry);
      growBox(b, s.cx + s.rx, s.cy + s.ry);
    } else if (s.kind === 'polyline') {
      for (let i = 0; i + 1 < s.points.length; i += 2) growBox(b, s.points[i]!, s.points[i + 1]!);
    } else if (s.kind === 'path') {
      for (const [x, y] of pathPoints(s.d)) growBox(b, x, y);
    }
  }
  for (const p of pins) {
    growBox(b, p.at.x, p.at.y);
    const inner = pinInner(p);
    growBox(b, inner.x, inner.y);
  }
  if (!Number.isFinite(b.x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return b;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b);

/** Rough width of a run of text at a font size (sans-serif average advance). */
export function textWidth(text: string, size: number): number {
  return text.length * size * 0.58;
}

const GENERIC_FONT = 7;

/**
 * A stand-in symbol for a part with no usable library symbol: a two-pin part
 * becomes a small in-line box, anything else a box with its pins down the
 * left side and up the right, DIP style. Pins are named by pad number unless
 * `names` gives a name.
 */
export function genericSymbol(padNumbers: string[], names: Record<string, string> = {}): SchematicSymbol {
  const numbers = [...new Set(padNumbers)].sort(naturalCompare);
  const pins: SymbolPin[] = [];
  const shapes: SymbolShape[] = [];
  if (numbers.length === 2) {
    shapes.push({ kind: 'rect', x: 10, y: -4, w: 20, h: 8 });
    pins.push({ number: numbers[0]!, name: names[numbers[0]!] ?? numbers[0]!, at: { x: 0, y: 0 }, dir: 'left', length: 10 });
    pins.push({ number: numbers[1]!, name: names[numbers[1]!] ?? numbers[1]!, at: { x: 40, y: 0 }, dir: 'right', length: 10 });
    return { shapes, pins, bbox: symbolBBox(shapes, pins) };
  }
  const leftCount = Math.ceil(numbers.length / 2);
  const left = numbers.slice(0, leftCount);
  const right = numbers.slice(leftCount).reverse();
  const label = (n: string): string => names[n] ?? n;
  const widest = (list: string[]): number => Math.max(0, ...list.map((n) => textWidth(label(n), GENERIC_FONT)));
  const bodyW = Math.max(40, Math.ceil((widest(left) + widest(right) + 16) / 10) * 10);
  const rows = Math.max(left.length, right.length, 1);
  const bodyH = rows * 10 + 10;
  shapes.push({ kind: 'rect', x: 10, y: 0, w: bodyW, h: bodyH, rx: 2 });
  left.forEach((n, i) => {
    const y = 10 + i * 10;
    pins.push({
      number: n,
      name: label(n),
      at: { x: 0, y },
      dir: 'left',
      length: 10,
      nameText: { x: 13, y: y + 2.5, rotation: 0, anchor: 'start', visible: true },
      numberText: { x: 8, y: y - 1.5, rotation: 0, anchor: 'end', visible: label(n) !== n },
    });
  });
  right.forEach((n, i) => {
    const y = 10 + i * 10;
    pins.push({
      number: n,
      name: label(n),
      at: { x: bodyW + 20, y },
      dir: 'right',
      length: 10,
      nameText: { x: bodyW + 7, y: y + 2.5, rotation: 0, anchor: 'end', visible: true },
      numberText: { x: bodyW + 12, y: y - 1.5, rotation: 0, anchor: 'start', visible: label(n) !== n },
    });
  });
  return { shapes, pins, bbox: symbolBBox(shapes, pins) };
}

/** Rotate a symbol-local offset by `turns` quarter turns clockwise (y down). */
export function turn(dx: number, dy: number, turns: number): [number, number] {
  switch (((turns % 4) + 4) % 4) {
    case 1:
      return [-dy, dx];
    case 2:
      return [-dx, -dy];
    case 3:
      return [dy, -dx];
    default:
      return [dx, dy];
  }
}
