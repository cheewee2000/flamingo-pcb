/**
 * Panel view - hit testing and drag arithmetic. Pure, so it can be tested
 * without a browser.
 */

import type { Point } from '@flamingo/engine';
import { pointInPolygon } from '@flamingo/engine';
import type { PanelGeometry, PlacedInstance } from '@flamingo/panel';
import type { Drag } from './store.js';

/** Positions are stored to a hundredth of a millimetre. */
export const POSITION_STEP_MM = 0.01;

/** A press turns into a drag once the pointer has moved this far, px. */
export const DRAG_THRESHOLD_PX = 3;

export function roundMm(n: number): number {
  const r = Math.round(n / POSITION_STEP_MM) * POSITION_STEP_MM;
  const fixed = Number(r.toFixed(2));
  return fixed === 0 ? 0 : fixed;
}

/** Where an instance is drawn: moved by the drag in progress, if it is the one dragged. */
export function dragOffset(id: string, drag: Drag | null): Point {
  return drag && drag.id === id ? { x: drag.dx, y: drag.dy } : { x: 0, y: 0 };
}

/** The instance under `world`, topmost first (instances are drawn in panel order). */
export function hitInstance(geometry: PanelGeometry, world: Point, drag: Drag | null = null): PlacedInstance | null {
  for (let i = geometry.instances.length - 1; i >= 0; i--) {
    const inst = geometry.instances[i]!;
    const off = dragOffset(inst.id, drag);
    const p = { x: world.x - off.x, y: world.y - off.y };
    const b = inst.bbox;
    if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue;
    if (pointInPolygon(p, inst.outline)) return inst;
  }
  return null;
}

/** The position to send when an instance at `at` is dropped after being dragged by (dx, dy). */
export function dropPosition(at: Point, dx: number, dy: number): Point {
  return { x: roundMm(at.x + dx), y: roundMm(at.y + dy) };
}

/** Box around everything worth seeing: the panel, or the default plate when it is empty. */
export function contentBox(geometry: PanelGeometry): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!geometry.frame) return { minX: 0, minY: 0, maxX: 100, maxY: 70 };
  const box = { ...geometry.frame.outer };
  for (const inst of geometry.instances) {
    for (const o of inst.overhangs) {
      for (const p of o.polygon) {
        box.minX = Math.min(box.minX, p.x);
        box.minY = Math.min(box.minY, p.y);
        box.maxX = Math.max(box.maxX, p.x);
        box.maxY = Math.max(box.maxY, p.y);
      }
    }
  }
  return box;
}

/** Gap between the plates of a scenario shown side by side, mm. */
export const PLATE_GAP_MM = 18;

export interface PlateSpot {
  /** Added to every point of the plate's geometry to put it in its place. */
  offset: Point;
  /** Where the plate's outline ends up. */
  box: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Places for the plates of a scenario: left to right in order, bottoms on one
 * line, the first with its corner at the origin.
 */
export function platePlaces(plates: Array<Pick<PanelGeometry, 'frame'>>, gap: number = PLATE_GAP_MM): PlateSpot[] {
  const out: PlateSpot[] = [];
  let x = 0;
  for (const p of plates) {
    const f = p.frame?.outer ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const w = f.maxX - f.minX;
    const h = f.maxY - f.minY;
    out.push({ offset: { x: x - f.minX, y: -f.minY }, box: { minX: x, minY: 0, maxX: x + w, maxY: h } });
    x += w + gap;
  }
  return out;
}

/**
 * Box around every plate, with room under each for its caption and above for
 * its quantity and the banner.
 */
export function platesBox(
  spots: PlateSpot[],
  below = 10,
  above = 22,
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (spots.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 70 };
  return {
    minX: Math.min(...spots.map((s) => s.box.minX)),
    minY: Math.min(...spots.map((s) => s.box.minY)) - below,
    maxX: Math.max(...spots.map((s) => s.box.maxX)) + 4,
    maxY: Math.max(...spots.map((s) => s.box.maxY)) + above,
  };
}
