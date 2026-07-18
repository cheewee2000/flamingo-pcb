/**
 * Flamingo UI - board ingest.
 *
 * Boards arriving over the websocket / REST never carry zone fills (the server
 * only fills a throwaway copy during fab export), so compute the pours
 * client-side before the board enters the store. The 2D canvas renderer and
 * the 3D viewer both draw `zone.fill` when present.
 */

import type { Board } from '@flamingo/engine';
import { fillAllZones } from '@flamingo/engine';

/** Prepare a freshly-received board for display: compute copper-zone pours. */
export function prepareBoard(board: Board): Board {
  return board.zones.length > 0 ? fillAllZones(board) : board;
}
