/** Boards and a server for the panel tests. No network: prices are injected. */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Board, Footprint, PathSeg } from '@flamingo/engine';
import { newBoard, serializeBoard } from '@flamingo/engine';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';
import type { PartInfo } from '../src/panel/parts.js';
import { PanelSession } from '../src/panel/session.js';
import type { PanelSessionOptions } from '../src/panel/session.js';

export function rect(w: number, h: number): PathSeg[] {
  const p = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  return p.map((start, i) => ({ type: 'line' as const, start, end: p[(i + 1) % 4]! }));
}

const R0603: Footprint = {
  name: 'R0603',
  lcsc: 'C25804',
  pads: [
    { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
    { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
  ],
  silk: [],
  courtyard: [
    [
      { x: -1.5, y: -0.8 },
      { x: 1.5, y: -0.8 },
      { x: 1.5, y: 0.8 },
      { x: -1.5, y: 0.8 },
    ],
  ],
};

const MODULE: Footprint = {
  name: 'MODULE',
  lcsc: 'C2913204',
  pads: Array.from({ length: 8 }, (_, i) => ({
    number: String(i + 1),
    shape: 'rect' as const,
    at: { x: i < 4 ? -4 : 4, y: -3 + (i % 4) * 2 },
    rotation: 0,
    size: { w: 1.2, h: 0.8 },
    layer: 'top' as const,
  })),
  silk: [],
  courtyard: [
    [
      { x: -5, y: -4 },
      { x: 5, y: -4 },
      { x: 5, y: 4 },
      { x: -5, y: 4 },
    ],
  ],
};

/** DRC-clean boards: a few parts, no nets, nothing near an edge. */
export function sensorBoard(): Board {
  const b = newBoard('sensor', 2);
  b.outline = rect(40, 30);
  b.components.push(
    { refdes: 'U1', lcsc: 'C2913204', footprint: MODULE, at: { x: 20, y: 15 }, rotation: 0, side: 'top', fields: { value: 'MODULE', package: 'MODULE', basic: false } },
    { refdes: 'R1', lcsc: 'C25804', footprint: R0603, at: { x: 8, y: 6 }, rotation: 0, side: 'top', fields: { value: '10k', package: '0603', basic: true } },
  );
  return b;
}

export function miniBoard(layers: 2 | 4 | 6 = 2): Board {
  const b = newBoard('mini', layers);
  b.outline = rect(18, 12);
  b.components.push({
    refdes: 'R1',
    lcsc: 'C25804',
    footprint: R0603,
    at: { x: 9, y: 6 },
    rotation: 0,
    side: 'top',
    fields: { value: '10k', package: '0603', basic: true },
  });
  return b;
}

export const PRICES: Record<string, number> = { C25804: 0.0012, C2913204: 3.2 };

/** The test lookup: an EasyEDA-style unit price for the parts in PRICES, nothing for the rest. */
export function partInfoFor(lcsc: string): PartInfo | undefined {
  const unitPrice = PRICES[lcsc];
  return unitPrice === undefined ? undefined : { unitPrice };
}

export async function writeBoards(dir: string): Promise<{ sensor: string; mini: string }> {
  const sensor = join(dir, 'sensor.flamingo');
  const mini = join(dir, 'mini.flamingo');
  await writeFile(sensor, serializeBoard(sensorBoard()));
  await writeFile(mini, serializeBoard(miniBoard()));
  return { sensor, mini };
}

export function testSession(projectDir: string, opts: Partial<PanelSessionOptions> = {}): PanelSession {
  return new PanelSession({ projectDir, partLookup: async (lcsc) => partInfoFor(lcsc), debounceMs: 20, ...opts });
}

export async function startPanelServer(
  projectDir: string,
  uiDistDir?: string,
  /** `board: false` is a server started on a panel file: no board at all. */
  opts: { board?: boolean; session?: PanelSession } = {},
): Promise<StartedServer> {
  return startServer(opts.board === false ? null : new Doc(newBoard('editor', 2)), 0, {
    projectDir,
    panel: opts.session ?? testSession(projectDir),
    partsApi: {
      fetchPart: async () => {
        throw new Error('no network in tests');
      },
      searchParts: async () => [],
      fetchStock: async (lcsc) => ({ lcsc, stock: 1_000_000, basic: false }),
    },
    routeRunner: { run: async () => '' },
    ...(uiDistDir ? { uiDistDir } : {}),
  });
}
