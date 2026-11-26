/**
 * KiCadRoutingTools backend for the autoroute pipeline.
 *
 * KiCadRoutingTools (https://github.com/drandyhaas/KiCadRoutingTools) is a
 * Rust-accelerated A* router that reads and writes `.kicad_pcb`. This module
 * is the counterpart of route.ts's runFreerouting(): given a board and the nets
 * to route it exports a KiCad file (fab/kicadpcb.ts), runs `py_router/route.py`,
 * and returns the routed `.kicad_pcb` text for importKiCadRoutes().
 *
 * Setup (one time):
 *   git clone https://github.com/drandyhaas/KiCadRoutingTools
 *   cd KiCadRoutingTools && python3 -m venv .venv && .venv/bin/pip install numpy scipy shapely
 *   .venv/bin/python build_router.py        # downloads the prebuilt Rust router
 * then point Flamingo at it with FLAMINGO_KRT_DIR=/path/to/KiCadRoutingTools
 * (and optionally FLAMINGO_KRT_PYTHON for a different interpreter), or put
 * {"krtDir": "/path/to/KiCadRoutingTools", "router": "krt"} in ~/.flamingo/config.json
 * -- the only option for the Mac app, which doesn't see your shell environment.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Board, LayerId, Point, Track } from '@flamingo/engine';
import { copperLayersOf, padCopperLayers, padOutline, padWorld, RULESETS } from '@flamingo/engine';

export interface RunKiCadRouterOptions {
  /** Nets to route; omit for every net with 2+ pins. */
  nets?: string[];
  /** Override the router checkout (default: $FLAMINGO_KRT_DIR). */
  krtDir?: string;
  /** Override the Python interpreter (default: $FLAMINGO_KRT_PYTHON, <krtDir>/.venv/bin/python, then python3). */
  python?: string;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 600000;

export const KRT_INSTALL_HINT =
  'KiCadRoutingTools not found. Clone https://github.com/drandyhaas/KiCadRoutingTools, create a venv with numpy/scipy/shapely, ' +
  'run build_router.py, then set FLAMINGO_KRT_DIR to the checkout.';

/** The useful part of a failed router run: its Python error lines, else the log tail. */
function errorSummary(out: string): string {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => /(^|\b)(error|exception|traceback)\b|Error:/i.test(l));
  return (errs.length > 0 ? errs.slice(-4).join(' | ') : lines.slice(-4).join(' | ')).slice(0, 600);
}

export interface FlamingoConfig {
  /** Path to the KiCadRoutingTools checkout. */
  krtDir?: string;
  /** Default router for autoroute: 'freerouting' | 'krt'. */
  router?: 'freerouting' | 'krt';
}

/**
 * Settings file for launches that don't inherit a shell environment (the Mac
 * app): `~/.flamingo/config.json`, or the path in $FLAMINGO_CONFIG. Environment
 * variables still win. A missing or unreadable file is just "no settings".
 */
export function readFlamingoConfig(): FlamingoConfig {
  const path = process.env.FLAMINGO_CONFIG ?? join(homedir(), '.flamingo', 'config.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as FlamingoConfig;
    return typeof raw === 'object' && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

export function findKiCadRoutingTools(krtDir?: string): { dir: string; python: string } {
  const dir = krtDir ?? process.env.FLAMINGO_KRT_DIR ?? readFlamingoConfig().krtDir;
  if (!dir || !existsSync(join(dir, 'py_router', 'route.py'))) throw new Error(KRT_INSTALL_HINT);
  const venv = join(dir, '.venv', 'bin', 'python');
  const python = process.env.FLAMINGO_KRT_PYTHON ?? (existsSync(venv) ? venv : 'python3');
  return { dir, python };
}

/**
 * Layers the router may put copper on. Only ground planes are reserved: a pour
 * on GND/VSS (the usual In1 reference plane under the top layer) stays intact,
 * while the other inner layers -- typically a power pour -- are left routable
 * so fine-pitch escapes have somewhere to go. Flamingo's pour simply fills
 * around any track the router puts there.
 */
function signalLayers(b: Board): LayerId[] {
  const copper = copperLayersOf(b);
  const ground = new Set(b.zones.filter((z) => /^(A|D|P)?(GND|VSS)/i.test(z.net)).map((z) => z.layer));
  return copper.filter((l) => !ground.has(l) || l === copper[0] || l === copper[copper.length - 1]);
}

/**
 * Routing grid for the run. The router's default 0.1mm grid cannot thread a
 * 0.35mm-pitch QFN (every neighbouring cell of the pad is blocked), so pick the
 * grid from the finest pad pitch on the board: a seventh of it, floored at
 * 0.05mm. Boards with nothing finer than 0.55mm keep the router's own default
 * (returns undefined).
 */
export function gridStepFor(b: Board): number | undefined {
  let pitch = Infinity;
  for (const c of b.components) {
    const pts = c.footprint.pads.filter((p) => p.layer !== 'through').map((p) => padWorld(c, p).at);
    if (pts.length < 8) continue;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
        if (d > 0.2 && d < pitch) pitch = d;
      }
    }
  }
  if (pitch > 0.55) return undefined;
  return Math.max(0.05, Math.round((pitch / 7) * 1000) / 1000);
}

/** The router takes one width/clearance/via for a run: use the tightest of the routed nets' classes. */
function runRules(b: Board, nets: string[]) {
  const rules = RULESETS[b.rules];
  const classOf = new Map(b.nets.map((n) => [n.name, n.class]));
  const wanted = new Set(nets.map((n) => classOf.get(n)).filter((c): c is string => !!c));
  const classes = b.netClasses.filter((c) => wanted.has(c.name));
  const pool = classes.length > 0 ? classes : b.netClasses;
  const min = (f: (c: (typeof pool)[number]) => number) => Math.min(...pool.map(f));
  return {
    trackWidth: Math.max(rules.minTrackWidth, min((c) => c.trackWidth)),
    clearance: Math.max(rules.minClearance, min((c) => c.clearance)),
    viaDiameter: Math.max(rules.minViaDiameter, min((c) => c.viaDiameter)),
    viaDrill: Math.max(rules.minDrill, min((c) => c.viaDrill)),
    holeToHole: rules.holeToHole,
    copperToEdge: rules.copperToEdge,
  };
}

/** One router invocation of a staged plan. */
export interface RouteStage {
  nets: string[];
  layers: LayerId[];
  /** Per-layer cost multipliers (one per layer) -- steers a rail onto its inner layer. */
  costs?: number[];
  label: string;
}

const RAIL_NAME = /^(A|D|P)?(GND|VSS)|^V(BUS|DD|CC|BAT)|^\+\d|^SW_|^VDDO|^ESP_VDD|^LED_D5V/i;

/** Pad number of `pin` ("U4.27" -> 27) when numeric, else Infinity. */
function numericPad(pin: string): number {
  const n = Number(pin.split('.')[1]);
  return Number.isFinite(n) ? n : Infinity;
}

/** The component carrying the finest pad pitch (the one whose pins need escaping first), if the board has a fine-pitch part. */
function finePitchRef(b: Board): string | undefined {
  let best: { ref: string; pitch: number } | undefined;
  for (const c of b.components) {
    const pts = c.footprint.pads.filter((p) => p.layer !== 'through').map((p) => padWorld(c, p).at);
    if (pts.length < 8) continue;
    let pitch = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
        if (d > 0.2 && d < pitch) pitch = d;
      }
    }
    if (pitch <= 0.55 && (!best || pitch < best.pitch)) best = { ref: c.refdes, pitch };
  }
  return best?.ref;
}

/**
 * Plan the router invocations. A board with no fine-pitch part is routed in one
 * run. With one (a 0.35mm QFN, say) routing everything at once starves its
 * escapes -- the same nets route fine in small groups -- so the plan is:
 *   1. signal nets, in batches of 8 ordered by the fine-pitch part's pin number
 *      (neighbouring pins together), each batch's copper fixed before the next;
 *   2. small supply nets (<= 4 pins), batched;
 *   3. each big rail alone, steered onto its own inner layer (a ground pour's
 *      layer for GND, else the first inner layer no ground plane owns) so it
 *      doesn't fight the outer layers the signals just claimed.
 */
export function planStages(b: Board, nets: string[]): RouteStage[] {
  const outer = copperLayersOf(b);
  const all = signalLayers(b);
  const fine = finePitchRef(b);
  if (!fine) return [{ nets, layers: all, label: 'all nets' }];
  const wanted = new Set(nets);
  const pins = new Map(b.nets.map((n) => [n.name, n.pins]));
  const zoneNets = new Map<string, LayerId>();
  for (const z of b.zones) if (!zoneNets.has(z.net)) zoneNets.set(z.net, z.layer);
  const classOf = new Map(b.nets.map((n) => [n.name, n.class]));
  const isRail = (n: string) => classOf.get(n) === 'power' || zoneNets.has(n) || RAIL_NAME.test(n);
  const sig = nets.filter((n) => !isRail(n));
  const key = (n: string) => Math.min(Infinity, ...(pins.get(n) ?? []).filter((p) => p.startsWith(`${fine}.`)).map(numericPad));
  sig.sort((x, y) => key(x) - key(y) || x.localeCompare(y));
  const stages: RouteStage[] = [];
  const batch = (list: string[], size: number, label: string) => {
    for (let i = 0; i < list.length; i += size) stages.push({ nets: list.slice(i, i + size), layers: all, label: `${label} ${stages.length + 1}` });
  };
  batch(sig, 8, 'signals');
  const rails = nets.filter((n) => isRail(n) && wanted.has(n));
  const small = rails.filter((n) => (pins.get(n)?.length ?? 0) <= 4);
  const big = rails.filter((n) => (pins.get(n)?.length ?? 0) > 4);
  batch(small, 4, 'supplies');
  big.sort((x, y) => Number(zoneNets.has(y)) - Number(zoneNets.has(x)) || (pins.get(y)?.length ?? 0) - (pins.get(x)?.length ?? 0));
  const groundLayers = new Set(b.zones.filter((z) => /^(A|D|P)?(GND|VSS)/i.test(z.net)).map((z) => z.layer));
  const inner = outer.slice(1, -1);
  for (const n of big) {
    const own = zoneNets.get(n);
    const home = own ?? inner.find((l) => !groundLayers.has(l));
    if (!home) {
      stages.push({ nets: [n], layers: all, label: `rail ${n}` });
      continue;
    }
    const layers = [outer[0]!, home, outer[outer.length - 1]!];
    stages.push({ nets: [n], layers, costs: [4, 1, 4], label: `rail ${n}` });
  }
  return stages;
}

/**
 * Route `pcb` (as written by exportKiCadPcb for `board`) with KiCadRoutingTools
 * and return the routed `.kicad_pcb` text. Runs the stages of planStages() in
 * sequence, each one reading the previous one's output. Throws on a missing
 * install, a non-zero exit, a timeout, or no output.
 */
export async function runKiCadRouter(pcb: string, board: Board, opts: RunKiCadRouterOptions = {}): Promise<string> {
  const { dir, python } = findKiCadRoutingTools(opts.krtDir);
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.FLAMINGO_ROUTE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const nets = opts.nets && opts.nets.length > 0 ? opts.nets : board.nets.filter((n) => n.pins.length >= 2).map((n) => n.name);
  if (nets.length === 0) return pcb;
  const rules = RULESETS[board.rules];
  // Global limits come from EVERY net on the board, not just the ones in this run: routing a few rails alone
  // must not raise the global clearance to their (larger) class value.
  const rr = runRules(board, board.nets.map((n) => n.name));

  const work = await mkdtemp(join(tmpdir(), `flamingo-krt-${randomUUID()}-`));
  const fabPath = join(work, 'fab.txt');
  const netClrPath = join(work, 'net-clearances.json');
  try {
    // Declare the fab's real limits so the router never narrows a via below what Flamingo's DRC accepts.
    await writeFile(fabPath, `via_diameter = ${rr.viaDiameter}\nvia_drill = ${rr.viaDrill}\nhole_to_hole = ${rr.holeToHole}\n`, 'utf8');
    const classClearance = new Map(board.netClasses.map((c) => [c.name, Math.max(rules.minClearance, c.clearance)]));
    const netClearances: Record<string, number> = {};
    for (const n of board.nets) netClearances[n.name] = classClearance.get(n.class) ?? rr.clearance;
    await writeFile(netClrPath, JSON.stringify(netClearances), 'utf8');
    const grid = gridStepFor(board);

    const runPy = (scriptArgs: string[]): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(python, scriptArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd: dir });
        let out = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs);
        const onData = (d: Buffer) => {
          const s = d.toString('utf8');
          out += s;
          if (opts.onLog) for (const line of s.split('\n')) if (line.trim()) opts.onLog(line);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (timedOut) reject(new Error(`KiCadRoutingTools timed out after ${timeoutMs}ms`));
          else if (code !== 0) reject(new Error(`KiCadRoutingTools exited ${code}. ${errorSummary(out)}`));
          else resolve(out);
        });
      });

    let current = join(work, 'stage0.kicad_pcb');
    await writeFile(current, pcb, 'utf8');
    const stages = planStages(board, nets);
    let lastLog = '';
    const failed = new Map<string, RouteStage>();
    const failuresOf = (log: string): string[] => {
      const line = log.split('\n').find((l) => l.includes('JSON_SUMMARY:'));
      if (!line) return [];
      try {
        const d = JSON.parse(line.slice(line.indexOf('JSON_SUMMARY:') + 13)) as { failed_single?: string[]; failed_multipoint?: { net_name: string }[] };
        return [...(d.failed_single ?? []), ...(d.failed_multipoint ?? []).map((m) => m.net_name)];
      } catch {
        return [];
      }
    };
    const runStage = async (st: RouteStage, label: string, step: string): Promise<void> => {
      const next = join(work, `${step}.kicad_pcb`);
      const sr = runRules(board, st.nets);
      // Supply runs follow their net class's width, bounded to 0.15..0.3mm: not thinner than a power track should be,
      // not so wide that it blocks a fine-pitch part's escape lanes.
      if (/^(supplies|rail)/.test(st.label)) sr.trackWidth = Math.min(Math.max(sr.trackWidth, 0.15), 0.3);
      const args = [
        join(dir, 'py_router', 'route.py'),
        current,
        next,
        '--nets',
        ...st.nets,
        '--layers',
        ...st.layers,
        '--track-width',
        String(sr.trackWidth),
        // Global clearance is the board's tightest class: a net's own (larger) class clearance goes in
        // --net-clearances instead. Passing it globally makes the router refuse every pad of a dense part.
        '--clearance',
        String(rr.clearance),
        // Vias are the board's smallest on every stage: a rail's own (larger) class via does not fit
        // through a fine-pitch part's escape area, and a smaller via only lowers its current rating.
        '--via-size',
        String(rr.viaDiameter),
        '--via-drill',
        String(rr.viaDrill),
        '--board-edge-clearance',
        String(sr.copperToEdge),
        '--fab-overrides',
        fabPath,
        '--net-clearances',
        netClrPath,
      ];
      if (st.costs) args.push('--layer-costs', ...st.costs.map(String));
      if (grid !== undefined) args.push('--grid-step', String(grid));
      opts.onLog?.(`[${label}] ${st.label}: ${st.nets.join(' ')}`);
      if (process.env.FLAMINGO_KRT_DEBUG) opts.onLog?.(`[args] ${python} ${args.join(' ')}`);
      lastLog = await runPy(args);
      const bad = new Set(failuresOf(lastLog));
      if (process.env.FLAMINGO_KRT_DEBUG) opts.onLog?.(`[summary] ${st.label}: failed=${[...bad].join(',')}`);
      for (const n of st.nets) {
        if (bad.has(n)) failed.set(n, st);
        else failed.delete(n);
      }
      current = next;
    };
    for (const [i, st] of stages.entries()) await runStage(st, `stage ${i + 1}/${stages.length}`, `stage${i + 1}`);
    // Retry: the nets that still had unconnected pads get another run on their own, so the router
    // can attach the orphaned pads to the copper it already laid.
    for (let round = 1; round <= 2 && failed.size > 0; round++) {
      for (const [net, st] of [...failed.entries()]) await runStage({ ...st, nets: [net], label: `retry ${net}` }, `retry ${round}`, `retry${round}-${net.replace(/[^A-Za-z0-9]/g, '_')}`);
    }
    try {
      return await readFile(current, 'utf8');
    } catch {
      throw new Error(`KiCadRoutingTools produced no output. ${lastLog.slice(-600)}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Pad snapping
// ---------------------------------------------------------------------------

function pointInPoly(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToPoly(p: Point, poly: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/**
 * KiCadRoutingTools counts a track as connected to a pad when the track's
 * copper overlaps it, so on a 0.15mm-wide pad it can end a stub exactly on the
 * pad's edge. Flamingo's connectivity wants the track END inside the pad. For
 * every track end that touches (but is not inside) a same-net pad on its layer,
 * return a short extra segment to the pad's centre; it lies inside the pad's
 * own copper, so it adds no new copper outside the pad but the width.
 */
export function snapRoutesToPads(board: Board, tracks: Omit<Track, 'id'>[]): Omit<Track, 'id'>[] {
  const copper = copperLayersOf(board);
  const netOf = new Map<string, string>();
  for (const n of board.nets) for (const pin of n.pins) netOf.set(pin, n.name);
  type PadInfo = { poly: Point[]; centre: Point; box: [number, number, number, number]; layers: Set<string> };
  const byNet = new Map<string, PadInfo[]>();
  for (const c of board.components) {
    for (const pad of c.footprint.pads) {
      const net = netOf.get(`${c.refdes}.${pad.number}`);
      if (!net) continue;
      const poly = padOutline(c, pad);
      const xs = poly.map((p) => p.x);
      const ys = poly.map((p) => p.y);
      const centre = padWorld(c, pad).at;
      const info: PadInfo = { poly, centre, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], layers: new Set(padCopperLayers(pad, c.side, copper)) };
      const list = byNet.get(net) ?? [];
      list.push(info);
      byNet.set(net, list);
    }
  }
  const extra: Omit<Track, 'id'>[] = [];
  for (const t of tracks) {
    if (t.seg.type !== 'line') continue;
    const pads = byNet.get(t.net);
    if (!pads) continue;
    const tol = t.width / 2 + 0.02;
    for (const e of [t.seg.start, t.seg.end]) {
      let handled = false;
      const near: PadInfo[] = [];
      for (const p of pads) {
        if (!p.layers.has(t.layer)) continue;
        if (e.x < p.box[0] - tol || e.x > p.box[2] + tol || e.y < p.box[1] - tol || e.y > p.box[3] + tol) continue;
        if (pointInPoly(e, p.poly)) {
          handled = true;
          break;
        }
        if (distToPoly(e, p.poly) <= tol) near.push(p);
      }
      if (handled || near.length === 0) continue;
      const target = near[0]!.centre;
      extra.push({ layer: t.layer, width: t.width, net: t.net, seg: { type: 'line', start: { x: e.x, y: e.y }, end: { x: target.x, y: target.y } } });
    }
  }
  return extra;
}
