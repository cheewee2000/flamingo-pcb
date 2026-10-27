/**
 * Flamingo Panel - create / serialize / parse.
 *
 * Mirrors the engine's board.ts: pretty-printed JSON with stable key order so
 * panel files diff cleanly, and a parser that validates shape and fills in
 * settings added after a file was written.
 */

import { parsePanelCurve } from './curve.js';
import { normalizeRotation } from './poly.js';
import type { Panel, PanelInstance, PanelSettings, PanelSource } from './types.js';

export const PANEL_EXTENSION = '.flamboyance';

/**
 * Settings a new panel starts with. The numbers mirror
 * `config/panel-limits.json` (`defaults`), which records where each one comes
 * from; `settingsFromLimits` builds settings from a loaded config instead.
 */
export const DEFAULT_SETTINGS: PanelSettings = {
  separation: 'mouse-bite',
  rails: { top: 5, bottom: 5, left: 0, right: 0 },
  spacing: 2,
  tabs: { width: 5, pitch: 50, maxLength: 8, holeDiameter: 0.6, holePitch: 1, holeOverlap: 1 / 3 },
  fiducials: { enabled: true, copperDiameter: 1, maskDiameter: 2, edgeDistance: 3.85, cornerOffset: 10 },
  toolingHoles: { enabled: true, diameter: 2, cornerOffset: 5 },
  copperLayers: 'auto',
  rotationStep: 90,
};

export function newPanel(name: string, settings: PanelSettings = DEFAULT_SETTINGS): Panel {
  return {
    formatVersion: 1,
    kind: 'flamingo-panel',
    name,
    sources: [],
    instances: [],
    settings: structuredClone(settings),
  };
}

export function serializePanel(p: Panel): string {
  return JSON.stringify(p, null, 2);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Overlay `patch` on `base`, one level deep into nested settings groups. */
export function mergeSettings(base: PanelSettings, patch: unknown): PanelSettings {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  if (!isObject(patch)) return out as unknown as PanelSettings;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in out)) continue; // unknown keys are dropped, not carried along
    const cur = out[k];
    if (isObject(cur) && isObject(v)) {
      const group = { ...cur };
      for (const [gk, gv] of Object.entries(v)) if (gk in group) group[gk] = gv;
      out[k] = group;
    } else if (!isObject(cur) && v !== undefined) {
      out[k] = v;
    }
  }
  return out as unknown as PanelSettings;
}

/** A packer step: a divisor of 360 between 1 and 180 degrees. */
export function isRotationStep(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 180) return false;
  const n = 360 / v;
  return Math.abs(n - Math.round(n)) < 1e-9;
}

/**
 * What is wrong with `s`, or null. Shared by the ops and the file parser, so a
 * hand-edited file cannot carry a value an op would refuse: a zero or
 * non-finite pitch would otherwise reach the tab layout and never finish.
 */
export function validateSettings(s: PanelSettings): string | null {
  const nonNeg = (v: number, name: string): string | null =>
    Number.isFinite(v) && v >= 0 ? null : `${name} must be a number >= 0`;
  const pos = (v: number, name: string): string | null =>
    Number.isFinite(v) && v > 0 ? null : `${name} must be a number > 0`;
  if (!['mouse-bite', 'solid-tab', 'silk-divider', 'v-cut'].includes(s.separation)) {
    return 'separation must be "mouse-bite", "solid-tab", "silk-divider" or "v-cut"';
  }
  if (s.copperLayers !== 'auto' && ![2, 4, 6].includes(s.copperLayers)) {
    return 'copperLayers must be "auto", 2, 4 or 6';
  }
  if (!isRotationStep(s.rotationStep)) return 'rotationStep must divide 360 evenly and be at least 1 degree';
  if (typeof s.fiducials.enabled !== 'boolean') return 'fiducials.enabled must be a boolean';
  if (typeof s.toolingHoles.enabled !== 'boolean') return 'toolingHoles.enabled must be a boolean';
  if (!(s.tabs.holeOverlap >= 0 && s.tabs.holeOverlap <= 0.5)) return 'tabs.holeOverlap must be between 0 and 0.5';
  return (
    nonNeg(s.rails.top, 'rails.top') ??
    nonNeg(s.rails.bottom, 'rails.bottom') ??
    nonNeg(s.rails.left, 'rails.left') ??
    nonNeg(s.rails.right, 'rails.right') ??
    pos(s.spacing, 'spacing') ??
    pos(s.tabs.width, 'tabs.width') ??
    pos(s.tabs.pitch, 'tabs.pitch') ??
    pos(s.tabs.maxLength, 'tabs.maxLength') ??
    pos(s.tabs.holeDiameter, 'tabs.holeDiameter') ??
    pos(s.tabs.holePitch, 'tabs.holePitch') ??
    pos(s.fiducials.copperDiameter, 'fiducials.copperDiameter') ??
    pos(s.fiducials.maskDiameter, 'fiducials.maskDiameter') ??
    nonNeg(s.fiducials.edgeDistance, 'fiducials.edgeDistance') ??
    nonNeg(s.fiducials.cornerOffset, 'fiducials.cornerOffset') ??
    pos(s.toolingHoles.diameter, 'toolingHoles.diameter') ??
    nonNeg(s.toolingHoles.cornerOffset, 'toolingHoles.cornerOffset')
  );
}

/**
 * Parse and validate a panel file. Throws with a message naming the first
 * problem found. Settings missing from the file take their defaults, so panels
 * written before a setting existed still load.
 */
export function parsePanel(json: string): Panel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(parsed)) throw new Error('Panel must be a JSON object');
  if (parsed.kind !== 'flamingo-panel') {
    throw new Error('Not a panel file: missing "kind": "flamingo-panel"');
  }
  if (parsed.formatVersion !== 1) {
    throw new Error(`Unsupported formatVersion: ${String(parsed.formatVersion)}. Expected 1.`);
  }
  if (typeof parsed.name !== 'string') throw new Error('Missing required field: name');
  if (!Array.isArray(parsed.sources)) throw new Error('Field "sources" must be an array');
  if (!Array.isArray(parsed.instances)) throw new Error('Field "instances" must be an array');

  const sources: PanelSource[] = parsed.sources.map((raw, i) => {
    if (!isObject(raw)) throw new Error(`sources[${i}] must be an object`);
    // An old file may carry a `niceToHave` quantity; it is ignored and not written back.
    const { key, path, hash, name, needed } = raw;
    if (typeof key !== 'string' || key === '') throw new Error(`sources[${i}].key must be a non-empty string`);
    if (typeof path !== 'string' || path === '') throw new Error(`sources[${i}].path must be a non-empty string`);
    if (typeof hash !== 'string') throw new Error(`sources[${i}].hash must be a string`);
    if (!isCount(needed)) throw new Error(`sources[${i}].needed must be a non-negative integer`);
    return {
      key,
      path,
      hash,
      name: typeof name === 'string' ? name : key,
      needed,
    };
  });
  const keys = new Set<string>();
  for (const s of sources) {
    if (keys.has(s.key)) throw new Error(`Duplicate source key "${s.key}"`);
    keys.add(s.key);
  }

  const instances: PanelInstance[] = parsed.instances.map((raw, i) => {
    if (!isObject(raw)) throw new Error(`instances[${i}] must be an object`);
    const { id, source, at, rotation, pinned, populate } = raw;
    if (typeof id !== 'string' || id === '') throw new Error(`instances[${i}].id must be a non-empty string`);
    if (typeof source !== 'string' || !keys.has(source)) {
      throw new Error(`instances[${i}] ("${id}") refers to unknown source "${String(source)}"`);
    }
    if (!isObject(at) || typeof at.x !== 'number' || typeof at.y !== 'number') {
      throw new Error(`instances[${i}] ("${id}").at must be {x, y}`);
    }
    if (typeof rotation !== 'number' || !Number.isFinite(rotation)) {
      throw new Error(`instances[${i}] ("${id}").rotation must be a number of degrees`);
    }
    return {
      id,
      source,
      at: { x: at.x, y: at.y },
      rotation: normalizeRotation(rotation),
      pinned: pinned === true,
      populate: populate !== false,
    };
  });
  const ids = new Set<string>();
  for (const inst of instances) {
    if (ids.has(inst.id)) throw new Error(`Duplicate instance id "${inst.id}"`);
    ids.add(inst.id);
  }

  const settings = mergeSettings(DEFAULT_SETTINGS, parsed.settings);
  const problem = validateSettings(settings);
  if (problem) throw new Error(`settings: ${problem}`);

  // The stored cost curve is a cache: one that does not parse is dropped, never a reason to refuse the file.
  const curve = parsePanelCurve(parsed.curve);
  return {
    formatVersion: 1,
    kind: 'flamingo-panel',
    name: parsed.name,
    sources,
    instances,
    settings,
    ...(curve ? { curve } : {}),
  };
}
