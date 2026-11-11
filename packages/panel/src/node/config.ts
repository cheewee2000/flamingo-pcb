/**
 * Flamingo Panel - config loading (Node only).
 *
 * The shipped config lives in `packages/panel/config/`. Point
 * `FLAMINGO_PANEL_CONFIG_DIR` at another directory to override it; a file that
 * is missing there falls back to the shipped one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PanelLimits } from '../config.js';
import type { FeeTable } from '../fees.js';

const here = dirname(fileURLToPath(import.meta.url));

/** `packages/panel/config`, found from either `src/node` (tsx, vitest) or `dist/node` (built). */
export function shippedConfigDir(): string {
  return join(here, '..', '..', 'config');
}

function readConfig<T>(file: string, dir?: string): T {
  const override = dir ?? process.env.FLAMINGO_PANEL_CONFIG_DIR;
  const candidates = [...(override ? [join(override, file)] : []), join(shippedConfigDir(), file)];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch (err) {
      throw new Error(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`config file ${file} not found (looked in ${candidates.join(', ')})`);
}

export function loadPanelLimits(dir?: string): PanelLimits {
  return readConfig<PanelLimits>('panel-limits.json', dir);
}

export function loadFeeTable(dir?: string): FeeTable {
  return readConfig<FeeTable>('fee-table.json', dir);
}
