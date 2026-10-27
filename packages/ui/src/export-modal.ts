/**
 * Export modal (3D HUD "Export…", or E in the 2D or 3D view): STEP, STEP HD, DXF
 * and SVG from one dialog. Pick a format and a preset, toggle the board
 * elements to include, set the format's options, export.
 *
 * Talks to GET /api/export.{step|dxf|svg} (packages/server/src/http.ts) with
 * include/side/layers/units query params; the response is streamed so the
 * footer bar shows download progress once the server starts sending (it
 * sweeps while the server is still generating). The last-used settings are
 * kept in localStorage under `flamingo.export`.
 */

import type { Board } from '@flamingo/engine';
import { allHoles } from '@flamingo/engine';

type Format = 'step' | 'stephd' | 'dxf' | 'svg';
type Preset = 'mech' | 'encl' | 'full' | 'custom';
type Element = 'board' | 'comps' | 'vias' | 'pth' | 'mnt';
type Include = Record<Element, boolean>;
type Side = 'top' | 'bottom' | 'both';
type Layers = 'single' | 'layered';
type Units = 'mm' | 'in';
type Phase = 'idle' | 'exporting' | 'done' | 'error';

interface Settings {
  format: Format;
  preset: Preset;
  include: Include;
  side: Side;
  layers: Layers;
  units: Units;
}

interface ExportState extends Settings {
  phase: Phase;
  /** 0–100, or null while the server is still generating (indeterminate sweep). */
  progress: number | null;
  error?: string;
  result?: { filename: string; bytes: number };
}

const STORAGE_KEY = 'flamingo.export';

const FORMATS: Record<Format, { label: string; sub: string; ext: string }> = {
  step: { label: 'STEP', sub: 'Block bodies, fast', ext: 'step' },
  stephd: { label: 'STEP HD', sub: 'Real part models, copper, silk', ext: 'step' },
  dxf: { label: 'DXF', sub: 'Board + component outlines', ext: 'dxf' },
  svg: { label: 'SVG', sub: 'Outline drawing', ext: 'svg' },
};
const FORMAT_ORDER = Object.keys(FORMATS) as Format[];

const PRESETS: Record<Exclude<Preset, 'custom'>, { label: string; include: Include; hd: boolean; note: string }> = {
  mech: {
    label: 'Mechanical',
    include: { board: true, comps: false, vias: false, pth: true, mnt: true },
    hd: false,
    note: 'Bare board with holes. Smallest file.',
  },
  encl: {
    label: 'Enclosure fit',
    include: { board: true, comps: true, vias: false, pth: false, mnt: true },
    hd: false,
    note: 'Board plus part bounding blocks for fit checks.',
  },
  full: {
    label: 'Full visual',
    include: { board: true, comps: true, vias: true, pth: true, mnt: true },
    hd: true,
    note: 'All geometry. Slowest to generate.',
  },
};

const ELEMENTS: { key: Element; label3d: string; sub3d: string; label2d: string; sub2d: string }[] = [
  { key: 'board', label3d: 'Board body', sub3d: 'FR4 extrusion', label2d: 'Board outline', sub2d: 'Closed polyline, cutouts included' },
  { key: 'comps', label3d: 'Components', sub3d: 'Bounding blocks', label2d: 'Component outlines', sub2d: 'Body outline per part' },
  { key: 'vias', label3d: 'Vias', sub3d: 'Drilled barrels through board', label2d: 'Vias', sub2d: 'Drill circles' },
  { key: 'pth', label3d: 'Plated holes', sub3d: 'Through-hole pads + drills', label2d: 'Plated holes', sub2d: 'Drill circles' },
  { key: 'mnt', label3d: 'Mounting holes', sub3d: 'NPTH, cut through board', label2d: 'Mounting holes', sub2d: 'Drill circles' },
];

/** Board thickness the STEP writer extrudes (packages/server/src/viewer3d.ts BOARD_T). */
const BOARD_T_MM = 1.6;

const DEFAULTS: Settings = {
  format: 'step',
  preset: 'encl',
  include: { ...PRESETS.encl.include },
  side: 'top',
  layers: 'layered',
  units: 'mm',
};

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function loadSettings(): Settings {
  let raw: Partial<Settings> & { include?: Partial<Include> } = {};
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') ?? {};
  } catch {
    raw = {};
  }
  const include = { ...DEFAULTS.include };
  if (raw.include && typeof raw.include === 'object') {
    for (const e of ELEMENTS) if (typeof raw.include[e.key] === 'boolean') include[e.key] = raw.include[e.key]!;
  }
  return {
    format: oneOf(raw.format, FORMAT_ORDER, DEFAULTS.format),
    preset: oneOf(raw.preset, ['mech', 'encl', 'full', 'custom'] as const, DEFAULTS.preset),
    include,
    side: oneOf(raw.side, ['top', 'bottom', 'both'] as const, DEFAULTS.side),
    layers: oneOf(raw.layers, ['single', 'layered'] as const, DEFAULTS.layers),
    units: oneOf(raw.units, ['mm', 'in'] as const, DEFAULTS.units),
  };
}

function saveSettings(s: Settings): void {
  const { format, preset, include, side, layers, units } = s;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ format, preset, include, side, layers, units }));
  } catch {
    // Storage blocked (private window): settings just don't persist.
  }
}

const is3d = (f: Format): boolean => f === 'step' || f === 'stephd';

/** Same rule as the server's exportFileName (packages/server/src/export-opts.ts). */
function fileNameFor(boardName: string, s: Settings): string {
  const base = boardName.replace(/[^\w.-]+/g, '_') || 'board';
  let suffix: string;
  if (is3d(s.format)) suffix = s.format === 'stephd' ? '-hd' : '';
  else if (s.include.comps && !s.include.board) suffix = '-components';
  else if (s.include.comps) suffix = '-outline+components';
  else suffix = '-outline';
  return `${base}${suffix}.${FORMATS[s.format].ext}`;
}

function exportUrl(s: Settings): string {
  const ext = FORMATS[s.format].ext;
  const q = new URLSearchParams();
  if (s.format === 'stephd') q.set('detail', 'hd');
  q.set('include', ELEMENTS.filter((e) => s.include[e.key]).map((e) => e.key).join(','));
  if (is3d(s.format)) q.set('side', s.side);
  if (s.format === 'dxf') q.set('layers', s.layers);
  if (!is3d(s.format)) q.set('units', s.units);
  return `/api/export.${ext}?${q.toString()}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function elementCounts(board: Board | null): Record<Element, number> {
  if (!board) return { board: 0, comps: 0, vias: 0, pth: 0, mnt: 0 };
  let pth = 0;
  for (const c of board.components) for (const p of c.footprint.pads) if (p.drill) pth++;
  return {
    board: board.outline.length > 0 ? 1 : 0,
    comps: board.components.length,
    vias: board.vias.length,
    pth,
    mnt: allHoles(board).length,
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export interface ExportModalDeps {
  getBoard: () => Board | null;
  download: (blob: Blob, disposition: string, fallbackName: string) => void;
}

export interface ExportModal {
  open(): void;
  isOpen(): boolean;
}

export function createExportModal(deps: ExportModalDeps): ExportModal {
  let scrim: HTMLDivElement | null = null;
  let state: ExportState = { ...loadSettings(), phase: 'idle', progress: null };
  let abort: AbortController | null = null;
  // Kept across renders so the fill's width transition animates.
  const track = el('div', 'exp-track');
  const fill = el('div', 'exp-fill');
  track.append(fill);

  const set = (patch: Partial<ExportState>): void => {
    state = { ...state, ...patch };
    saveSettings(state);
    render();
  };

  // ---- actions ----

  function pickFormat(format: Format): void {
    set({ format, phase: 'idle', error: undefined });
  }

  function pickPreset(preset: Preset): void {
    if (preset === 'custom') {
      set({ preset });
      return;
    }
    const p = PRESETS[preset];
    // A preset picks STEP vs STEP HD when the format is 3D; 2D formats stay put.
    const format = is3d(state.format) ? (p.hd ? 'stephd' : 'step') : state.format;
    set({ preset, include: { ...p.include }, format, phase: 'idle', error: undefined });
  }

  function toggle(key: Element): void {
    set({ preset: 'custom', include: { ...state.include, [key]: !state.include[key] }, phase: 'idle', error: undefined });
  }

  function selectedCount(): number {
    return ELEMENTS.filter((e) => state.include[e.key]).length;
  }

  async function runExport(): Promise<void> {
    if (state.phase === 'exporting' || selectedCount() === 0) return;
    const board = deps.getBoard();
    const filename = fileNameFor(board?.name ?? 'board', state);
    const controller = new AbortController();
    abort = controller;
    set({ phase: 'exporting', progress: null, error: undefined, result: undefined });
    try {
      const res = await fetch(exportUrl(state), { signal: controller.signal });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? res.statusText);
      }
      const total = Number(res.headers.get('content-length') ?? 0);
      const chunks: BlobPart[] = [];
      let received = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
          if (pct !== null && pct !== state.progress) set({ progress: pct });
        }
      } else {
        const blob = await res.blob();
        chunks.push(blob);
        received = blob.size;
      }
      if (abort !== controller) return;
      const blob = new Blob(chunks, { type: res.headers.get('content-type') ?? 'application/octet-stream' });
      deps.download(blob, res.headers.get('content-disposition') ?? '', filename);
      abort = null;
      set({ phase: 'done', progress: 100, result: { filename, bytes: blob.size } });
    } catch (err) {
      if (controller.signal.aborted || abort !== controller) return; // cancelled: already back to idle
      abort = null;
      set({ phase: 'error', progress: null, error: `Export failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  function cancelExport(): void {
    const c = abort;
    abort = null;
    c?.abort();
    set({ phase: 'idle', progress: null });
  }

  function primary(): void {
    if (state.phase === 'done') close();
    else void runExport();
  }

  function secondary(): void {
    if (state.phase === 'exporting') cancelExport();
    else if (state.phase === 'done') set({ phase: 'idle', progress: null, result: undefined });
    else close();
  }

  // ---- open / close / keys ----

  function onKey(ev: KeyboardEvent): void {
    // The modal owns the keyboard while open: nothing reaches the editor's
    // tool shortcuts behind it (browser defaults like ⌘R still work).
    ev.stopPropagation();
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (state.phase !== 'exporting') close();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (state.phase !== 'exporting') primary();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (state.phase === 'exporting') return;
      const i = FORMAT_ORDER.indexOf(state.format);
      const next = FORMAT_ORDER[(i + (ev.key === 'ArrowDown' ? 1 : -1) + FORMAT_ORDER.length) % FORMAT_ORDER.length];
      pickFormat(next);
    }
  }

  function open(): void {
    if (scrim) return;
    state = { ...loadSettings(), phase: 'idle', progress: null };
    scrim = el('div', 'modal-scrim');
    scrim.addEventListener('click', (ev) => {
      if (ev.target === scrim && state.phase !== 'exporting') close();
    });
    document.body.appendChild(scrim);
    document.addEventListener('keydown', onKey, true);
    render();
  }

  function close(): void {
    if (!scrim) return;
    abort?.abort();
    abort = null;
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    scrim = null;
  }

  // ---- render (rebuilt on every state change; the modal is small) ----

  function render(): void {
    if (!scrim) return;
    const board = deps.getBoard();
    const boardName = board?.name ?? 'board';
    const counts = elementCounts(board);
    const three = is3d(state.format);
    const busy = state.phase === 'exporting';
    const n = selectedCount();
    const filename = fileNameFor(boardName, state);

    const modal = el('div', 'exp-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Export');

    // Header
    const head = el('div', 'exp-head');
    head.append(el('span', 'modal-title', `Export · ${boardName}`));
    const closeBtn = button('modal-close', '×', () => {
      if (!busy) close();
    });
    closeBtn.setAttribute('aria-label', 'Close');
    head.append(closeBtn);

    // Body
    const body = el('div', `exp-body${busy ? ' busy' : ''}`);
    const rail = el('div', 'exp-rail');
    rail.append(el('div', 'exp-label exp-rail-label', 'Format'));
    for (const f of FORMAT_ORDER) {
      const b = button(`exp-fmt${state.format === f ? ' active' : ''}`, '', () => pickFormat(f));
      b.setAttribute('aria-pressed', String(state.format === f));
      b.append(el('span', 'exp-fmt-title', FORMATS[f].label), el('span', 'exp-fmt-sub', FORMATS[f].sub));
      rail.append(b);
    }

    const main = el('div', 'exp-main');

    const presetSec = el('div', 'exp-section');
    presetSec.append(el('div', 'exp-label', 'Preset'));
    const presetRow = el('div', 'exp-presets');
    for (const p of ['mech', 'encl', 'full', 'custom'] as const) {
      const label = p === 'custom' ? 'Custom' : PRESETS[p].label;
      const b = button(`exp-preset${state.preset === p ? ' active' : ''}`, label, () => pickPreset(p));
      b.setAttribute('aria-pressed', String(state.preset === p));
      presetRow.append(b);
    }
    presetSec.append(presetRow, el('div', 'exp-note', state.preset === 'custom' ? 'Your own selection.' : PRESETS[state.preset].note));

    const incSec = el('div', 'exp-include');
    const incHead = el('div', 'exp-label exp-include-head');
    incHead.append(el('span', '', 'Include'), el('span', '', 'Count'));
    incSec.append(incHead);
    for (const e of ELEMENTS) {
      const on = state.include[e.key];
      const row = el('div', `exp-row${on ? ' on' : ''}`);
      row.setAttribute('role', 'checkbox');
      row.setAttribute('aria-checked', String(on));
      row.addEventListener('click', () => toggle(e.key));
      let sub = three ? e.sub3d : e.sub2d;
      if (three && e.key === 'board') sub = `${BOARD_T_MM} mm FR4 extrusion`;
      if (three && e.key === 'comps') sub = state.format === 'stephd' ? 'Real 3D models' : 'Bounding blocks';
      const text = el('span', 'exp-row-text');
      text.append(el('span', 'exp-row-label', three ? e.label3d : e.label2d), el('span', 'exp-row-sub', sub));
      row.append(el('span', 'exp-box'), text, el('span', 'exp-row-count', String(counts[e.key])));
      incSec.append(row);
    }

    const optSec = el('div', 'exp-section exp-options');
    optSec.append(el('div', 'exp-label', `${three ? 'STEP' : FORMATS[state.format].label} options`));
    const optRow = <T extends string>(label: string, choices: [T, string][], cur: T, pick: (v: T) => void): void => {
      const row = el('div', 'exp-opt');
      row.append(el('span', '', label));
      const seg = el('div', 'exp-seg');
      for (const [v, l] of choices) {
        const b = button(cur === v ? 'active' : '', l, () => pick(v));
        b.setAttribute('aria-pressed', String(cur === v));
        seg.append(b);
      }
      row.append(seg);
      optSec.append(row);
    };
    if (three) {
      optRow('Component side', [['top', 'Top'], ['bottom', 'Bottom'], ['both', 'Both']], state.side, (side) => set({ side }));
    } else {
      if (state.format === 'dxf') {
        optRow('Layers', [['single', 'One layer'], ['layered', 'Per element']], state.layers, (layers) => set({ layers }));
      }
      optRow('Units', [['mm', 'mm'], ['in', 'in']], state.units, (units) => set({ units }));
    }

    main.append(presetSec, incSec, optSec);
    body.append(rail, main);

    // Footer
    const foot = el('div', 'exp-foot');
    track.className = `exp-track${busy ? ' busy' : ''}${busy && state.progress === null ? ' sweep' : ''}`;
    fill.style.width = busy && state.progress !== null ? `${state.progress}%` : '';

    const bar = el('div', 'exp-foot-row');
    let statusText: string;
    let statusKind = '';
    let primaryLabel = `Export ${FORMATS[state.format].label}`;
    let secondaryLabel = 'Cancel';
    let primaryDisabled = false;
    if (state.phase === 'exporting') {
      statusText = `Generating ${filename}…${state.progress !== null ? ` ${state.progress}%` : ''}`;
      primaryLabel = 'Exporting…';
      primaryDisabled = true;
    } else if (state.phase === 'done' && state.result) {
      statusText = `Saved ${state.result.filename} · ${formatBytes(state.result.bytes)}`;
      statusKind = 'ok';
      primaryLabel = 'Close';
      secondaryLabel = 'Export another';
    } else if (state.phase === 'error') {
      statusText = state.error ?? 'Export failed';
      statusKind = 'err';
      primaryLabel = 'Retry';
      primaryDisabled = n === 0;
    } else if (n === 0) {
      statusText = 'Select at least one element to export';
      statusKind = 'err';
      primaryDisabled = true;
    } else {
      statusText = `${filename}  ·  ${n} of ${ELEMENTS.length} elements`;
    }
    const status = el('span', `exp-status${statusKind ? ` ${statusKind}` : ''}`, statusText);
    status.title = statusText;
    const secBtn = button('exp-btn', secondaryLabel, secondary);
    const priBtn = button('exp-btn primary', primaryLabel, primary);
    priBtn.disabled = primaryDisabled;
    bar.append(status, secBtn, priBtn);
    foot.append(track, bar);

    modal.append(head, body, foot);
    scrim.replaceChildren(modal);
  }

  return { open, isOpen: () => scrim !== null };
}
