/**
 * Flamingo Panel - config file shapes.
 *
 * Every number that describes what JLCPCB accepts or charges lives in a JSON
 * file under `packages/panel/config/`, not in code. Each entry carries where
 * it came from and whether it was verified, so anything built on an
 * unverified number can be flagged as an estimate all the way up to the UI.
 */

import type { PanelSettings, Separation } from './types.js';

export interface Sourced<T> {
  value: T;
  /** URL the value was taken from, or `design-choice` for a Flamingo default. */
  source: string;
  /** true only when read from the cited JLCPCB /help/ article with WebFetch on `date`. */
  verified: boolean;
  /** ISO date of verification. */
  date?: string;
  note?: string;
}

export interface SizeRange {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}

export type AssemblyType = 'economic' | 'standard';

export interface AssemblyLimits {
  singleSize: Sourced<SizeRange>;
  panelSize: Sourced<SizeRange>;
  quantity: Sourced<{ min: number; max: number }>;
  layers: Sourced<number[]>;
  /** How many board sides this service places parts on. */
  sides: Sourced<1 | 2>;
  separations: Sourced<Separation[]>;
  railsRequired: Sourced<boolean>;
}

export interface PanelLimits {
  asOf: string;
  fab: {
    maxSize: Record<'2' | '4' | '6', Sourced<{ width: number; height: number }>>;
    minSize: Sourced<{ width: number; height: number }>;
    minSpacing: Sourced<number>;
    minNpthDiameter: Sourced<number>;
  };
  assembly: Record<AssemblyType, AssemblyLimits>;
  rails: {
    width: Sourced<number>;
    toolingHoleDiameter: Sourced<number>;
    toolingHoleCornerOffset: Sourced<number>;
    fiducialCopperDiameter: Sourced<number>;
    fiducialMaskDiameter: Sourced<number>;
    fiducialEdgeDistance: Sourced<number>;
    fiducialCornerOffset: Sourced<number>;
  };
  tabs: {
    width: Sourced<number>;
    pitch: Sourced<number>;
    maxLength: Sourced<number>;
    holeDiameter: Sourced<number>;
    holePitch: Sourced<number>;
    holeOverlap: Sourced<number>;
    minPerInstance: Sourced<number>;
    copperClearance: Sourced<number>;
  };
  blockedEdges: {
    overhangMargin: Sourced<number>;
    keepoutClearance: Sourced<number>;
    keepoutEdgeTolerance: Sourced<number>;
  };
  silkDivider: {
    maxDesigns: Sourced<number>;
    freeDesigns: Sourced<number>;
    lineWidth: Sourced<number>;
    minFillRatio: Sourced<number>;
  };
  vcut: {
    straightEdgeToEdge: Sourced<boolean>;
    minPanelSize: Sourced<{ width: number; height: number }>;
    maxPanelSize: Sourced<{ width: number; height: number }>;
    /** Closest two parallel score lines may be, mm. */
    minLineSpacing: Sourced<number>;
    maxLinesPerAxis: Sourced<number>;
    /** A board with a side under this, mm, costs extra to V-cut. */
    smallBoardSide: Sourced<number>;
    /** Copper to the score line's centre, mm. */
    copperClearance: Sourced<number>;
    minThickness: Sourced<number>;
    layers: Sourced<number[]>;
    allowNoRails: Sourced<boolean>;
    gerberLayer: Sourced<string>;
    label: Sourced<string>;
    lineWidth: Sourced<number>;
    labelHeight: Sourced<number>;
  };
}

/** Settings for a new panel, taken from the limits config. */
export function settingsFromLimits(limits: PanelLimits): PanelSettings {
  return {
    separation: 'mouse-bite',
    rails: { top: limits.rails.width.value, bottom: limits.rails.width.value, left: 0, right: 0 },
    spacing: 2,
    tabs: {
      width: limits.tabs.width.value,
      pitch: limits.tabs.pitch.value,
      maxLength: limits.tabs.maxLength.value,
      holeDiameter: limits.tabs.holeDiameter.value,
      holePitch: limits.tabs.holePitch.value,
      holeOverlap: limits.tabs.holeOverlap.value,
    },
    fiducials: {
      enabled: true,
      copperDiameter: limits.rails.fiducialCopperDiameter.value,
      maskDiameter: limits.rails.fiducialMaskDiameter.value,
      edgeDistance: limits.rails.fiducialEdgeDistance.value,
      cornerOffset: limits.rails.fiducialCornerOffset.value,
    },
    toolingHoles: {
      enabled: true,
      diameter: limits.rails.toolingHoleDiameter.value,
      cornerOffset: limits.rails.toolingHoleCornerOffset.value,
    },
    copperLayers: 'auto',
    rotationStep: 90,
  };
}

/** Walk a config object and collect every Sourced entry with its dotted path. */
export function listSourced(config: unknown, prefix = ''): Array<{ path: string; entry: Sourced<unknown> }> {
  const out: Array<{ path: string; entry: Sourced<unknown> }> = [];
  if (typeof config !== 'object' || config === null) return out;
  const obj = config as Record<string, unknown>;
  if ('value' in obj && 'source' in obj && 'verified' in obj) {
    out.push({ path: prefix, entry: obj as unknown as Sourced<unknown> });
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    out.push(...listSourced(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}
