/**
 * Flamingo 3D viewer - silk group editing.
 *
 * Makes silk groups selectable and editable in the 3D view with the same
 * gestures as the 2D select tool:
 *
 *  - Click a group's artwork to select it (shares `state.selection` with 2D,
 *    so the side panel, Delete, R, ⌘G/⌘⇧G all work while the 3D tab is up).
 *  - Drag a group to move it; drag a corner handle to resize (aspect locked);
 *    drag the knob to rotate (Shift snaps 15°).
 *  - Loose silk text / lines are selectable too (text can be dragged). A
 *    directly-hit loose item wins over a group's bounding box, and
 *    Cmd/Ctrl-click ignores groups entirely to reach whatever is underneath.
 *  - Anything else falls through to OrbitControls, so orbiting is unchanged.
 *
 * Picking casts the pointer ray onto the silk plane of the side the camera is
 * looking at; handles are tested in screen space so they stay grabbable at
 * any tilt. The transform maths is `groupGestureTransform` from the 2D select
 * tool, so a drag lands the same way in either view. The only state that
 * leaves this module is a single `editSilkGroup` op on release.
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Op, Point, SilkGroup } from '@flamingo/engine';
import { silkGroupContains, silkGroupSize, silkGroupWorld, silkTextCorners } from '@flamingo/engine';
import { hitEditTargets } from '../hit-test.js';
import type { AppState } from '../state.js';
import { SILK_KEY } from '../state.js';
import { groupHandleGeometry, HANDLE_PX, ROTATE_RADIUS_PX } from '../silk-handles.js';
import type { GroupGesture } from '../tools/select.js';
import { groupGestureTransform } from '../tools/select.js';
import { snapPoint } from '../tools/overlay-utils.js';
import { BOARD_T, disposeGroup, silkGroupFillShapes } from './scene.js';

export interface SilkEditHooks {
  getState(): AppState;
  setState(patch: Partial<AppState>): void;
  sendOp(op: Op): void;
}

export interface SilkEdit3D {
  /** Rebuild the selection frame/handles (selection, board or camera changed). */
  refresh(): void;
  /** World board point under a client-space position on the side facing the camera, or null. */
  pickBoardPoint(clientX: number, clientY: number): Point | null;
  dispose(): void;
}

const SELECT_COLOR = 0x4da6ff;
const DRAG_THRESHOLD_PX = 4;
const SILK_TOP_Z = BOARD_T + 0.09;
const SILK_BOT_Z = -0.095;

const silkZ = (layer: SilkGroup['layer']): number => (layer === 'B.Silk' ? SILK_BOT_Z : SILK_TOP_Z);

export function attachSilkEditing(opts: {
  canvas: HTMLCanvasElement;
  viewport: HTMLElement;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  scene: THREE.Scene;
  hooks: SilkEditHooks;
  isActive: () => boolean;
}): SilkEdit3D {
  const { canvas, viewport, camera, controls, scene, hooks, isActive } = opts;
  const overlay = new THREE.Group();
  overlay.renderOrder = 10;
  scene.add(overlay);
  const raycaster = new THREE.Raycaster();

  let gesture: (GroupGesture & { z: number }) | null = null;
  let preview: SilkGroup | null = null;
  let down: { x: number; y: number } | null = null;
  /** Loose silk text being dragged: start position and the live position. */
  let textDrag: { id: string; startAt: Point; startWorld: Point; z: number; at: Point } | null = null;

  const rect = (): DOMRect => canvas.getBoundingClientRect();

  function viewingTop(): boolean {
    return camera.position.z >= BOARD_T / 2;
  }

  function rayPoint(clientX: number, clientY: number, z: number): Point | null {
    const r = rect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
    return raycaster.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y } : null;
  }

  function toScreen(p: Point, z: number): Point {
    const v = new THREE.Vector3(p.x, p.y, z).project(camera);
    const r = rect();
    return { x: ((v.x + 1) / 2) * r.width + r.left, y: ((1 - v.y) / 2) * r.height + r.top };
  }

  /** Screen px per board mm around `p` (perspective: varies over the board, fine locally). */
  function pxPerMm(p: Point, z: number): number {
    const a = toScreen(p, z);
    const b = toScreen({ x: p.x + 1, y: p.y }, z);
    const c = toScreen({ x: p.x, y: p.y + 1 }, z);
    return Math.max(1e-3, (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - a.x, c.y - a.y)) / 2);
  }

  function selectedGroup(): SilkGroup | null {
    const s = hooks.getState();
    const sel = s.selection;
    if (!s.board || !sel || sel.kind !== 'silkGroup') return null;
    return (s.board.silkGroups ?? []).find((g) => g.id === sel.id) ?? null;
  }

  function silkVisible(): boolean {
    return hooks.getState().layerVisibility[SILK_KEY] !== false;
  }

  /** Which handle of `g` is under the client point, tested in screen space. */
  function handleAt(g: SilkGroup, clientX: number, clientY: number): { kind: 'corner'; index: number } | { kind: 'rotate' } | null {
    const z = silkZ(g.layer);
    const geo = groupHandleGeometry(g, pxPerMm(g.at, z));
    const near = (p: Point, r: number): boolean => {
      const s = toScreen(p, z);
      return Math.hypot(s.x - clientX, s.y - clientY) <= r + 4;
    };
    if (near(geo.rotate, ROTATE_RADIUS_PX)) return { kind: 'rotate' };
    for (let i = 0; i < 4; i++) if (near(geo.corners[i]!, HANDLE_PX)) return { kind: 'corner', index: i };
    return null;
  }

  /** Smallest group on the camera-facing silk layer under the client point. */
  function groupAt(clientX: number, clientY: number): SilkGroup | null {
    const board = hooks.getState().board;
    if (!board || !silkVisible()) return null;
    const layer = viewingTop() ? 'F.Silk' : 'B.Silk';
    const p = rayPoint(clientX, clientY, silkZ(layer));
    if (!p) return null;
    let best: SilkGroup | null = null;
    let bestArea = Infinity;
    for (const g of board.silkGroups ?? []) {
      if (g.layer !== layer || !silkGroupContains(g, p)) continue;
      const { width, height } = silkGroupSize(g);
      if (width * height < bestArea) {
        best = g;
        bestArea = width * height;
      }
    }
    return best;
  }

  /** Loose silk text or line on the camera-facing layer under the client point. */
  function looseSilkAt(clientX: number, clientY: number): { kind: 'silk' | 'silkLine'; id: string } | null {
    const s = hooks.getState();
    const board = s.board;
    if (!board || !silkVisible()) return null;
    const layer = viewingTop() ? 'F.Silk' : 'B.Silk';
    const z = silkZ(layer);
    const p = rayPoint(clientX, clientY, z);
    if (!p) return null;
    for (const h of hitEditTargets(board, p, pxPerMm(p, z), s.layerVisibility)) {
      if (h.kind === 'silk' && board.silk.find((t) => t.id === h.id)?.layer === layer) return h;
      if (h.kind === 'silkLine' && (board.silkLines ?? []).find((l) => l.id === h.id)?.layer === layer) return h;
    }
    return null;
  }

  // ---- overlay: selection frame + handles, and the live drag preview ----

  // Shared materials: refresh() runs on every camera change, so only
  // geometries are rebuilt (and disposed) per frame.
  const LINE_MAT = new THREE.LineBasicMaterial({ color: SELECT_COLOR, depthTest: false, transparent: true });
  const FILL_MAT = new THREE.MeshBasicMaterial({
    color: SELECT_COLOR,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const lineMat = (): THREE.LineBasicMaterial => LINE_MAT;

  function frameObjects(g: SilkGroup): THREE.Object3D[] {
    const z = silkZ(g.layer);
    const k = pxPerMm(g.at, z);
    const geo = groupHandleGeometry(g, k);
    const v = (p: Point): THREE.Vector3 => new THREE.Vector3(p.x, p.y, z);
    const out: THREE.Object3D[] = [];
    out.push(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(geo.corners.map(v)), lineMat()));
    out.push(new THREE.Line(new THREE.BufferGeometry().setFromPoints([v(geo.topMid), v(geo.rotate)]), lineMat()));
    const half = HANDLE_PX / k;
    for (const c of geo.corners) {
      const sq = [
        { x: c.x - half, y: c.y - half },
        { x: c.x + half, y: c.y - half },
        { x: c.x + half, y: c.y + half },
        { x: c.x - half, y: c.y + half },
      ];
      out.push(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(sq.map(v)), lineMat()));
    }
    const r = ROTATE_RADIUS_PX / k;
    const knob: THREE.Vector3[] = [];
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * Math.PI * 2;
      knob.push(v({ x: geo.rotate.x + r * Math.cos(t), y: geo.rotate.y + r * Math.sin(t) }));
    }
    out.push(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(knob), lineMat()));
    return out;
  }

  function previewObjects(g: SilkGroup): THREE.Object3D[] {
    const z = silkZ(g.layer) + (g.layer === 'B.Silk' ? -0.01 : 0.01);
    const mat = FILL_MAT;
    const out: THREE.Object3D[] = [];
    const shapes = silkGroupFillShapes(g);
    if (shapes.length) {
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shapes), mat);
      mesh.position.z = z;
      out.push(mesh);
    }
    const w = silkGroupWorld(g);
    const pts: THREE.Vector3[] = [];
    for (const l of w.lines) pts.push(new THREE.Vector3(l.start.x, l.start.y, z), new THREE.Vector3(l.end.x, l.end.y, z));
    if (pts.length) out.push(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat()));
    return out;
  }

  /** Outline of the selected loose text (at its live drag position) or line. */
  function looseFrameObjects(): THREE.Object3D[] {
    const s = hooks.getState();
    const sel = s.selection;
    if (!s.board || !sel) return [];
    if (sel.kind === 'silk') {
      const t = s.board.silk.find((x) => x.id === sel.id);
      if (!t) return [];
      const z = silkZ(t.layer);
      const at = textDrag && textDrag.id === t.id ? textDrag.at : t.at;
      const pts = silkTextCorners(at, t.height, t.rotation, t.text).map((p) => new THREE.Vector3(p.x, p.y, z));
      return [new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat())];
    }
    if (sel.kind === 'silkLine') {
      const l = (s.board.silkLines ?? []).find((x) => x.id === sel.id);
      if (!l) return [];
      const z = silkZ(l.layer);
      const pts = [new THREE.Vector3(l.start.x, l.start.y, z), new THREE.Vector3(l.end.x, l.end.y, z)];
      return [new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat())];
    }
    return [];
  }

  function refresh(): void {
    for (const child of [...overlay.children]) {
      overlay.remove(child);
      disposeGroup(child);
    }
    if (!silkVisible()) return;
    const loose = looseFrameObjects();
    if (loose.length) overlay.add(...loose);
    const g = preview ?? selectedGroup();
    if (!g) return;
    if (preview) overlay.add(...previewObjects(preview));
    overlay.add(...frameObjects(g));
  }

  // ---- pointer handling (capture phase on the viewport: runs before OrbitControls) ----

  function onPointerDown(ev: PointerEvent): void {
    if (!isActive() || ev.target !== canvas || ev.button !== 0) return;
    const sel = selectedGroup();
    const throughGroups = ev.metaKey || ev.ctrlKey;
    const handle = sel && !ev.shiftKey && !throughGroups ? handleAt(sel, ev.clientX, ev.clientY) : null;
    if (!handle) {
      const loose = looseSilkAt(ev.clientX, ev.clientY);
      if (loose) {
        ev.stopPropagation();
        ev.preventDefault();
        down = { x: ev.clientX, y: ev.clientY };
        hooks.setState({ selection: loose, silkSelection: [], multiSelection: [] });
        const t = loose.kind === 'silk' ? hooks.getState().board?.silk.find((x) => x.id === loose.id) : undefined;
        const z = t ? silkZ(t.layer) : 0;
        const start = t ? rayPoint(ev.clientX, ev.clientY, z) : null;
        if (t && start) {
          controls.enabled = false;
          textDrag = { id: t.id, startAt: t.at, startWorld: snapPoint(start, hooks.getState()), z, at: t.at };
          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
        }
        refresh();
        return;
      }
      if (throughGroups) return; // nothing loose here: orbit
    }
    let g: SilkGroup | null = null;
    let kind: GroupGesture['kind'] = 'move';
    let corner: number | undefined;
    if (sel && handle) {
      g = sel;
      kind = handle.kind;
      corner = handle.kind === 'corner' ? handle.index : undefined;
    } else {
      g = groupAt(ev.clientX, ev.clientY);
    }
    if (!g) return; // not on silk: let OrbitControls have it
    const z = silkZ(g.layer);
    const start = rayPoint(ev.clientX, ev.clientY, z);
    if (!start) return;
    ev.stopPropagation();
    ev.preventDefault();
    controls.enabled = false;
    down = { x: ev.clientX, y: ev.clientY };
    gesture = { id: g.id, kind, corner, start: g, startWorld: kind === 'move' ? snapPoint(start, hooks.getState()) : start, z };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(ev: PointerEvent): void {
    if (textDrag && down) {
      if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) <= DRAG_THRESHOLD_PX) return;
      const raw = rayPoint(ev.clientX, ev.clientY, textDrag.z);
      if (!raw) return;
      const w = snapPoint(raw, hooks.getState());
      textDrag.at = { x: textDrag.startAt.x + w.x - textDrag.startWorld.x, y: textDrag.startAt.y + w.y - textDrag.startWorld.y };
      refresh();
      return;
    }
    if (!gesture || !down) return;
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) <= DRAG_THRESHOLD_PX && !preview) return;
    const raw = rayPoint(ev.clientX, ev.clientY, gesture.z);
    if (!raw) return;
    const t = groupGestureTransform(gesture, snapPoint(raw, hooks.getState()), raw, ev.shiftKey);
    preview = { ...gesture.start, ...t };
    refresh();
  }

  function onPointerUp(ev: PointerEvent): void {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    controls.enabled = true;
    const gst = gesture;
    const moved = down !== null && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > DRAG_THRESHOLD_PX;
    if (textDrag) {
      const td = textDrag;
      textDrag = null;
      down = null;
      if (moved) hooks.sendOp({ op: 'editSilkText', id: td.id, text: { at: td.at } });
      refresh();
      return;
    }
    gesture = null;
    preview = null;
    down = null;
    if (!gst) return;
    if (moved) {
      const raw = rayPoint(ev.clientX, ev.clientY, gst.z);
      if (raw) {
        const t = groupGestureTransform(gst, snapPoint(raw, hooks.getState()), raw, ev.shiftKey);
        hooks.sendOp({ op: 'editSilkGroup', id: gst.id, group: t });
      }
    }
    hooks.setState({ selection: { kind: 'silkGroup', id: gst.id }, silkSelection: [], multiSelection: [] });
    refresh();
  }

  /** A plain click on bare board (no orbit drag) clears a silk selection. */
  function onClick(ev: MouseEvent): void {
    if (!isActive() || ev.target !== canvas) return;
    const s = hooks.getState();
    const sel = s.selection;
    if (!sel || (sel.kind !== 'silkGroup' && sel.kind !== 'silk' && sel.kind !== 'silkLine')) return;
    if (groupAt(ev.clientX, ev.clientY) === null && looseSilkAt(ev.clientX, ev.clientY) === null) hooks.setState({ selection: null, silkSelection: [] });
  }
  // Track click-vs-orbit for clicks OrbitControls receives (no gesture armed).
  let orbitDown: { x: number; y: number } | null = null;
  function onAnyDown(ev: PointerEvent): void {
    if (ev.target === canvas) orbitDown = { x: ev.clientX, y: ev.clientY };
  }
  function onAnyClick(ev: MouseEvent): void {
    if (orbitDown && Math.hypot(ev.clientX - orbitDown.x, ev.clientY - orbitDown.y) <= DRAG_THRESHOLD_PX) onClick(ev);
    orbitDown = null;
  }

  viewport.addEventListener('pointerdown', onPointerDown, { capture: true });
  canvas.addEventListener('pointerdown', onAnyDown);
  canvas.addEventListener('click', onAnyClick);
  controls.addEventListener('change', refresh);

  return {
    refresh,
    pickBoardPoint(clientX: number, clientY: number): Point | null {
      return rayPoint(clientX, clientY, viewingTop() ? SILK_TOP_Z : SILK_BOT_Z);
    },
    dispose(): void {
      viewport.removeEventListener('pointerdown', onPointerDown, { capture: true });
      canvas.removeEventListener('pointerdown', onAnyDown);
      canvas.removeEventListener('click', onAnyClick);
      controls.removeEventListener('change', refresh);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      scene.remove(overlay);
      disposeGroup(overlay);
      LINE_MAT.dispose();
      FILL_MAT.dispose();
    },
  };
}
