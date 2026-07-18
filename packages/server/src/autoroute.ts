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
import { isFullyRouted, RULESETS } from '@flamingo/engine';
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
  /** Nets re-routed at escape width after failing at full class width. */
  retriedThin: string[];
  /** Tracks fattened back toward class width by the post-route widen pass. */
  widened: number;
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

  let tracksAdded = tracks.length;
  let viasAdded = vias.length;
  let remaining = isFullyRouted(doc.board);

  // 6. Escape-width retry: nets whose class width physically can't pass their
  // fine-pitch pad escapes (0.5mm power tracks vs 0.5mm-pitch FPC pads) fail
  // at full width no matter how many passes Freerouting gets. Re-route just
  // the still-split nets with their classes temporarily thinned to an escape
  // width in the exported DSN; the widen pass below fattens the runs back to
  // class width wherever they clear, leaving thin copper only at the pads.
  let retriedThin: string[] = [];
  if (remaining.length > 0) {
    const rules = RULESETS[doc.board.rules];
    const thinNets = remaining.map((r) => r.net);
    const shadow: Board = structuredClone(doc.board);
    const classesToThin = new Set(
      shadow.nets.filter((n) => thinNets.includes(n.name)).map((n) => n.class),
    );
    let changed = false;
    for (const nc of shadow.netClasses) {
      if (!classesToThin.has(nc.name)) continue;
      const escapeWidth = Math.max(rules.minTrackWidth, Math.min(0.25, nc.trackWidth));
      const escapeVia = Math.max(rules.minViaDiameter, Math.min(0.6, nc.viaDiameter));
      if (escapeWidth < nc.trackWidth - 1e-6 || escapeVia < nc.viaDiameter - 1e-6) changed = true;
      nc.trackWidth = escapeWidth;
      nc.viaDiameter = escapeVia;
      nc.viaDrill = Math.max(rules.minDrill, Math.min(nc.viaDrill, escapeVia / 2));
    }
    if (changed) {
      for (const n of thinNets) {
        const r = doc.apply({ op: 'unroute', net: n });
        if (!r.ok) throw new Error((r as OpError).error);
      }
      // The shadow's copper must mirror the just-unrouted doc.
      shadow.tracks = shadow.tracks.filter((t) => !thinNets.includes(t.net));
      shadow.vias = shadow.vias.filter((v) => !thinNets.includes(v.net));
      const dsn2 = exportDSN(shadow, { nets: thinNets });
      const ses2 = await route.run(dsn2, opts.passes !== undefined ? { passes: opts.passes } : undefined);
      const imported = importSES(ses2, doc.board);
      const applyRes2 = doc.apply({ op: 'addTracks', tracks: imported.tracks, vias: imported.vias });
      if (!applyRes2.ok) throw new Error((applyRes2 as OpError).error);
      tracksAdded += imported.tracks.length;
      viasAdded += imported.vias.length;
      retriedThin = thinNets;
      remaining = isFullyRouted(doc.board);
    }
  }

  // 7. Widen pass: fatten every under-class-width track back toward class
  // width where it clears, splitting so only pad-adjacent spans stay thin.
  const beforeWiden = doc.board.tracks.length;
  const widenRes = doc.apply({ op: 'widenTracks', ...(netList ? { nets: netList } : {}) });
  if (!widenRes.ok) throw new Error((widenRes as OpError).error);
  // Each widened track is replaced by N pieces (net track-count delta N-1), so
  // pieces-added minus count-delta = number of original tracks fattened.
  const widened = widenRes.createdIds.length - (doc.board.tracks.length - beforeWiden);

  const routedCount = netList
    ? netList.length
    : doc.board.nets.filter((n) => n.pins.length >= 2).length;

  return {
    routedCount,
    tracksAdded,
    viasAdded,
    remaining,
    retriedThin,
    widened,
  };
}

/** The one-line human summary the MCP autoroute tool reports. */
export function formatAutorouteSummary(result: AutorouteResult): string {
  const remainingStr =
    result.remaining.length === 0
      ? 'All nets fully routed.'
      : `Unrouted remaining: ${result.remaining.map((u) => `${u.net} (${u.unconnected})`).join(', ')}`;
  const extras: string[] = [];
  if (result.retriedThin.length > 0) {
    extras.push(`retried ${result.retriedThin.join(', ')} at escape width`);
  }
  if (result.widened > 0) {
    extras.push(`widened ${result.widened} track(s) back toward class width`);
  }
  const extraStr = extras.length > 0 ? ` (${extras.join('; ')})` : '';
  return `Routed ${result.routedCount} net(s): ${result.tracksAdded} tracks, ${result.viasAdded} vias added. ${remainingStr}${extraStr}`;
}
