/**
 * Flamingo Engine - Board Model Types
 * Units: mm
 * Coordinate system: y-up
 * Angles: degrees, counter-clockwise (CCW)
 */

export type LayerId =
  | 'F.Cu'
  | 'In1.Cu'
  | 'In2.Cu'
  | 'In3.Cu'
  | 'In4.Cu'
  | 'B.Cu'
  | 'F.Silk'
  | 'B.Silk'
  | 'F.Mask'
  | 'B.Mask'
  | 'F.Paste'
  | 'B.Paste'
  | 'Edge';

export interface Point {
  x: number;
  y: number;
}

export type PathSeg =
  | { type: 'line'; start: Point; end: Point }
  | {
      type: 'arc';
      start: Point;
      end: Point;
      center: Point;
      cw: boolean;
    };

export interface Pad {
  number: string;
  shape: 'rect' | 'oval' | 'circle' | 'polygon';
  at: Point; // relative to footprint origin
  rotation: number; // deg CCW, relative to footprint
  size: { w: number; h: number };
  polygon?: Point[]; // when shape==='polygon', relative to `at`
  drill?: { diameter: number; slotLength?: number; plated: boolean };
  layer: 'top' | 'bottom' | 'through';
}

export type SilkItem =
  | { kind: 'line'; start: Point; end: Point; width: number }
  | {
      kind: 'arc';
      start: Point;
      end: Point;
      center: Point;
      cw: boolean;
      width: number;
    }
  | { kind: 'circle'; center: Point; radius: number; width: number }
  | { kind: 'text'; at: Point; text: string; height: number; rotation: number };

export interface Footprint {
  name: string;
  lcsc: string;
  pads: Pad[];
  silk: SilkItem[];
  courtyard: Point[][];
}

export interface ComponentInst {
  refdes: string;
  lcsc: string;
  footprint: Footprint;
  at: Point;
  rotation: number;
  side: 'top' | 'bottom';
  fields: {
    value?: string;
    description?: string;
    /** Plain-English note on what this part is for on THIS board (e.g.
     * "Decouples the 3V3 rail at U2"), as opposed to `description`, which
     * is the LCSC catalog text for what the part is. Shown in the UI's
     * selection properties panel. */
    role?: string;
    mfr?: string;
    package?: string;
    basic?: boolean;
  };
}

export interface Net {
  name: string;
  class: string;
  pins: string[];
}

export interface NetClass {
  name: string;
  trackWidth: number;
  clearance: number;
  viaDrill: number;
  viaDiameter: number;
}

export interface Track {
  id: string;
  layer: LayerId;
  width: number;
  net: string;
  seg: PathSeg;
}

export interface Via {
  id: string;
  at: Point;
  drill: number;
  diameter: number;
  net: string;
}

export interface Zone {
  id: string;
  layer: LayerId;
  net: string;
  polygon: Point[];
  clearance: number;
  minWidth: number;
  thermal: { gap: number; spokeWidth: number };
  fill?: Point[][];
}

export interface Keepout {
  id: string;
  layers: LayerId[] | 'all';
  polygon: Point[];
  keepout: { copper: boolean; via: boolean; pour?: boolean };
}

export interface MountingHole {
  id: string;
  at: Point;
  drill: number;
  padDiameter: number;
  plated: boolean;
  /**
   * Total slot length in mm along the rotated long axis. When present and
   * greater than `drill`, the hole is a milled (G85) slot: geometrically a
   * capsule swept from a centerline of length `slotLength - drill` at the swept
   * width `drill` (the annulus uses `padDiameter`). Values <= drill (or absent)
   * mean a plain round hole.
   */
  slotLength?: number;
  /** Orientation of the slot's long axis in degrees CCW (0 = along +x). Default 0. */
  rotation?: number;
}

export interface SilkText {
  id: string;
  layer: 'F.Silk' | 'B.Silk';
  at: Point;
  text: string;
  height: number;
  rotation: number;
}

/**
 * A straight silkscreen line segment, used for mechanical reference outlines
 * (e.g. display-glass and FPC-tail footprints drawn on the legend layer).
 */
export interface SilkLine {
  id: string;
  layer: 'F.Silk' | 'B.Silk';
  start: Point;
  end: Point;
  width: number;
}

/**
 * A linear dimension annotation between two measured points. Documentation
 * only — never affects DRC, routing, or fab outputs. The dimension line runs
 * parallel to a→b, displaced by `offset` mm along the left-hand perpendicular
 * of a→b (negative = right-hand side).
 */
export interface Dimension {
  id: string;
  a: Point;
  b: Point;
  offset: number;
}

export interface Board {
  formatVersion: 1;
  name: string;
  copperLayers: 2 | 4 | 6;
  outline: PathSeg[];
  keepouts: Keepout[];
  holes: MountingHole[];
  components: ComponentInst[];
  nets: Net[];
  netClasses: NetClass[];
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  silk: SilkText[];
  silkLines: SilkLine[];
  dimensions: Dimension[];
  rules: 'jlcpcb-2l' | 'jlcpcb-4l' | 'jlcpcb-6l';
}
