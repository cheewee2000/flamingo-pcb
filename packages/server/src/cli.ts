#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { newBoard } from '@flamingo/engine';
import { Doc } from './document.js';
import { startServer } from './http.js';

const VERSION = '0.1.0';

async function serve(fileArg: string): Promise<void> {
  const filePath = resolve(process.cwd(), fileArg);

  let doc: Doc;
  if (existsSync(filePath)) {
    doc = await Doc.load(filePath);
  } else {
    const stem = basename(filePath, extname(filePath)) || 'board';
    doc = new Doc(newBoard(stem, 2), filePath);
    await doc.save();
  }

  const port = process.env.FLAMINGO_PORT ? Number(process.env.FLAMINGO_PORT) : 4242;
  const started = await startServer(doc, port, { projectDir: dirname(filePath) });
  console.log(`Flamingo v${VERSION} serving ${fileArg} at http://localhost:${started.port}`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    doc
      .close()
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

  if (command === 'serve') {
    await serve(args[1] ?? './board.flamingo');
    return;
  }
  if (command === 'import' && args[1]) {
    const pcbFlag = args.indexOf('--pcb');
    const pcbName = pcbFlag !== -1 ? args[pcbFlag + 1] : undefined;
    const rest = args.slice(2).filter((a, i) => pcbFlag === -1 || (i + 2 !== pcbFlag && i + 2 !== pcbFlag + 1));
    await importCmd(args[1], rest[0], pcbName);
    return;
  }
  console.error('Usage: flamingo serve [file.flamingo]\n       flamingo import <project.epro> [out.flamingo] [--pcb name]');
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
