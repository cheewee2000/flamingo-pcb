/**
 * Server-side parsing + placement of EasyEDA OBJ component models, for the
 * detail STEP export. Mirrors the UI's loader (packages/ui/src/viewer3d/
 * models.ts) without three.js:
 *   - the OBJ interleaves non-standard inline `newmtl … endmtl` blocks; only
 *     `Kd` (diffuse) is read, `d` is inverted upstream and ignored.
 *   - faces are vertex-only (`f a// b// c//`), polygons fan-triangulated.
 *   - vertices are millimetres, model-local, +Z up.
 *
 * Placement composes exactly like the UI's composeTransform: EasyEDA euler
 * (XYZ order, z applied first — matching three.js) → recenter the rotated
 * bbox on originMm in x/y and rest its BOTTOM at zMm (EasyEDA's `z` attr is
 * the model-bottom height relative to the board face; through-hole legs give
 * it a negative value) → mirror x/z for bottom-side parts → component
 * rotation about z → translate to `at`, lifted to the board's top face.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export type Tri = [Vec3, Vec3, Vec3];

export interface MeshGroup {
  /** Kd diffuse 0..1, or null when the group has no parsed material. */
  color: [number, number, number] | null;
  tris: Tri[];
}

/** Parse one OBJ payload into per-`usemtl`-group triangle soups. */
export function parseObjMesh(text: string): MeshGroup[] {
  const verts: Vec3[] = [];
  const colors = new Map<string, [number, number, number]>();
  const groups = new Map<string, MeshGroup>();
  let curMtl: string | null = null; // inside a newmtl block
  let curGroup = ensureGroup('');

  function ensureGroup(name: string): MeshGroup {
    let g = groups.get(name);
    if (!g) {
      g = { color: null, tris: [] };
      groups.set(name, g);
    }
    return g;
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (curMtl !== null) {
      if (line === 'endmtl') {
        curMtl = null;
      } else if (line.startsWith('Kd ')) {
        const [r, g, b] = line.slice(3).trim().split(/\s+/).map(Number);
        if ([r, g, b].every(Number.isFinite)) colors.set(curMtl, [r, g, b]);
      }
      continue;
    }
    if (line.startsWith('newmtl ')) {
      curMtl = line.slice(7).trim();
      continue;
    }
    if (line.startsWith('v ')) {
      const [x, y, z] = line.slice(2).trim().split(/\s+/).map(Number);
      verts.push({ x, y, z });
    } else if (line.startsWith('usemtl ')) {
      curGroup = ensureGroup(line.slice(7).trim());
    } else if (line.startsWith('f ')) {
      const idx = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((tok) => {
          const i = Number(tok.split('/')[0]);
          return i > 0 ? i - 1 : verts.length + i;
        })
        .filter((i) => i >= 0 && i < verts.length);
      for (let i = 1; i + 1 < idx.length; i++) {
        curGroup.tris.push([verts[idx[0]], verts[idx[i]], verts[idx[i + 1]]]);
      }
    }
  }

  const out: MeshGroup[] = [];
  for (const [name, g] of groups) {
    if (g.tris.length === 0) continue;
    g.color = colors.get(name) ?? null;
    out.push(g);
  }
  return out;
}

export interface ModelPlacement {
  originMm: { x: number; y: number };
  zMm: number;
  rotationDeg: { x: number; y: number; z: number };
}

export interface ComponentPose {
  at: { x: number; y: number };
  /** deg CCW about z. */
  rotation: number;
  side: 'top' | 'bottom';
}

type M3 = [number, number, number, number, number, number, number, number, number];

/** three.js Euler 'XYZ': R = Rx·Ry·Rz (z applied to the vector first). */
function eulerXYZ(rx: number, ry: number, rz: number): M3 {
  const a = Math.cos(rx),
    b = Math.sin(rx),
    c = Math.cos(ry),
    d = Math.sin(ry),
    e = Math.cos(rz),
    f = Math.sin(rz);
  return [
    c * e,
    -c * f,
    d,
    a * f + b * e * d,
    a * e - b * f * d,
    -b * c,
    b * f - a * e * d,
    b * e + a * f * d,
    a * c,
  ];
}

function apply(m: M3, p: Vec3): Vec3 {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2] * p.z,
    y: m[3] * p.x + m[4] * p.y + m[5] * p.z,
    z: m[6] * p.x + m[7] * p.y + m[8] * p.z,
  };
}

const DEG = Math.PI / 180;

/**
 * Transform model-local triangle groups into board-world space. `boardT` is
 * the board thickness (top face height for top-side parts).
 */
export function placeMeshGroups(
  groups: MeshGroup[],
  placement: ModelPlacement,
  comp: ComponentPose,
  boardT: number,
): MeshGroup[] {
  const rot = eulerXYZ(placement.rotationDeg.x * DEG, placement.rotationDeg.y * DEG, placement.rotationDeg.z * DEG);

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity;
  const rotated = groups.map((g) => ({
    color: g.color,
    tris: g.tris.map((t) => {
      return t.map((p) => {
        const q = apply(rot, p);
        if (q.x < minX) minX = q.x;
        if (q.x > maxX) maxX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.y > maxY) maxY = q.y;
        if (q.z < minZ) minZ = q.z;
        return q;
      }) as Tri;
    }),
  }));
  if (!Number.isFinite(minX)) return [];

  const off = {
    x: placement.originMm.x - (minX + maxX) / 2,
    y: placement.originMm.y - (minY + maxY) / 2,
    z: placement.zMm - minZ,
  };
  const bottom = comp.side === 'bottom';
  const cr = Math.cos(comp.rotation * DEG);
  const sr = Math.sin(comp.rotation * DEG);
  const lift = bottom ? 0 : boardT;

  return rotated.map((g) => ({
    color: g.color,
    tris: g.tris.map((t) => {
      return t.map((q) => {
        let lx = q.x + off.x;
        const ly = q.y + off.y;
        let lz = q.z + off.z;
        if (bottom) {
          lx = -lx;
          lz = -lz;
        }
        return {
          x: cr * lx - sr * ly + comp.at.x,
          y: sr * lx + cr * ly + comp.at.y,
          z: lz + lift,
        };
      }) as Tri;
    }),
  }));
}
