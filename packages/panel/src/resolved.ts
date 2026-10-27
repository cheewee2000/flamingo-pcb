/**
 * Flamingo Panel - a source board as resolved against the file system.
 *
 * Produced by `node/load.ts`; consumed by the pure checks, packer, merge and
 * cost code, which therefore never touch the disk themselves.
 */

import type { Board } from '@flamingo/engine';
import type { SourceGeometry } from './source.js';

export interface ResolvedSource {
  key: string;
  path: string;
  name: string;
  /** Hash the panel recorded when the board was added or last refreshed. */
  recordedHash: string;
  /** Hash of the board as it is on disk now. Absent when the file could not be read. */
  hash?: string;
  /** The board on disk differs from the one the panel was built against. */
  stale: boolean;
  /** Why the board cannot be used (missing file, invalid JSON, no outline). */
  error?: string;
  board?: Board;
  geometry?: SourceGeometry;
}

export type ResolvedSources = ReadonlyArray<ResolvedSource>;

export function findSource(sources: ResolvedSources, key: string): ResolvedSource | undefined {
  return sources.find((s) => s.key === key);
}
