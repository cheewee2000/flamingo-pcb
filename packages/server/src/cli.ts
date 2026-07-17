#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { newBoard } from '@flamingo/engine';
import { Doc } from './document.js';
import { startServer } from './http.js';

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
  console.log(`Flamingo serving ${fileArg} at http://localhost:${started.port}`);

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'serve') {
    console.error('Usage: flamingo serve [file.flamingo]');
    process.exitCode = 1;
    return;
  }

  const file = args[1] ?? './board.flamingo';
  await serve(file);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
