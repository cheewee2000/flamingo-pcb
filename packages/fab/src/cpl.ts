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
 *   - top side:    rot % 360, shifted into [0, 360)
 *   - bottom side: (360 - normalized-rot) % 360
 * The bottom-side flip matches JLCPCB's convention that CPL rotation for
 * bottom-side parts is measured after mirroring the board (so a part's
 * silkscreen-visible rotation, once physically flipped face-down, keeps
 * agreeing with the rotation JLC's placement machine expects) -- e.g. a
 * board-space rotation of 270 on the bottom side reports as 90.
 */

import type { Board, ComponentInst } from '@flamingo/engine';

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
  const out = c.side === 'bottom' ? (360 - rot) % 360 : rot;
  return trimNum(out);
}

/** Generate the JLCPCB CPL CSV for a board. */
export function generateCPL(b: Board): string {
  const lines = ['Designator,Mid X,Mid Y,Layer,Rotation'];
  for (const c of b.components) {
    const layer = c.side === 'bottom' ? 'Bottom' : 'Top';
    lines.push([c.refdes, mm4(c.at.x), mm4(c.at.y), layer, rotationOf(c)].join(','));
  }
  return lines.join(CRLF) + CRLF;
}
