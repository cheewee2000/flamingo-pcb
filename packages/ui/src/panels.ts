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

import { copperLayersOf } from '@flamingo/engine';
import { RATSNEST_KEY, SILK_KEY, store, withLayerKeys, type AppState, type HitInfo } from './state.js';

export interface PanelEls {
  layerList: HTMLElement;
  netList: HTMLElement;
  boardInfo: HTMLElement;
  sideBadge: HTMLElement;
  statusCursor: HTMLElement;
  statusZoom: HTMLElement;
  statusHover: HTMLElement;
  statusConn: HTMLElement;
}

function layerSwatchColor(key: string): string {
  const colors: Record<string, string> = {
    'F.Cu': '#C83434',
    'In1.Cu': '#7FC87F',
    'In2.Cu': '#CE7D2C',
    'In3.Cu': '#9C6BC8',
    'In4.Cu': '#C8B96B',
    'B.Cu': '#4D7FC4',
  };
  return colors[key] ?? '#999';
}

function hoverText(hit: HitInfo): string {
  if (hit.kind === 'pad') return `${hit.refdes}.${hit.padNumber}  net:${hit.net}`;
  if (hit.kind === 'track') return `track  net:${hit.net}`;
  return `via  net:${hit.net}`;
}

/** Wire the layer list, net list, board-info panel, and status bar to `store`. */
export function initPanels(els: PanelEls): void {
  let lastBoard: AppState['board'] = null;
  const netRows = new Map<string, HTMLElement>();

  function buildLayerList(state: AppState): void {
    els.layerList.replaceChildren();
    const board = state.board;
    if (!board) return;
    const keys = [...copperLayersOf(board), SILK_KEY, RATSNEST_KEY];
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
      swatch.style.background = key === SILK_KEY || key === RATSNEST_KEY ? '#888' : layerSwatchColor(key);
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

  function updateSelection(state: AppState): void {
    for (const [name, row] of netRows) {
      row.classList.toggle('selected', state.selectedNet === name);
    }
  }

  function updateStatusBar(state: AppState): void {
    els.statusCursor.textContent = state.cursorMm
      ? `x: ${state.cursorMm.x.toFixed(2)} y: ${state.cursorMm.y.toFixed(2)}`
      : 'x: -- y: --';
    els.statusZoom.textContent = `${state.view.scale.toFixed(1)} px/mm`;
    els.statusHover.textContent = state.hover ? hoverText(state.hover) : '';
    els.statusConn.textContent = state.connected ? 'connected' : 'disconnected';
    els.statusConn.classList.toggle('connected', state.connected);
    els.statusConn.classList.toggle('disconnected', !state.connected);
    els.sideBadge.hidden = !state.view.flipped;
  }

  function onStateChange(state: AppState): void {
    if (state.board !== lastBoard) {
      lastBoard = state.board;
      buildLayerList(state);
      buildNetList(state);
      buildBoardInfo(state);
    }
    updateSelection(state);
    updateStatusBar(state);
  }

  store.subscribe(onStateChange);
  onStateChange(store.get());
}
