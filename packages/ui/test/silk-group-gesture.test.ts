import { describe, it, expect } from 'vitest';
import { newBoard, silkGroupCenter } from '@flamingo/engine';
import type { SilkGroup } from '@flamingo/engine';
import { groupGestureTransform, silkInBox } from '../src/tools/select.js';
import { hitGroupHandle, groupHandleGeometry } from '../src/silk-handles.js';

const g: SilkGroup = {
  id: 'G',
  name: 'g',
  layer: 'F.Silk',
  at: { x: 10, y: 10 },
  rotation: 0,
  scale: 1,
  fills: [[[{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }]]],
  lines: [],
  texts: [],
};

describe('silk group gestures (shared by 2D and 3D)', () => {
  it('move uses the snapped pointer delta', () => {
    const t = groupGestureTransform({ id: 'G', kind: 'move', start: g, startWorld: { x: 10, y: 10 } }, { x: 12.5, y: 9 }, { x: 12.43, y: 9.1 }, false);
    expect(t.at).toEqual({ x: 12.5, y: 9 });
  });

  it('corner drag scales about the opposite corner; rotate knob snaps with shift', () => {
    const corner = groupGestureTransform({ id: 'G', kind: 'corner', corner: 2, start: g, startWorld: { x: 12, y: 11 } }, { x: 0, y: 0 }, { x: 16, y: 13 }, false);
    expect(corner.scale).toBeCloseTo(2);
    const rot = groupGestureTransform({ id: 'G', kind: 'rotate', start: g, startWorld: { x: 10, y: 14 } }, { x: 0, y: 0 }, { x: 6, y: 10.3 }, true);
    expect(rot.rotation).toBe(90);
    expect(silkGroupCenter({ ...g, ...rot }).x).toBeCloseTo(10);
  });

  it('handles are hit in screen-constant sizes', () => {
    const scale = 20; // px per mm
    const geo = groupHandleGeometry(g, scale);
    expect(hitGroupHandle(g, geo.corners[1]!, scale)).toEqual({ kind: 'corner', index: 1 });
    expect(hitGroupHandle(g, geo.rotate, scale)).toEqual({ kind: 'rotate' });
    expect(hitGroupHandle(g, { x: 10, y: 10 }, scale)).toBeNull();
  });

  it('box selection collects silk text, lines and groups wholly inside', () => {
    const b = newBoard('t', 2);
    b.silkGroups = [g];
    b.silk.push({ id: 'T', layer: 'F.Silk', at: { x: 1, y: 1 }, text: 'x', height: 1, rotation: 0 });
    b.silkLines.push({ id: 'L', layer: 'F.Silk', start: { x: 0, y: 0 }, end: { x: 30, y: 0 }, width: 0.2 });
    expect(silkInBox(b, 0, 0, 13, 12).sort()).toEqual(['G', 'T']);
  });
});
