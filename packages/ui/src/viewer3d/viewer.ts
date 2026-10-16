/**
 * Flamingo 3D viewer — WebGL controller.
 *
 * Owns the three.js renderer, camera, OrbitControls, lighting, and the render
 * loop for one <canvas>. The loop only runs while the 3D tab is active
 * (`setActive`) so the GPU is idle when the 2D view is showing. Board changes
 * arrive via `setBoard` and trigger a debounced scene rebuild — but only while
 * active; a rebuild is deferred until the tab is shown again otherwise.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Board } from '@flamingo/engine';
import { buildBoardGroup, disposeGroup } from './scene.js';
import { createModelManager } from './models.js';

const BG = 0x14161a;
const WHEEL_ROTATE_PER_PX = 0.005; // rad
const WHEEL_ZOOM_PER_PX = 0.003;
const WHEEL_LINE_PX = 16;
const WHEEL_DELTA_CLAMP_PX = 400;
const clampDelta = (v: number): number => Math.max(-WHEEL_DELTA_CLAMP_PX, Math.min(WHEEL_DELTA_CLAMP_PX, v));
const REBUILD_DEBOUNCE_MS = 140;

export interface Viewer3DOptions {
  showComponents: boolean;
  showSilk: boolean;
}

export interface Viewer3D {
  /** Show/hide the view. When shown, resumes the render loop and rebuilds if
   * the board changed while hidden; when hidden, stops the loop. */
  setActive(active: boolean): void;
  /** Feed the latest board; rebuilds (debounced) if currently active. */
  setBoard(board: Board | null): void;
  /** Re-frame the camera to fit the whole board (zoom-to-all). */
  frame(): void;
  setShowComponents(v: boolean): void;
  setShowSilk(v: boolean): void;
  /** Mirror the camera across the board plane so the 3D view follows the 2D
   * Front/Back toggle: back view looks at the bottom with X mirrored, same as
   * the flipped 2D render. Keeps the current zoom and tilt. */
  setFlipped(v: boolean): void;
  dispose(): void;
}

export function createViewer3D(canvas: HTMLCanvasElement, viewport: HTMLElement): Viewer3D {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);

  const camera = new THREE.PerspectiveCamera(40, 1, 1, 4000);
  camera.up.set(0, 0, 1);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enableZoom = false; // wheel is ours: scroll orbits, shift+scroll pans, pinch/ctrl+scroll dollies
  canvas.addEventListener('wheel', onWheel, { passive: false });

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  scene.add(new THREE.HemisphereLight(0xbfd0e0, 0x30281f, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(60, -80, 120);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x8899ff, 0.35);
  fill.position.set(-40, 60, -80);
  scene.add(fill);

  const models = createModelManager();

  let boardGroup: THREE.Group | null = null;
  let componentGroup: THREE.Group | null = null;
  let silkGroup: THREE.Group | null = null;

  let board: Board | null = null;
  let active = false;
  let dirty = false;
  let hasFramedOnce = false;
  let flipped = false;
  let lastBBox: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  let rafHandle = 0;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const opts: Viewer3DOptions = { showComponents: true, showSilk: true };

  function clearScene(): void {
    for (const g of [boardGroup, componentGroup]) {
      if (!g) continue;
      scene.remove(g);
      disposeGroup(g);
    }
    boardGroup = null;
    componentGroup = null;
    silkGroup = null;
  }

  function rebuild(): void {
    if (!board) {
      clearScene();
      return;
    }
    clearScene();
    const built = buildBoardGroup(board);
    boardGroup = built.group;
    silkGroup = built.silk;
    silkGroup.visible = opts.showSilk;
    scene.add(boardGroup);

    componentGroup = models.build(board, requestRebuildSoon);
    componentGroup.visible = opts.showComponents;
    scene.add(componentGroup);

    lastBBox = built.bbox;
    if (!hasFramedOnce) {
      frameCamera(built.bbox);
      hasFramedOnce = true;
    }
    dirty = false;
  }

  /** Model loads land asynchronously; coalesce their rebuilds. */
  function requestRebuildSoon(): void {
    if (!active) {
      dirty = true;
      return;
    }
    if (rebuildTimer !== undefined) return;
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      rebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  function frameCamera(bbox: { minX: number; minY: number; maxX: number; maxY: number }): void {
    const w = Math.max(bbox.maxX - bbox.minX, 1);
    const h = Math.max(bbox.maxY - bbox.minY, 1);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const span = Math.max(w, h);
    const side = flipped ? -1 : 1;
    camera.position.set(cx - 8 * side, cy - h * 0.75, (span * 1.05 + 20) * side);
    camera.up.set(0, 0, side);
    controls.target.set(cx, cy, 0);
    controls.update();
  }

  // Wheel gestures, mirroring the 2D view: plain two-finger scroll tumbles the
  // camera about the target (trackball-style, no pole limit — camera.up rolls
  // with it), shift+scroll pans in the camera plane, pinch (browsers deliver it
  // as wheel+ctrlKey) or cmd+scroll dollies. Camera is moved directly around
  // controls.target; OrbitControls re-reads the position each update, so its
  // drag handling keeps working alongside.
  const offset = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const tilt = new THREE.Quaternion();
  function onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const unit = ev.deltaMode === 1 ? WHEEL_LINE_PX : 1;
    const dx = clampDelta(ev.deltaX * unit);
    const dy = clampDelta(ev.deltaY * unit);
    offset.copy(camera.position).sub(controls.target);
    if (ev.ctrlKey || ev.metaKey) {
      offset.multiplyScalar(Math.exp(dy * WHEEL_ZOOM_PER_PX));
    } else if (ev.shiftKey) {
      // One screen pixel moves one world pixel at the target's depth.
      const perPx = (2 * offset.length() * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / canvas.clientHeight;
      axis.setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-dx * perPx);
      controls.target.add(axis);
      axis.setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * perPx);
      controls.target.add(axis);
    } else {
      spin.setFromAxisAngle(axis.setFromMatrixColumn(camera.matrix, 1), -dx * WHEEL_ROTATE_PER_PX);
      tilt.setFromAxisAngle(axis.setFromMatrixColumn(camera.matrix, 0), -dy * WHEEL_ROTATE_PER_PX);
      spin.multiply(tilt);
      offset.applyQuaternion(spin);
      camera.up.applyQuaternion(spin);
    }
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
    camera.updateMatrix();
  }

  function resize(): void {
    const rect = viewport.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const ro = new ResizeObserver(() => {
    if (active) resize();
  });
  ro.observe(viewport);

  function loop(): void {
    if (!active) {
      rafHandle = 0;
      return;
    }
    rafHandle = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  }

  return {
    setActive(next: boolean): void {
      if (next === active) return;
      active = next;
      if (active) {
        resize();
        if (dirty || !boardGroup) rebuild();
        if (!rafHandle) rafHandle = requestAnimationFrame(loop);
      } else if (rafHandle) {
        cancelAnimationFrame(rafHandle);
        rafHandle = 0;
      }
    },
    setBoard(next: Board | null): void {
      board = next;
      if (active) {
        // Debounce so a burst of ops collapses into one rebuild.
        if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
          rebuildTimer = undefined;
          rebuild();
        }, REBUILD_DEBOUNCE_MS);
      } else {
        dirty = true;
      }
    },
    /** Re-frame the camera to fit the whole board (zoom-to-all). */
    frame(): void {
      if (lastBBox) frameCamera(lastBBox);
    },
    setShowComponents(v: boolean): void {
      opts.showComponents = v;
      if (componentGroup) componentGroup.visible = v;
    },
    setShowSilk(v: boolean): void {
      opts.showSilk = v;
      if (silkGroup) silkGroup.visible = v;
    },
    setFlipped(v: boolean): void {
      if (v === flipped) return;
      flipped = v;
      camera.position.z *= -1;
      camera.up.z *= -1;
      controls.target.z *= -1;
      camera.lookAt(controls.target);
      camera.updateMatrix();
    },
    dispose(): void {
      active = false;
      if (rafHandle) cancelAnimationFrame(rafHandle);
      if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
      ro.disconnect();
      clearScene();
      models.dispose();
      canvas.removeEventListener('wheel', onWheel);
      controls.dispose();
      renderer.dispose();
    },
  };
}
