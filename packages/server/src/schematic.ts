/**
 * Flamingo Server - schematic export
 *
 * A board carries its netlist but no drawn schematic, so the schematic is
 * generated: the engine lays the sheet out (`buildSchematic`), and this
 * module supplies each part's library symbol from the parts cache (fetching
 * it on a miss) and renders the SVG, plus a PNG for viewing.
 */

import { Resvg } from '@resvg/resvg-js';
import type { Board, Schematic, SchematicSymbol } from '@flamingo/engine';
import { buildSchematic, renderSchematicSVG } from '@flamingo/engine';
import { fetchSymbol } from '@flamingo/parts';

export type SymbolLoader = (lcsc: string) => Promise<SchematicSymbol | null>;

export interface BoardSchematic {
  svg: string;
  schematic: Schematic;
}

/** PNG pixels per schematic unit, and the widest PNG written. */
const PNG_SCALE = 2.5;
const PNG_MAX_WIDTH = 6000;

/**
 * Generate the board's schematic. `loadSymbol` defaults to the parts cache
 * with a network fetch on a miss; a part whose symbol cannot be had is drawn
 * as a generic box and listed in `schematic.generic`.
 */
export async function boardSchematic(board: Board, loadSymbol: SymbolLoader = (lcsc) => fetchSymbol(lcsc)): Promise<BoardSchematic> {
  const ids = [...new Set(board.components.map((c) => c.lcsc).filter(Boolean))];
  const loaded = await Promise.all(ids.map(async (id) => [id, await loadSymbol(id).catch(() => null)] as const));
  const symbols = new Map(loaded);
  const schematic = buildSchematic(board, { symbolFor: (c) => symbols.get(c.lcsc) ?? undefined });
  return { svg: renderSchematicSVG(schematic), schematic };
}

export function schematicPng(s: BoardSchematic): Buffer {
  const width = Math.min(PNG_MAX_WIDTH, Math.max(600, Math.round(s.schematic.width * PNG_SCALE)));
  const resvg = new Resvg(s.svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true }, background: '#ffffff' });
  return Buffer.from(resvg.render().asPng());
}

export function schematicFileBase(boardName: string): string {
  return `${boardName.replace(/[^\w.-]+/g, '_') || 'board'}-schematic`;
}

/** One line per fact worth telling whoever asked for the export. */
export function schematicSummary(board: Board, s: Schematic): string[] {
  const count = (shown: string): number => s.pins.filter((p) => p.shown === shown).length;
  const netted = new Set(board.nets.flatMap((n) => n.pins));
  const drawn = new Set(s.pins.filter((p) => p.net !== null).map((p) => p.pin));
  const missing = [...netted].filter((p) => !drawn.has(p));
  const lines = [
    `${board.components.length} components, ${board.nets.length} nets; ${s.pins.length} pins drawn: ` +
      `${count('wire')} on wires, ${count('label')} by net label, ${count('rail') + count('ground')} on power symbols, ${count('nc')} unconnected.`,
  ];
  if (s.generic.length > 0) lines.push(`Drawn as a generic box (no usable library symbol): ${s.generic.join(', ')}.`);
  if (missing.length > 0) lines.push(`NOT DRAWN (pins on a net with no pad on the footprint): ${missing.join(', ')}.`);
  return lines;
}
