import { describe, it, expect } from 'vitest';
import { parseObjMesh, placeMeshGroups } from '../src/objmesh.js';
import type { MeshGroup } from '../src/objmesh.js';

const BOARD_T = 1.6;

// Inline-material OBJ in the server's real shape: newmtl blocks between
// geometry, vertex-only faces, one quad (fan-triangulated) + one tri.
const OBJ = `newmtl body
Kd 0.10 0.20 0.30
d 0.0
endmtl
v 0 0 -1
v 2 0 -1
v 2 1 -1
v 0 1 -1
v 0 0 3
usemtl body
f 1// 2// 3// 4//
f 1// 2// 5//
`;

function allZ(groups: MeshGroup[]): number[] {
  return groups.flatMap((g) => g.tris.flat().map((p) => p.z));
}

describe('parseObjMesh', () => {
  it('parses vertices, fan-triangulates quads, and colors groups from Kd', () => {
    const groups = parseObjMesh(OBJ);
    expect(groups).toHaveLength(1);
    expect(groups[0].color).toEqual([0.1, 0.2, 0.3]);
    // quad -> 2 tris, plus the standalone tri
    expect(groups[0].tris).toHaveLength(3);
  });
});

describe('placeMeshGroups', () => {
  const placement = { originMm: { x: 0, y: 0 }, zMm: 0, rotationDeg: { x: 0, y: 0, z: 0 } };
  const top = { at: { x: 10, y: 20 }, rotation: 0, side: 'top' as const };

  it('rests the model bbox bottom at zMm on the board top face', () => {
    // Model spans z -1..3; zMm=0 must lift it so its bottom sits AT the board face.
    const placed = placeMeshGroups(parseObjMesh(OBJ), placement, top, BOARD_T);
    expect(Math.min(...allZ(placed))).toBeCloseTo(BOARD_T, 6);
    expect(Math.max(...allZ(placed))).toBeCloseTo(BOARD_T + 4, 6);
  });

  it('sinks through-hole legs by a negative zMm (USB-C case)', () => {
    const placed = placeMeshGroups(parseObjMesh(OBJ), { ...placement, zMm: -0.85 }, top, BOARD_T);
    expect(Math.min(...allZ(placed))).toBeCloseTo(BOARD_T - 0.85, 6);
  });

  it('recenters x/y on originMm and translates to the component position', () => {
    const placed = placeMeshGroups(parseObjMesh(OBJ), placement, top, BOARD_T);
    const xs = placed.flatMap((g) => g.tris.flat().map((p) => p.x));
    // model x span 0..2 recentered on origin 0 -> -1..1, then +10
    expect(Math.min(...xs)).toBeCloseTo(9, 6);
    expect(Math.max(...xs)).toBeCloseTo(11, 6);
  });

  it('mirrors x and z for bottom-side parts (model hangs under the board)', () => {
    const placed = placeMeshGroups(parseObjMesh(OBJ), placement, { ...top, side: 'bottom' }, BOARD_T);
    expect(Math.max(...allZ(placed))).toBeCloseTo(0, 6);
    expect(Math.min(...allZ(placed))).toBeCloseTo(-4, 6);
  });

  it('applies the component z-rotation after the euler', () => {
    const placed = placeMeshGroups(parseObjMesh(OBJ), placement, { ...top, rotation: 90 }, BOARD_T);
    const ys = placed.flatMap((g) => g.tris.flat().map((p) => p.y));
    // x span (-1..1) rotates into y about the component origin
    expect(Math.min(...ys)).toBeCloseTo(19, 6);
    expect(Math.max(...ys)).toBeCloseTo(21, 6);
  });
});
