#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, resolve } from 'node:path';
import { newBoard } from '@flamingo/engine';
import { Doc } from './document.js';
import { startServer } from './http.js';
import { PanelDoc } from './panel/doc.js';
import { PANEL_EXTENSION } from '@flamingo/panel';
import { PANEL_USAGE, runPanelCli } from './panel/cli.js';
import { partLookupFrom } from './panel/parts.js';
import { PanelSession } from './panel/session.js';
import { fetchJlcStock, fetchPart } from '@flamingo/parts';

const VERSION = createRequire(import.meta.url)('../package.json').version as string;
/** What panel files were called before they were `.flamboyance`. */
const OLD_PANEL_EXTENSIONS = ['.flamingo-panel', '.plamingo'];

const partLookup = partLookupFrom({ fetchStock: fetchJlcStock, fetchPart });

function shutDownOn(close: () => Promise<unknown>): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    close()
      .catch((err: unknown) => {
        console.error('[flamingo] failed to flush pending save on shutdown:', err);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Serve a panel file the way a board file is served: the file is created if
 * it is missing, and its view is the page at '/'.
 */
async function servePanel(fileArg: string): Promise<void> {
  const filePath = resolve(process.cwd(), fileArg);
  const projectDir = dirname(filePath);

  let panel: PanelSession;
  if (existsSync(filePath)) {
    panel = new PanelSession({ projectDir, partLookup }, await PanelDoc.load(filePath));
    void panel.loadPrices(await panel.resolved()).then(() => panel.touch());
  } else {
    panel = new PanelSession({ projectDir, partLookup });
    const created = await panel.create(basename(filePath, PANEL_EXTENSION) || 'panel', filePath);
    if (!created.ok) throw new Error(created.error);
  }

  const port = process.env.FLAMINGO_PORT ? Number(process.env.FLAMINGO_PORT) : 4242;
  // No board: the server has only the panel to offer.
  const started = await startServer(null, port, { projectDir, panel });
  console.log(`Flamingo v${VERSION} serving ${fileArg} at http://localhost:${started.port}`);
  shutDownOn(() => started.close());
}

async function serve(fileArg: string, panelArg?: string): Promise<void> {
  const filePath = resolve(process.cwd(), fileArg);

  let doc: Doc;
  if (existsSync(filePath)) {
    doc = await Doc.load(filePath);
  } else {
    const stem = basename(filePath, extname(filePath)) || 'board';
    doc = new Doc(newBoard(stem, 2), filePath);
    await doc.save();
  }

  // Panels are served next to the board: open the one named with --panel, or
  // start with an empty, unsaved one.
  const projectDir = dirname(filePath);
  let panel: PanelSession;
  if (panelArg) {
    const panelPath = resolve(process.cwd(), panelArg);
    if (!existsSync(panelPath)) throw new Error(`${panelPath} does not exist (create it with: flamingo panel new ${panelArg})`);
    panel = new PanelSession({ projectDir, partLookup }, await PanelDoc.load(panelPath));
    void panel.loadPrices(await panel.resolved()).then(() => panel.touch());
  } else {
    panel = new PanelSession({ projectDir, partLookup });
  }

  const port = process.env.FLAMINGO_PORT ? Number(process.env.FLAMINGO_PORT) : 4242;
  const started = await startServer(doc, port, { projectDir, panel });
  console.log(`Flamingo v${VERSION} serving ${fileArg} at http://localhost:${started.port}`);
  console.log(`Panel view at http://localhost:${started.port}/panel${panelArg ? ` (${panelArg})` : ''}`);

  shutDownOn(() => Promise.all([doc.close(), panel.close()]));
}

async function importCmd(srcArg: string, outArg: string | undefined, pcbName: string | undefined): Promise<void> {
  const { importEpro } = await import('./import/epro.js');
  const src = resolve(process.cwd(), srcArg);
  const out = resolve(process.cwd(), outArg ?? basename(src, extname(src)) + '.flamingo');
  const { board, warnings } = importEpro(src, { pcbName });
  const doc = new Doc(board, out);
  await doc.save();
  for (const w of warnings) console.warn(`[import] ${w}`);
  console.log(
    `Imported "${board.name}" -> ${out}: ${board.components.length} components, ${board.nets.length} nets, ` +
      `${board.tracks.length} tracks, ${board.vias.length} vias, ${board.zones.length} zones (${warnings.length} warning(s))`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'panel') {
    process.exitCode = await runPanelCli(args.slice(1));
    return;
  }

  if (command === 'import' && args[1]) {
    const pcbFlag = args.indexOf('--pcb');
    const pcbName = pcbFlag !== -1 ? args[pcbFlag + 1] : undefined;
    const rest = args.slice(2).filter((a, i) => pcbFlag === -1 || (i + 2 !== pcbFlag && i + 2 !== pcbFlag + 1));
    await importCmd(args[1], rest[0], pcbName);
    return;
  }

  if (command !== 'serve') {
    console.error(
      `Usage: flamingo serve [file.flamingo] [--panel file${PANEL_EXTENSION}]    the board editor, with a panel at /panel\n` +
        `       flamingo serve <file${PANEL_EXTENSION}>    the panel view\n` +
        `       flamingo import <project.epro> [out.flamingo] [--pcb name]\n\n${PANEL_USAGE}`,
    );
    process.exitCode = 1;
    return;
  }

  const rest = args.slice(1);
  const panelAt = rest.indexOf('--panel');
  const panelArg = panelAt >= 0 ? rest.splice(panelAt, 2)[1] : undefined;
  if (panelAt >= 0 && panelArg === undefined) {
    console.error('--panel needs a file');
    process.exitCode = 1;
    return;
  }
  const file = rest[0] ?? './board.flamingo';
  for (const f of [file, panelArg]) {
    if (f && OLD_PANEL_EXTENSIONS.some((ext) => f.endsWith(ext))) {
      throw new Error(`${f}: panel files end in ${PANEL_EXTENSION} now. Rename the file; its contents are unchanged.`);
    }
  }
  if (file.endsWith(PANEL_EXTENSION)) {
    if (panelArg !== undefined) throw new Error(`${file} is a panel already: leave out --panel`);
    await servePanel(file);
    return;
  }
  await serve(file, panelArg);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
