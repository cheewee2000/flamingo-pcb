/**
 * Flamingo Panel - loading a panel's source boards (Node only).
 *
 * Reads every board a panel refers to, hashes it, and compares the hash with
 * the one the panel recorded. A source whose board changed since is `stale`;
 * one whose file is missing or unreadable carries an `error` and no geometry.
 * Parsed boards are cached per path and reused only while the file's bytes
 * are the same, so re-resolving on every panel edit costs a read per source,
 * not a parse. File times are not trusted: two quick saves of the same length
 * can share an mtime (coarse clocks, FAT/exFAT, bind mounts).
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Board } from '@flamingo/engine';
import { parseBoard } from '@flamingo/engine';
import type { PanelLimits } from '../config.js';
import type { ResolvedSource } from '../resolved.js';
import { resolveSourceGeometry } from '../source.js';
import type { Panel, PanelSource } from '../types.js';
import { hashBoard } from './hash.js';

interface CacheEntry {
  /** The file's text the board was parsed from. */
  text: string;
  board: Board;
  hash: string;
}

const cache = new Map<string, CacheEntry>();

/** Forget every cached board (tests). */
export function clearSourceCache(): void {
  cache.clear();
}

export interface LoadedBoard {
  board: Board;
  hash: string;
}

/** Read, parse and hash one board file. Throws when it cannot be read or parsed. */
export async function loadBoardFile(absPath: string): Promise<LoadedBoard> {
  const text = await readFile(absPath, 'utf8');
  const hit = cache.get(absPath);
  if (hit && hit.text === text) return { board: hit.board, hash: hit.hash };
  const board = parseBoard(text);
  const hash = hashBoard(board);
  cache.set(absPath, { text, board, hash });
  return { board, hash };
}

/** Absolute path of a source board, given the directory holding the panel file. */
export function sourcePath(panelDir: string, source: Pick<PanelSource, 'path'>): string {
  return isAbsolute(source.path) ? source.path : resolve(panelDir, source.path);
}

/** Path to store in the panel for a board: relative to the panel's directory, forward slashes. */
export function relativeSourcePath(panelDir: string, boardPath: string): string {
  const rel = relative(panelDir, resolve(panelDir, boardPath));
  return rel.split('\\').join('/');
}

export async function resolveSource(
  panelDir: string,
  source: PanelSource,
  limits: PanelLimits,
): Promise<ResolvedSource> {
  const base = { key: source.key, path: source.path, recordedHash: source.hash };
  let loaded: LoadedBoard;
  try {
    loaded = await loadBoardFile(sourcePath(panelDir, source));
  } catch (err) {
    return {
      ...base,
      name: source.name,
      stale: false,
      error: `cannot read "${source.path}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const stale = loaded.hash !== source.hash;
  try {
    return {
      ...base,
      name: loaded.board.name,
      hash: loaded.hash,
      stale,
      board: loaded.board,
      geometry: resolveSourceGeometry(loaded.board, limits),
    };
  } catch (err) {
    return {
      ...base,
      name: loaded.board.name,
      hash: loaded.hash,
      stale,
      board: loaded.board,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Resolve every source of `panel`, in panel order. */
export async function resolveSources(
  panel: Panel,
  panelDir: string,
  limits: PanelLimits,
): Promise<ResolvedSource[]> {
  return Promise.all(panel.sources.map((s) => resolveSource(panelDir, s, limits)));
}
