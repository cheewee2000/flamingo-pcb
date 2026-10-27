/** Panel view - text formatting. Pure. */

import type {
  CostLine,
  IssueCode,
  PanelIssue,
  PieceCount,
  Received,
  Scenario,
  ScenarioKind,
} from '@flamingo/panel';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function mm(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** The mark that follows every amount resting on an unverified number. */
export const ESTIMATE_MARK = 'est.';

export const ESTIMATE_LEGEND = 'est. = estimate, not a verified JLCPCB price';

/** The long form, shown on hover. */
export const ESTIMATE_LEGEND_LONG =
  'The amount rests on a number that was not verified on a JLCPCB help page. Bare-board prices are always estimates. Shipping, tax and coupons are not included.';

/** `S 2/1  M 6/5`: boards received over boards needed, per design. */
export function receivedShort(received: Received[]): string {
  return received.map((r) => `${r.key} ${r.assembled}/${r.needed}`).join('  ');
}

export function receivedLong(r: Received): string {
  const bits = [`${r.assembled} assembled`];
  if (r.bare > 0) bits.push(`${r.bare} bare`);
  const verdict = r.shortfall > 0 ? `short by ${r.shortfall}` : r.overage > 0 ? `${r.overage} over` : 'exact';
  return `${r.key}  ${bits.join(' + ')}  (need ${r.needed}; ${verdict})`;
}

export function issueCounts(issues: PanelIssue[]): string {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const notes = issues.filter((i) => i.severity === 'info').length;
  const part = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [part(errors, 'error'), part(warnings, 'warning'), part(notes, 'note')].join(', ');
}

export const LEVEL_LABEL: Record<PanelIssue['severity'], string> = {
  error: 'ERROR',
  warning: 'WARNING',
  info: 'NOTE',
};

/** Worst severity per instance id, for marking instances on the canvas. */
export function worstByInstance(issues: PanelIssue[]): Map<string, 'error' | 'warning'> {
  const out = new Map<string, 'error' | 'warning'>();
  for (const issue of issues) {
    if (issue.severity === 'info') continue;
    for (const id of issue.instances) {
      if (out.get(id) !== 'error') out.set(id, issue.severity);
    }
  }
  return out;
}

export function scenarioWarningCount(s: Scenario): string {
  return s.warnings.length === 0 ? '' : `${s.warnings.length} warning${s.warnings.length === 1 ? '' : 's'}`;
}

/** What decides whether the scenarios (and the cost curve) have to be fetched again. */
export function quoteKey(view: {
  panel: { sources: Array<{ key: string; hash: string; needed: number }>; settings: unknown };
  sources: Array<{ key: string; stale: boolean; error?: string }>;
}): string {
  return JSON.stringify([
    view.panel.sources.map((s) => [s.key, s.hash, s.needed]),
    view.sources.map((s) => [s.key, s.stale, s.error ?? '']),
    view.panel.settings,
  ]);
}

// ---------------------------------------------------------------------------
// Short forms: the lists show a few words and a shape; the sentence is one
// click away.
// ---------------------------------------------------------------------------


/** Two or three words per kind of finding. */
export const ISSUE_TITLE: Record<IssueCode, string> = {
  'source-missing': 'Board file unreadable',
  'source-stale': 'Board changed on disk',
  'source-drc': 'Board fails its own DRC',
  'stackup-mismatch': 'Layer counts differ',
  'stackup-too-few': 'Too few layers',
  'stackup-promoted': 'Promoted to more layers',
  'rules-mismatch': 'Design rules differ',
  overlap: 'Overlap',
  spacing: 'Too close',
  'blocked-edge-clearance': 'Blocked edge too close',
  'overhang-collision': 'Overhanging part collides',
  'blocked-edge': 'Blocked edge',
  'blocked-edge-tab': 'Tab on a blocked edge',
  'unsupported-instance': 'Not held firmly',
  'tab-near-copper': 'Mouse bite near copper',
  'size-fab': 'Too big to fabricate',
  'size-assembly': 'Assembly size limit',
  'spacing-setting': 'Spacing too small',
  'hole-setting': 'Hole too small',
  'rail-features': 'Fiducials or tooling holes',
  'rails-required': 'No rails',
  'no-instances': 'Needed board not on panel',
  'silk-divider-designs': 'Too many designs',
  'silk-divider-shape': 'Not a plain rectangle',
  'v-cut-shape': 'Not a rectangle for V-cut',
  'v-cut-misaligned': 'V-cut through a board',
  'v-cut-size': 'V-cut panel size',
  'v-cut-lines': 'V-cut lines',
  'v-cut-rails': 'V-cut without rails',
  'v-cut-small-board': 'Small board on V-cut',
  'v-cut-near-copper': 'V-cut near copper',
  'assembly-sides': 'Parts on both sides',
  'assembly-standard-only': 'Standard-only parts',
  empty: 'Empty panel',
};

export interface IssueGroup {
  code: IssueCode;
  severity: PanelIssue['severity'];
  title: string;
  /** Every message in the group, in order. */
  messages: string[];
  /** Instances any of them is about, in order of first mention. */
  instances: string[];
}

/** One row per kind of finding and severity, worst first. */
export function groupIssues(issues: PanelIssue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const i of issues) {
    const key = `${i.severity}/${i.code}`;
    let g = groups.get(key);
    if (!g) {
      g = { code: i.code, severity: i.severity, title: ISSUE_TITLE[i.code] ?? i.code, messages: [], instances: [] };
      groups.set(key, g);
    }
    g.messages.push(i.message);
    for (const id of i.instances) if (!g.instances.includes(id)) g.instances.push(id);
  }
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...groups.values()].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export const SCENARIO_LABEL: Record<ScenarioKind, string> = {
  separate: 'Separate orders',
  'own-panels': 'A panel per design',
  merged: 'Mouse-bite panel',
  'silk-divider': 'Silk-divided board',
  split: 'Split by layers',
};

/** What sets a scenario apart from others of its kind, in a word or two each. */
export function scenarioTags(s: Pick<Scenario, 'id' | 'promotedTo'>): string[] {
  const tags: string[] = [];
  if (s.promotedTo !== undefined) tags.push(`as ${s.promotedTo}-layer`);
  return tags;
}

export type CostGroupName = 'Boards' | 'Assembly' | 'Parts';

export interface CostGroup {
  name: CostGroupName;
  amount: number;
  estimate: boolean;
  lines: CostLine[];
}

/** Fee lines folded into three subtotals. Groups with no lines are left out. */
export function groupCost(lines: CostLine[]): CostGroup[] {
  const of = (l: CostLine): CostGroupName =>
    l.code === 'part' ? 'Parts' : l.code.startsWith('asm-') ? 'Assembly' : 'Boards';
  return (['Boards', 'Assembly', 'Parts'] as const)
    .map((name) => {
      const mine = lines.filter((l) => of(l) === name);
      return {
        name,
        amount: Math.round(mine.reduce((s, l) => s + l.amount, 0) * 100) / 100,
        estimate: mine.some((l) => l.estimate),
        lines: mine,
      };
    })
    .filter((g) => g.lines.length > 0);
}

/** Most pips drawn for one design before the row falls back to numbers. */
export const MAX_PIPS = 12;

export interface Pips {
  /** Delivered and needed. */
  met: number;
  /** Delivered beyond the need. */
  over: number;
  /** Needed and not delivered. */
  short: number;
  /** Too many to draw: show `label` instead. */
  asText: boolean;
  label: string;
}

/** Boards received against boards needed, as counts to draw one mark each. */
export function pips(r: Pick<Received, 'assembled' | 'needed'>): Pips {
  const met = Math.min(r.assembled, r.needed);
  const over = Math.max(0, r.assembled - r.needed);
  const short = Math.max(0, r.needed - r.assembled);
  return { met, over, short, asText: met + over + short > MAX_PIPS, label: `${r.assembled}/${r.needed}` };
}

/** Populated and bare boards of one design in one piece. */
export function composition(c: PieceCount, hasParts = true): { populated: number; bare: number } {
  if (!hasParts) return { populated: c.total, bare: 0 };
  return { populated: c.populated, bare: c.total - c.populated };
}

/** What a kind of scenario is, in two sentences, for the detail of the selected one. */
export const SCENARIO_MEANING: Record<ScenarioKind, string> = {
  separate: 'Each design is ordered on its own, as single boards. Nothing is panelized.',
  'own-panels': 'Each design gets a panel of its own, and each panel is its own order.',
  merged: 'All boards share one panel, held in it by break-off tabs or scored with V-cuts to snap apart. JLCPCB charges for each extra design on a panel.',
  'silk-divider':
    'All boards sit inside one plain outline with printed lines between them, which JLCPCB counts as one design. You cut the boards apart yourself.',
  split: 'Boards are grouped by layer count, and each group is its own order.',
};

/** True when selecting the scenario replaces the panel: it is one order, and that order is a panel. */
export function loadsOntoPanel(s: Pick<Scenario, 'orders'>): boolean {
  return s.orders.length === 1 && s.orders[0]!.panel && s.orders[0]!.layout !== null;
}

/** `5 panels`, `1 board`. */
export function pieces(n: number, panel: boolean): string {
  const word = panel ? 'panel' : 'board';
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One line for the banner over a scenario that is shown, not loaded. */
export function previewLine(s: Pick<Scenario, 'kind' | 'orders'>, rank: number): string {
  const panels = s.orders.filter((o) => o.panel).length;
  const singles = s.orders.length - panels;
  const what =
    panels === 0
      ? `${s.orders.length} order${s.orders.length === 1 ? '' : 's'} of single boards, no panel`
      : singles === 0
        ? `${panels} panels, each its own order`
        : `${s.orders.length} orders: ${panels} panel${panels === 1 ? '' : 's'} and ${singles} of single boards`;
  return `Option ${rank}, ${SCENARIO_LABEL[s.kind]}: ${what}`;
}
