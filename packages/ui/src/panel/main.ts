/**
 * Flamingo panel view - entry point.
 *
 * A slicer-style plate: the panel is the build plate, board instances are the
 * objects. Click selects, drag moves (and pins), right-click opens the object
 * menu, scroll zooms, dragging empty space pans. A arranges, Delete removes,
 * Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes.
 *
 * The server owns the panel. This page sends ops and draws the views the
 * server pushes back; the only thing it keeps to itself is what is being
 * looked at (zoom, selection, a drag in progress).
 */

import './panel.css';
import type { Point } from '@flamingo/engine';
import type { PanelOp, PanelView, Scenario } from '@flamingo/panel';
import { fitToBoard, panBy, screenToWorld, worldToScreen, zoomAt } from '../view.js';
import { addBoard, api, isError, listBoards } from './api.js';
import { drawPlate } from './draw.js';
import { loadsOntoPanel, mm, previewLine, quoteKey } from './format.js';
import { OWN, buildOptions, rankOf, scenarioOnPlate } from './options.js';
import { DRAG_THRESHOLD_PX, contentBox, dropPosition, hitInstance, platePlaces, platesBox } from './hit.js';
import { createLoading } from './loading.js';
import { createSidebar } from './sidebar.js';
import { PanelStore, loadLook, saveLook, type QuoteSnapshot } from './store.js';
import { connectPanelWs } from './ws.js';

const WHEEL_ZOOM_PER_PX = 0.001;
const WHEEL_DELTA_CLAMP_PX = 400;
const LINE_DELTA_PX = 16;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const store = new PanelStore();
store.set({ look: loadLook() });
const plate = $('plate');
const canvas = $<HTMLCanvasElement>('plate-canvas');
const menuEl = $('context-menu');
const ctx = canvas.getContext('2d')!;

// ---------------------------------------------------------------------------
// Drawing: one paint per frame, however many state changes fall into it.
// ---------------------------------------------------------------------------

let cssWidth = 0;
let cssHeight = 0;
let dirty = false;

function resize(): void {
  const rect = plate.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cssWidth = rect.width;
  cssHeight = rect.height;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestDraw();
}

function requestDraw(): void {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(() => {
    dirty = false;
    drawPlate(ctx, store.get(), cssWidth, cssHeight);
  });
}

function fit(view: PanelView): void {
  store.set({
    transform: fitToBoard(store.get().transform, contentBox(view.geometry), cssWidth, cssHeight),
    hasFit: true,
  });
}

/** The scenario shown on the plate in place of the panel, if one is. */
function previewed(): Scenario | undefined {
  const { preview, quote } = store.get();
  return preview ? quote?.scenarios.find((s) => s.id === preview) : undefined;
}

/** Show the panel again. */
function leavePreview(): void {
  if (!store.get().preview) return;
  store.set({ preview: null, exportMsg: null });
  const view = store.get().view;
  if (view) fit(view);
}

/**
 * Fit the plate to a layout that was just replaced wholesale (arrange, a
 * scenario). The view carrying it may have arrived before the reply that
 * reports it, or may still be on its way: `since` is the revision the request
 * was made at.
 */
function fitNewLayout(since: number): void {
  const view = store.get().view;
  if (view && view.revision > since) fit(view);
  else store.set({ hasFit: false });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

let quotedFor = '';
let quoteSeq = 0;
let boardsFor = '';
/** The last quote that settled, so a change of quantities can be cancelled back to it. */
let settled: QuoteSnapshot | null = null;

function quantitiesOf(view: PanelView): QuoteSnapshot['quantities'] {
  return view.panel.sources.map((s) => ({ key: s.key, needed: s.needed }));
}

/** Is `view` the settled quote's panel with only its quantities changed? Then a cancel can put them back. */
function onlyQuantitiesChanged(view: PanelView, from: QuoteSnapshot): boolean {
  const restored = {
    ...view,
    panel: {
      ...view.panel,
      sources: view.panel.sources.map((s) => {
        const q = from.quantities.find((x) => x.key === s.key);
        return q ? { ...s, needed: q.needed } : s;
      }),
    },
  };
  return quoteKey(restored) === from.key && quoteKey(view) !== from.key;
}

/**
 * Stop waiting for the quote in flight, put the quantities back to what the
 * last settled quote was for, and show that quote's ways again.
 */
function cancelQuote(): void {
  const { quoting, view } = store.get();
  const previous = quoting?.previous;
  if (!previous || !view) return;
  quoteSeq++; // the answer on its way is for numbers nobody wants any more
  const ops: PanelOp[] = [];
  for (const q of previous.quantities) {
    const s = view.panel.sources.find((x) => x.key === q.key);
    if (s && s.needed !== q.needed) {
      ops.push({ op: 'setQuantity', key: q.key, needed: q.needed });
    }
  }
  if (ops.length > 0) send(ops.length === 1 ? ops[0]! : { op: 'transaction', ops });
  quotedFor = previous.key;
  store.set({ quote: previous.quote, quoteError: null, quoting: null, quoteRev: store.get().quoteRev + 1 });
}

/** List the project's board files again when the panel's boards have changed. */
function refreshBoardFiles(view: PanelView | null, force = false): void {
  const key = JSON.stringify(view?.panel.sources.map((s) => s.path) ?? null);
  if (!force && key === boardsFor) return;
  boardsFor = key;
  void listBoards().then((boardFiles) => store.set({ boardFiles }));
}

let curveFor = '';
let curveSeq = 0;

/**
 * Show the cost-by-quantity points the panel file already holds whenever the
 * boards, settings or quantities change, and which quantities are missing.
 * Nothing is priced here: that waits for `priceCurve`, so a change to the
 * panel never starts a job nobody asked for. Pricing in flight is dropped,
 * since what it was pricing may no longer be the panel.
 */
function refreshCurve(view: PanelView, force = false): void {
  const key = quoteKey(view);
  if (!force && key === curveFor) return;
  curveFor = key;
  const seq = ++curveSeq;
  if (store.get().curvePricing) store.set({ curvePricing: null });
  // The chart is for a panel of one design; with several there is nothing to fetch.
  if (view.panel.sources.length !== 1) {
    if (store.get().curve || store.get().curveError) store.set({ curve: null, curveError: null, curveRev: store.get().curveRev + 1 });
    return;
  }
  void (async () => {
    const r = await api.costCurve({ price: false });
    if (seq !== curveSeq) return;
    if (isError(r)) store.set({ curve: null, curveError: r.error, curveRev: store.get().curveRev + 1 });
    else store.set({ curve: r, curveError: null, curveRev: store.get().curveRev + 1 });
  })();
}

const CURVE_BATCH = 3;

/**
 * Price the missing quantities, a few at a time so the chart fills in and
 * the count moves while it runs. Each step is stored by the server, so a
 * stop or a reload keeps what was done.
 */
async function priceCurve(): Promise<void> {
  const { curve, curvePricing } = store.get();
  if (!curve || curvePricing || curve.missing.length === 0) return;
  const seq = ++curveSeq;
  const missing = [...curve.missing];
  store.set({ curvePricing: { done: 0, total: missing.length } });
  let points = curve.points;
  let impossible = curve.impossible;
  for (let i = 0; i < missing.length; i += CURVE_BATCH) {
    const batch = missing.slice(i, i + CURVE_BATCH);
    const r = await api.costCurve({ price: true, quantities: batch });
    if (seq !== curveSeq) return;
    if (isError(r)) {
      store.set({ curveError: r.error, curvePricing: null, curveRev: store.get().curveRev + 1 });
      return;
    }
    points = [...points, ...r.points].sort((a, b) => a.quantity - b.quantity);
    impossible = [...impossible, ...r.impossible].sort((a, b) => a.quantity - b.quantity);
    const done = Math.min(missing.length, i + batch.length);
    const left = missing.slice(done);
    store.set({
      curve: { ...curve, points, impossible, missing: left },
      curvePricing: { done, total: missing.length },
      curveRev: store.get().curveRev + 1,
    });
  }
  // The whole curve as the file now has it: entered quantities and all.
  const whole = await api.costCurve({ price: false });
  if (seq !== curveSeq) return;
  if (isError(whole)) store.set({ curveError: whole.error, curvePricing: null, curveRev: store.get().curveRev + 1 });
  else store.set({ curve: whole, curveError: null, curvePricing: null, curveRev: store.get().curveRev + 1 });
}

/** Stop pricing; what was priced so far stays on the chart and in the file. */
function stopPricing(): void {
  const view = store.get().view;
  if (!store.get().curvePricing || !view) return;
  refreshCurve(view, true);
}

/** Fetch the scenarios again when what they depend on has changed. */
function refreshQuote(view: PanelView): void {
  const key = quoteKey(view);
  if (key === quotedFor) return;
  quotedFor = key;
  const seq = ++quoteSeq;
  const quantities = quantitiesOf(view);
  // Cancelling makes sense only when the numbers are all that changed.
  const previous = settled && onlyQuantitiesChanged(view, settled) ? settled : null;
  store.set({ quoting: { since: Date.now(), previous } });
  void (async () => {
    const r = await api.quote();
    if (seq !== quoteSeq) return; // a newer request is on its way, or this one was cancelled
    if (isError(r)) {
      store.set({ quote: null, quoteError: r.error, quoting: null, quoteRev: store.get().quoteRev + 1, preview: null });
      return;
    }
    settled = { key, quote: r, quantities };
    // What was shown for comparison may not be among the new answers.
    const still = r.scenarios.some((s) => s.id === store.get().preview);
    const left = !still && store.get().preview !== null;
    store.set({ quote: r, quoteError: null, quoting: null, quoteRev: store.get().quoteRev + 1, ...(still ? {} : { preview: null }) });
    const view = store.get().view;
    if (left && view) fit(view);
  })();
}

const ws = connectPanelWs({
  onConnectionChange: (connected) => store.set({ connected }),
  onLoading: (loading) => store.set({ loading }),
  onOpResult: (result) => {
    if (!result.ok) store.set({ arrangeMsg: { text: result.error ?? 'Edit rejected', problem: true }, drag: null });
  },
  onView: (view) => {
    const state = store.get();
    if (state.view && view.revision < state.view.revision) return; // late arrival
    const drag = state.drag?.droppedAt !== undefined && view.revision > state.drag.droppedAt ? null : state.drag;
    const selection = view.panel.instances.some((i) => i.id === state.selection) ? state.selection : null;
    const menu = state.menu && view.panel.instances.some((i) => i.id === state.menu!.id) ? state.menu : null;
    // Another panel was opened or started: look at it afresh.
    const swapped = state.view !== null && state.view.filePath !== view.filePath;
    // The panel itself changed under a scenario that was being shown: show the
    // panel. A change to what is needed leaves the plate alone, and the list of
    // answers is worked out again.
    const edited =
      state.preview !== null &&
      state.view !== null &&
      JSON.stringify([view.panel.instances, view.panel.settings]) !== JSON.stringify([state.view.panel.instances, state.view.panel.settings]);
    store.set({
      view,
      drag,
      selection,
      menu,
      ...(swapped ? { hasFit: false, arrangeMsg: null, exportMsg: null, preview: null } : {}),
      ...(edited ? { hasFit: false, preview: null } : {}),
    });
    if (!store.get().hasFit && cssWidth > 0) fit(view);
    refreshQuote(view);
    refreshCurve(view);
    refreshBoardFiles(view);
  },
});

/** Send an op over the socket, or over HTTP if the socket is down. */
function send(op: PanelOp): void {
  if (ws.sendOp(op)) return;
  void (async () => {
    const r = await api.op(op);
    if (isError(r)) store.set({ arrangeMsg: { text: r.error, problem: true }, drag: null });
  })();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function arrange(): Promise<void> {
  const state = store.get();
  if (state.busy || !state.view || state.view.panel.instances.length === 0) return;
  store.set({ busy: true, menu: null });
  const since = state.view.revision;
  const r = await api.arrange();
  // An arrange that does not fit is an answer, not a failed request: it has a
  // `reason`, where a failed request has an `error`.
  if ('error' in r) {
    store.set({ busy: false, arrangeMsg: { text: r.error, problem: true } });
    return;
  }
  if (r.ok) {
    const skipped = r.skipped.length > 0 ? `\nSkipped (board unreadable): ${r.skipped.join(', ')}` : '';
    store.set({
      busy: false,
      arrangeMsg:
        r.placements.length === 0
          ? { text: `Nothing to arrange: every instance is pinned.${skipped}`, problem: false }
          : { text: `Arranged ${r.placements.length} instance${r.placements.length === 1 ? '' : 's'} into ${mm(r.width)} × ${mm(r.height)} mm.${skipped}`, problem: false },
    });
    if (r.placements.length > 0) fitNewLayout(since);
    return;
  }
  // The layout engine's reason usually names the smallest panel already.
  const smallest =
    r.smallestFit && !/smallest panel/i.test(r.reason)
      ? `\nSmallest panel that would fit: ${mm(r.smallestFit.width)} × ${mm(r.smallestFit.height)} mm.`
      : '';
  store.set({
    busy: false,
    arrangeMsg: { text: `Does not fit. ${r.reason}${smallest}\nNothing was moved.`, problem: true },
  });
}

async function setCount(board: string, count: number): Promise<void> {
  if (count < 0) return;
  const since = store.get().view?.revision ?? 0;
  const r = await api.count(board, count);
  if (isError(r)) {
    store.set({ arrangeMsg: { text: r.error, problem: true } });
    return;
  }
  if (r.arranged && !r.arranged.ok) {
    store.set({
      arrangeMsg: {
        text: `${r.added.join(', ')} added, but the panel no longer fits. ${r.arranged.reason}\nThe new instance sits at the origin: move it, or remove one.`,
        problem: true,
      },
    });
  } else {
    store.set({ arrangeMsg: null });
    // Adding arranges the panel, which may have outgrown the view.
    if (r.added.length > 0) fitNewLayout(since);
  }
}

/**
 * Add a board file to what is needed. Nothing is put on the plate: how the
 * board gets made is the next step's question, and its answers appear there.
 */
async function addBoardToPanel(path: string): Promise<void> {
  if (store.get().busy) return;
  store.set({ busy: true, boardMsg: null });
  const added = await addBoard(path);
  store.set({ busy: false, boardMsg: isError(added) ? { text: added.error, problem: true } : null });
}

async function refreshBoard(key: string): Promise<void> {
  if (store.get().busy) return;
  store.set({ busy: true, boardMsg: null });
  const r = await api.refresh([key]);
  store.set({ busy: false, boardMsg: isError(r) ? { text: r.error, problem: true } : null });
}

function removeSelected(): void {
  const id = store.get().selection;
  if (!id) return;
  send({ op: 'removeInstance', id });
  store.set({ selection: null, menu: null });
}

/** Pick one of the ways to order: it goes on the plate, or is shown there if it is not one panel. */
async function selectOption(id: string): Promise<void> {
  const { view, quote } = store.get();
  if (!view) return;
  store.set({ arrangeMsg: null, exportMsg: null, selection: null, menu: null, drag: null });
  // The panel that is already on the plate: look at it.
  if (id === OWN || scenarioOnPlate(view, quote)?.id === id) {
    leavePreview();
    return;
  }
  const scenario = quote?.scenarios.find((s) => s.id === id);
  if (!scenario) return;
  if (!loadsOntoPanel(scenario)) {
    // Not one panel, so there is nothing to load: the plate shows the orders
    // themselves, and the panel stays as it is underneath.
    store.set({ preview: id });
    const places = platePlaces(scenario.orders.map((o) => o.plate));
    store.set({ transform: fitToBoard(store.get().transform, platesBox(places), cssWidth, cssHeight), hasFit: true });
    return;
  }
  const layout = scenario.orders[0]!.layout!;
  const hadPanel = view.panel.instances.length > 0;
  const wasPreview = store.get().preview !== null;
  store.set({ preview: null });
  if (wasPreview) store.set({ hasFit: false });
  const since = view.revision;
  const r = await api.applyScenario(id);
  if (isError(r)) {
    store.set({ arrangeMsg: { text: r.error, problem: true } });
    return;
  }
  store.set({
    selection: null,
    arrangeMsg: {
      text:
        `Put on the plate: ${layout.instances.length} instance${layout.instances.length === 1 ? '' : 's'}, ${mm(layout.width)} × ${mm(layout.height)} mm.` +
        (hadPanel ? ' Ctrl/Cmd+Z brings the previous panel back.' : ''),
      problem: false,
    },
  });
  fitNewLayout(since);
}

let exportUrl: string | null = null;

async function exportFab(): Promise<void> {
  if (store.get().busy) return;
  const shown = previewed();
  store.set({ busy: true, exportMsg: { text: 'Exporting…', problem: false } });
  const r = await api.exportZip(shown?.id);
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  exportUrl = null;
  if (isError(r)) {
    const findings = (r.issues ?? []).map((i) => `— ${i.message}`).join('\n');
    store.set({
      busy: false,
      exportMsg: {
        text: shown
          ? `Not exported: ${r.error}.${findings ? `\n${findings}` : ''}\nFix them in the boards.`
          : `Not exported: ${r.error}.${findings ? `\n${findings}` : ''}\nFix the errors listed under Warnings. To export regardless, use export_panel_fab with waive.`,
        problem: true,
      },
    });
    return;
  }
  exportUrl = URL.createObjectURL(r.blob);
  // Start the download at once; the link in the message is for browsers that
  // only let a user gesture start one, and for fetching the same zip again.
  const a = document.createElement('a');
  a.href = exportUrl;
  a.download = r.name;
  a.click();
  store.set({
    busy: false,
    exportMsg: {
      text: shown
        ? `Exported: ${shown.orders.length} order${shown.orders.length === 1 ? '' : 's'}, a folder each with gerbers.zip, bom.csv, cpl.csv and a render; orders.txt has the quantities (${Math.max(1, Math.round(r.blob.size / 1024))} kB).`
        : `Exported: gerbers, drills, bom.csv, cpl.csv and a render, in one zip (${Math.max(1, Math.round(r.blob.size / 1024))} kB).`,
      problem: false,
      link: { href: exportUrl, name: r.name, label: `Download ${r.name} again` },
    },
  });
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function renderMenu(): void {
  const { menu, view } = store.get();
  const inst = menu && view ? view.panel.instances.find((i) => i.id === menu.id) : undefined;
  if (!menu || !inst) {
    menuEl.hidden = true;
    menuEl.innerHTML = '';
    return;
  }
  menuEl.innerHTML =
    `<div class="menu-title">${inst.id}</div>` +
    `<button type="button" role="menuitem" data-action="rotate">Rotate 90°</button>` +
    `<button type="button" role="menuitem" data-action="duplicate">Duplicate</button>` +
    `<button type="button" role="menuitem" data-action="delete">Delete</button>` +
    `<button type="button" role="menuitem" data-action="populate">${inst.populate ? 'Make bare' : 'Make populated'}</button>` +
    `<button type="button" role="menuitem" data-action="unpin" ${inst.pinned ? '' : 'disabled'}>Unpin</button>`;
  menuEl.hidden = false;
  // Keep the menu on the plate.
  const w = menuEl.offsetWidth;
  const h = menuEl.offsetHeight;
  menuEl.style.left = `${Math.max(0, Math.min(menu.x, cssWidth - w - 2))}px`;
  menuEl.style.top = `${Math.max(0, Math.min(menu.y, cssHeight - h - 2))}px`;
}

menuEl.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  const { menu, view } = store.get();
  if (!btn || btn.disabled || !menu || !view) return;
  const inst = view.panel.instances.find((i) => i.id === menu.id);
  store.set({ menu: null });
  if (!inst) return;
  switch (btn.dataset.action) {
    case 'rotate':
      void api.rotate(inst.id);
      break;
    case 'duplicate':
      void api.duplicate(inst.id);
      break;
    case 'delete':
      send({ op: 'removeInstance', id: inst.id });
      store.set({ selection: null });
      break;
    case 'populate':
      send({ op: 'setPopulate', id: inst.id, populate: !inst.populate });
      break;
    case 'unpin':
      send({ op: 'setPinned', id: inst.id, pinned: false });
      break;
  }
});
menuEl.addEventListener('contextmenu', (ev) => ev.preventDefault());

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

function plateXY(ev: MouseEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

interface Press {
  kind: 'instance' | 'plate';
  id?: string;
  start: Point;
  last: Point;
  moved: boolean;
}

let press: Press | null = null;

canvas.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  const state = store.get();
  const at = plateXY(ev);
  // A scenario on show is looked at, not edited: every press pans.
  const hit = state.view && !state.preview ? hitInstance(state.view.geometry, screenToWorld(state.transform, at)) : null;
  press = { kind: hit ? 'instance' : 'plate', ...(hit ? { id: hit.id } : {}), start: at, last: at, moved: false };
  store.set({ selection: hit ? hit.id : null, menu: null });
});

window.addEventListener('mousemove', (ev) => {
  const state = store.get();
  const at = plateXY(ev);
  const inside = at.x >= 0 && at.y >= 0 && at.x <= cssWidth && at.y <= cssHeight;
  if (!press) {
    const cursorMm = inside ? screenToWorld(state.transform, at) : null;
    if (cursorMm || state.cursorMm) store.set({ cursorMm });
    return;
  }
  if (!press.moved && Math.hypot(at.x - press.start.x, at.y - press.start.y) < DRAG_THRESHOLD_PX) return;
  press.moved = true;
  if (press.kind === 'plate') {
    canvas.style.cursor = 'grabbing';
    store.set({ transform: panBy(state.transform, at.x - press.last.x, at.y - press.last.y) });
  } else {
    canvas.style.cursor = 'move';
    store.set({
      drag: {
        id: press.id!,
        dx: (at.x - press.start.x) / state.transform.scale,
        dy: -(at.y - press.start.y) / state.transform.scale,
      },
      cursorMm: screenToWorld(state.transform, at),
    });
  }
  press.last = at;
});

window.addEventListener('mouseup', (ev) => {
  if (ev.button !== 0 || !press) return;
  const done = press;
  press = null;
  canvas.style.cursor = 'default';
  const state = store.get();
  if (done.kind !== 'instance' || !done.moved || !state.drag || !state.view) return;
  const inst = state.view.panel.instances.find((i) => i.id === done.id);
  if (!inst) {
    store.set({ drag: null });
    return;
  }
  // Dropping pins: arrange then leaves the instance where it was put.
  const at = dropPosition(inst.at, state.drag.dx, state.drag.dy);
  store.set({
    drag: { id: inst.id, dx: at.x - inst.at.x, dy: at.y - inst.at.y, droppedAt: state.view.revision },
    arrangeMsg: null,
  });
  send({ op: 'moveInstance', id: inst.id, at, pin: true });
});

canvas.addEventListener('mouseleave', () => {
  if (!press) store.set({ cursorMm: null });
});

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const state = store.get();
  const at = plateXY(ev);
  const hit = state.view && !state.preview ? hitInstance(state.view.geometry, screenToWorld(state.transform, at)) : null;
  store.set(hit ? { selection: hit.id, menu: { id: hit.id, x: at.x, y: at.y } } : { menu: null });
});

canvas.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    const raw = ev.deltaMode === 1 ? ev.deltaY * LINE_DELTA_PX : ev.deltaY;
    const px = Math.max(-WHEEL_DELTA_CLAMP_PX, Math.min(WHEEL_DELTA_CLAMP_PX, raw));
    store.set({ transform: zoomAt(store.get().transform, plateXY(ev), Math.exp(-px * WHEEL_ZOOM_PER_PX)), menu: null });
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

function typing(ev: KeyboardEvent): boolean {
  const el = ev.target;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Escape' && store.get().preview) {
    leavePreview();
    return;
  }
  if (ev.code === 'Escape') {
    if (press?.kind === 'instance') press = null;
    store.set({ menu: null, drag: null, selection: store.get().menu ? store.get().selection : null });
    canvas.style.cursor = 'default';
    return;
  }
  if (typing(ev)) return;

  if (ev.code === 'KeyZ' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    void (ev.shiftKey ? api.redo() : api.undo());
    return;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

  // Arrange and Delete act on the panel, which is not what a scenario on show is.
  if (store.get().preview) return;

  if (ev.code === 'KeyA') {
    ev.preventDefault();
    void arrange();
  } else if (ev.code === 'Delete' || ev.code === 'Backspace') {
    if (store.get().selection) {
      ev.preventDefault();
      removeSelected();
    }
  }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const renderSidebar = createSidebar(
  {
    panelName: $('panel-name'),
    panelFile: $('panel-file'),
    boardList: $('board-list'),
    boardAdd: $('board-add'),
    boardMsg: $('board-msg'),
    optionList: $('option-list'),
    costCurve: $('cost-curve'),
    plateTitle: $('plate-title'),
    plateMeaning: $('plate-meaning'),
    plateEdit: $('plate-edit'),
    plateCounts: $('plate-counts'),
    arrangeBtn: $<HTMLButtonElement>('arrange-btn'),
    arrangeMsg: $('arrange-msg'),
    costFlag: $('cost-flag'),
    costSummary: $('cost-summary'),
    checks: $('checks'),
    issueCount: $('issue-count'),
    issueList: $('issue-list'),
    exportBtn: $<HTMLButtonElement>('export-btn'),
    exportMsg: $('export-msg'),
    plateEmpty: $('plate-empty'),
    statusCursor: $('status-cursor'),
    statusZoom: $('status-zoom'),
    statusSize: $('status-size'),
    statusSelection: $('status-selection'),
    statusConn: $('status-conn'),
  },
  {
    setCount: (board, count) => void setCount(board, count),
    setQuantity: (board, needed) => send({ op: 'setQuantity', key: board, needed }),
    setAllQuantities: (needed) => {
      // The curve is "this many of each design", so a point on it means every design.
      const view = store.get().view;
      if (!view) return;
      const ops: PanelOp[] = view.panel.sources.filter((s) => s.needed !== needed).map((s) => ({ op: 'setQuantity', key: s.key, needed }));
      if (ops.length > 0) send(ops.length === 1 ? ops[0]! : { op: 'transaction', ops });
    },
    cancelQuote,
    priceCurve,
    stopPricing,
    selectOption: (id) => void selectOption(id),
    selectInstance: (id) => store.set({ selection: id, menu: null }),
    addBoard: (path) => void addBoardToPanel(path),
    refreshBoard: (key) => void refreshBoard(key),
  },
);

const renderLoading = createLoading($('plate-loading'));

// A board made in the editor since this page loaded should be on offer.
window.addEventListener('focus', () => refreshBoardFiles(store.get().view, true));

// The editor is at '/' only on a server started on a board, where this view is
// at /panel. On a server started on a panel file this view is the page at '/'.
const editorLink = document.querySelector<HTMLElement>('a.bar-link');
if (editorLink && !location.pathname.startsWith('/panel')) editorLink.hidden = true;

const banner = $('plate-banner');
function renderBanner(): void {
  const shown = previewed();
  banner.hidden = !shown;
  if (!shown) return;
  const { view, quote, preview } = store.get();
  const rank = view ? rankOf(buildOptions(view, quote, preview), shown.id) : 0;
  $('banner-title').textContent = previewLine(shown, rank);
  $('banner-note').textContent = 'Shown for comparison. Your panel is unchanged.';
}
$('banner-back').addEventListener('click', leavePreview);

// Layout / Fabricated. Only the drawing changes: selection, drag and menus work in both.
const lookButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#look-toggle button[data-look]'));
function renderLook(): void {
  for (const b of lookButtons) b.setAttribute('aria-pressed', String(b.dataset.look === store.get().look));
}
for (const b of lookButtons) {
  b.addEventListener('click', () => {
    const look = b.dataset.look === 'fab' ? 'fab' : 'layout';
    saveLook(look);
    store.set({ look });
  });
}
renderLook();

$('arrange-btn').addEventListener('click', () => void arrange());
$('export-btn').addEventListener('click', () => void exportFab());

store.subscribe((state, previous) => {
  requestDraw();
  renderSidebar(state);
  renderLoading(state);
  if (state.menu !== previous.menu || state.view !== previous.view) renderMenu();
  if (state.look !== previous.look) renderLook();
  if (state.preview !== previous.preview || state.quote !== previous.quote || state.view !== previous.view) renderBanner();
});

new ResizeObserver(() => {
  resize();
  const { view, hasFit } = store.get();
  if (view && !hasFit) fit(view);
}).observe(plate);
resize();
renderSidebar(store.get());
renderLoading(store.get());

// A read-only handle for scripted checks (packages/server/scripts/verify-panel-ui.ts):
// where things are on the plate cannot be read from the DOM, because the plate is a canvas.
declare global {
  interface Window {
    flamingoPanel?: {
      state: () => ReturnType<PanelStore['get']>;
      /** Plate pixel position of a panel position in mm. */
      toPlate: (p: Point) => Point;
    };
  }
}
window.flamingoPanel = {
  state: () => store.get(),
  toPlate: (p) => worldToScreen(store.get().transform, p),
};

// The canvas measures text with Space Mono: repaint once the font has loaded.
void document.fonts?.ready.then(requestDraw);
