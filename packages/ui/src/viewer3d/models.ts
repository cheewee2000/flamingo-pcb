/**
 * Flamingo 3D viewer — real component 3D models.
 *
 * Fetches the model manifest (GET /api/models) and, per component, loads the
 * part's OBJ (GET /api/model/{uuid}.obj) and places it. Parsed OBJ geometry is
 * cached per uuid and shared across every refdes that uses the same part.
 * Anything without a model — or before its OBJ has loaded, or if the endpoint
 * isn't deployed yet (404) — falls back to the courtyard-box heuristic.
 *
 * OBJ quirks (confirmed against real downloads from this server):
 *   - Materials are INLINE and non-standard: no `mtllib`; the file interleaves
 *     `newmtl N` … `endmtl` blocks (Ka/Kd/Ks/d) that three's OBJLoader ignores.
 *     We parse the `Kd` diffuse colors ourselves and feed them to the loader as
 *     a MaterialCreator shim, keyed by the `usemtl` names. `d` (opacity) is
 *     stored inverted upstream, so we ignore it and treat parts as opaque.
 *   - Faces are vertex-only (`f a// b// c//`) with NO `vn` normals, so we run
 *     computeVertexNormals() after parsing or the lighting is flat/broken.
 *   - Vertices are already in millimetres, model-local, +Z up — no scaling.
 *
 * Placement convention (see composeTransform): the manifest gives the model's
 * transform in *footprint-local* engine space (originMm/zMm/rotationDeg, the
 * same y-up mm space as the footprint's pads; rotationDeg is EasyEDA's euler,
 * separate from the OBJ's own Z-up frame). That is composed with the
 * component's placement (`at` / `rotation` / `side`) exactly the way engine
 * `componentTransformPoints` composes: mirror-x on the bottom side, rotate by
 * `rotation` (deg CCW about z), translate by `at`. The whole footprint-local
 * frame is lifted to the board's top face (or dropped under it and z-mirrored
 * for bottom parts). Rotation/side sign conventions are the parts most likely
 * to need tweaking against real models — each is a one-line change flagged
 * below.
 */

import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { Board, ComponentInst } from '@flamingo/engine';
import { BOARD_T, componentCourtyardBox } from './scene.js';

export interface ModelEntry {
  uuid: string;
  objUrl: string;
  originMm: { x: number; y: number };
  zMm: number;
  rotationDeg: { x: number; y: number; z: number };
}

const DEG = Math.PI / 180;
const NEUTRAL = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.6, metalness: 0.2 });

function deg(d: number): number {
  return d * DEG;
}

/**
 * Split the server's non-standard OBJ into (a) a name→material map parsed from
 * its inline `newmtl … endmtl` blocks, and (b) OBJ text with those blocks
 * stripped so OBJLoader sees only geometry + `usemtl` references.
 */
export function parseInlineObj(text: string): { materials: Map<string, THREE.Material>; geometryText: string } {
  const materials = new Map<string, THREE.Material>();
  const kept: string[] = [];
  let cur: { name: string; mat: THREE.MeshStandardMaterial } | null = null;

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('newmtl ')) {
      const name = t.slice(7).trim();
      const mat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.55, metalness: 0.3 });
      mat.name = name;
      cur = { name, mat };
      materials.set(name, mat);
      continue; // strip from geometry text
    }
    if (t === 'endmtl') {
      cur = null;
      continue;
    }
    if (cur) {
      // Inside a material block: consume Kd (diffuse). Ka/Ks/d are ignored
      // (d is stored inverted upstream, so opacity would be wrong).
      if (t.startsWith('Kd ')) {
        const [r, g, b] = t.slice(3).trim().split(/\s+/).map(Number);
        if ([r, g, b].every(Number.isFinite)) cur.mat.color.setRGB(r, g, b);
      }
      continue; // strip all in-block lines
    }
    if (t.startsWith('mtllib ')) continue; // no external mtl exists
    kept.push(line);
  }
  return { materials, geometryText: kept.join('\n') };
}

/**
 * Parse one OBJ payload into a colored, normal-computed Object3D.
 *
 * OBJLoader builds the geometry and (because the file has no `mtllib` and we
 * strip the inline `newmtl` blocks) leaves each `usemtl N` face group with a
 * placeholder material *named* `N`. We then swap each group's material for the
 * MeshStandardMaterial parsed from that block's `Kd`, keyed by name. A mesh
 * with several `usemtl` groups comes back with a material ARRAY (one entry per
 * geometry group, in group order), so we remap element-by-element by name.
 * This keys off names OBJLoader itself assigns rather than its `setMaterials`
 * hook, so the coloring never depends on loader-internal resolution.
 */
export function parseModel(text: string): THREE.Object3D {
  const { materials, geometryText } = parseInlineObj(text);
  const obj = new OBJLoader().parse(geometryText);
  const pick = (m: THREE.Material): THREE.Material => materials.get(m.name) ?? NEUTRAL;
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // OBJ has no normals — required for the standard-material lighting.
    if (mesh.geometry && !mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(pick) : pick(mesh.material);
  });
  return obj;
}

/**
 * Compose the footprint-local model transform with the component placement.
 * Nesting: `world (rotate+translate+lift) → mirror → model(rotate+translate)`.
 * three composes parent-onto-child, so a vertex is transformed by the model's
 * own rotation/offset first, then the mirror, then the component rotate+lift —
 * matching engine `componentTransformPoints` (mirror → rotate → translate).
 */
function composeTransform(obj: THREE.Object3D, entry: ModelEntry, comp: ComponentInst): THREE.Group {
  // model-local frame: EasyEDA euler ('XYZ' order verified against the SVGNODE
  // projection outlines — no axis flips needed).
  obj.rotation.set(deg(entry.rotationDeg.x), deg(entry.rotationDeg.y), deg(entry.rotationDeg.z), 'XYZ');
  // EasyEDA anchors the model by the CENTER of its rotated bbox at c_origin,
  // not by the model's local origin (many OBJs are off-center in their own
  // frame). Recenter x/y. Z: EasyEDA's `z` attr is where the model's BOTTOM
  // sits relative to the board face (0 = resting on it, negative = through-
  // hole legs penetrating), so rest the rotated bbox bottom at zMm — verified
  // against every cached part: nonzero z always equals the model's own zmin
  // (USB-C −0.85, battery holder −3.0), while centered z=0 bodies (0402s,
  // SOT-23s) must be lifted by −bb.min.z to sit on the surface.
  obj.position.set(0, 0, 0);
  obj.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(obj);
  obj.position.set(
    entry.originMm.x - (bb.min.x + bb.max.x) / 2,
    entry.originMm.y - (bb.min.y + bb.max.y) / 2,
    entry.zMm - bb.min.z,
  );

  const bottom = comp.side === 'bottom';
  // mirror x on the bottom side (same as pads); z-mirror drops the part to the
  // underside so its own +z still points away from the board.
  const mirror = new THREE.Group();
  mirror.scale.set(bottom ? -1 : 1, 1, bottom ? -1 : 1);
  mirror.add(obj);

  const world = new THREE.Group();
  world.add(mirror);
  world.rotation.z = deg(comp.rotation); // deg CCW about z
  world.position.set(comp.at.x, comp.at.y, bottom ? 0 : BOARD_T);
  return world;
}

export interface ModelManager {
  /**
   * Build a group of component bodies for `board`: real models where loaded,
   * courtyard boxes otherwise. Kicks off any missing OBJ loads; `onLoaded` is
   * called (debounce-and-rebuild upstream) whenever new geometry arrives.
   */
  build(board: Board, onLoaded: () => void): THREE.Group;
  dispose(): void;
}

export function createModelManager(): ModelManager {
  let manifest: Record<string, ModelEntry> | null = null;
  let manifestState: 'idle' | 'loading' | 'ready' | 'absent' = 'idle';
  const geomCache = new Map<string, THREE.Object3D>(); // uuid -> parsed OBJ (prototype)
  const loading = new Set<string>();
  let disposed = false;

  function ensureManifest(onLoaded: () => void): void {
    if (manifestState !== 'idle') return;
    manifestState = 'loading';
    void (async () => {
      try {
        const res = await fetch('/api/models');
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { models?: Record<string, ModelEntry> };
        manifest = body.models ?? {};
        manifestState = 'ready';
        if (!disposed) onLoaded();
      } catch {
        // Endpoint not deployed / errored: fall back to boxes for good.
        manifest = {};
        manifestState = 'absent';
      }
    })();
  }

  function ensureGeometry(entry: ModelEntry, onLoaded: () => void): void {
    if (geomCache.has(entry.uuid) || loading.has(entry.uuid)) return;
    loading.add(entry.uuid);
    void (async () => {
      try {
        const res = await fetch(entry.objUrl);
        if (!res.ok) throw new Error(String(res.status));
        const text = await res.text();
        if (disposed) return;
        geomCache.set(entry.uuid, parseModel(text));
        onLoaded();
      } catch {
        // Leave uncached: the component keeps its courtyard-box fallback.
      } finally {
        loading.delete(entry.uuid);
      }
    })();
  }

  function build(board: Board, onLoaded: () => void): THREE.Group {
    const root = new THREE.Group();
    ensureManifest(onLoaded);

    for (const comp of board.components) {
      const entry = manifest?.[comp.refdes];
      const proto = entry ? geomCache.get(entry.uuid) : undefined;
      if (entry && proto) {
        root.add(composeTransform(proto.clone(), entry, comp));
      } else {
        if (entry) ensureGeometry(entry, onLoaded);
        const box = componentCourtyardBox(comp);
        if (box) root.add(box);
      }
    }
    return root;
  }

  return {
    build,
    dispose(): void {
      disposed = true;
      for (const proto of geomCache.values()) {
        proto.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
        });
      }
      geomCache.clear();
    },
  };
}
