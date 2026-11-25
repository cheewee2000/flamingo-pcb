/**
 * Flamingo Engine - silkscreen clearance around exposed copper.
 *
 * Silk printed onto a pad stops solder wetting it, and silk over a drilled
 * hole is simply lost. Rather than asking the designer to keep every outline,
 * label and graphic clear by hand, Flamingo clips ALL silk back from:
 *
 *  - every pad exposed on that side (SMD pads on their side, through pads on
 *    both), grown by `RuleSet.silkToPad`, and
 *  - every hole (plated annulus or bare NPTH drill), grown the same way.
 *
 * The Gerber legend subtracts these regions (LPC clear), and the 2D canvas,
 * 3D viewer and SVG renderer mask silk with the same regions, so what you see
 * is what gets printed. DRC no longer flags clipped strokes or artwork;
 * only clipped TEXT is still reported, since a half-erased label is unreadable.
 */

import type { Board, Point } from './types.js';
import { capsulePolygon, holeSlotCenterline, padOutline, allHoles } from './geometry.js';
import { copperLayersOf, padCopperLayers } from './layers.js';
import { bufferPolygon, unionPolygons } from './zonefill.js';

export type SilkLayerId = 'F.Silk' | 'B.Silk';

/** Default silk-to-pad clearance, mm (JLCPCB: pad to silkscreen >= 0.15). */
export const DEFAULT_SILK_TO_PAD = 0.15;

/**
 * Every keep-clear region for `layer`, one simple CCW polygon per pad/hole.
 * Regions may overlap; use `silkClearanceUnion` for an even-odd fillable set.
 */
export function silkClearanceRegions(b: Board, layer: SilkLayerId, clearance = DEFAULT_SILK_TO_PAD): Point[][] {
  const cu = layer === 'F.Silk' ? 'F.Cu' : 'B.Cu';
  const copper = copperLayersOf(b);
  const out: Point[][] = [];
  for (const comp of b.components) {
    for (const pad of comp.footprint.pads) {
      if (!padCopperLayers(pad, comp.side, copper).includes(cu)) continue;
      const outline = padOutline(comp, pad);
      if (clearance <= 0) {
        out.push(outline);
        continue;
      }
      for (const poly of bufferPolygon(outline, clearance)) {
        const ring = poly[0]!.map(([x, y]): Point => ({ x, y }));
        const n = ring.length;
        if (n > 1 && ring[0]!.x === ring[n - 1]!.x && ring[0]!.y === ring[n - 1]!.y) ring.pop();
        out.push(ring);
      }
    }
  }
  for (const h of allHoles(b)) {
    const { start, end } = holeSlotCenterline(h);
    const r = (h.plated ? Math.max(h.padDiameter, h.drill) : h.drill) / 2 + clearance;
    out.push(capsulePolygon(start, end, r));
  }
  return out;
}

const unionCache = new WeakMap<Board, Map<string, Point[][][]>>();

/**
 * The clearance regions for `layer` merged into polygons-with-holes
 * ([outer, ...holes]), cached per board object. Renderers build an even-odd
 * clip/mask from this; overlapping raw regions would cancel under even-odd.
 */
export function silkClearanceUnion(b: Board, layer: SilkLayerId, clearance = DEFAULT_SILK_TO_PAD): Point[][][] {
  let perBoard = unionCache.get(b);
  if (!perBoard) {
    perBoard = new Map();
    unionCache.set(b, perBoard);
  }
  const key = `${layer}:${clearance}`;
  let u = perBoard.get(key);
  if (!u) {
    u = unionPolygons(silkClearanceRegions(b, layer, clearance));
    perBoard.set(key, u);
  }
  return u;
}
