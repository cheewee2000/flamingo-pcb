/**
 * Flamingo Panel - fab output for a panel (Node only).
 *
 * Reuses packages/fab end to end: the panel is merged into one Board and
 * handed to the same Gerber, drill, BOM and CPL writers a single board uses.
 *
 * Written into `outDir`:
 *   gerbers.zip       Gerber X2 + Excellon for the whole panel
 *   bom.csv           merged BOM, designators prefixed per instance (S1_U2)
 *   cpl.csv           merged placement list, panel coordinates
 *   panel.render.svg  reference picture of the panel (the layout view)
 *   panel.fab.svg     what the fab makes: material, routed openings, drilled holes
 *
 * Instances with populate=false are fabricated like any other, but none of
 * their parts appear in the BOM or CPL (JLCPCB's do-not-place), and their pads
 * get no solder paste.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateBOM, generateCPL, generateGerbers, zipFiles } from '@flamingo/fab';
import type { PanelIssue } from '../check.js';
import type { PanelLimits } from '../config.js';
import type { PanelGeometry } from '../geometry.js';
import { computeGeometry } from '../geometry.js';
import { assemblyBoard, mergePanel } from '../merge.js';
import type { ResolvedSources } from '../resolved.js';
import type { Panel } from '../types.js';
import { renderPanelSVG } from './render.js';

export interface PanelFabFiles {
  /** Gerber and drill files by name. */
  gerbers: Map<string, string>;
  bom: string;
  cpl: string;
  svg: string;
  /** The fabricated view (render.ts, view 'fab'). */
  fabSvg: string;
  /** Components placed by assembly, and components left off because their board ships bare. */
  placed: number;
  skipped: number;
  notes: string[];
}

export interface ExportPanelFabResult {
  gerberZip: string;
  bomCsv: string;
  cplCsv: string;
  renderSvg: string;
  fabSvg: string;
  placed: number;
  skipped: number;
  gerberFiles: string[];
  notes: string[];
}

/** Build every fab file for `panel` in memory. */
export function buildPanelFab(
  panel: Panel,
  sources: ResolvedSources,
  limits: PanelLimits,
  opts: { geometry?: PanelGeometry; issues?: PanelIssue[] } = {},
): PanelFabFiles {
  const geometry = opts.geometry ?? computeGeometry(panel, sources);
  const merged = mergePanel(panel, sources, limits, geometry);
  const { files } = generateGerbers(merged.board, {
    prefilled: true,
    profile: merged.profile,
    fiducials: merged.fiducials,
    labels: merged.labels,
    noPaste: (refdes) => merged.bare.has(refdes),
    ...(merged.scores.length > 0
      ? {
          scores: {
            lines: merged.scores,
            width: limits.vcut.lineWidth.value,
            label: limits.vcut.label.value,
            labelHeight: limits.vcut.labelHeight.value,
          },
        }
      : {}),
  });
  const assembled = assemblyBoard(merged);
  return {
    gerbers: files,
    bom: generateBOM(assembled),
    cpl: generateCPL(assembled),
    svg: renderPanelSVG(panel, sources, geometry, { issues: opts.issues }),
    fabSvg: renderPanelSVG(panel, sources, geometry, { issues: opts.issues, view: 'fab' }),
    placed: assembled.components.length,
    skipped: merged.bare.size,
    notes: merged.notes,
  };
}

/** Write the panel's fab fileset into `outDir` (created if missing). Returns absolute paths. */
export async function exportPanelFab(
  panel: Panel,
  sources: ResolvedSources,
  limits: PanelLimits,
  outDir: string,
  opts: { geometry?: PanelGeometry; issues?: PanelIssue[] } = {},
): Promise<ExportPanelFabResult> {
  const built = buildPanelFab(panel, sources, limits, opts);
  const abs = resolve(outDir);
  await mkdir(abs, { recursive: true });

  const gerberZip = resolve(abs, 'gerbers.zip');
  await writeFile(gerberZip, zipFiles(built.gerbers));
  const bomCsv = resolve(abs, 'bom.csv');
  await writeFile(bomCsv, built.bom, 'utf8');
  const cplCsv = resolve(abs, 'cpl.csv');
  await writeFile(cplCsv, built.cpl, 'utf8');
  const renderSvg = resolve(abs, 'panel.render.svg');
  await writeFile(renderSvg, built.svg, 'utf8');
  const fabSvg = resolve(abs, 'panel.fab.svg');
  await writeFile(fabSvg, built.fabSvg, 'utf8');

  return {
    gerberZip,
    bomCsv,
    cplCsv,
    renderSvg,
    fabSvg,
    placed: built.placed,
    skipped: built.skipped,
    gerberFiles: [...built.gerbers.keys()],
    notes: built.notes,
  };
}
