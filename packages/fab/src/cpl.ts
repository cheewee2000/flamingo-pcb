/**
 * Flamingo Fab - JLCPCB Component Placement List (CPL) CSV.
 *
 * Header is exactly `Designator,Mid X,Mid Y,Layer,Rotation`. One row per
 * component, Mid X/Y in mm formatted to 4 decimal places with no unit
 * suffix (JLCPCB's CPL importer expects bare numbers). Layer is `Top` or
 * `Bottom`. Line endings are CRLF throughout, matching bom.ts.
 *
 * Mid X/Y = component.at directly: Flamingo footprints are parsed straight
 * from EasyEDA/JLC part data, so the footprint origin (what `at` places on
 * the board) already IS the EasyEDA/JLC centroid convention -- no extra
 * offset is needed.
 *
 * Rotation is degrees CCW, normalized to [0, 360):
 *   - top side:    rot
 *   - bottom side: 360 - rot  (the angle as seen looking at the bottom face)
 * plus the component's optional `cplRotationOffset`, for parts whose JLC
 * library image is turned relative to the EasyEDA footprint.
 *
 * History: until 2026-11-08 the bottom rule was rot + 180, copied from the
 * EasyEDA pick-and-place of the Random Together v3.1 pilot. That file was
 * never built as-is -- the rotations were corrected by hand in JLC's
 * placement preview. Measured on that preview: every part at 90/270 was
 * right, 18 of 20 multi-pin parts at 0/180 were 180 degrees off.
 */

import type { Board, ComponentInst } from '@flamingo/engine';
import { isAssembled } from '@flamingo/engine';

const CRLF = '\r\n';

/** Normalize a degree value into [0, 360). */
function normDeg(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

/** Trim to <=4dp, dropping trailing zeros (e.g. 90.0000 -> "90"). */
function trimNum(n: number): string {
  return String(parseFloat(n.toFixed(4)));
}

function mm4(n: number): string {
  // Avoid emitting "-0.0000" for values that round to zero at 4dp.
  const s = n.toFixed(4);
  return s === '-0.0000' ? '0.0000' : s;
}

function rotationOf(c: ComponentInst): string {
  const rot = normDeg(c.rotation);
  // Bottom: JLC's placement preview wants the mirrored angle (see header).
  const base = c.side === 'bottom' ? 360 - rot : rot;
  const out = normDeg(base + (c.cplRotationOffset ?? 0));
  return trimNum(out);
}

/** Generate the JLCPCB CPL CSV for a board. */
export function generateCPL(b: Board): string {
  const lines = ['Designator,Mid X,Mid Y,Layer,Rotation'];
  for (const c of b.components) {
    if (!isAssembled(c)) continue; // matches the BOM
    const layer = c.side === 'bottom' ? 'Bottom' : 'Top';
    lines.push([c.refdes, mm4(c.at.x), mm4(c.at.y), layer, rotationOf(c)].join(','));
  }
  return lines.join(CRLF) + CRLF;
}
