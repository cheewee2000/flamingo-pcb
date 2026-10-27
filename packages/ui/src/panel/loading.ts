/**
 * Panel view - what the plate shows while the server is still working.
 *
 * Before the first view arrives the plate is empty, and on a panel of routed
 * boards that can take a minute or more: the server runs each source board's
 * own DRC (zone fill included) before it can judge the panel. The server
 * reports how far each board has got, and this card shows it as one bar per
 * board, in the board's colour, with a time left once there is enough to go
 * on. Centred while there is no panel to look at yet; docked in a corner
 * when a board edited on disk is being checked again under a panel already
 * drawn.
 */

import type { BoardLoading } from '@flamingo/panel';
import { escapeHtml } from './format.js';
import type { PanelState } from './store.js';

const TICK_MS = 500;
/** No time left is guessed before this page has watched a board run this long and get this much further. */
const ESTIMATE_AFTER_MS = 3000;
const ESTIMATE_AFTER_FRACTION = 0.03;

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createLoading(el: HTMLElement): (state: PanelState) => void {
  const pageStart = Date.now();
  /** When this page first saw each board running, and how far it was then, by key. */
  const began = new Map<string, { at: number; fraction: number }>();
  let last: PanelState | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function status(b: BoardLoading, now: number): string {
    if (b.phase === 'done') return 'done';
    if (b.phase === 'queued') return 'waiting';
    let start = began.get(b.key);
    if (!start) began.set(b.key, (start = { at: now, fraction: b.fraction }));
    const spent = now - start.at;
    const gained = b.fraction - start.fraction;
    const what = b.phase === 'zones' ? b.detail ?? 'zones' : `DRC: ${b.detail ?? ''}`;
    if (spent < ESTIMATE_AFTER_MS || gained < ESTIMATE_AFTER_FRACTION) return what;
    return `${what} · ~${clock((spent * (1 - b.fraction)) / gained)} left`;
  }

  function row(b: BoardLoading, now: number): string {
    const pct = Math.round(Math.min(1, Math.max(0, b.fraction)) * 100);
    return (
      `<div class="load-row load-${b.phase}" style="--board:${b.color}">` +
      `<span class="chip">${escapeHtml(b.key)}</span>` +
      `<span class="load-name">${escapeHtml(b.name)}</span>` +
      `<span class="load-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></span>` +
      `<span class="load-status">${escapeHtml(status(b, now))}</span>` +
      `</div>`
    );
  }

  function render(state: PanelState): void {
    last = state;
    const { view, loading, connected } = state;
    const show = loading !== null || view === null;
    el.hidden = !show;
    el.classList.toggle('plate-loading-docked', view !== null);
    if (!show) {
      if (timer) clearInterval(timer);
      timer = null;
      return;
    }
    if (!timer) timer = setInterval(() => last && render(last), TICK_MS);
    const now = Date.now();
    if (!loading) {
      el.innerHTML =
        `<div class="load-head"><strong>${connected ? 'Loading panel' : 'Connecting'}</strong>` +
        `<span class="load-clock">${clock(now - pageStart)}</span></div>`;
      return;
    }
    const all = loading.boards;
    const done = all.filter((b) => b.phase === 'done').length;
    el.innerHTML =
      `<div class="load-head"><strong>Checking boards</strong>` +
      `<span class="load-count">${done} of ${all.length}</span>` +
      `<span class="load-clock">${clock(now - loading.startedAt)}</span></div>` +
      all.map((b) => row(b, now)).join('') +
      (view === null ? `<div class="load-note">Each board's own DRC, run once per version of the board.</div>` : '');
  }

  return (state: PanelState): void => {
    // The store changes on every mouse move; only these three matter here.
    if (last && last.loading === state.loading && last.view === state.view && last.connected === state.connected) return;
    if (last?.loading && !state.loading) began.clear();
    render(state);
  };
}
