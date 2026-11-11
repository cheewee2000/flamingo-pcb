/**
 * Flamingo Panel - source board content hash (Node only).
 *
 * The hash covers the board's canonical serialization, not the file's bytes,
 * so re-indenting or re-saving an unchanged board does not mark panels stale,
 * while any change to the board's content does.
 */

import { createHash } from 'node:crypto';
import type { Board } from '@flamingo/engine';
import { serializeBoard } from '@flamingo/engine';

export function hashBoard(board: Board): string {
  return `sha256:${createHash('sha256').update(serializeBoard(board), 'utf8').digest('hex')}`;
}
