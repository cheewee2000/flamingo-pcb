/**
 * Flamingo Panel - the view a client draws.
 *
 * Derived by the server from the panel and its source boards after every
 * change, and pushed to every connected browser. Plain data: it crosses the
 * WebSocket as JSON, so the browser draws exactly what MCP reads.
 */

import type { RuleSet } from '@flamingo/engine';
import type { PanelIssue } from './check.js';
import type { PanelGeometry } from './geometry.js';
import type { PanelQuote } from './order.js';
import type { SourceGeometry } from './source.js';
import type { Panel } from './types.js';

/** A source as a client needs it: geometry and status, never the whole board. */
export interface SourceView {
  key: string;
  path: string;
  name: string;
  stale: boolean;
  error?: string;
  needed: number;
  instances: number;
  populated: number;
  geometry?: Omit<SourceGeometry, 'parts'> & { partLines: number; extendedParts: number };
}

export interface LimitView {
  label: string;
  width: number;
  height: number;
  /** false = an estimate or a design choice. */
  verified: boolean;
  source: string;
  /** This is the limit arrange packs against. */
  binding: boolean;
}

/** The smallest order JLCPCB takes: why 5 panels are made when 2 are needed. */
export interface OrderMinimums {
  /** Fewest pieces fabricated in one order. */
  made: number;
  /** Fewest pieces assembled in one order. */
  assembled: number;
  /** false = an estimate. */
  verified: boolean;
}

export interface PanelView {
  panel: Panel;
  filePath: string | null;
  canUndo: boolean;
  canRedo: boolean;
  sources: SourceView[];
  geometry: PanelGeometry;
  issues: PanelIssue[];
  quote: PanelQuote;
  limits: LimitView[];
  minimums: OrderMinimums;
  /** Layer count the panel will be made at; null while the boards disagree. */
  layers: 2 | 4 | 6 | null;
  /** DRC ruleset the panel is made to (the loosest tier its boards need); null while the boards disagree. */
  rules: RuleSet['id'] | null;
  /** Milliseconds it took to derive this view. */
  derivedMs: number;
  /** Counts up on every change, so a client can drop views that arrive late. */
  revision: number;
}

/** Where one source board is in the checks a view waits for. */
export interface BoardLoading {
  key: string;
  name: string;
  /** The board's colour on this panel (colors.ts). */
  color: string;
  /** `zones`: filling copper pours. `drc`: design rule check. */
  phase: 'queued' | 'zones' | 'drc' | 'done';
  /** Estimated share of this board's work done, 0..1. */
  fraction: number;
  /** What is running right now, e.g. `zone 2 of 4` or `clearance`. */
  detail?: string;
}

/**
 * Progress of a view that is being derived. Pushed to clients while it runs,
 * then `null` once the view is out. Only the source boards' own DRC (zone fill
 * included) takes long enough to report; the rest is folded into it.
 */
export interface PanelLoading {
  /** When this derivation started, ms since the epoch (server clock). */
  startedAt: number;
  boards: BoardLoading[];
}
