/**
 * Flamingo Engine - DRC shared types
 *
 * Split out from drc.ts so check modules can import these without creating
 * an import cycle with the orchestrator (drc.ts imports every check module).
 */

import type { LayerId, Point } from '../types.js';

/** A single DRC finding. `items` holds refdes/net/id refs of the offenders. */
export interface DrcViolation {
  rule: string;
  message: string;
  at: Point;
  items: string[];
}

/**
 * One piece of copper on one layer, in a uniform shape checks can consume
 * without recomputing pad outlines / track strokes / via circles themselves.
 * Through pads and vias contribute one CopperItem per copper layer; zones
 * contribute one CopperItem per fill island (or the raw outline polygon if
 * unfilled).
 */
export interface CopperItem {
  kind: 'track' | 'via' | 'pad' | 'zone';
  net: string;
  ref: string;
  polygon: Point[];
  layer: LayerId;
}
