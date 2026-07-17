/**
 * Flamingo Fab - minimal single-stroke vector font for silkscreen text.
 *
 * Fab-local (not shared with the SVG renderer, which uses native <text>): the
 * Gerber legend layer needs text as drawn polylines, so we carry a small stroke
 * font here. Glyphs are defined on a unit cell: x in [0, 0.6], y in [0, 1] with
 * y-up and the baseline at y=0, cap height at y=1. Each glyph is a list of
 * polylines (flat [x0,y0,x1,y1,...] arrays in glyph units).
 *
 * Coverage: 0-9 A-Z space - . + _ / . Unknown characters are skipped. This is a
 * legibility-adequate blocky font, not a typographic one -- fine for refdes and
 * short labels on a hobby board.
 */

import type { Point } from '@flamingo/engine';
import { rotate } from '@flamingo/engine';

const ADVANCE = 0.9; // cell advance in glyph units (0.6 glyph + 0.3 gap)

/* eslint-disable prettier/prettier */
const GLYPHS: Record<string, number[][]> = {
  ' ': [],
  '-': [[0, 0.5, 0.6, 0.5]],
  '_': [[0, 0, 0.6, 0]],
  '.': [[0.25, 0, 0.35, 0, 0.35, 0.1, 0.25, 0.1, 0.25, 0]],
  '+': [[0.3, 0.2, 0.3, 0.8], [0, 0.5, 0.6, 0.5]],
  '/': [[0, 0, 0.6, 1]],
  '0': [[0, 0, 0.6, 0, 0.6, 1, 0, 1, 0, 0], [0, 0, 0.6, 1]],
  '1': [[0.15, 0.8, 0.3, 1, 0.3, 0], [0.1, 0, 0.5, 0]],
  '2': [[0, 0.8, 0.3, 1, 0.6, 0.8, 0.6, 0.6, 0, 0, 0.6, 0]],
  '3': [[0, 1, 0.6, 1, 0.3, 0.55, 0.6, 0.35, 0.5, 0.05, 0.1, 0, 0, 0.2]],
  '4': [[0.45, 0, 0.45, 1, 0, 0.35, 0.6, 0.35]],
  '5': [[0.6, 1, 0, 1, 0, 0.55, 0.4, 0.6, 0.6, 0.35, 0.4, 0.02, 0, 0.1]],
  '6': [[0.55, 0.9, 0.2, 1, 0, 0.6, 0, 0.2, 0.3, 0, 0.6, 0.2, 0.6, 0.4, 0.3, 0.55, 0, 0.45]],
  '7': [[0, 1, 0.6, 1, 0.2, 0]],
  '8': [[0.3, 0.55, 0.05, 0.75, 0.3, 1, 0.55, 0.75, 0.3, 0.55, 0.05, 0.25, 0.3, 0, 0.55, 0.25, 0.3, 0.55]],
  '9': [[0.6, 0.55, 0.3, 0.45, 0, 0.6, 0.3, 1, 0.6, 0.8, 0.6, 0.4, 0.4, 0]],
  'A': [[0, 0, 0.3, 1, 0.6, 0], [0.12, 0.4, 0.48, 0.4]],
  'B': [[0, 0, 0, 1, 0.45, 1, 0.6, 0.8, 0.45, 0.55, 0, 0.55], [0.45, 0.55, 0.62, 0.28, 0.45, 0, 0, 0]],
  'C': [[0.6, 0.85, 0.3, 1, 0.05, 0.75, 0.05, 0.25, 0.3, 0, 0.6, 0.15]],
  'D': [[0, 0, 0, 1, 0.35, 1, 0.6, 0.7, 0.6, 0.3, 0.35, 0, 0, 0]],
  'E': [[0.6, 1, 0, 1, 0, 0, 0.6, 0], [0, 0.5, 0.45, 0.5]],
  'F': [[0.6, 1, 0, 1, 0, 0], [0, 0.5, 0.45, 0.5]],
  'G': [[0.6, 0.85, 0.3, 1, 0.05, 0.75, 0.05, 0.25, 0.3, 0, 0.6, 0.15, 0.6, 0.45, 0.35, 0.45]],
  'H': [[0, 0, 0, 1], [0.6, 0, 0.6, 1], [0, 0.5, 0.6, 0.5]],
  'I': [[0.1, 1, 0.5, 1], [0.3, 1, 0.3, 0], [0.1, 0, 0.5, 0]],
  'J': [[0.5, 1, 0.5, 0.2, 0.3, 0, 0.1, 0.15]],
  'K': [[0, 0, 0, 1], [0.6, 1, 0, 0.5, 0.6, 0]],
  'L': [[0, 1, 0, 0, 0.6, 0]],
  'M': [[0, 0, 0, 1, 0.3, 0.5, 0.6, 1, 0.6, 0]],
  'N': [[0, 0, 0, 1, 0.6, 0, 0.6, 1]],
  'O': [[0.3, 1, 0.05, 0.75, 0.05, 0.25, 0.3, 0, 0.55, 0.25, 0.55, 0.75, 0.3, 1]],
  'P': [[0, 0, 0, 1, 0.45, 1, 0.6, 0.8, 0.45, 0.55, 0, 0.55]],
  'Q': [[0.3, 1, 0.05, 0.75, 0.05, 0.25, 0.3, 0, 0.55, 0.25, 0.55, 0.75, 0.3, 1], [0.35, 0.3, 0.6, 0]],
  'R': [[0, 0, 0, 1, 0.45, 1, 0.6, 0.8, 0.45, 0.55, 0, 0.55], [0.3, 0.55, 0.6, 0]],
  'S': [[0.6, 0.85, 0.3, 1, 0.05, 0.8, 0.3, 0.55, 0.55, 0.35, 0.3, 0, 0, 0.15]],
  'T': [[0, 1, 0.6, 1], [0.3, 1, 0.3, 0]],
  'U': [[0, 1, 0, 0.2, 0.3, 0, 0.6, 0.2, 0.6, 1]],
  'V': [[0, 1, 0.3, 0, 0.6, 1]],
  'W': [[0, 1, 0.15, 0, 0.3, 0.5, 0.45, 0, 0.6, 1]],
  'X': [[0, 0, 0.6, 1], [0, 1, 0.6, 0]],
  'Y': [[0, 1, 0.3, 0.5, 0.6, 1], [0.3, 0.5, 0.3, 0]],
  'Z': [[0, 1, 0.6, 1, 0, 0, 0.6, 0]],
};
/* eslint-enable prettier/prettier */

/**
 * Stroke `text` as world-space polylines, centered on `at` (both axes, like the
 * SVG renderer's text-anchor="middle" refdes labels), scaled to `height`,
 * rotated `rotationDeg` (CCW), optionally mirrored across the local Y axis
 * (x -> -x, applied before rotation) for bottom-side components.
 */
export function strokeText(
  text: string,
  at: Point,
  height: number,
  rotationDeg: number,
  mirror: boolean,
): Point[][] {
  const upper = text.toUpperCase();
  const width = upper.length > 0 ? upper.length * ADVANCE * height : 0;
  const x0 = -width / 2;
  const y0 = -height / 2;

  const out: Point[][] = [];
  let cursor = 0;
  for (const ch of upper) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (const stroke of glyph) {
        const poly: Point[] = [];
        for (let i = 0; i < stroke.length; i += 2) {
          // glyph-space -> centered local text space
          let lx = x0 + cursor + stroke[i] * height;
          let ly = y0 + stroke[i + 1] * height;
          if (mirror) lx = -lx;
          const r = rotate({ x: lx, y: ly }, rotationDeg);
          poly.push({ x: r.x + at.x, y: r.y + at.y });
        }
        out.push(poly);
      }
    }
    cursor += ADVANCE * height;
  }
  return out;
}
