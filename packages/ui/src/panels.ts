/**
 * Flamingo UI - side panels + status bar.
 *
 * Pure DOM wiring: reads `store` for data, writes `store.set(...)` for user
 * actions (checkbox toggle, net click), and never touches the canvas.
 * Rebuilds the layer/net/board-info lists only when the board reference
 * actually changes (cheap at hobby scale, and avoids nuking scroll position
 * or checkbox focus on every mousemove-driven state update); the selected-net
 * highlight and the status bar update unconditionally on every state change.
 */

import type { LayerId } from '@flamingo/engine';
import { copperLayersOf } from '@flamingo/engine';
import {
  LABEL_NETS_KEY,
  LABEL_PADS_KEY,
  RATSNEST_KEY,
  SILK_KEY,
  ZONES_KEY,
  store,
  withLayerKeys,
  type AppState,
  type HitInfo,
  type ToolOptions,
} from './state.js';
import type { ToolManager } from './tools/manager.js';

export interface PanelEls {
  layerList: HTMLElement;
  netList: HTMLElement;
  boardInfo: HTMLElement;
  sideBadge: HTMLElement;
  statusCursor: HTMLElement;
  statusZoom: HTMLElement;
  statusHover: HTMLElement;
  statusConn: HTMLElement;
  statusMeasure: HTMLElement;
  toolButtons: HTMLElement;
  toolOptions: HTMLElement;
  snapToggle: HTMLInputElement;
  undoBtn: HTMLButtonElement;
  redoBtn: HTMLButtonElement;
  routeBtn: HTMLButtonElement;
  routeStatus: HTMLElement;
  bomList: HTMLElement;
  propsPanel: HTMLElement;
  projectName: HTMLElement;
  openBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
}

/** Actions the panels trigger that need canvas/view access (owned by main.ts). */
export interface PanelActions {
  focusComponent(refdes: string): void;
  /** Called after /api/open succeeds: refetch the board and refit the view. */
  boardOpened(): void;
}

// Swatch colors for the two label pseudo-layers, matching the overlay colors in
// packages/engine/src/render.ts (PAD_LABEL_COLOR / NET_LABEL_COLOR).
const LABEL_SWATCH: Record<string, string> = {
  [LABEL_PADS_KEY]: '#22D3EE',
  [LABEL_NETS_KEY]: '#FACC15',
};

// COPIED from packages/engine/src/render.ts's LAYER_COLORS (binding table).
// Keep in sync by hand; exported so packages/ui/test/consistency.test.ts can
// assert this stays equal to the engine's LAYER_COLORS (drift insurance for
// the hand-kept-in-sync copy).
export const LAYER_SWATCH_COLORS: Record<string, string> = {
  'F.Cu': '#C83434',
  'In1.Cu': '#7FC87F',
  'In2.Cu': '#CE7D2C',
  'In3.Cu': '#9C6BC8',
  'In4.Cu': '#C8B96B',
  'B.Cu': '#4D7FC4',
};

function layerSwatchColor(key: string): string {
  return LAYER_SWATCH_COLORS[key] ?? '#999';
}

function hoverText(hit: HitInfo): string {
  if (hit.kind === 'pad') return `${hit.refdes}.${hit.padNumber}  net:${hit.net}`;
  if (hit.kind === 'track') return `track  net:${hit.net}`;
  return `via  net:${hit.net}`;
}

/** Wire the layer list, net list, BOM, properties, board-info panel, toolbar, and status bar to `store`. */
export function initPanels(els: PanelEls, toolManager: ToolManager, actions: PanelActions): void {
  let lastBoard: AppState['board'] = null;
  let lastToolOptionsTool: string | null = null;
  let lastSelection: AppState['selection'] = null;
  let lastPropsBoard: AppState['board'] = null;
  const netRows = new Map<string, HTMLElement>();
  const bomRowsByRefdes = new Map<string, HTMLElement>();
  let measureReadoutEl: HTMLElement | null = null;

  function buildLayerList(state: AppState): void {
    els.layerList.replaceChildren();
    const board = state.board;
    if (!board) return;
    const keys = [...copperLayersOf(board), ZONES_KEY, SILK_KEY, RATSNEST_KEY, LABEL_PADS_KEY, LABEL_NETS_KEY];
    store.set({ layerVisibility: withLayerKeys(state.layerVisibility, keys) });
    const vis = store.get().layerVisibility;

    for (const key of keys) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = vis[key] !== false;
      cb.addEventListener('change', () => {
        store.set({ layerVisibility: { ...store.get().layerVisibility, [key]: cb.checked } });
      });
      const swatch = document.createElement('span');
      swatch.className = 'layer-swatch';
      swatch.style.background =
        LABEL_SWATCH[key] ??
        (key === SILK_KEY || key === RATSNEST_KEY || key === ZONES_KEY ? '#888' : layerSwatchColor(key));
      const text = document.createElement('span');
      text.textContent = key;
      label.append(cb, swatch, text);
      els.layerList.appendChild(label);
    }
  }

  function buildNetList(state: AppState): void {
    els.netList.replaceChildren();
    netRows.clear();
    const board = state.board;
    if (!board) return;
    const names = board.nets.map((n) => n.name).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const row = document.createElement('div');
      row.className = 'net-list-item';
      row.textContent = name;
      row.addEventListener('click', () => {
        const cur = store.get().selectedNet;
        store.set({ selectedNet: cur === name ? null : name });
      });
      els.netList.appendChild(row);
      netRows.set(name, row);
    }
  }

  function buildBoardInfo(state: AppState): void {
    els.boardInfo.replaceChildren();
    const board = state.board;
    if (!board) return;
    const rows: [string, string][] = [
      ['name', board.name],
      ['layers', String(board.copperLayers)],
      ['rules', board.rules],
      ['components', String(board.components.length)],
      ['nets', String(board.nets.length)],
      ['tracks', String(board.tracks.length)],
      ['vias', String(board.vias.length)],
      ['unrouted', String(state.ratsnestLines.length)],
    ];
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      const kSpan = document.createElement('span');
      kSpan.textContent = k;
      const vSpan = document.createElement('span');
      vSpan.textContent = v;
      div.append(kSpan, vSpan);
      els.boardInfo.appendChild(div);
    }
  }

  // ---------------------------------------------------------------------------
  // BOM: components grouped by part (LCSC id, falling back to footprint name).
  // Clicking a refdes chip selects that component and centers the view on it.
  // ---------------------------------------------------------------------------

  function refdesCompare(a: string, b: string): number {
    const ma = a.match(/^([A-Za-z]+)(\d+)$/);
    const mb = b.match(/^([A-Za-z]+)(\d+)$/);
    if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
    return a.localeCompare(b);
  }

  function buildBom(state: AppState): void {
    els.bomList.replaceChildren();
    bomRowsByRefdes.clear();
    const board = state.board;
    if (!board) return;

    interface BomLine {
      key: string;
      lcsc: string;
      title: string;
      refs: string[];
    }
    const lines = new Map<string, BomLine>();
    for (const c of board.components) {
      const key = c.lcsc || c.footprint.name || c.refdes;
      let line = lines.get(key);
      if (!line) {
        const title = c.fields.value || c.fields.package || c.footprint.name || key;
        line = { key, lcsc: c.lcsc, title, refs: [] };
        lines.set(key, line);
      }
      line.refs.push(c.refdes);
    }
    const sorted = [...lines.values()].sort((a, b) => refdesCompare(a.refs[0], b.refs[0]));

    for (const line of sorted) {
      line.refs.sort(refdesCompare);
      const row = document.createElement('div');
      row.className = 'bom-row';

      const head = document.createElement('div');
      head.className = 'bom-row-head';
      const title = document.createElement('span');
      title.className = 'bom-title';
      title.textContent = line.title;
      title.title = line.lcsc ? `${line.title} · ${line.lcsc}` : line.title;
      const qty = document.createElement('span');
      qty.className = 'bom-qty';
      qty.textContent = `×${line.refs.length}`;
      head.append(title, qty);

      const refs = document.createElement('div');
      refs.className = 'bom-refs';
      for (const refdes of line.refs) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'bom-ref';
        chip.textContent = refdes;
        chip.addEventListener('click', () => actions.focusComponent(refdes));
        refs.appendChild(chip);
        bomRowsByRefdes.set(refdes, chip);
      }

      row.append(head, refs);
      els.bomList.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Properties: key/value rows for the current edit selection.
  // ---------------------------------------------------------------------------

  function propsRows(state: AppState): Array<[string, string]> | null {
    const board = state.board;
    const sel = state.selection;
    if (!board || !sel) return null;
    switch (sel.kind) {
      case 'component': {
        const c = board.components.find((x) => x.refdes === sel.refdes);
        if (!c) return null;
        const rows: Array<[string, string]> = [['refdes', c.refdes]];
        if (c.fields.value) rows.push(['value', c.fields.value]);
        if (c.fields.package) rows.push(['package', c.fields.package]);
        if (c.footprint.name && c.footprint.name !== c.fields.package) rows.push(['footprint', c.footprint.name]);
        if (c.lcsc) rows.push(['lcsc', c.lcsc]);
        if (c.fields.mfr) rows.push(['mfr', c.fields.mfr]);
        rows.push(
          ['side', c.side],
          ['at', `${c.at.x.toFixed(2)}, ${c.at.y.toFixed(2)} mm`],
          ['rotation', `${c.rotation}°`],
          ['pads', String(c.footprint.pads.length)],
        );
        return rows;
      }
      case 'track': {
        const t = board.tracks.find((x) => x.id === sel.id);
        if (!t) return null;
        return [
          ['type', 'track'],
          ['net', t.net],
          ['layer', t.layer],
          ['width', `${t.width} mm`],
        ];
      }
      case 'via': {
        const v = board.vias.find((x) => x.id === sel.id);
        if (!v) return null;
        return [
          ['type', 'via'],
          ['net', v.net],
          ['at', `${v.at.x.toFixed(2)}, ${v.at.y.toFixed(2)} mm`],
          ['size', `${v.diameter} / ${v.drill} mm`],
        ];
      }
      case 'zone': {
        const z = board.zones.find((x) => x.id === sel.id);
        if (!z) return null;
        return [
          ['type', 'zone'],
          ['net', z.net],
          ['layer', z.layer],
        ];
      }
      case 'keepout':
        return [['type', 'keepout'], ['id', sel.id]];
      case 'hole': {
        const h = board.holes.find((x) => x.id === sel.id);
        if (!h) return null;
        const rows: Array<[string, string]> = [
          ['type', h.plated ? 'plated hole' : 'hole'],
          ['at', `${h.at.x.toFixed(2)}, ${h.at.y.toFixed(2)} mm`],
          ['drill', `${h.drill} mm`],
        ];
        if (h.plated) rows.push(['pad', `${h.padDiameter} mm`]);
        return rows;
      }
      case 'silk': {
        const s = board.silk.find((x) => x.id === sel.id);
        if (!s) return null;
        return [
          ['type', 'silk text'],
          ['text', s.text],
          ['layer', s.layer],
          ['at', `${s.at.x.toFixed(2)}, ${s.at.y.toFixed(2)} mm`],
        ];
      }
    }
  }

  function buildProps(state: AppState): void {
    els.propsPanel.replaceChildren();
    const rows = propsRows(state);
    if (!rows) {
      const hint = document.createElement('div');
      hint.className = 'props-empty';
      hint.textContent = 'nothing selected';
      els.propsPanel.appendChild(hint);
      return;
    }
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      div.className = 'props-row';
      const kSpan = document.createElement('span');
      kSpan.textContent = k;
      const vSpan = document.createElement('span');
      vSpan.textContent = v;
      vSpan.title = v;
      div.append(kSpan, vSpan);
      els.propsPanel.appendChild(div);
    }
    const sel = state.selection;
    if (sel && sel.kind === 'component') {
      const c = state.board?.components.find((x) => x.refdes === sel.refdes);
      // Plain-English "what this part is for on this board" (fields.role),
      // then the LCSC catalog text for what the part is (fields.description).
      if (c?.fields.role) {
        const role = document.createElement('div');
        role.className = 'props-role';
        role.textContent = c.fields.role;
        els.propsPanel.appendChild(role);
      }
      if (c?.fields.description && c.fields.description !== c.fields.value) {
        const desc = document.createElement('div');
        desc.className = 'props-desc';
        desc.textContent = c.fields.description;
        els.propsPanel.appendChild(desc);
      }
      const center = document.createElement('button');
      center.type = 'button';
      center.className = 'props-center';
      center.textContent = 'center in view →';
      center.addEventListener('click', () => actions.focusComponent(sel.refdes));
      els.propsPanel.appendChild(center);
    }
  }

  function updateSelection(state: AppState): void {
    for (const [name, row] of netRows) {
      row.classList.toggle('selected', state.selectedNet === name);
    }
    const selRefdes = state.selection?.kind === 'component' ? state.selection.refdes : null;
    for (const [refdes, chip] of bomRowsByRefdes) {
      chip.classList.toggle('selected', refdes === selRefdes);
    }
  }

  function updateStatusBar(state: AppState): void {
    els.statusCursor.textContent = state.cursorMm
      ? `x: ${state.cursorMm.x.toFixed(2)} y: ${state.cursorMm.y.toFixed(2)}`
      : 'x: -- y: --';
    els.statusZoom.textContent = `${state.view.scale.toFixed(1)} px/mm`;
    els.statusHover.textContent = state.hover ? hoverText(state.hover) : '';
    els.statusMeasure.textContent = state.measureMm !== null ? `measure: ${state.measureMm.toFixed(2)} mm` : '';
    els.statusConn.textContent = state.connected ? 'connected' : 'disconnected';
    els.statusConn.classList.toggle('connected', state.connected);
    els.statusConn.classList.toggle('disconnected', !state.connected);
    els.sideBadge.hidden = !state.view.flipped;
  }

  // ---------------------------------------------------------------------------
  // Toolbar (Task 10): tool buttons, per-tool options row, snap toggle, undo/redo.
  // ---------------------------------------------------------------------------

  function buildToolButtons(): void {
    els.toolButtons.replaceChildren();
    for (const tool of toolManager.tools) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-btn';
      btn.dataset.toolId = tool.id;
      btn.title = `${tool.label} (${tool.shortcut})`;
      btn.textContent = `${tool.label} (${tool.shortcut})`;
      btn.addEventListener('click', () => toolManager.setActive(tool.id));
      els.toolButtons.appendChild(btn);
    }
  }

  function updateToolButtons(state: AppState): void {
    for (const btn of Array.from(els.toolButtons.children)) {
      if (btn instanceof HTMLElement) {
        btn.classList.toggle('active', btn.dataset.toolId === state.activeTool);
      }
    }
  }

  /** Keep zoneLayer/zoneNet pointed at a value that actually exists on the current board. */
  function syncToolOptionDefaults(state: AppState): void {
    const board = state.board;
    if (!board) return;
    const layers = copperLayersOf(board);
    const nets = board.nets.map((n) => n.name);
    const cur = state.toolOptions;
    const patch: Partial<ToolOptions> = {};
    if (!layers.includes(cur.zoneLayer)) patch.zoneLayer = layers[0];
    if (!nets.includes(cur.zoneNet)) patch.zoneNet = nets[0] ?? '';
    if (Object.keys(patch).length > 0) {
      store.set({ toolOptions: { ...cur, ...patch } });
    }
  }

  function setToolOptions(patch: Partial<ToolOptions>): void {
    store.set({ toolOptions: { ...store.get().toolOptions, ...patch } });
  }

  function buildToolOptions(state: AppState): void {
    els.toolOptions.replaceChildren();
    measureReadoutEl = null;
    const board = state.board;
    const opts = state.toolOptions;

    switch (state.activeTool) {
      case 'outline': {
        const row = document.createElement('div');
        row.className = 'tool-options-row';
        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.gap = '4px';
        for (const mode of ['rect', 'polygon'] as const) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'tool-suboption' + (opts.outlineMode === mode ? ' active' : '');
          btn.textContent = mode;
          btn.addEventListener('click', () => setToolOptions({ outlineMode: mode }));
          buttons.appendChild(btn);
        }
        row.appendChild(buttons);
        const hint = document.createElement('div');
        hint.className = 'tool-hint';
        hint.textContent = 'Rect: drag corners (Shift = square). Polygon: click points, Enter/dblclick closes.';
        row.appendChild(hint);
        els.toolOptions.appendChild(row);
        break;
      }
      case 'zone': {
        if (!board) break;
        const row = document.createElement('div');
        row.className = 'tool-options-row';

        const layerLabel = document.createElement('label');
        layerLabel.textContent = 'layer';
        const layerSel = document.createElement('select');
        for (const l of copperLayersOf(board)) {
          const o = document.createElement('option');
          o.value = l;
          o.textContent = l;
          o.selected = l === opts.zoneLayer;
          layerSel.appendChild(o);
        }
        layerSel.addEventListener('change', () => setToolOptions({ zoneLayer: layerSel.value as LayerId }));
        layerLabel.appendChild(layerSel);

        const netLabel = document.createElement('label');
        netLabel.textContent = 'net';
        const netSel = document.createElement('select');
        for (const n of board.nets.map((x) => x.name)) {
          const o = document.createElement('option');
          o.value = n;
          o.textContent = n;
          o.selected = n === opts.zoneNet;
          netSel.appendChild(o);
        }
        netSel.addEventListener('change', () => setToolOptions({ zoneNet: netSel.value }));
        netLabel.appendChild(netSel);

        row.append(layerLabel, netLabel);
        els.toolOptions.appendChild(row);
        break;
      }
      case 'hole': {
        const row = document.createElement('div');
        row.className = 'tool-options-row';

        const drillLabel = document.createElement('label');
        drillLabel.textContent = 'drill mm';
        const drillInput = document.createElement('input');
        drillInput.type = 'number';
        drillInput.step = '0.1';
        drillInput.min = '0.1';
        drillInput.value = String(opts.holeDrillMm);
        drillInput.addEventListener('change', () => {
          const v = parseFloat(drillInput.value);
          if (Number.isFinite(v) && v > 0) setToolOptions({ holeDrillMm: v });
        });
        drillLabel.appendChild(drillInput);

        const platedLabel = document.createElement('label');
        const platedInput = document.createElement('input');
        platedInput.type = 'checkbox';
        platedInput.checked = opts.holePlated;
        platedInput.addEventListener('change', () => setToolOptions({ holePlated: platedInput.checked }));
        platedLabel.append(platedInput, ' plated');

        row.append(drillLabel, platedLabel);
        els.toolOptions.appendChild(row);
        break;
      }
      case 'measure': {
        const readout = document.createElement('div');
        readout.className = 'tool-hint';
        readout.textContent = state.measureMm !== null ? `${state.measureMm.toFixed(2)} mm` : 'drag to measure';
        els.toolOptions.appendChild(readout);
        measureReadoutEl = readout;
        break;
      }
      case 'select': {
        appendHint('Click to select. Drag a component to move it. R rotate, F flip, Del/Backspace remove.');
        break;
      }
      case 'ripup': {
        appendHint('Click a track/via to remove it. Alt-click removes the whole net.');
        break;
      }
      case 'keepout': {
        appendHint('Click points to build a polygon. Enter or double-click closes it.');
        break;
      }
      case 'silk': {
        appendHint('Click to place a text label. Enter commits, Esc cancels.');
        break;
      }
      default:
        break;
    }

    function appendHint(text: string): void {
      const hint = document.createElement('div');
      hint.className = 'tool-hint';
      hint.textContent = text;
      els.toolOptions.appendChild(hint);
    }
  }

  function updateMeasureReadout(state: AppState): void {
    if (measureReadoutEl) {
      measureReadoutEl.textContent = state.measureMm !== null ? `${state.measureMm.toFixed(2)} mm` : 'drag to measure';
    }
  }

  // ---------------------------------------------------------------------------
  // Project controls: Save (explicit flush; the server also autosaves after
  // every op) and Open (modal listing every .flamingo the server can see).
  // ---------------------------------------------------------------------------

  function wireProjectControls(): void {
    els.saveBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const res = await fetch('/api/save', { method: 'POST' });
          const body = await res.json();
          if (!res.ok || !body.ok) throw new Error(body.error ?? res.statusText);
          els.saveBtn.textContent = 'Saved';
        } catch {
          els.saveBtn.textContent = 'Save failed';
          els.saveBtn.classList.add('err');
        }
        setTimeout(() => {
          els.saveBtn.textContent = 'Save';
          els.saveBtn.classList.remove('err');
        }, 1500);
      })();
    });
    els.openBtn.addEventListener('click', showProjectsModal);
  }

  function showProjectsModal(): void {
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('span');
    title.className = 'modal-title';
    title.textContent = 'Open project';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close';
    closeBtn.textContent = '×';
    head.append(title, closeBtn);
    const list = document.createElement('div');
    list.className = 'project-list';
    list.textContent = 'loading…';
    modal.append(head, list);
    scrim.appendChild(modal);
    document.body.appendChild(scrim);

    const close = (): void => {
      document.removeEventListener('keydown', onKey);
      scrim.remove();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    scrim.addEventListener('click', (ev) => {
      if (ev.target === scrim) close();
    });
    closeBtn.addEventListener('click', close);

    void (async () => {
      interface ProjectEntry {
        path: string;
        name: string;
        mtimeMs: number;
      }
      try {
        const res = await fetch('/api/projects');
        const body = (await res.json()) as { ok: boolean; error?: string; current: string | null; projects: ProjectEntry[] };
        if (!res.ok || !body.ok) throw new Error(body.error ?? res.statusText);
        list.replaceChildren();
        if (body.projects.length === 0) {
          list.textContent = 'no .flamingo files found';
          return;
        }
        for (const p of body.projects) {
          const isCurrent = p.path === body.current;
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'project-row' + (isCurrent ? ' current' : '');
          const nm = document.createElement('span');
          nm.className = 'project-row-name';
          nm.textContent = isCurrent ? `${p.name} · current` : p.name;
          const pth = document.createElement('span');
          pth.className = 'project-row-path';
          pth.textContent = p.path;
          pth.title = p.path;
          row.append(nm, pth);
          if (!isCurrent) {
            row.addEventListener('click', () => {
              void (async () => {
                row.disabled = true;
                try {
                  const r = await fetch('/api/open', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ path: p.path }),
                  });
                  const b = await r.json();
                  if (!r.ok || !b.ok) throw new Error(b.error ?? r.statusText);
                  close();
                  actions.boardOpened();
                } catch (err) {
                  row.disabled = false;
                  nm.textContent = `${p.name} — failed: ${err instanceof Error ? err.message : String(err)}`;
                  nm.classList.add('err');
                }
              })();
            });
          }
          list.appendChild(row);
        }
      } catch (err) {
        list.textContent = `failed to list projects: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  }

  function wireToolbarControls(): void {
    els.snapToggle.checked = store.get().snapEnabled;
    els.snapToggle.addEventListener('change', () => {
      store.set({ snapEnabled: els.snapToggle.checked });
    });
    els.undoBtn.addEventListener('click', () => {
      void fetch('/api/undo', { method: 'POST' });
    });
    els.redoBtn.addEventListener('click', () => {
      void fetch('/api/redo', { method: 'POST' });
    });
  }

  // ---------------------------------------------------------------------------
  // Lock & Route: an in-page confirm (no window.confirm) that POSTs /api/route,
  // shows a routing-in-progress state, then reports routed/unrouted counts. The
  // routed board streams back over the existing /ws channel automatically.
  // ---------------------------------------------------------------------------

  function wireRouteControls(): void {
    let routing = false;
    const btn = els.routeBtn;
    const status = els.routeStatus;

    function idle(): void {
      status.replaceChildren();
      btn.disabled = false;
      btn.textContent = 'Lock & Route';
    }

    function setResult(text: string, kind: 'ok' | 'err'): void {
      status.replaceChildren();
      const el = document.createElement('div');
      el.className = `route-result ${kind}`;
      el.textContent = text;
      status.appendChild(el);
    }

    async function doRoute(): Promise<void> {
      if (routing) return;
      routing = true;
      btn.disabled = true;
      status.replaceChildren();
      const busy = document.createElement('div');
      busy.className = 'route-busy';
      busy.textContent = 'Routing… this can take a minute.';
      status.appendChild(busy);
      try {
        const res = await fetch('/api/route', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const body = await res.json();
        if (res.ok && body.ok) {
          const summary = body.fullyRouted
            ? `Routed ${body.routedCount} net(s): ${body.tracksAdded} tracks, ${body.viasAdded} vias. All nets routed.`
            : `Routed ${body.tracksAdded} tracks, ${body.viasAdded} vias — ${body.remaining.length} net(s) still unrouted.`;
          setResult(summary, 'ok');
        } else {
          setResult(`Route failed: ${body.error ?? res.statusText}`, 'err');
        }
      } catch (err) {
        setResult(`Route failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
      } finally {
        routing = false;
        btn.disabled = false;
        btn.textContent = 'Lock & Route';
      }
    }

    function showConfirm(): void {
      status.replaceChildren();
      const msg = document.createElement('div');
      msg.className = 'route-confirm-msg';
      msg.textContent = 'Lock placement and run the autorouter?';
      const row = document.createElement('div');
      row.className = 'route-confirm-row';
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'route-confirm-go';
      go.textContent = 'Route';
      go.addEventListener('click', () => {
        void doRoute();
      });
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'route-confirm-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', idle);
      row.append(go, cancel);
      status.append(msg, row);
    }

    btn.addEventListener('click', () => {
      if (routing) return;
      showConfirm();
    });
  }

  function onStateChange(state: AppState): void {
    const boardChanged = state.board !== lastBoard;
    if (boardChanged) {
      lastBoard = state.board;
      els.projectName.textContent = state.board ? state.board.name : '';
      buildLayerList(state);
      buildNetList(state);
      buildBoardInfo(state);
      buildBom(state);
      syncToolOptionDefaults(state);
    }
    if (state.activeTool !== lastToolOptionsTool || boardChanged) {
      lastToolOptionsTool = state.activeTool;
      buildToolOptions(state);
    }
    if (state.selection !== lastSelection || state.board !== lastPropsBoard) {
      lastSelection = state.selection;
      lastPropsBoard = state.board;
      buildProps(state);
    }
    updateSelection(state);
    updateStatusBar(state);
    updateToolButtons(state);
    updateMeasureReadout(state);
  }

  buildToolButtons();
  wireToolbarControls();
  wireProjectControls();
  wireRouteControls();
  store.subscribe(onStateChange);
  onStateChange(store.get());
}
