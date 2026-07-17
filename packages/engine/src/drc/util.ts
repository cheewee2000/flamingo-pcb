/**
 * Small geometry helpers shared by the DRC orchestrator and checks. Split
 * out from drc.ts (which imports every check module) so checks can depend
 * on these without an import cycle.
 */
import type { Point } from '../types.js';

/** Tessellated circle polygon, centered at `center`, radius `r`. */
export function circlePolygon(center: Point, r: number, segments = 24): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}
