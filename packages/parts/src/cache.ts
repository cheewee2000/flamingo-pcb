/**
 * On-disk cache of RAW EasyEDA API responses.
 * Location: `~/.flamingo/parts/<LCSC>.json` (override via FLAMINGO_CACHE_DIR).
 * We store the raw response so parsing logic can improve without re-fetching.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export function cacheDir(): string {
  const override = process.env.FLAMINGO_CACHE_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), '.flamingo', 'parts');
}

function cachePath(lcsc: string): string {
  return join(cacheDir(), `${lcsc}.json`);
}

/** Read a raw cached API response, or null if absent/unreadable. */
export async function readCache(lcsc: string): Promise<unknown | null> {
  try {
    const txt = await readFile(cachePath(lcsc), 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/** Persist a raw API response for `lcsc`. */
export async function writeCache(lcsc: string, raw: unknown): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(cachePath(lcsc), JSON.stringify(raw), 'utf8');
}
