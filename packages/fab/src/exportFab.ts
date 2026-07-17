/**
 * Flamingo Fab - export_fab: the exact fileset uploaded to JLCPCB.
 *
 * Writes, into `outDir` (created with mkdir -p):
 *   - gerbers.zip   -- every file generateGerbers() produces, zipped with
 *                      archiver (JLCPCB accepts a single zip of Gerber X2 +
 *                      Excellon drill files for its "Add gerber file" step)
 *   - bom.csv       -- generateBOM()
 *   - cpl.csv       -- generateCPL()
 *   - board.render.svg -- a bonus reference render (renderSVG), not part of
 *                      the JLCPCB upload set but cheap to produce and useful
 *                      for a human to eyeball what was exported without
 *                      opening a Gerber viewer.
 *
 * Zone fills are computed once up front via fillAllZones and that filled
 * board is what feeds both generateGerbers (which would otherwise silently
 * re-fill internally -- see gerber.ts) and the reference SVG (renderSVG only
 * draws a zone's `fill` islands if already populated; an unfilled zone
 * renders as a faint outline instead of real copper). fillAllZones is pure/
 * idempotent (it recomputes fill from scratch off `b`, never consulting an
 * existing `z.fill`), so this doesn't change generateGerbers' output.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ZipArchive } from 'archiver';
import type { Board } from '@flamingo/engine';
import { fillAllZones, renderSVG } from '@flamingo/engine';
import { generateGerbers } from './gerber.js';
import { generateBOM } from './bom.js';
import { generateCPL } from './cpl.js';

export interface ExportFabResult {
  gerberZip: string;
  bomCsv: string;
  cplCsv: string;
}

/** Zip a filename->content map to `outPath` (deterministic order: Map insertion order). */
function zipFiles(files: Map<string, string>, outPath: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const output = createWriteStream(outPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', () => resolveP());
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const [name, content] of files) archive.append(content, { name });
    void archive.finalize();
  });
}

/** Export the full JLCPCB fabrication fileset for `b` into `outDir`. Returns absolute paths. */
export async function exportFab(b: Board, outDir: string): Promise<ExportFabResult> {
  const absOutDir = resolve(outDir);
  await mkdir(absOutDir, { recursive: true });

  const filled = fillAllZones(b);

  const { files } = generateGerbers(filled);
  const gerberZip = resolve(absOutDir, 'gerbers.zip');
  await zipFiles(files, gerberZip);

  const bomCsv = resolve(absOutDir, 'bom.csv');
  await writeFile(bomCsv, generateBOM(b), 'utf8');

  const cplCsv = resolve(absOutDir, 'cpl.csv');
  await writeFile(cplCsv, generateCPL(b), 'utf8');

  const svgPath = resolve(absOutDir, 'board.render.svg');
  await writeFile(svgPath, renderSVG(filled), 'utf8');

  return { gerberZip, bomCsv, cplCsv };
}
