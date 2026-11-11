/**
 * Panel session: everything the server can do with a panel, in one place.
 *
 * The MCP tools, the HTTP routes, the WebSocket channel and the CLI are all
 * thin wrappers over this class, so an edit made through any of them is the
 * same edit: one op on the PanelDoc, one 'change', one fresh view pushed to
 * every connected browser.
 *
 * The view is derived state. It is recomputed from the panel and the source
 * boards on disk after every change and never stored.
 */

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type { Board, DrcViolation } from '@flamingo/engine';
import { fillAllZones, renderSVG } from '@flamingo/engine';
import { generateBOM, generateCPL, generateGerbers } from '@flamingo/fab';
import type {
  ArrangeResult,
  CostCurve,
  FeeTable,
  Objective,
  Panel,
  PanelGeometry,
  PanelIssue,
  PanelLimits,
  PanelOp,
  PanelOpError,
  PanelOpResult,
  PanelView,
  QuoteResult,
  ResolvedSource,
  Rotation,
  Scenario,
  SettingsPatch,
  LimitView,
  SourceView,
  BoardLoading,
  PanelLoading,
} from '@flamingo/panel';
import {
  boardColor,
  PANEL_EXTENSION,
  applyPanelOp,
  arrange,
  atForRotationAboutCentre,
  isRotationStep,
  normalizeRotation,
  rotatedSize,
  checkPanel,
  computeGeometry,
  priceCurve,
  hasErrors,
  newPanel,
  parsePanel,
  quoteOrder,
  quotePanel,
  settingsFromLimits,
  sizeLimit,
  panelRules,
  targetLayers,
} from '@flamingo/panel';
import type { ExportPanelFabResult, PanelFabFiles, PanelRenderView } from '@flamingo/panel/node';
import {
  buildPanelFab,
  exportPanelFab,
  loadBoardFile,
  loadFeeTable,
  loadPanelLimits,
  relativeSourcePath,
  renderPanelSVG,
  resolveSources,
  sourcePath,
} from '@flamingo/panel/node';
import { PanelDoc } from './doc.js';
import { boardDrcAsync } from './drc-run.js';
import type { PartInfo, PartLookup } from './parts.js';

export interface PanelSessionOptions {
  projectDir: string;
  limits?: PanelLimits;
  fees?: FeeTable;
  /** What is known about each part beyond the board file: prices, attrition, Standard only. */
  partLookup?: PartLookup;
  /** Debounce for the panel's autosave, ms. */
  debounceMs?: number;
  /** How often to look at the source boards' file times, ms. */
  watchMs?: number;
}

export type { LimitView, PanelView, SourceView } from '@flamingo/panel';

/** One order of a scenario, as the files it uploads to JLCPCB. */
export interface ScenarioFab {
  /** Folder in the download, e.g. `S-sensor` or `M-panel`. */
  folder: string;
  label: string;
  /** Pieces fabricated, and how many of them are assembled. */
  made: number;
  assembled: number;
  gerbers: Map<string, string>;
  bom: string;
  cpl: string;
  svgName: string;
  svg: string;
  /** A panel order's fabricated view, `panel.fab.svg`. */
  fabSvg?: string;
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; error: string };

const PRICE_TIMEOUT_MS = 8000;
const LCSC_ID = /^C\d+$/i;

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** A lookup's answer with anything that is not a usable number or library entry dropped. */
function cleanPartInfo(info: PartInfo | undefined): PartInfo | undefined {
  if (!info || typeof info !== 'object') return undefined;
  const out: PartInfo = {};
  if (typeof info.unitPrice === 'number' && Number.isFinite(info.unitPrice) && info.unitPrice >= 0) out.unitPrice = info.unitPrice;
  if (info.jlc && typeof info.jlc === 'object') out.jlc = info.jlc;
  return out.unitPrice === undefined && out.jlc === undefined ? undefined : out;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'panel';
}

export class PanelSession extends EventEmitter {
  readonly doc: PanelDoc;
  readonly projectDir: string;
  readonly limits: PanelLimits;
  readonly fees: FeeTable;
  private readonly partLookup: PartLookup | undefined;
  private readonly parts = new Map<string, PartInfo | undefined>();
  /** Last DRC result per source key: one entry each, replaced when the board's hash changes. */
  private readonly drcCache = new Map<string, { hash: string; violations: DrcViolation[] }>();
  /** DRC runs in flight, by content hash, so one board is never checked twice at once. */
  private readonly drcRuns = new Map<string, Promise<DrcViolation[]>>();
  /** Boards being checked, by content hash. Cleared when the last one finishes. */
  private readonly checking = new Map<string, BoardLoading>();
  private checkingSince = 0;
  private cached: { panel: Panel; revision: number; view: PanelView; sources: ResolvedSource[] } | null = null;
  private deriving: { panel: Panel; revision: number; view: Promise<PanelView> } | null = null;
  private revision = 0;
  private watch: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PanelSessionOptions, doc?: PanelDoc) {
    super();
    this.projectDir = opts.projectDir;
    this.limits = opts.limits ?? loadPanelLimits();
    this.fees = opts.fees ?? loadFeeTable();
    this.partLookup = opts.partLookup;
    this.doc = doc ?? new PanelDoc(newPanel('panel', settingsFromLimits(this.limits)), undefined, opts.debounceMs);
    this.doc.on('change', () => {
      this.cached = null;
      this.revision++;
      this.emit('change');
    });
    this.watchSources(opts.watchMs ?? 1500);
  }

  get panel(): Panel {
    return this.doc.panel;
  }

  /** Directory source paths are relative to. */
  get panelDir(): string {
    return this.doc.filePath ? dirname(this.doc.filePath) : this.projectDir;
  }

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  /** Sources of the current panel, resolved against the disk, with known prices filled in. */
  async resolved(): Promise<ResolvedSource[]> {
    return this.resolvedFor(this.panel);
  }

  /** Sources of `panel`, resolved against the disk, with known prices filled in. */
  private async resolvedFor(panel: Panel): Promise<ResolvedSource[]> {
    const raw = await resolveSources(panel, this.panelDir, this.limits);
    return raw.map((s) =>
      s.geometry
        ? {
            ...s,
            geometry: {
              ...s.geometry,
              parts: s.geometry.parts.map((p) => {
                const info = this.parts.get(p.lcsc);
                if (!info) return p;
                return {
                  ...p,
                  ...(info.unitPrice !== undefined ? { unitPrice: info.unitPrice } : {}),
                  // JLCPCB's library says what is basic today; the board's flag is from when the part was placed.
                  ...(info.jlc ? { jlc: info.jlc, basic: info.jlc.basic } : {}),
                };
              }),
            },
          }
        : s,
    );
  }

  /**
   * DRC of a source board, as it would gate that board's own export. The last
   * result is kept per source until its content hash changes. While it runs,
   * the board is listed in `loading()`.
   */
  private async sourceDrc(src: ResolvedSource): Promise<DrcViolation[]> {
    if (!src.board || !src.hash) return [];
    const hash = src.hash;
    const key = src.key;
    const cached = this.drcCache.get(key);
    if (cached?.hash === hash) return cached.violations;
    let run = this.drcRuns.get(hash);
    if (!run) {
      if (this.checking.size === 0) this.checkingSince = Date.now();
      const board = { key: src.key, name: src.name, color: boardColor(this.panel.sources.map((s) => s.key), src.key) };
      this.checking.set(hash, { ...board, phase: 'queued', fraction: 0 });
      this.emit('loading');
      run = boardDrcAsync(src.board, (step) => {
        this.checking.set(hash, { ...board, ...step });
        this.emit('loading');
      })
        .then((v) => {
          this.drcCache.set(key, { hash, violations: v });
          return v;
        })
        .finally(() => {
          this.drcRuns.delete(hash);
          this.checking.set(hash, { ...board, phase: 'done', fraction: 1 });
          if (this.drcRuns.size === 0) this.checking.clear();
          this.emit('loading');
        });
      this.drcRuns.set(hash, run);
    }
    return run;
  }

  /** Boards whose checks are running, for a client to show while it waits; null when none are. */
  loading(): PanelLoading | null {
    if (this.checking.size === 0) return null;
    return { startedAt: this.checkingSince, boards: [...this.checking.values()] };
  }

  private async drcIssues(panel: Panel, sources: ResolvedSource[]): Promise<PanelIssue[]> {
    // Forget the results of boards that left the panel.
    for (const key of this.drcCache.keys()) {
      if (!panel.sources.some((s) => s.key === key)) this.drcCache.delete(key);
    }
    const used = sources
      .map((s) => ({ s, instances: panel.instances.filter((i) => i.source === s.key).map((i) => i.id) }))
      .filter((u) => u.instances.length > 0);
    const issues = await Promise.all(used.map((u) => this.drcIssue(u.s, u.instances)));
    return issues.filter((i): i is PanelIssue => i !== null);
  }

  /** A source board's own DRC violations as one issue, or null when it has none. */
  private async drcIssue(s: ResolvedSource, instances: string[]): Promise<PanelIssue | null> {
    const v = await this.sourceDrc(s);
    if (v.length === 0) return null;
    const rules = [...new Set(v.map((x) => x.rule))];
    return {
      code: 'source-drc',
      severity: 'error',
      message: `${s.key} (${s.name}) has ${v.length} DRC violation${v.length === 1 ? '' : 's'} of its own (${rules.join(', ')}). Fix them in the board, or waive to export anyway.`,
      instances,
      sources: [s.key],
      data: { count: v.length, rules },
    };
  }

  /** Everything a client needs to draw and judge the panel. Cached until the next change. */
  async view(): Promise<PanelView> {
    const panel = this.panel;
    const revision = this.revision;
    // Keyed on the revision too: touch() leaves the panel as it is but means
    // a source board changed, so a view derived before it is out of date.
    if (this.cached?.panel === panel && this.cached.revision === revision) return this.cached.view;
    // Every caller waiting on the same state shares one derivation.
    if (this.deriving?.panel === panel && this.deriving.revision === revision) return this.deriving.view;
    const view = this.derive(panel, revision).finally(() => {
      if (this.deriving?.view === view) this.deriving = null;
    });
    this.deriving = { panel, revision, view };
    return view;
  }

  private async derive(panel: Panel, revision: number): Promise<PanelView> {
    const t0 = performance.now();
    const sources = await this.resolvedFor(panel);
    const geometry = computeGeometry(panel, sources);
    const issues = [...checkPanel(panel, sources, this.limits, geometry), ...(await this.drcIssues(panel, sources))].sort(
      (a, b) => rankOf(a) - rankOf(b),
    );
    const quote = quotePanel(panel, sources, geometry, this.limits, this.fees);
    const layers = targetLayers(panel, sources);
    const view: PanelView = {
      panel,
      filePath: this.doc.filePath ?? null,
      canUndo: this.doc.canUndo,
      canRedo: this.doc.canRedo,
      sources: panel.sources.map((ps) => {
        const r = sources.find((s) => s.key === ps.key);
        const mine = panel.instances.filter((i) => i.source === ps.key);
        let geometryView: SourceView['geometry'];
        if (r?.geometry) {
          const { parts, ...rest } = r.geometry;
          geometryView = {
            ...rest,
            partLines: parts.length,
            extendedParts: parts.filter((p) => !p.basic).length,
          };
        }
        return {
          key: ps.key,
          path: ps.path,
          name: r?.name ?? ps.name,
          stale: r?.stale ?? false,
          ...(r?.error ? { error: r.error } : {}),
          needed: ps.needed,
          instances: mine.length,
          populated: mine.filter((i) => i.populate).length,
          ...(geometryView ? { geometry: geometryView } : {}),
        };
      }),
      geometry,
      issues,
      quote,
      limits: this.limitViews(panel, sources),
      minimums: this.minimums(),
      layers,
      rules: layers === null ? null : panelRules(layers, sources.filter((s) => panel.instances.some((i) => i.source === s.key))).id,
      derivedMs: Math.round((performance.now() - t0) * 10) / 10,
      revision,
    };
    // Only keep it if nothing changed while the sources were being read.
    if (this.panel === panel && this.revision === revision) this.cached = { panel, revision, view, sources };
    return view;
  }

  /** The smallest order the fee table knows of, for a client to explain a quantity with. */
  private minimums(): PanelView['minimums'] {
    const { pcb, assembly } = this.fees;
    const steps = [assembly.economic.qtySteps, assembly.standard.qtySteps];
    return {
      made: Math.min(...pcb.qtySteps.value),
      assembled: Math.min(...steps.flatMap((s) => s.value)),
      verified: pcb.qtySteps.verified && steps.every((s) => s.verified),
    };
  }

  private limitViews(panel: Panel, sources: ResolvedSource[]): LimitView[] {
    const layers = targetLayers(panel, sources) ?? 2;
    const fab = this.limits.fab.maxSize[String(layers) as '2' | '4' | '6'];
    const binding = sizeLimit(panel, sources, this.limits);
    const asmPanel = this.limits.assembly.standard.panelSize;
    const asmSingle = this.limits.assembly.economic.singleSize;
    const panelized = panel.settings.separation !== 'silk-divider' && panel.instances.length > 1;
    const asm = panelized ? asmPanel : asmSingle;
    const same = (w: number, h: number): boolean =>
      Math.max(w, h) === Math.max(binding.width, binding.height) && Math.min(w, h) === Math.min(binding.width, binding.height);
    return [
      {
        label: panelized ? 'assembly max (panel)' : 'assembly max (single board)',
        width: asm.value.maxWidth,
        height: asm.value.maxHeight,
        verified: asm.verified,
        source: asm.source,
        binding: same(asm.value.maxWidth, asm.value.maxHeight),
      },
      {
        label: `fab max (${layers}-layer)`,
        width: fab.value.width,
        height: fab.value.height,
        verified: fab.verified,
        source: fab.source,
        binding: same(fab.value.width, fab.value.height),
      },
    ];
  }

  /**
   * Tell clients the view may have changed although the panel did not (a
   * source board was edited on disk).
   */
  touch(): void {
    this.doc.touch();
  }

  // -------------------------------------------------------------------------
  // Prices
  // -------------------------------------------------------------------------

  /** Look up prices and JLCPCB's library data for every part of the given sources not looked up yet. Never throws. */
  async loadPrices(sources: ResolvedSource[]): Promise<void> {
    if (!this.partLookup || process.env.FLAMINGO_PANEL_PRICES === 'off') return;
    const wanted = new Set<string>();
    for (const s of sources) {
      for (const p of s.geometry?.parts ?? []) {
        if (LCSC_ID.test(p.lcsc) && !this.parts.has(p.lcsc)) wanted.add(p.lcsc);
      }
    }
    if (wanted.size === 0) return;
    const lookup = this.partLookup;
    const one = async (lcsc: string): Promise<void> => {
      try {
        const info = await Promise.race([
          lookup(lcsc),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), PRICE_TIMEOUT_MS)),
        ]);
        this.parts.set(lcsc, cleanPartInfo(info));
      } catch {
        this.parts.set(lcsc, undefined);
      }
    };
    const queue = [...wanted];
    await Promise.all(
      Array.from({ length: Math.min(6, queue.length) }, async () => {
        while (queue.length > 0) await one(queue.shift()!);
      }),
    );
    // New prices: a view derived before them, or deriving now, is out of date.
    this.cached = null;
    this.revision++;
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  private resolvePath(path: string): string {
    return resolve(isAbsolute(path) ? path : join(this.projectDir, path));
  }

  /** Create an empty panel and save it as `<projectDir>/<name>.flamboyance` (or at `path`). */
  async create(name: string, path?: string): Promise<Outcome<{ filePath: string }>> {
    const filePath = path
      ? this.resolvePath(path.endsWith(PANEL_EXTENSION) ? path : `${path}${PANEL_EXTENSION}`)
      : join(this.projectDir, `${safeName(name)}${PANEL_EXTENSION}`);
    this.doc.reset(newPanel(name, settingsFromLimits(this.limits)), filePath, true);
    try {
      await this.doc.save();
    } catch (err) {
      return fail(`panel created but not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true, filePath };
  }

  async open(path: string): Promise<Outcome<{ filePath: string }>> {
    const abs = this.resolvePath(path);
    let panel: Panel;
    try {
      panel = parsePanel(await readFile(abs, 'utf8'));
    } catch (err) {
      return fail(`could not open "${abs}": ${err instanceof Error ? err.message : String(err)}`);
    }
    // A pure read: the file it came from must not be rewritten.
    this.doc.reset(panel, abs, false);
    await this.loadPrices(await this.resolved());
    this.touch();
    return { ok: true, filePath: abs };
  }

  async save(): Promise<Outcome<{ filePath: string }>> {
    try {
      if (!this.doc.filePath) {
        // First save of a panel that was started in the browser.
        const filePath = join(this.projectDir, `${safeName(this.panel.name)}${PANEL_EXTENSION}`);
        this.doc.reset(this.panel, filePath, true);
      }
      await this.doc.save();
      return { ok: true, filePath: this.doc.filePath! };
    } catch (err) {
      return fail(err);
    }
  }

  /** Panel files under the project directory, newest first. */
  async listPanelFiles(): Promise<Array<{ path: string; name: string; mtimeMs: number }>> {
    return findFiles(this.projectDir, PANEL_EXTENSION);
  }

  /** Board files under the project directory, newest first. */
  async listBoardFiles(): Promise<Array<{ path: string; name: string; mtimeMs: number; onPanel: boolean }>> {
    const onPanel = new Set(this.panel.sources.map((s) => sourcePath(this.panelDir, s)));
    return (await findFiles(this.projectDir, '.flamingo')).map((f) => ({ ...f, onPanel: onPanel.has(f.path) }));
  }

  // -------------------------------------------------------------------------
  // Edits
  // -------------------------------------------------------------------------

  apply(op: PanelOp): PanelOpResult | PanelOpError {
    return this.doc.apply(op);
  }

  /**
   * A panel that has never been saved gets its file the moment it gains
   * content, the way `flamingo serve` creates a missing board file.
   */
  private ensureFile(): void {
    if (this.doc.filePath) return;
    let filePath = join(this.projectDir, `${safeName(this.panel.name)}${PANEL_EXTENSION}`);
    for (let n = 2; existsSync(filePath); n++) {
      filePath = join(this.projectDir, `${safeName(this.panel.name)}-${n}${PANEL_EXTENSION}`);
    }
    this.doc.reset(this.panel, filePath, false);
  }

  async addBoard(
    path: string,
    opts: { key?: string; needed?: number } = {},
  ): Promise<Outcome<{ key: string; name: string; width: number; height: number; layers: number }>> {
    const abs = this.resolvePath(path);
    let loaded;
    try {
      loaded = await loadBoardFile(abs);
    } catch (err) {
      return fail(`could not read board "${abs}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (loaded.board.outline.length === 0) {
      return fail(`board "${loaded.board.name}" has no outline, so it cannot be placed on a panel`);
    }
    this.ensureFile();
    const result = this.doc.apply({
      op: 'addSource',
      source: {
        path: relativeSourcePath(this.panelDir, abs),
        hash: loaded.hash,
        name: loaded.board.name,
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        ...(opts.needed !== undefined ? { needed: opts.needed } : {}),
      },
    });
    if (!result.ok) return fail(result.error);
    const key = result.created[0]!;
    const sources = await this.resolved();
    await this.loadPrices(sources);
    this.touch();
    const g = sources.find((s) => s.key === key)?.geometry;
    return {
      ok: true,
      key,
      name: loaded.board.name,
      width: g?.width ?? 0,
      height: g?.height ?? 0,
      layers: loaded.board.copperLayers,
    };
  }

  /** Accept the boards as they are on disk now: clears `stale`. */
  async refreshSources(keys?: string[]): Promise<Outcome<{ refreshed: string[] }>> {
    const sources = await this.resolved();
    const ops: PanelOp[] = [];
    for (const s of sources) {
      if (keys && !keys.includes(s.key)) continue;
      if (!s.hash) continue;
      if (s.hash !== s.recordedHash || s.name !== this.panel.sources.find((x) => x.key === s.key)?.name) {
        ops.push({ op: 'refreshSource', key: s.key, hash: s.hash, name: s.name });
      }
    }
    if (keys) {
      const unknown = keys.filter((k) => !this.panel.sources.some((s) => s.key === k));
      if (unknown.length > 0) return fail(`Unknown source "${unknown[0]}"`);
    }
    if (ops.length === 0) return { ok: true, refreshed: [] };
    const r = this.doc.apply(ops.length === 1 ? ops[0]! : { op: 'transaction', ops });
    if (!r.ok) return fail(r.error);
    await this.loadPrices(await this.resolved());
    return { ok: true, refreshed: ops.map((o) => (o as { key: string }).key) };
  }

  /** Turn an instance, keeping the centre of its bounding box where it is. */
  async rotateInstance(id: string, to: { rotation?: Rotation; by?: number }): Promise<PanelOpResult | PanelOpError> {
    const inst = this.panel.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: `Unknown instance "${id}"` };
    const by = to.by ?? 90;
    if (!Number.isFinite(by)) return { ok: false, error: 'by must be a number of degrees' };
    const next = normalizeRotation(to.rotation ?? inst.rotation + by);
    const g = (await this.resolved()).find((s) => s.key === inst.source)?.geometry;
    const center = g ? atForRotationAboutCentre(g.outline, inst.at, inst.rotation, next) : inst.at;
    return this.doc.apply({ op: 'rotateInstance', id, rotation: next, center });
  }

  /** Copy an instance, placed just to the right of the original and left unpinned. */
  async duplicateInstance(id: string): Promise<PanelOpResult | PanelOpError> {
    const inst = this.panel.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: `Unknown instance "${id}"` };
    const g = (await this.resolved()).find((s) => s.key === inst.source)?.geometry;
    const width = g ? rotatedSize(g.outline, inst.rotation).width : 10;
    return this.doc.apply({
      op: 'addInstance',
      source: inst.source,
      at: { x: inst.at.x + width + this.panel.settings.spacing, y: inst.at.y },
      rotation: inst.rotation,
      populate: inst.populate,
      pinned: false,
    });
  }

  /**
   * Set how many instances of a board the panel holds. Extra ones are added
   * and then everything unpinned is arranged; surplus ones are removed,
   * unpinned and highest-numbered first. One undo step either way.
   */
  async setInstanceCount(key: string, count: number): Promise<Outcome<{ added: string[]; removed: string[]; arranged: ArrangeResult | null }>> {
    if (!this.panel.sources.some((s) => s.key === key)) return fail(`Unknown source "${key}"`);
    if (!Number.isInteger(count) || count < 0) return fail('count must be a non-negative integer');
    const mine = this.panel.instances.filter((i) => i.source === key);
    const ops: PanelOp[] = [];
    const removed: string[] = [];
    if (count < mine.length) {
      const num = (id: string): number => Number(id.slice(key.length)) || 0;
      const order = [...mine].sort((a, b) => Number(a.pinned) - Number(b.pinned) || num(b.id) - num(a.id));
      for (const inst of order.slice(0, mine.length - count)) {
        ops.push({ op: 'removeInstance', id: inst.id });
        removed.push(inst.id);
      }
    } else {
      for (let i = mine.length; i < count; i++) ops.push({ op: 'addInstance', source: key });
    }
    if (ops.length === 0) return { ok: true, added: [], removed: [], arranged: null };

    // Dry-run the edit to know the new ids and to arrange the result.
    const dry = applyPanelOp(this.panel, { op: 'transaction', ops });
    if (!dry.ok) return fail(dry.error);
    const added = dry.created;
    let arranged: ArrangeResult | null = null;
    if (added.length > 0) {
      arranged = arrange(dry.panel, await this.resolvedFor(dry.panel), this.limits);
      if (arranged.ok) ops.push({ op: 'placeInstances', placements: arranged.placements });
    }
    const r = this.doc.apply({ op: 'transaction', ops });
    if (!r.ok) return fail(r.error);
    return { ok: true, added, removed, arranged };
  }

  /** Arrange every unpinned instance. The panel only changes when the result fits. */
  async arrange(opts: { rotate?: boolean; rotationStep?: number } = {}): Promise<ArrangeResult> {
    if (opts.rotationStep !== undefined && !isRotationStep(opts.rotationStep)) {
      return { ok: false, reason: 'rotationStep must divide 360 evenly and be at least 1 degree', limit: sizeLimit(this.panel, await this.resolved(), this.limits), skipped: [] };
    }
    const sources = await this.resolved();
    const result = arrange(this.panel, sources, this.limits, opts);
    if (result.ok && result.placements.length > 0) {
      const r = this.doc.apply({ op: 'placeInstances', placements: result.placements });
      if (!r.ok) return { ok: false, reason: r.error, limit: result.limit, skipped: result.skipped };
    }
    return result;
  }

  setSettings(settings: SettingsPatch): PanelOpResult | PanelOpError {
    return this.doc.apply({ op: 'setSettings', settings });
  }

  undo(): boolean {
    return this.doc.undo() !== null;
  }

  redo(): boolean {
    return this.doc.redo() !== null;
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  async check(): Promise<PanelIssue[]> {
    return (await this.view()).issues;
  }

  /** `layout` is the schematic the panel view edits; `fab` is what the fab makes. */
  async renderSvg(widthPx?: number, render: PanelRenderView = 'layout'): Promise<string> {
    const view = await this.view();
    const sources = this.cached?.sources ?? (await this.resolved());
    return renderPanelSVG(this.panel, sources, view.geometry, {
      issues: view.issues,
      limits: view.limits.map((l) => ({ width: l.width, height: l.height, label: l.label })),
      view: render,
      ...(widthPx !== undefined ? { widthPx } : {}),
    });
  }

  async renderPng(widthPx = 1200, render: PanelRenderView = 'layout'): Promise<Buffer> {
    const width = Math.max(200, Math.min(2400, Math.round(widthPx)));
    return new Resvg(await this.renderSvg(width, render)).render().asPng();
  }

  async quote(objective: Objective = 'total'): Promise<QuoteResult> {
    const sources = await this.resolved();
    return quoteOrder({
      name: this.panel.name,
      sources: this.panel.sources,
      resolved: sources,
      settings: this.panel.settings,
      limits: this.limits,
      fees: this.fees,
      objective,
    });
  }

  /**
   * Total and per-board cost of the cheapest way at each quantity: the
   * standard set plus every quantity the boards have been set to, or
   * `quantities` for a one-off table. Points come from the curve stored in
   * the panel file while its inputs are unchanged, and what is priced anew
   * goes back into it. With `price` false nothing is priced: the curve has
   * what is stored and lists the rest as `missing`.
   */
  async costCurve(objective: Objective = 'total', quantities?: readonly number[], price = true): Promise<CostCurve> {
    const sources = await this.resolved();
    const { curve, stored } = priceCurve(
      {
        name: this.panel.name,
        sources: this.panel.sources,
        resolved: sources,
        settings: this.panel.settings,
        limits: this.limits,
        fees: this.fees,
        objective,
      },
      this.doc.curve,
      quantities,
      price,
    );
    this.doc.setCurve(stored);
    return curve;
  }

  /** Load a scenario's panel onto the plate: one undo step. */
  async applyScenario(id: string, objective: Objective = 'total'): Promise<Outcome<{ scenario: Scenario; loaded: boolean }>> {
    const result = await this.quote(objective);
    const scenario = result.scenarios.find((s) => s.id === id);
    if (!scenario) {
      const rejected = result.rejected.find((r) => r.id === id);
      return fail(rejected ? `Scenario "${id}" is not possible: ${rejected.reason}` : `Unknown scenario "${id}"`);
    }
    if (!scenario.layout) return { ok: true, scenario, loaded: false };
    const r = this.doc.apply({
      op: 'setLayout',
      instances: scenario.layout.instances,
      settings: scenario.layout.settings,
    });
    if (!r.ok) return fail(r.error);
    return { ok: true, scenario, loaded: true };
  }

  /** Issues that stop an export, unless waived. */
  async gate(): Promise<{ issues: PanelIssue[]; blocking: PanelIssue[] }> {
    const issues = await this.check();
    return { issues, blocking: issues.filter((i) => i.severity === 'error') };
  }

  defaultFabDir(): string {
    return join(this.panelDir, 'fab', safeName(this.panel.name));
  }

  async exportFab(
    opts: { outDir?: string; waive?: boolean } = {},
  ): Promise<Outcome<{ outDir: string; result: ExportPanelFabResult; waived: PanelIssue[]; issues: PanelIssue[] }> & { blocking?: PanelIssue[] }> {
    const { issues, blocking } = await this.gate();
    if (blocking.length > 0 && !opts.waive) {
      return { ok: false, error: `${blocking.length} error(s) stop the export`, blocking };
    }
    const outDir = opts.outDir ? this.resolvePath(opts.outDir) : this.defaultFabDir();
    try {
      const view = await this.view();
      const sources = this.cached?.sources ?? (await this.resolved());
      const result = await exportPanelFab(this.panel, sources, this.limits, outDir, {
        geometry: view.geometry,
        issues,
      });
      return { ok: true, outDir, result, waived: blocking, issues };
    } catch (err) {
      return fail(err);
    }
  }

  /** The fab files in memory, for the browser's zip download. */
  async buildFab(opts: { waive?: boolean } = {}): Promise<Outcome<{ files: PanelFabFiles; waived: PanelIssue[] }> & { blocking?: PanelIssue[] }> {
    const { issues, blocking } = await this.gate();
    if (blocking.length > 0 && !opts.waive) {
      return { ok: false, error: `${blocking.length} error(s) stop the export`, blocking };
    }
    try {
      const view = await this.view();
      const sources = this.cached?.sources ?? (await this.resolved());
      return {
        ok: true,
        files: buildPanelFab(this.panel, sources, this.limits, { geometry: view.geometry, issues }),
        waived: blocking,
      };
    } catch (err) {
      return fail(err);
    }
  }

  /**
   * The fab files of a scenario that is not one panel (separate orders, each
   * design on its own panel, split by layer count), in memory: one fileset per
   * order, each what that order uploads to JLCPCB. A single-board order gets
   * the board's own export, as export_fab writes it; a panel order gets the
   * panel export of the scenario's layout. The panel on the plate is untouched.
   */
  async buildScenarioFab(
    id: string,
    opts: { waive?: boolean; objective?: Objective } = {},
  ): Promise<Outcome<{ scenario: Scenario; orders: ScenarioFab[]; waived: PanelIssue[] }> & { blocking?: PanelIssue[] }> {
    const result = await this.quote(opts.objective);
    const scenario = result.scenarios.find((s) => s.id === id);
    if (!scenario) {
      const rejected = result.rejected.find((r) => r.id === id);
      return fail(rejected ? `Scenario "${id}" is not possible: ${rejected.reason}` : `Unknown scenario "${id}"`);
    }
    const sources = await this.resolved();
    const blocking: PanelIssue[] = [];
    const orders: ScenarioFab[] = [];
    try {
      for (const order of scenario.orders) {
        const made = order.priced.order.pcbQty;
        const assembled = order.priced.order.assembly?.qty ?? 0;
        if (!order.panel) {
          const key = order.designs[0]!;
          const src = sources.find((s) => s.key === key);
          if (!src?.board) return fail(src?.error ?? `Board ${key} is not resolved`);
          const drc = await this.drcIssue(src, []);
          if (drc) blocking.push(drc);
          const filled = fillAllZones(src.board);
          orders.push({
            folder: `${key}-${safeName(src.name)}`,
            label: order.label,
            made,
            assembled,
            gerbers: generateGerbers(filled).files,
            bom: generateBOM(src.board),
            cpl: generateCPL(src.board),
            svgName: 'board.render.svg',
            svg: renderSVG(filled),
          });
          continue;
        }
        if (!order.layout) return fail(`Order "${order.label}" has no panel layout`);
        const applied = applyPanelOp(this.panel, { op: 'setLayout', instances: order.layout.instances, settings: order.layout.settings });
        if (!applied.ok) return fail(applied.error);
        const panel = applied.panel;
        const geometry = computeGeometry(panel, sources);
        const issues = [...checkPanel(panel, sources, this.limits, geometry), ...(await this.drcIssues(panel, sources))];
        blocking.push(...issues.filter((i) => i.severity === 'error'));
        const built = buildPanelFab(panel, sources, this.limits, { geometry, issues });
        orders.push({
          folder: `${order.designs.join('-')}-panel`,
          label: order.label,
          made,
          assembled,
          gerbers: built.gerbers,
          bom: built.bom,
          cpl: built.cpl,
          svgName: 'panel.render.svg',
          svg: built.svg,
          fabSvg: built.fabSvg,
        });
      }
    } catch (err) {
      return fail(err);
    }
    if (blocking.length > 0 && !opts.waive) {
      return { ok: false, error: `${blocking.length} error(s) stop the export`, blocking };
    }
    return { ok: true, scenario, orders, waived: blocking };
  }

  hasErrors(issues: PanelIssue[]): boolean {
    return hasErrors(issues);
  }

  /**
   * Notice source boards that change on disk, so that a board edited in a
   * server of its own, in this server's editor, or by hand, shows up here as
   * stale without anyone telling this one. Polls file times: cheap, and works
   * on every file system. Started by the constructor and stopped by close();
   * unref'd, so it never keeps a process alive.
   */
  private watchSources(intervalMs: number): void {
    if (this.watch || intervalMs <= 0) return;
    let last: string | null = null;
    let busy = false;
    const tick = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const seen = await Promise.all(
          this.panel.sources.map(async (s) => {
            const path = sourcePath(this.panelDir, s);
            try {
              const st = await stat(path);
              return `${path}:${st.mtimeMs}:${st.size}`;
            } catch {
              return `${path}:missing`;
            }
          }),
        );
        const now = seen.join('|');
        if (last !== null && now !== last) this.touch();
        last = now;
      } finally {
        busy = false;
      }
    };
    this.watch = setInterval(() => void tick(), intervalMs);
    this.watch.unref();
    void tick();
  }

  async close(): Promise<void> {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    await this.doc.close();
  }
}

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;

function rankOf(issue: PanelIssue): number {
  return SEVERITY_RANK[issue.severity];
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'fab', 'fixtures']);

async function findFiles(root: string, extension: string): Promise<Array<{ path: string; name: string; mtimeMs: number }>> {
  const found: Array<{ path: string; name: string; mtimeMs: number }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(full, depth + 1);
      } else if (e.isFile() && extname(e.name) === extension) {
        try {
          const s = await stat(full);
          found.push({ path: full, name: basename(e.name, extension), mtimeMs: s.mtimeMs });
        } catch {
          // deleted while listing
        }
      }
    }
  }
  await walk(resolve(root), 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
