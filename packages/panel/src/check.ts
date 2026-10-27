/**
 * Flamingo Panel - constraint checks.
 *
 * `checkPanel` reports what is wrong with a panel as data, the way `runDRC`
 * does for a board. Three severities:
 *  - error:   the panel cannot be fabricated or assembled as it stands.
 *             Errors gate `export_panel_fab` (waivable).
 *  - warning: it can be made, but something deserves a look.
 *  - info:    a consequence worth knowing (an edge is blocked, a board is promoted).
 */

import type { Board, Point } from '@flamingo/engine';
import { allHoles, padWorld, polyIntersects, RULESETS } from '@flamingo/engine';
import type { AssemblyType, PanelLimits, SizeRange } from './config.js';
import type { PanelGeometry, PlacedInstance } from './geometry.js';
import { computeGeometry, effectiveSpacing, sideToward, tabCounts, usesTabs } from './geometry.js';
import { closestPoints, dot, edgesOf, onSegment } from './poly.js';
import type { ResolvedSources } from './resolved.js';
import { panelRules, tighterLimits } from './rules.js';
import { applyTransform, boxCorners } from './transform.js';
import type { Box, Panel } from './types.js';
import { SIDES } from './types.js';

export type Severity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'source-missing'
  | 'source-stale'
  /** Raised by the server, which runs each source board's own DRC. */
  | 'source-drc'
  | 'stackup-mismatch'
  | 'stackup-too-few'
  | 'stackup-promoted'
  | 'rules-mismatch'
  | 'overlap'
  | 'spacing'
  | 'blocked-edge-clearance'
  | 'overhang-collision'
  | 'blocked-edge'
  | 'blocked-edge-tab'
  | 'unsupported-instance'
  | 'tab-near-copper'
  | 'size-fab'
  | 'size-assembly'
  | 'spacing-setting'
  | 'hole-setting'
  | 'rail-features'
  | 'rails-required'
  | 'no-instances'
  | 'silk-divider-designs'
  | 'silk-divider-shape'
  | 'v-cut-shape'
  | 'v-cut-misaligned'
  | 'v-cut-size'
  | 'v-cut-lines'
  | 'v-cut-rails'
  | 'v-cut-small-board'
  | 'v-cut-near-copper'
  | 'assembly-sides'
  | 'assembly-standard-only'
  | 'empty';

export interface PanelIssue {
  code: IssueCode;
  severity: Severity;
  message: string;
  /** Instance ids the issue is about; the canvas marks these. */
  instances: string[];
  /** Source keys the issue is about. */
  sources: string[];
  /** Where to point at, panel mm, when the issue has a place. */
  at?: Point;
  /** Machine-readable detail, e.g. `{promoteTo: 4}` on a stackup mismatch. */
  data?: Record<string, unknown>;
}

const EPS = 0.01;

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function centre(b: Box): Point {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

function fitsEitherWay(w: number, h: number, maxW: number, maxH: number): boolean {
  return (w <= maxW + EPS && h <= maxH + EPS) || (w <= maxH + EPS && h <= maxW + EPS);
}

function atLeastEitherWay(w: number, h: number, minW: number, minH: number): boolean {
  return (w >= minW - EPS && h >= minH - EPS) || (w >= minH - EPS && h >= minW - EPS);
}

/** Layer count the panel is fabricated at, or null when the sources disagree and nothing was chosen. */
export function targetLayers(panel: Panel, sources: ResolvedSources): 2 | 4 | 6 | null {
  if (panel.settings.copperLayers !== 'auto') return panel.settings.copperLayers;
  const used = usedLayerCounts(panel, sources);
  if (used.length === 1) return used[0]!;
  if (used.length === 0) return 2;
  return null;
}

/** Distinct layer counts among the sources that have instances (all sources when none has). */
export function usedLayerCounts(panel: Panel, sources: ResolvedSources): Array<2 | 4 | 6> {
  const withInstances = new Set(panel.instances.map((i) => i.source));
  const pool = sources.filter((s) => s.geometry && (withInstances.size === 0 || withInstances.has(s.key)));
  return [...new Set(pool.map((s) => s.geometry!.copperLayers))].sort((a, b) => a - b);
}

/** Which assembly service a panel of this size and make-up can go to. */
export function assemblyFit(
  width: number,
  height: number,
  panelized: boolean,
  limits: PanelLimits,
): Record<AssemblyType, { fits: boolean; range: SizeRange; reason?: string }> {
  const out = {} as Record<AssemblyType, { fits: boolean; range: SizeRange; reason?: string }>;
  for (const type of ['economic', 'standard'] as const) {
    const range = (panelized ? limits.assembly[type].panelSize : limits.assembly[type].singleSize).value;
    let reason: string | undefined;
    if (!fitsEitherWay(width, height, range.maxWidth, range.maxHeight)) {
      reason = `${fmt(width)} x ${fmt(height)} mm exceeds the ${range.maxWidth} x ${range.maxHeight} mm maximum`;
    } else if (!atLeastEitherWay(width, height, range.minWidth, range.minHeight)) {
      reason = `${fmt(width)} x ${fmt(height)} mm is under the ${range.minWidth} x ${range.minHeight} mm minimum`;
    }
    out[type] = { fits: reason === undefined, range, ...(reason ? { reason } : {}) };
  }
  return out;
}

function sourceIssues(panel: Panel, sources: ResolvedSources): PanelIssue[] {
  const issues: PanelIssue[] = [];
  for (const s of sources) {
    const instances = panel.instances.filter((i) => i.source === s.key).map((i) => i.id);
    if (s.error) {
      issues.push({
        code: 'source-missing',
        severity: 'error',
        message: `${s.key}: ${s.error}`,
        instances,
        sources: [s.key],
      });
    } else if (s.stale) {
      issues.push({
        code: 'source-stale',
        severity: 'warning',
        message: `${s.key} (${s.path}) changed on disk since it was added to the panel. Everything shown uses the board as it is now; refresh the source to accept the change.`,
        instances,
        sources: [s.key],
      });
    }
  }
  for (const s of panel.sources) {
    if (s.needed > 0 && !panel.instances.some((i) => i.source === s.key && i.populate)) {
      const anyBare = panel.instances.some((i) => i.source === s.key);
      issues.push({
        code: 'no-instances',
        severity: 'warning',
        message: anyBare
          ? `${s.key}: ${s.needed} assembled board(s) needed, but every ${s.key} instance on the panel is bare`
          : `${s.key}: ${s.needed} board(s) needed, but the panel has no ${s.key} instance`,
        instances: [],
        sources: [s.key],
      });
    }
  }
  return issues;
}

function stackupIssues(panel: Panel, sources: ResolvedSources): PanelIssue[] {
  const issues: PanelIssue[] = [];
  const used = usedLayerCounts(panel, sources);
  const withInstances = new Set(panel.instances.map((i) => i.source));
  const pool = sources.filter((s) => s.geometry && (withInstances.size === 0 || withInstances.has(s.key)));
  const describe = (): string =>
    pool.map((s) => `${s.key} is ${s.geometry!.copperLayers}-layer`).join(', ');
  const idsOf = (keys: string[]): string[] =>
    panel.instances.filter((i) => keys.includes(i.source)).map((i) => i.id);

  const chosen = panel.settings.copperLayers;
  if (chosen === 'auto') {
    if (used.length > 1) {
      const promoteTo = used[used.length - 1]!;
      const minority = pool.filter((s) => s.geometry!.copperLayers !== promoteTo).map((s) => s.key);
      issues.push({
        code: 'stackup-mismatch',
        severity: 'error',
        message:
          `Boards on one panel must share a layer count: ${describe()}. ` +
          `Either promote the panel to ${promoteTo} layers (the boards with fewer layers are then made as ${promoteTo}-layer boards with empty inner layers), ` +
          `or put them on separate panels.`,
        instances: idsOf(minority),
        sources: pool.map((s) => s.key),
        data: { layers: used, promoteTo },
      });
    }
  } else {
    const tooMany = pool.filter((s) => s.geometry!.copperLayers > chosen);
    if (tooMany.length > 0) {
      issues.push({
        code: 'stackup-too-few',
        severity: 'error',
        message: `The panel is set to ${chosen} layers, but ${tooMany
          .map((s) => `${s.key} has ${s.geometry!.copperLayers}`)
          .join(', ')}. A board cannot be made with fewer layers than it was designed for.`,
        instances: idsOf(tooMany.map((s) => s.key)),
        sources: tooMany.map((s) => s.key),
        data: { promoteTo: Math.max(...pool.map((s) => s.geometry!.copperLayers)) },
      });
    }
    const promoted = pool.filter((s) => s.geometry!.copperLayers < chosen);
    if (promoted.length > 0) {
      issues.push({
        code: 'stackup-promoted',
        severity: 'info',
        message: `${promoted.map((s) => `${s.key} (${s.geometry!.copperLayers}-layer)`).join(', ')} will be made as ${chosen}-layer with empty inner layers.`,
        instances: idsOf(promoted.map((s) => s.key)),
        sources: promoted.map((s) => s.key),
      });
    }
  }

  // Rules: the panel takes the loosest tier its boards need (panelRules); a
  // board still designed tighter than that, such as a 4l-adv board on a
  // 6-layer panel, cannot be made to the panel's rules.
  const target = targetLayers(panel, sources);
  if (target !== null) {
    const rules = panelRules(target, pool);
    for (const s of pool) {
      const own = RULESETS[s.geometry!.rules];
      if (!own) {
        issues.push({
          code: 'rules-mismatch',
          severity: 'error',
          message: `${s.key} uses unknown rules set "${s.geometry!.rules}"`,
          instances: idsOf([s.key]),
          sources: [s.key],
        });
        continue;
      }
      const tighter = tighterLimits(own, rules);
      if (tighter.length > 0) {
        issues.push({
          code: 'rules-mismatch',
          severity: 'error',
          message: `${s.key} was designed to ${own.id}, which allows smaller ${tighter.join(', ')} than the panel's ${rules.id}`,
          instances: idsOf([s.key]),
          sources: [s.key],
        });
      }
    }
  }
  return issues;
}

/** Whether the closest approach at `p` toward `dir` is along a flat edge of `poly` rather than at a corner. */
function flatToward(poly: Point[], p: Point, dir: Point): boolean {
  for (const e of edgesOf(poly)) {
    if (dot(e.normal, dir) > 1 - 1e-6 && onSegment(p, e.start, e.end)) return true;
  }
  return false;
}

function placementIssues(panel: Panel, geometry: PanelGeometry, limits: PanelLimits): PanelIssue[] {
  const issues: PanelIssue[] = [];
  const spacing = effectiveSpacing(panel.settings);
  const list = geometry.instances;

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      const mid: Point = {
        x: (centre(a.bbox).x + centre(b.bbox).x) / 2,
        y: (centre(a.bbox).y + centre(b.bbox).y) / 2,
      };
      if (polyIntersects(a.outline, b.outline)) {
        issues.push({
          code: 'overlap',
          severity: 'error',
          message: `${a.id} and ${b.id} overlap`,
          instances: [a.id, b.id],
          sources: [],
          at: mid,
        });
        continue;
      }
      // The true gap between the outlines, at any angle, and the side of each
      // board that faces the other across it.
      const { d, pa, pb } = closestPoints(a.outline, b.outline);
      let dir = { x: pb.x - pa.x, y: pb.y - pa.y };
      // Touching: no direction across the gap, so go by where the boxes sit.
      if (d < EPS) {
        const ca = centre(a.bbox);
        const cb = centre(b.bbox);
        const gapX = Math.max(b.bbox.minX - a.bbox.maxX, a.bbox.minX - b.bbox.maxX);
        const gapY = Math.max(b.bbox.minY - a.bbox.maxY, a.bbox.minY - b.bbox.maxY);
        dir = gapX >= gapY ? { x: Math.sign(cb.x - ca.x), y: 0 } : { x: 0, y: Math.sign(cb.y - ca.y) };
      }
      const len = Math.hypot(dir.x, dir.y) || 1;
      dir = { x: dir.x / len, y: dir.y / len };
      const back = { x: -dir.x, y: -dir.y };
      const sideA = sideToward(a, dir);
      const sideB = sideToward(b, back);
      // Two parts overhanging toward each other must clear each other, not
      // just the board opposite.
      const oa = a.edges[sideA].overhang;
      const ob = b.edges[sideB].overhang;
      const both = oa > 0 && ob > 0 ? oa + ob + limits.blockedEdges.overhangMargin.value : 0;
      const need = Math.max(a.margins[sideA], b.margins[sideB], both);
      if (d >= need - EPS) continue;
      const blocked = need > spacing + EPS;
      const why = blocked
        ? [
            ...a.edges[sideA].reasons.map((r) => `${a.id}: ${r}`),
            ...b.edges[sideB].reasons.map((r) => `${b.id}: ${r}`),
          ].join('; ')
        : '';
      const corners = d >= EPS && !flatToward(a.outline, pa, dir) && !flatToward(b.outline, pb, back);
      issues.push({
        code: blocked ? 'blocked-edge-clearance' : 'spacing',
        severity: 'error',
        message: blocked
          ? `${a.id} and ${b.id} are ${fmt(d)} mm apart; the blocked edge between them needs ${fmt(need)} mm (${why})`
          : `${a.id} and ${b.id} are ${fmt(d)} mm apart${corners ? ' corner to corner' : ''}; the panel spacing is ${fmt(need)} mm`,
        instances: [a.id, b.id],
        sources: [],
        at: mid,
      });
    }
  }

  // A part that sticks out past its board must not land on anything solid.
  for (const a of list) {
    for (const o of a.overhangs) {
      for (const b of list) {
        if (b === a) continue;
        if (polyIntersects(o.polygon, b.outline) || b.overhangs.some((p) => b.id > a.id && polyIntersects(o.polygon, p.polygon))) {
          issues.push({
            code: 'overhang-collision',
            severity: 'error',
            message: `${a.id}: ${o.refdes}, which overhangs the board edge, collides with ${b.id}`,
            instances: [a.id, b.id],
            sources: [],
            at: centre(b.bbox),
          });
        }
      }
      for (const r of geometry.rails) {
        if (polyIntersects(o.polygon, boxCorners(r.box))) {
          issues.push({
            code: 'overhang-collision',
            severity: 'error',
            message: `${a.id}: ${o.refdes}, which overhangs the board edge, collides with the ${r.side} rail`,
            instances: [a.id],
            sources: [],
            at: centre(a.bbox),
          });
        }
      }
    }
  }
  return issues;
}

function edgeAndTabIssues(panel: Panel, geometry: PanelGeometry, limits: PanelLimits): PanelIssue[] {
  const issues: PanelIssue[] = [];
  for (const i of geometry.instances) {
    for (const side of SIDES) {
      const e = i.edges[side];
      if (!e.blocked) continue;
      issues.push({
        code: 'blocked-edge',
        severity: 'info',
        message: `${i.id} edge ${side} is blocked (${e.reasons.join('; ')}): no tabs there, ${fmt(i.margins[side])} mm clearance`,
        instances: [i.id],
        sources: [i.source],
      });
    }
  }
  if (!usesTabs(panel.settings)) return issues;

  // Tabs are generated clear of blocked edges; this guards that promise.
  for (const t of geometry.tabs) {
    const a = geometry.instances.find((i) => i.id === t.a);
    const b = geometry.instances.find((i) => i.id === t.b);
    const bad: string[] = [];
    if (a?.edges[t.side].blocked) bad.push(a.id);
    if (b?.edges[sideToward(b, { x: -t.normal.x, y: -t.normal.y })].blocked) bad.push(b.id);
    if (bad.length > 0) {
      issues.push({
        code: 'blocked-edge-tab',
        severity: 'error',
        message: `A tab between ${t.a} and ${t.b} lands on a blocked edge of ${bad.join(' and ')}`,
        instances: bad,
        sources: [],
        at: t.center,
      });
    }
  }

  const min = limits.tabs.minPerInstance.value;
  for (const [id, n] of tabCounts(geometry)) {
    if (n >= min) continue;
    const inst = geometry.instances.find((i) => i.id === id)!;
    const blocked = SIDES.filter((s) => inst.edges[s].blocked);
    const hint = blocked.length > 0 ? ` (edges ${blocked.join(', ')} are blocked)` : '';
    issues.push({
      code: 'unsupported-instance',
      severity: n === 0 ? 'error' : 'warning',
      message:
        n === 0
          ? `${id} has no tabs${hint}: nothing holds it in the panel. Move it within ${fmt(panel.settings.tabs.maxLength)} mm of a rail or another board.`
          : `${id} is held by ${n} tab${n === 1 ? '' : 's'}${hint}; ${min} or more are recommended`,
      instances: [id],
      sources: [],
      at: centre(inst.bbox),
    });
  }
  return issues;
}

type Disc = { at: Point; r: number; what: string };

/** A board's copper and drills as discs in panel space: cheap, and conservative enough for a warning. */
function copperDiscs(board: Board, inst: PlacedInstance): Disc[] {
  const discs: Disc[] = [];
  const toPanel = (p: Point): Point => applyTransform(inst.transform, p);
  for (const v of board.vias) discs.push({ at: toPanel(v.at), r: v.diameter / 2, what: 'a via' });
  for (const h of allHoles(board)) {
    discs.push({ at: toPanel(h.at), r: Math.max(h.drill, h.padDiameter) / 2, what: 'a hole' });
  }
  for (const t of board.tracks) {
    for (const p of [t.seg.start, t.seg.end]) {
      discs.push({ at: toPanel(p), r: t.width / 2, what: `a track on ${t.net}` });
    }
  }
  for (const c of board.components) {
    for (const pad of c.footprint.pads) {
      discs.push({
        at: toPanel(padWorld(c, pad).at),
        r: Math.hypot(pad.size.w, pad.size.h) / 2,
        what: `${c.refdes}.${pad.number}`,
      });
    }
  }
  return discs;
}

/** Copper and drills of a board near its edge would be damaged by a mouse-bite hole: warn. */
function tabCopperIssues(panel: Panel, sources: ResolvedSources, geometry: PanelGeometry, limits: PanelLimits): PanelIssue[] {
  if (panel.settings.separation !== 'mouse-bite') return [];
  const issues: PanelIssue[] = [];
  const clearance = limits.tabs.copperClearance.value;
  const r = panel.settings.tabs.holeDiameter / 2;
  const reported = new Set<string>();

  for (const inst of geometry.instances) {
    const board = sources.find((s) => s.key === inst.source)?.board;
    if (!board) continue;
    const holes = geometry.tabs
      .filter((t) => t.a === inst.id || t.b === inst.id)
      .flatMap((t) => t.holes)
      .filter((h) => h.x >= inst.bbox.minX - r - EPS && h.x <= inst.bbox.maxX + r + EPS && h.y >= inst.bbox.minY - r - EPS && h.y <= inst.bbox.maxY + r + EPS);
    if (holes.length === 0) continue;

    const discs = copperDiscs(board, inst);
    for (const h of holes) {
      const hit = discs.find((d) => Math.hypot(d.at.x - h.x, d.at.y - h.y) < d.r + r + clearance);
      if (!hit) continue;
      const key = `${inst.id}:${hit.what}`;
      if (reported.has(key)) continue;
      reported.add(key);
      issues.push({
        code: 'tab-near-copper',
        severity: 'warning',
        message: `${inst.id}: a mouse-bite hole comes within ${fmt(clearance)} mm of ${hit.what}`,
        instances: [inst.id],
        sources: [inst.source],
        at: h,
      });
    }
  }
  return issues;
}

function sizeIssues(panel: Panel, sources: ResolvedSources, geometry: PanelGeometry, limits: PanelLimits): PanelIssue[] {
  const issues: PanelIssue[] = [];
  const frame = geometry.frame;
  if (!frame) return issues;
  const { width, height } = frame;
  const all = geometry.instances.map((i) => i.id);

  const layers = targetLayers(panel, sources) ?? Math.max(2, ...usedLayerCounts(panel, sources));
  const fabMax = limits.fab.maxSize[String(layers) as '2' | '4' | '6'].value;
  if (!fitsEitherWay(width, height, fabMax.width, fabMax.height)) {
    issues.push({
      code: 'size-fab',
      severity: 'error',
      message: `The panel is ${fmt(width)} x ${fmt(height)} mm; the largest ${layers}-layer board JLCPCB makes is ${fabMax.width} x ${fabMax.height} mm`,
      instances: all,
      sources: [],
      data: { width, height, max: fabMax },
    });
  }
  const fabMin = limits.fab.minSize.value;
  if (!atLeastEitherWay(width, height, fabMin.width, fabMin.height)) {
    issues.push({
      code: 'size-fab',
      severity: 'error',
      message: `The panel is ${fmt(width)} x ${fmt(height)} mm; the smallest board JLCPCB makes is ${fabMin.width} x ${fabMin.height} mm`,
      instances: all,
      sources: [],
    });
  }

  const populated = geometry.instances.filter((i) => i.populate);
  if (populated.length > 0) {
    // A silk-divider panel is one board as far as the assembly line can tell.
    const panelized = panel.settings.separation !== 'silk-divider' && geometry.instances.length > 1;
    const fit = assemblyFit(width, height, panelized, limits);
    const kind = panelized ? 'panel' : 'single board';
    if (!fit.economic.fits && !fit.standard.fits) {
      issues.push({
        code: 'size-assembly',
        severity: 'error',
        message: `Too ${/exceeds/.test(fit.standard.reason ?? '') ? 'large' : 'small'} to assemble as a ${kind}: Standard PCBA: ${fit.standard.reason}. Economic PCBA: ${fit.economic.reason}.`,
        instances: populated.map((i) => i.id),
        sources: [],
        data: { width, height, economic: fit.economic.range, standard: fit.standard.range },
      });
    } else {
      for (const type of ['economic', 'standard'] as const) {
        if (fit[type].fits) continue;
        const label = type === 'economic' ? 'Economic' : 'Standard';
        issues.push({
          code: 'size-assembly',
          severity: 'warning',
          message: `${label} PCBA cannot take this ${kind}: ${fit[type].reason}. ${type === 'economic' ? 'Standard' : 'Economic'} PCBA still can.`,
          instances: [],
          sources: [],
          data: { width, height, type, range: fit[type].range },
        });
      }
    }
  }
  return issues;
}

function settingIssues(panel: Panel, sources: ResolvedSources, geometry: PanelGeometry, limits: PanelLimits): PanelIssue[] {
  const issues: PanelIssue[] = [];
  const s = panel.settings;
  // Only a routed gap has a spacing to check; silk-divider and V-cut boards abut.
  if (usesTabs(s)) {
    if (s.spacing < limits.fab.minSpacing.value - 1e-9) {
      issues.push({
        code: 'spacing-setting',
        severity: 'error',
        message: `Panel spacing is ${fmt(s.spacing)} mm; JLCPCB routes ${fmt(limits.fab.minSpacing.value)} mm or wider between boards`,
        instances: [],
        sources: [],
      });
    }
  }
  if (s.separation === 'mouse-bite' && s.tabs.holeDiameter < limits.fab.minNpthDiameter.value - 1e-9) {
    issues.push({
      code: 'hole-setting',
      severity: 'error',
      message: `Mouse-bite holes are ${fmt(s.tabs.holeDiameter)} mm; the smallest non-plated hole JLCPCB drills is ${fmt(limits.fab.minNpthDiameter.value)} mm`,
      instances: [],
      sources: [],
    });
  }
  if (s.toolingHoles.enabled && s.toolingHoles.diameter < limits.fab.minNpthDiameter.value - 1e-9) {
    issues.push({
      code: 'hole-setting',
      severity: 'error',
      message: `Tooling holes are ${fmt(s.toolingHoles.diameter)} mm; the smallest non-plated hole JLCPCB drills is ${fmt(limits.fab.minNpthDiameter.value)} mm`,
      instances: [],
      sources: [],
    });
  }
  for (const note of geometry.featureNotes) {
    issues.push({ code: 'rail-features', severity: 'warning', message: note, instances: [], sources: [] });
  }

  const populated = geometry.instances.filter((i) => i.populate);
  if (populated.length > 0 && geometry.frame) {
    if (geometry.rails.length === 0 && limits.assembly.standard.railsRequired.value) {
      issues.push({
        code: 'rails-required',
        severity: 'warning',
        message: 'The panel has no rails. Standard PCBA needs edge rails and fiducials; Economic PCBA does not.',
        instances: [],
        sources: [],
      });
    }
    const bottom = populated.filter((i) => sources.find((x) => x.key === i.source)?.geometry?.hasBottomParts);
    if (bottom.length > 0) {
      issues.push({
        code: 'assembly-sides',
        severity: 'info',
        message: `${[...new Set(bottom.map((i) => i.source))].join(', ')} has parts on the bottom side: only Standard PCBA places both sides.`,
        instances: bottom.map((i) => i.id),
        sources: [...new Set(bottom.map((i) => i.source))],
      });
    }
    const standardOnly = new Map<string, string[]>();
    for (const key of new Set(populated.map((i) => i.source))) {
      const parts = sources.find((x) => x.key === key)?.geometry?.parts ?? [];
      const only = parts.filter((p) => p.jlc?.standardOnly).map((p) => p.lcsc);
      if (only.length > 0) standardOnly.set(key, only);
    }
    if (standardOnly.size > 0) {
      const named = [...standardOnly].map(([key, parts]) => `${key} (${parts.join(', ')})`).join('; ');
      issues.push({
        code: 'assembly-standard-only',
        severity: 'info',
        message: `${named}: Standard only in JLCPCB's parts library. Economic PCBA cannot place ${standardOnly.size === 1 && standardOnly.values().next().value!.length === 1 ? 'it' : 'them'}.`,
        instances: populated.filter((i) => standardOnly.has(i.source)).map((i) => i.id),
        sources: [...standardOnly.keys()],
      });
    }
  }

  if (s.separation === 'silk-divider') {
    const designs = new Set(geometry.instances.map((i) => i.source));
    const { maxDesigns, freeDesigns, minFillRatio } = limits.silkDivider;
    if (designs.size > maxDesigns.value) {
      issues.push({
        code: 'silk-divider-designs',
        severity: 'error',
        message: `${designs.size} designs on one silkscreen-divided board; JLCPCB allows ${maxDesigns.value}`,
        instances: [],
        sources: [...designs],
      });
    } else if (designs.size > freeDesigns.value) {
      issues.push({
        code: 'silk-divider-designs',
        severity: 'warning',
        message: `${designs.size} designs on one silkscreen-divided board; more than ${freeDesigns.value} may still be charged as different designs (unverified)`,
        instances: [],
        sources: [...designs],
      });
    }
    for (const key of designs) {
      const g = sources.find((x) => x.key === key)?.geometry;
      if (g && g.fillRatio < minFillRatio.value) {
        issues.push({
          code: 'silk-divider-shape',
          severity: 'warning',
          message: `${key} is not a plain rectangle (its outline fills ${Math.round(g.fillRatio * 100)}% of its bounding box): it cannot be cut out with straight cuts`,
          instances: geometry.instances.filter((i) => i.source === key).map((i) => i.id),
          sources: [key],
        });
      }
    }
  }
  return issues;
}

/** True when `outline` is exactly its axis-aligned bounding box: every edge lies on one of its sides. */
function isAxisRect(outline: Point[], b: Box): boolean {
  const onSide = (p: Point, q: Point): boolean =>
    (Math.abs(p.x - q.x) <= EPS && (Math.abs(p.x - b.minX) <= EPS || Math.abs(p.x - b.maxX) <= EPS)) ||
    (Math.abs(p.y - q.y) <= EPS && (Math.abs(p.y - b.minY) <= EPS || Math.abs(p.y - b.maxY) <= EPS));
  return outline.length >= 4 && outline.every((p, i) => onSide(p, outline[(i + 1) % outline.length]!));
}

/**
 * V-cut rules. A score is a straight groove across the whole panel, so every
 * board must be a rectangle and every line must pass between boards, never
 * through one.
 */
function vcutIssues(panel: Panel, sources: ResolvedSources, geometry: PanelGeometry, limits: PanelLimits): PanelIssue[] {
  if (panel.settings.separation !== 'v-cut') return [];
  const issues: PanelIssue[] = [];
  const v = limits.vcut;
  const list = geometry.instances;

  const odd = list.filter((i) => !isAxisRect(i.outline, i.bbox));
  for (const key of [...new Set(odd.map((i) => i.source))]) {
    const ids = odd.filter((i) => i.source === key).map((i) => i.id);
    issues.push({
      code: 'v-cut-shape',
      severity: 'error',
      message: `${key} is not a plain rectangle (rounded corners, arcs or notches): a V-cut scores only straight lines across the whole panel, so it cannot free ${ids.join(', ')}. Use mouse bites for this board.`,
      instances: ids,
      sources: [key],
    });
  }

  for (const line of geometry.scores) {
    const crossed = list.filter((i) => {
      const [lo, hi] = line.axis === 'h' ? [i.bbox.minY, i.bbox.maxY] : [i.bbox.minX, i.bbox.maxX];
      return line.level > lo + EPS && line.level < hi - EPS;
    });
    if (crossed.length === 0) continue;
    const where = `${line.axis === 'h' ? 'y' : 'x'} = ${fmt(line.level)} mm`;
    const c = centre(crossed[0]!.bbox);
    issues.push({
      code: 'v-cut-misaligned',
      severity: 'error',
      message:
        `The ${line.axis === 'h' ? 'horizontal' : 'vertical'} V-cut along the edge of ${line.instances.join(', ')} (${where}) runs through ${crossed.map((i) => i.id).join(', ')}. ` +
        'A V-cut crosses the whole panel: boards in a row must share their top and bottom edges, and boards in a column their left and right edges.',
      instances: [...line.instances, ...crossed.map((i) => i.id)],
      sources: [],
      at: line.axis === 'h' ? { x: c.x, y: line.level } : { x: line.level, y: c.y },
      data: { axis: line.axis, level: line.level },
    });
  }

  const frame = geometry.frame;
  if (frame) {
    const min = v.minPanelSize.value;
    const max = v.maxPanelSize.value;
    if (!atLeastEitherWay(frame.width, frame.height, min.width, min.height)) {
      issues.push({
        code: 'v-cut-size',
        severity: 'error',
        message: `The panel is ${fmt(frame.width)} x ${fmt(frame.height)} mm; JLCPCB V-cuts panels of ${min.width} x ${min.height} mm or more. Add boards or rails, or use mouse bites.`,
        instances: [],
        sources: [],
        data: { width: frame.width, height: frame.height, min },
      });
    } else if (!fitsEitherWay(frame.width, frame.height, max.width, max.height)) {
      issues.push({
        code: 'v-cut-size',
        severity: 'error',
        message: `The panel is ${fmt(frame.width)} x ${fmt(frame.height)} mm; JLCPCB V-cuts panels up to ${max.width} x ${max.height} mm`,
        instances: [],
        sources: [],
        data: { width: frame.width, height: frame.height, max },
      });
    }
  }

  for (const axis of ['h', 'v'] as const) {
    const lines = geometry.scores.filter((l) => l.axis === axis);
    const name = axis === 'h' ? 'horizontal' : 'vertical';
    if (lines.length > v.maxLinesPerAxis.value) {
      issues.push({
        code: 'v-cut-lines',
        severity: 'error',
        message: `${lines.length} ${name} V-cuts; JLCPCB scores at most ${v.maxLinesPerAxis.value} in each direction`,
        instances: [],
        sources: [],
      });
    }
    for (let k = 1; k < lines.length; k++) {
      const a = lines[k - 1]!;
      const b = lines[k]!;
      const gap = b.level - a.level;
      if (gap >= v.minLineSpacing.value - EPS) continue;
      const ids = [...new Set([...a.instances, ...b.instances])];
      const mid = (a.level + b.level) / 2;
      issues.push({
        code: 'v-cut-lines',
        severity: 'error',
        message: `Two ${name} V-cuts are ${fmt(gap)} mm apart (along ${ids.join(', ')}); JLCPCB needs ${fmt(v.minLineSpacing.value)} mm between parallel V-cuts. Make the boards abut, or move them further apart.`,
        instances: ids,
        sources: [],
        at: axis === 'h' ? { x: (a.start.x + a.end.x) / 2, y: mid } : { x: mid, y: (a.start.y + a.end.y) / 2 },
      });
    }
    // A groove through a tooling hole or a fiducial on the rail spoils it.
    for (const line of lines) {
      const dist = (p: Point): number => Math.abs((axis === 'h' ? p.y : p.x) - line.level);
      const hole = geometry.toolingHoles.find((h) => dist(h.at) < h.diameter / 2);
      const fid = geometry.fiducials.find((f) => dist(f.at) < f.maskDiameter / 2);
      const what = hole ? { at: hole.at, name: 'a tooling hole' } : fid ? { at: fid.at, name: 'a fiducial' } : null;
      if (!what) continue;
      issues.push({
        code: 'v-cut-lines',
        severity: 'warning',
        message: `The ${name} V-cut along ${line.instances.join(', ')} runs through ${what.name} on the rail`,
        instances: line.instances,
        sources: [],
        at: what.at,
      });
    }
  }

  if (geometry.frame && geometry.rails.length === 0 && !v.allowNoRails.value) {
    issues.push({
      code: 'v-cut-rails',
      severity: 'error',
      message: 'A V-cut panel needs rails',
      instances: [],
      sources: [],
    });
  }

  const small = list.filter((i) => Math.min(i.bbox.maxX - i.bbox.minX, i.bbox.maxY - i.bbox.minY) < v.smallBoardSide.value - EPS);
  if (small.length > 0) {
    issues.push({
      code: 'v-cut-small-board',
      severity: 'warning',
      message: `${small.map((i) => i.id).join(', ')} ${small.length === 1 ? 'has' : 'have'} a side under ${fmt(v.smallBoardSide.value)} mm: JLCPCB charges extra to V-cut boards that small. The amount is not published as text, so the quote leaves it out.`,
      instances: small.map((i) => i.id),
      sources: [...new Set(small.map((i) => i.source))],
    });
  }

  // Copper too near a score is cut into or cracked when the board is snapped off.
  const clearance = v.copperClearance.value;
  for (const inst of list) {
    const board = sources.find((s) => s.key === inst.source)?.board;
    const lines = geometry.scores.filter((l) => l.instances.includes(inst.id));
    if (!board || lines.length === 0) continue;
    const discs = copperDiscs(board, inst);
    for (const line of lines) {
      const hit = discs.find((d) => Math.abs((line.axis === 'h' ? d.at.y : d.at.x) - line.level) - d.r < clearance - 1e-9);
      if (!hit) continue;
      issues.push({
        code: 'v-cut-near-copper',
        severity: 'warning',
        message: `${inst.id}: ${hit.what} comes within ${fmt(clearance)} mm of a V-cut`,
        instances: [inst.id],
        sources: [inst.source],
        at: hit.at,
      });
    }
  }
  return issues;
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Check a panel. Pass `geometry` when it has already been computed for this
 * panel and these sources; it is derived otherwise.
 */
export function checkPanel(
  panel: Panel,
  sources: ResolvedSources,
  limits: PanelLimits,
  geometry: PanelGeometry = computeGeometry(panel, sources),
): PanelIssue[] {
  const issues: PanelIssue[] = [
    ...sourceIssues(panel, sources),
    ...stackupIssues(panel, sources),
  ];
  if (panel.instances.length === 0) {
    issues.push({
      code: 'empty',
      severity: 'info',
      message: 'The panel has no instances yet.',
      instances: [],
      sources: [],
    });
  }
  issues.push(
    ...placementIssues(panel, geometry, limits),
    ...edgeAndTabIssues(panel, geometry, limits),
    ...tabCopperIssues(panel, sources, geometry, limits),
    ...sizeIssues(panel, sources, geometry, limits),
    ...settingIssues(panel, sources, geometry, limits),
    ...vcutIssues(panel, sources, geometry, limits),
  );
  // Stable: severity first, original order within a severity.
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => ORDER[a.issue.severity] - ORDER[b.issue.severity] || a.i - b.i)
    .map((x) => x.issue);
}

export function hasErrors(issues: PanelIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
