/**
 * Flamingo Panel - panel model types.
 * Units: mm. Coordinate system: y-up. Angles: degrees CCW (as in the engine).
 *
 * A panel is plain JSON (`.flamboyance`), diff-friendly like a board. It
 * never embeds board content: source boards are referenced by path plus a
 * content hash, so editing a source board marks the panel stale instead of
 * silently fabricating an old copy.
 */

import type { Point } from '@flamingo/engine';
import type { PanelCurve } from './curve.js';

/** Instances sit on the panel at right angles only. */
/** Degrees CCW, any angle; stored in [0, 360). Multiples of 90 stay exact. */
export type Rotation = number;

/** A side of an axis-aligned box: N = +y, E = +x, S = -y, W = -x. */
export type Side = 'N' | 'E' | 'S' | 'W';

export const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];

/** How boards are separated from each other and from the rails. */
export type Separation =
  /** Routed gap bridged by tabs perforated with a row of NPTH holes. */
  | 'mouse-bite'
  /** Routed gap bridged by plain tabs (cut them yourself). */
  | 'solid-tab'
  /**
   * No routing at all: one rectangular outline with the boards drawn inside it
   * as silkscreen lines. JLCPCB treats that as a single design; you cut the
   * boards apart yourself.
   */
  | 'silk-divider'
  /**
   * No routing between boards: they abut, and a straight V-groove is scored
   * along every shared edge, from one side of the panel to the other. Snapped
   * apart by hand. Boards must be rectangles on a grid.
   */
  | 'v-cut';

export interface PanelSource {
  /**
   * Short label prefix, unique on the panel (`S`, `M`, ...). Instances are
   * named `<key><n>` and merged refdes are `<key><n>_<refdes>`.
   */
  key: string;
  /** Board file, relative to the directory holding the panel file. */
  path: string;
  /** `sha256:<hex>` of the board's canonical serialization when it was added or last refreshed. */
  hash: string;
  /** Board name when it was added or last refreshed (display only). */
  name: string;
  /** Assembled boards of this design that the order must deliver. */
  needed: number;
}

export interface PanelInstance {
  /** `<source key><n>`, e.g. `S1`, `M3`. A new instance takes one past the highest number in use. */
  id: string;
  /** Key of the source board this is a copy of. */
  source: string;
  /** Bottom-left corner of the instance's rotated outline bounding box, panel mm. */
  at: Point;
  rotation: Rotation;
  /** Pinned instances are never moved by arrange. */
  pinned: boolean;
  /** true = assemble; false = ship bare (every part on it becomes do-not-place). */
  populate: boolean;
}

export interface RailSettings {
  /** Rail width in mm on each panel side; 0 = no rail on that side. */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TabSettings {
  /** Tab width along the board edge, mm. */
  width: number;
  /** Target distance between tab centres along one edge, mm. */
  pitch: number;
  /** Longest gap a tab may bridge, mm. Wider gaps get no tab. */
  maxLength: number;
  /** Mouse-bite hole diameter, mm. */
  holeDiameter: number;
  /** Mouse-bite hole centre-to-centre distance, mm. */
  holePitch: number;
  /** Fraction of the hole diameter that reaches into the board (0..0.5). */
  holeOverlap: number;
}

export interface FiducialSettings {
  enabled: boolean;
  /** Bare copper dot diameter, mm. */
  copperDiameter: number;
  /** Solder mask opening diameter, mm. */
  maskDiameter: number;
  /** Distance from the fiducial centre to the outer edge of its rail, mm. */
  edgeDistance: number;
  /** Distance from the panel corner along the rail, mm. */
  cornerOffset: number;
}

export interface ToolingHoleSettings {
  enabled: boolean;
  /** NPTH diameter, mm. */
  diameter: number;
  /** Distance from the panel corner along the rail, mm. */
  cornerOffset: number;
}

export interface PanelSettings {
  separation: Separation;
  rails: RailSettings;
  /** Routed gap between boards, and between boards and rails, mm. Ignored for silk-divider and v-cut. */
  spacing: number;
  tabs: TabSettings;
  fiducials: FiducialSettings;
  toolingHoles: ToolingHoleSettings;
  /**
   * Layer count the panel is fabricated at. `auto` requires every source board
   * to share one layer count; a number promotes boards with fewer layers.
   */
  copperLayers: 'auto' | 2 | 4 | 6;
  /**
   * Angle step the packer may turn boards by, degrees: 90 tries each board as
   * it is and a quarter turn from it; 36 lets pentagons nest; it must divide
   * 360. Any angle can still be set on an instance by hand.
   */
  rotationStep: number;
}

export interface Panel {
  formatVersion: 1;
  kind: 'flamingo-panel';
  name: string;
  sources: PanelSource[];
  instances: PanelInstance[];
  settings: PanelSettings;
  /**
   * The cost-by-quantity curve last priced for this panel, kept in the file
   * so it is there again on open. A cache, not part of the design: ops never
   * read or write it, and undo does not restore it (`PanelDoc` holds it).
   */
  curve?: PanelCurve;
}

/** Axis-aligned box. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
