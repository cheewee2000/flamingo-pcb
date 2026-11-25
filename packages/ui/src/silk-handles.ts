/**
 * Flamingo UI - silk group transform handles.
 *
 * One definition of where a selected silk group's handles sit and which one
 * a pointer is on, shared by the 2D renderer (drawing), the select tool
 * (gestures) and the 3D viewer (picking). Handle sizes are given in screen
 * pixels and converted with the caller's px-per-mm scale, so they stay a
 * constant size on screen at any zoom.
 *
 *  - 4 corner handles: uniform resize, opposite corner anchored.
 *  - 1 rotate handle: a knob beyond the middle of the box's top edge.
 */

import type { Point, SilkGroup } from '@flamingo/engine';
import { dist, silkGroupCorners, silkGroupRotateHandle } from '@flamingo/engine';

/** Corner handle half-size, px. */
export const HANDLE_PX = 5;
/** Distance of the rotate knob beyond the top edge, px. */
export const ROTATE_OFFSET_PX = 22;
/** Rotate knob radius, px. */
export const ROTATE_RADIUS_PX = 5;

export type GroupHandle = { kind: 'corner'; index: number } | { kind: 'rotate' };

export interface GroupHandleGeometry {
  corners: Point[];
  /** Middle of the box's top edge (the rotate knob's stem starts here). */
  topMid: Point;
  rotate: Point;
}

/** World positions of every handle for `g` at `scale` px/mm. */
export function groupHandleGeometry(g: SilkGroup, scale: number): GroupHandleGeometry {
  const corners = silkGroupCorners(g);
  const topMid = { x: (corners[2]!.x + corners[3]!.x) / 2, y: (corners[2]!.y + corners[3]!.y) / 2 };
  return { corners, topMid, rotate: silkGroupRotateHandle(g, ROTATE_OFFSET_PX / scale) };
}

/** Which handle of `g` (if any) is under world point `p`, with a few px of slack. */
export function hitGroupHandle(g: SilkGroup, p: Point, scale: number): GroupHandle | null {
  const geo = groupHandleGeometry(g, scale);
  const slack = 3 / scale;
  if (dist(p, geo.rotate) <= ROTATE_RADIUS_PX / scale + slack) return { kind: 'rotate' };
  const half = HANDLE_PX / scale + slack;
  for (let i = 0; i < 4; i++) {
    const c = geo.corners[i]!;
    if (Math.abs(p.x - c.x) <= half && Math.abs(p.y - c.y) <= half) return { kind: 'corner', index: i };
  }
  return null;
}
