/**
 * Flamingo Engine - DRC shared types
 *
 * Split out from drc.ts so check modules can import these without creating
 * an import cycle with the orchestrator (drc.ts imports every check module).
 */

import type { LayerId, Point } from '../types.js';
import type { PolyGroup } from '../geometry.js';

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
  /**
   * Zone (copper pour) items only. When a zone has a winding-encoded fill,
   * its rings are decoded into polygons-with-holes: `group.outer` is the solid
   * boundary and `group.holes` are knockouts (e.g. clearance around other-net
   * copper). Checks that test intersection/distance MUST honor holes for these
   * items (an item inside a hole is NOT touching copper). `polygon` mirrors
   * `group.outer` so bbox/centroid/rendering consumers keep working unchanged.
   */
  group?: PolyGroup;
}
