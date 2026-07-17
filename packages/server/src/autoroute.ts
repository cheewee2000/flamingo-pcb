/**
 * Shared autoroute pipeline.
 *
 * Both the MCP `autoroute` tool and the UI's "Lock & Route" button (POST
 * /api/route) drive Freerouting through this one function so the two entry
 * points can never drift: unroute the target nets, export a Specctra DSN, run
 * the injected route runner, import the returned SES, and apply the routed
 * tracks/vias to the document.
 */

import type { Board, OpError } from '@flamingo/engine';
import { isFullyRouted } from '@flamingo/engine';
import { exportDSN, importSES } from '@flamingo/fab';
import type { Doc } from './document.js';
import type { RouteRunner } from './route.js';

export interface AutorouteOptions {
  /** Route only these nets (existing routes on other nets stay as obstacles). Omit to route the whole board. */
  nets?: string[];
  /** Max autorouter passes (Freerouting default is used when omitted). */
  passes?: number;
}

export interface AutorouteResult {
  /** Number of nets handed to the router this run. */
  routedCount: number;
  tracksAdded: number;
  viasAdded: number;
  /** Nets still split across >1 island after routing (empty => fully routed). */
  remaining: { net: string; unconnected: number }[];
}

/**
 * Run the full autoroute pipeline against `doc` using `route`. Mutates the
 * document (unroute + addTracks). Throws an Error with a human-readable message
 * on any failure (bad unroute op, router error, SES parse error, apply error).
 */
export async function runAutoroute(
  doc: Doc,
  route: RouteRunner,
  opts: AutorouteOptions = {},
): Promise<AutorouteResult> {
  const netList = opts.nets && opts.nets.length > 0 ? opts.nets : undefined;

  // 1. Unroute the nets we are about to (re)route so freerouting starts fresh.
  if (netList) {
    for (const n of netList) {
      const r = doc.apply({ op: 'unroute', net: n });
      if (!r.ok) throw new Error((r as OpError).error);
    }
  } else {
    const r = doc.apply({ op: 'unroute' });
    if (!r.ok) throw new Error((r as OpError).error);
  }

  // 2. Export DSN, 3. run freerouting, 4. import SES.
  const board: Board = doc.board;
  const dsn = exportDSN(board, netList ? { nets: netList } : {});
  const ses = await route.run(dsn, opts.passes !== undefined ? { passes: opts.passes } : undefined);
  const { tracks, vias } = importSES(ses, board);

  // 5. Apply the routed geometry.
  const applyRes = doc.apply({ op: 'addTracks', tracks, vias });
  if (!applyRes.ok) throw new Error((applyRes as OpError).error);

  const routedCount = netList
    ? netList.length
    : doc.board.nets.filter((n) => n.pins.length >= 2).length;

  return {
    routedCount,
    tracksAdded: tracks.length,
    viasAdded: vias.length,
    remaining: isFullyRouted(doc.board),
  };
}

/** The one-line human summary the MCP autoroute tool reports. */
export function formatAutorouteSummary(result: AutorouteResult): string {
  const remainingStr =
    result.remaining.length === 0
      ? 'All nets fully routed.'
      : `Unrouted remaining: ${result.remaining.map((u) => `${u.net} (${u.unconnected})`).join(', ')}`;
  return `Routed ${result.routedCount} net(s): ${result.tracksAdded} tracks, ${result.viasAdded} vias added. ${remainingStr}`;
}
