import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseInlineObj, parseModel } from '../src/viewer3d/models.js';

// A payload in the server's non-standard shape: inline `newmtl … endmtl`
// blocks (no mtllib), inverted `d`, and vertex-only faces with no normals.
const OBJ = `newmtl body
Ka 0 0 0
Kd 0.80 0.10 0.10
Ks 0.1 0.1 0.1
d 0.0
endmtl
newmtl pin
Kd 0.90 0.90 0.20
d 0.0
endmtl
o part
v 0 0 0
v 2 0 0
v 2 1 0
v 0 1 0
usemtl body
f 1// 2// 3//
f 1// 3// 4//
`;

describe('parseInlineObj', () => {
  it('lifts inline materials out and strips their blocks from the geometry text', () => {
    const { materials, geometryText } = parseInlineObj(OBJ);
    expect([...materials.keys()].sort()).toEqual(['body', 'pin']);
    // Kd -> diffuse color.
    const body = materials.get('body') as THREE.MeshStandardMaterial;
    expect(body.color.r).toBeCloseTo(0.8, 3);
    expect(body.color.g).toBeCloseTo(0.1, 3);
    // Material keywords must not survive into the geometry text.
    expect(geometryText).not.toMatch(/newmtl|endmtl|Kd |mtllib/);
    // Geometry lines are preserved.
    expect(geometryText).toMatch(/usemtl body/);
    expect(geometryText).toMatch(/^f 1\/\/ 2\/\/ 3\/\//m);
  });
});

describe('parseModel', () => {
  it('produces a mesh with computed normals and the parsed diffuse color', () => {
    const obj = parseModel(OBJ);
    let mesh: THREE.Mesh | null = null;
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    expect(mesh).not.toBeNull();
    const m = mesh!;
    expect(m.geometry.getAttribute('normal')).toBeTruthy();
    const mat = m.material as THREE.MeshStandardMaterial;
    expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(mat.color.r).toBeCloseTo(0.8, 3);
  });

  // Mirrors the real server payload: numeric material names, `newmtl` blocks
  // interleaved BETWEEN vertex lines, and two `usemtl` groups → a per-group
  // material array that must be colored element-by-element.
  it('colors each usemtl group of a multi-material mesh from its Kd', () => {
    const multi = `v 0 0 0
v 1 0 0
v 1 1 0
newmtl 1
Kd 0.0 0.0 0.0
d 0.0
endmtl
v 0 1 0
v 2 0 0
v 2 1 0
newmtl 2
Kd 0.9 0.9 0.2
d 0.0
endmtl
usemtl 1
f 1// 2// 3//
usemtl 2
f 1// 3// 4//
`;
    const obj = parseModel(multi);
    let mesh: THREE.Mesh | null = null;
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    const mats = (mesh!.material as THREE.MeshStandardMaterial[]);
    expect(Array.isArray(mats)).toBe(true);
    expect(mats).toHaveLength(2);
    expect(mats[0].color.getHex()).toBe(0x000000); // usemtl 1 = black
    expect(mats[1].color.r).toBeCloseTo(0.9, 3); // usemtl 2 = gold-ish
    expect(mats[1].color.b).toBeCloseTo(0.2, 3);
  });
});
