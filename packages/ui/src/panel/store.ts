/**
 * Panel view - state.
 *
 * One object, replaced on every change, with synchronous subscribers: the
 * same scheme as the board editor's store (../state.ts), kept separate so the
 * two pages share nothing at run time.
 */

import type { Point } from '@flamingo/engine';
import type { CostCurve, PanelLoading, PanelView, QuoteResult } from '@flamingo/panel';
import type { ViewTransform } from '../state.js';
import type { BoardFile } from './api.js';

export interface Drag {
  id: string;
  /** Offset of the instance from where it was picked up, mm. */
  dx: number;
  dy: number;
  /**
   * Set on drop: the instance stays drawn where it was dropped until a view
   * newer than this revision arrives, so it does not jump back for a frame.
   */
  droppedAt?: number;
}

export interface Message {
  text: string;
  /** A problem is framed more heavily than a note. */
  problem: boolean;
  /** Download link offered by the export. */
  link?: { href: string; name: string; label: string };
}

/** How the plate draws the panel: the editable layout, or as the fab makes it. */
export type PanelLook = 'layout' | 'fab';

/** The last quote that settled, with the quantities it was for. */
export interface QuoteSnapshot {
  key: string;
  quote: QuoteResult | null;
  quantities: Array<{ key: string; needed: number }>;
}

export interface QuotePending {
  since: number;
  previous: QuoteSnapshot | null;
}

export interface PanelState {
  view: PanelView | null;
  look: PanelLook;
  /** Board checks the server is running before it can send the next view. */
  loading: PanelLoading | null;
  connected: boolean;
  transform: ViewTransform;
  hasFit: boolean;
  /** Selected instance id. */
  selection: string | null;
  drag: Drag | null;
  cursorMm: Point | null;
  quote: QuoteResult | null;
  quoteError: string | null;
  /**
   * A new quote is being fetched, because the quantities (or something else
   * the ways depend on) changed. `previous` is what was shown before, when
   * only quantities changed: a cancel puts those numbers back and shows the
   * previous ways again instead of waiting.
   */
  quoting: QuotePending | null;
  /**
   * Cost against quantity for the panel's boards and settings: the points the
   * panel file holds, null until asked for. Nothing is priced until the
   * person asks; `curve.missing` lists what pricing would add.
   */
  curve: CostCurve | null;
  curveError: string | null;
  curveRev: number;
  /** Pricing in progress, a few quantities at a time: how many of the missing ones are done. */
  curvePricing: { done: number; total: number } | null;
  /** Counts up whenever `quote` is replaced, so lists built from it know when to rebuild. */
  quoteRev: number;
  /**
   * Scenario shown on the plate in place of the panel, because it is not one
   * panel that could be loaded (single boards, or several orders). Nothing on
   * the plate can be edited while this is set.
   */
  preview: string | null;
  arrangeMsg: Message | null;
  exportMsg: Message | null;
  boardMsg: Message | null;
  /** Board files in the project that could be added to the panel. */
  boardFiles: BoardFile[];
  /** Open context menu: the instance it is for and where, in plate pixels. */
  menu: { id: string; x: number; y: number } | null;
  busy: boolean;
}

function initial(): PanelState {
  return {
    view: null,
    look: 'layout',
    loading: null,
    connected: false,
    transform: { scale: 6, originPxX: 40, originPxY: 400, flipped: false },
    hasFit: false,
    selection: null,
    drag: null,
    cursorMm: null,
    quote: null,
    quoteError: null,
    quoting: null,
    curve: null,
    curveError: null,
    curveRev: 0,
    curvePricing: null,
    quoteRev: 0,
    preview: null,
    arrangeMsg: null,
    exportMsg: null,
    boardMsg: null,
    boardFiles: [],
    menu: null,
    busy: false,
  };
}

const LOOK_KEY = 'flamingo.panel.look';

/** The view last chosen in this browser. Storage can be missing or throw (private windows): then the layout. */
export function loadLook(storage?: Pick<Storage, 'getItem'>): PanelLook {
  try {
    // Reading `localStorage` itself can throw, so it is looked up in here.
    return (storage ?? globalThis.localStorage)?.getItem(LOOK_KEY) === 'fab' ? 'fab' : 'layout';
  } catch {
    return 'layout';
  }
}

export function saveLook(look: PanelLook, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(LOOK_KEY, look);
  } catch {
    // Not remembered; the toggle still works for this page.
  }
}

type Listener = (state: PanelState, previous: PanelState) => void;

export class PanelStore {
  private state: PanelState = initial();
  private listeners = new Set<Listener>();

  get(): PanelState {
    return this.state;
  }

  set(patch: Partial<PanelState>): void {
    const previous = this.state;
    this.state = { ...previous, ...patch };
    for (const fn of this.listeners) fn(this.state, previous);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
