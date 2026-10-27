/**
 * Flamingo Fab - JLCPCB SMT Bill of Materials CSV.
 *
 * Header is exactly `Comment,Designator,Footprint,LCSC Part #` (JLCPCB's
 * required column set/order for its "Import BOM" step). Line endings are
 * CRLF throughout -- JLCPCB's upload tooling has historically been picky
 * about bare LF, so we emit CRLF unconditionally regardless of platform.
 *
 * One row per distinct (lcsc, Comment) combination on the board, where
 * Comment = fields.value, falling back to fields.description (there is no
 * separate "short description" field in ComponentInst.fields -- description
 * is the closest analog and is what the task brief's "description-short"
 * meant), falling back to the bare lcsc part number. Grouping on the
 * *computed* Comment (rather than the raw fields.value) guarantees every
 * row's Comment column is unambiguous: two components sharing an lcsc but
 * differing only in which fallback tier produced their Comment would
 * otherwise merge into a row whose Comment lied about half its members.
 * Designators within a group are joined with a bare comma ("R1,R2,R5"), no
 * space, sorted in natural order (numeric run compared as a number, so
 * R2 < R10) since plain lexicographic sort would put R10 before R2.
 *
 * JLCPCB's upload rejects a Designator cell over 2048 characters ("The
 * 'Designator' characters in each cell should not exceed 2048"), which a
 * panel reaches easily (eight boards of 144 LEDs, each named like F1_D100).
 * A group whose joined designators would pass that limit is written as
 * several rows with the same Comment, Footprint and LCSC Part #; JLCPCB
 * merges them back into one line item.
 */

import type { Board, ComponentInst } from '@flamingo/engine';
import { isAssembled } from '@flamingo/engine';

const CRLF = '\r\n';
const GROUP_SEP = ' ';
/** JLCPCB's limit on the Designator cell, in characters (observed 2026-10-26). */
export const MAX_DESIGNATOR_CELL = 2048;

/** Split a designator into alternating non-digit/digit runs for natural sort. */
function naturalChunks(s: string): string[] {
  return s.match(/(\d+|\D+)/g) ?? [];
}

/** Natural-order compare ("R2" < "R10") -- numeric runs compare as numbers. */
function naturalCompare(a: string, b: string): number {
  const ca = naturalChunks(a);
  const cb = naturalChunks(b);
  const len = Math.max(ca.length, cb.length);
  for (let i = 0; i < len; i++) {
    const x = ca[i] ?? '';
    const y = cb[i] ?? '';
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = parseInt(x, 10) - parseInt(y, 10);
      if (diff !== 0) return diff;
    }
    return x < y ? -1 : 1;
  }
  return 0;
}

/** RFC-4180 field quoting: quote if it contains a comma, quote, or newline. */
function csvField(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

// Mirrored by the engine's bom-comment-conflict DRC check (drc/checks/bomComment.ts).
// Keep the two in sync.
function commentOf(c: ComponentInst): string {
  return c.fields.value || c.fields.description || c.lcsc;
}

function footprintOf(c: ComponentInst): string {
  return c.fields.package || c.footprint.name;
}

/**
 * Join sorted designators with commas into cells of at most `max` characters.
 * A single designator longer than `max` still gets its own cell: there is
 * nothing shorter to write.
 */
export function designatorCells(designators: string[], max = MAX_DESIGNATOR_CELL): string[] {
  const cells: string[] = [];
  let cell = '';
  for (const d of designators) {
    if (cell === '') cell = d;
    else if (cell.length + 1 + d.length <= max) cell += ',' + d;
    else {
      cells.push(cell);
      cell = d;
    }
  }
  if (cell !== '') cells.push(cell);
  return cells;
}

interface BomGroup {
  comment: string;
  footprint: string;
  lcsc: string;
  designators: string[];
}

/** Generate the JLCPCB BOM CSV for a board. */
export function generateBOM(b: Board): string {
  const groups = new Map<string, BomGroup>();

  for (const c of b.components) {
    if (!isAssembled(c)) continue; // no LCSC number, or do not place
    const comment = commentOf(c);
    const key = c.lcsc + GROUP_SEP + comment;
    let g = groups.get(key);
    if (!g) {
      g = { comment, footprint: footprintOf(c), lcsc: c.lcsc, designators: [] };
      groups.set(key, g);
    }
    g.designators.push(c.refdes);
  }

  const rows = [...groups.values()].sort((a, b2) =>
    naturalCompare(a.designators[0]!, b2.designators[0]!),
  );

  const lines = ['Comment,Designator,Footprint,LCSC Part #'];
  for (const g of rows) {
    for (const designators of designatorCells([...g.designators].sort(naturalCompare))) {
      lines.push(
        [csvField(g.comment), csvField(designators), csvField(g.footprint), csvField(g.lcsc)].join(','),
      );
    }
  }
  return lines.join(CRLF) + CRLF;
}
