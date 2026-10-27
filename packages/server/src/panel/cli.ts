/**
 * `flamingo panel <command> <file.flamboyance> ...`
 *
 * The panel MCP tools as shell commands. Each command opens the panel file,
 * does one thing through the same PanelSession the server uses, saves, and
 * prints the same report the matching MCP tool returns. No server is needed.
 *
 * Undo and redo have no command: the op log lives in memory, as it does for
 * boards, and a command is a process of its own. Use the server (MCP
 * panel_undo / panel_redo, or the browser) or version control.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Objective, PanelOp, PanelOpError, PanelOpResult, Rotation, Separation, SettingsPatch } from '@flamingo/panel';
import { OBJECTIVES, PANEL_EXTENSION, newPanel, settingsFromLimits } from '@flamingo/panel';
import { loadPanelLimits } from '@flamingo/panel/node';
import { fetchJlcStock, fetchPart } from '@flamingo/parts';
import { PanelDoc } from './doc.js';
import {
  fmt,
  formatArrange,
  formatIssues,
  formatPanelQuote,
  formatQuote,
  formatView,
} from './format.js';
import { partLookupFrom } from './parts.js';
import { PanelSession } from './session.js';

export const PANEL_USAGE = `Usage: flamingo panel <command> <file${PANEL_EXTENSION}> [arguments]

  new <file> [--name NAME]                        create an empty panel
  show <file>                                     summary of the panel
  add-board <file> <board.flamingo> [--key K] [--needed N]
  remove-board <file> <key>
  refresh <file> [key ...]                        accept source boards as they are on disk
  set-quantity <file> <key> --needed N
  add-instance <file> <key> [--x X --y Y] [--rotation 0|90|180|270] [--bare] [--count N]
  remove-instance <file> <id>
  move-instance <file> <id> --x X --y Y [--no-pin]
  rotate-instance <file> <id> [--rotation R | --by DEG]
  set-populate <file> <id> <true|false>
  pin <file> <id> [--unpin]
  set <file> [--separation mouse-bite|solid-tab|silk-divider|v-cut] [--spacing MM]
             [--rail-top MM] [--rail-bottom MM] [--rail-left MM] [--rail-right MM]
             [--tab-width MM] [--tab-pitch MM] [--fiducials on|off]
             [--tooling-holes on|off] [--layers auto|2|4|6] [--rotation-step DEG]
             [--name NAME]
  arrange <file> [--no-rotate] [--rotation-step DEG]
  check <file>                                    exit status 1 when there are errors
  screenshot <file> [--out panel.png] [--width PX] [--view layout|fab]
  quote <file> [--objective total|per-board|overage] [--brief] [--json] [--offline]
  apply-scenario <file> <scenario-id>
  export <file> [--out DIR] [--waive]

Undo and redo are available in the server (panel_undo, panel_redo) and in the
browser; the op log is not kept between commands.`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['bare', 'no-pin', 'unpin', 'no-rotate', 'brief', 'json', 'offline', 'waive', 'help']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) flags.set(name, a.slice(eq + 1));
    else if (BOOLEAN_FLAGS.has(name)) flags.set(name, true);
    else {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      flags.set(name, value);
    }
  }
  return { positional, flags };
}

function number(args: Args, name: string): number | undefined {
  const v = args.flags.get(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === true || !Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

function string(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  if (v === undefined) return undefined;
  if (v === true) throw new Error(`--${name} needs a value`);
  return v;
}

function onOff(args: Args, name: string): boolean | undefined {
  const v = string(args, name);
  if (v === undefined) return undefined;
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false') return false;
  throw new Error(`--${name} must be on or off`);
}

function rotation(v: number | undefined): Rotation | undefined {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v)) throw new Error('rotation must be a number of degrees');
  return v;
}

function need(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`missing ${what}\n\n${PANEL_USAGE}`);
  return value;
}

function done(r: PanelOpResult | PanelOpError, message: string): string {
  if (!r.ok) throw new Error(r.error);
  return message;
}

export interface PanelCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Run one panel command. Returns the process exit status. */
export async function runPanelCli(argv: string[], io: PanelCliIo = { out: console.log, err: console.error }): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const [command, fileArg, ...rest] = args.positional;
  if (!command || command === 'help' || args.flags.has('help')) {
    io.out(PANEL_USAGE);
    return command ? 0 : 2;
  }

  let session: PanelSession | undefined;
  try {
    const file = resolve(process.cwd(), need(fileArg, 'panel file'));
    const projectDir = dirname(file);
    const limits = loadPanelLimits();
    const offline = args.flags.has('offline');

    let doc: PanelDoc;
    if (command === 'new') {
      if (existsSync(file)) throw new Error(`${file} already exists`);
      const name = string(args, 'name') ?? basename(file, PANEL_EXTENSION);
      doc = new PanelDoc(newPanel(name, settingsFromLimits(limits)), file);
    } else {
      if (!existsSync(file)) throw new Error(`${file} does not exist (create it with: flamingo panel new ${fileArg})`);
      doc = await PanelDoc.load(file);
    }
    session = new PanelSession(
      {
        projectDir,
        limits,
        ...(offline ? {} : { partLookup: partLookupFrom({ fetchStock: fetchJlcStock, fetchPart }) }),
      },
      doc,
    );
    const s = session;

    let status = 0;
    switch (command) {
      case 'new': {
        await doc.save();
        io.out(`Created panel "${doc.panel.name}" — ${file}`);
        return 0;
      }
      case 'show': {
        io.out(formatView(await s.view()));
        return 0;
      }
      case 'add-board': {
        const r = await s.addBoard(resolve(process.cwd(), need(rest[0], 'board file')), {
          key: string(args, 'key'),
          needed: number(args, 'needed'),
        });
        if (!r.ok) throw new Error(r.error);
        io.out(`Added board ${r.key} = "${r.name}" (${fmt(r.width)} x ${fmt(r.height)} mm, ${r.layers}-layer)`);
        break;
      }
      case 'remove-board': {
        const key = need(rest[0], 'board key');
        io.out(done(s.apply({ op: 'removeSource', key }), `Removed board ${key} and its instances`));
        break;
      }
      case 'refresh': {
        const r = await s.refreshSources(rest.length > 0 ? rest : undefined);
        if (!r.ok) throw new Error(r.error);
        io.out(r.refreshed.length === 0 ? 'Nothing to refresh: no board changed.' : `Refreshed ${r.refreshed.join(', ')}`);
        break;
      }
      case 'set-quantity': {
        const key = need(rest[0], 'board key');
        const r = s.apply({ op: 'setQuantity', key, needed: number(args, 'needed') });
        if (!r.ok) throw new Error(r.error);
        const src = r.panel.sources.find((x) => x.key === key)!;
        io.out(`${key}: need ${src.needed}`);
        break;
      }
      case 'add-instance': {
        const key = need(rest[0], 'board key');
        const x = number(args, 'x');
        const y = number(args, 'y');
        const positioned = x !== undefined || y !== undefined;
        const count = number(args, 'count') ?? 1;
        if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer');
        const op: PanelOp = {
          op: 'addInstance',
          source: key,
          ...(positioned ? { at: { x: x ?? 0, y: y ?? 0 } } : {}),
          ...(rotation(number(args, 'rotation')) !== undefined ? { rotation: rotation(number(args, 'rotation'))! } : {}),
          populate: !args.flags.has('bare'),
          pinned: positioned,
        };
        const r = s.apply(count === 1 ? op : { op: 'transaction', ops: Array.from({ length: count }, () => op) });
        if (!r.ok) throw new Error(r.error);
        io.out(`Added ${r.created.join(', ')}${positioned ? '' : ' (unplaced: run arrange)'}`);
        break;
      }
      case 'remove-instance': {
        const id = need(rest[0], 'instance id');
        io.out(done(s.apply({ op: 'removeInstance', id }), `Removed ${id}`));
        break;
      }
      case 'move-instance': {
        const id = need(rest[0], 'instance id');
        const x = number(args, 'x');
        const y = number(args, 'y');
        if (x === undefined || y === undefined) throw new Error('move-instance needs --x and --y');
        const pin = !args.flags.has('no-pin');
        io.out(done(s.apply({ op: 'moveInstance', id, at: { x, y }, pin }), `Moved ${id} to (${fmt(x)}, ${fmt(y)})${pin ? ', pinned' : ''}`));
        break;
      }
      case 'rotate-instance': {
        const id = need(rest[0], 'instance id');
        const r = await s.rotateInstance(id, { rotation: rotation(number(args, 'rotation')), by: number(args, 'by') });
        if (!r.ok) throw new Error(r.error);
        const inst = r.panel.instances.find((i) => i.id === id)!;
        io.out(`Rotated ${id} to ${inst.rotation}, now at (${fmt(inst.at.x)}, ${fmt(inst.at.y)})`);
        break;
      }
      case 'set-populate': {
        const id = need(rest[0], 'instance id');
        const v = need(rest[1], 'true or false');
        if (v !== 'true' && v !== 'false') throw new Error('set-populate takes true or false');
        io.out(done(s.apply({ op: 'setPopulate', id, populate: v === 'true' }), `${id} is now ${v === 'true' ? 'populated' : 'bare'}`));
        break;
      }
      case 'pin': {
        const id = need(rest[0], 'instance id');
        const pinned = !args.flags.has('unpin');
        io.out(done(s.apply({ op: 'setPinned', id, pinned }), `${id} is now ${pinned ? 'pinned' : 'unpinned'}`));
        break;
      }
      case 'set': {
        const rails = {
          ...(number(args, 'rail-top') !== undefined ? { top: number(args, 'rail-top')! } : {}),
          ...(number(args, 'rail-bottom') !== undefined ? { bottom: number(args, 'rail-bottom')! } : {}),
          ...(number(args, 'rail-left') !== undefined ? { left: number(args, 'rail-left')! } : {}),
          ...(number(args, 'rail-right') !== undefined ? { right: number(args, 'rail-right')! } : {}),
        };
        const tabs = {
          ...(number(args, 'tab-width') !== undefined ? { width: number(args, 'tab-width')! } : {}),
          ...(number(args, 'tab-pitch') !== undefined ? { pitch: number(args, 'tab-pitch')! } : {}),
        };
        const layersRaw = string(args, 'layers');
        const layers = layersRaw === undefined ? undefined : layersRaw === 'auto' ? 'auto' : Number(layersRaw);
        if (layers !== undefined && layers !== 'auto' && ![2, 4, 6].includes(layers)) {
          throw new Error('--layers must be auto, 2, 4 or 6');
        }
        const separation = string(args, 'separation');
        if (separation !== undefined && !['mouse-bite', 'solid-tab', 'silk-divider', 'v-cut'].includes(separation)) {
          throw new Error('--separation must be mouse-bite, solid-tab, silk-divider or v-cut');
        }
        const settings: SettingsPatch = {
          ...(separation !== undefined ? { separation: separation as Separation } : {}),
          ...(number(args, 'spacing') !== undefined ? { spacing: number(args, 'spacing')! } : {}),
          ...(Object.keys(rails).length > 0 ? { rails } : {}),
          ...(Object.keys(tabs).length > 0 ? { tabs } : {}),
          ...(onOff(args, 'fiducials') !== undefined ? { fiducials: { enabled: onOff(args, 'fiducials')! } } : {}),
          ...(onOff(args, 'tooling-holes') !== undefined ? { toolingHoles: { enabled: onOff(args, 'tooling-holes')! } } : {}),
          ...(layers !== undefined ? { copperLayers: layers as 'auto' | 2 | 4 | 6 } : {}),
          ...(number(args, 'rotation-step') !== undefined ? { rotationStep: number(args, 'rotation-step')! } : {}),
        };
        const ops: PanelOp[] = [];
        if (Object.keys(settings).length > 0) ops.push({ op: 'setSettings', settings });
        if (string(args, 'name') !== undefined) ops.push({ op: 'setName', name: string(args, 'name')! });
        if (ops.length === 0) throw new Error('set needs at least one setting');
        io.out(done(s.apply(ops.length === 1 ? ops[0]! : { op: 'transaction', ops }), 'Settings updated.'));
        break;
      }
      case 'arrange': {
        const r = await s.arrange({
          rotate: !args.flags.has('no-rotate'),
          ...(number(args, 'rotation-step') !== undefined ? { rotationStep: number(args, 'rotation-step')! } : {}),
        });
        io.out(formatArrange(r));
        if (!r.ok) status = 1;
        break;
      }
      case 'check': {
        const issues = await s.check();
        io.out(formatIssues(issues));
        return s.hasErrors(issues) ? 1 : 0;
      }
      case 'screenshot': {
        const out = resolve(process.cwd(), string(args, 'out') ?? `${basename(file, PANEL_EXTENSION)}.png`);
        const view = string(args, 'view') ?? 'layout';
        if (view !== 'layout' && view !== 'fab') {
          io.err(`--view must be layout or fab, not "${view}"`);
          return 2;
        }
        await writeFile(out, await s.renderPng(number(args, 'width'), view));
        io.out(`Wrote ${out}`);
        return 0;
      }
      case 'quote': {
        const objective = string(args, 'objective') ?? 'total';
        if (!(OBJECTIVES as readonly string[]).includes(objective)) {
          throw new Error(`--objective must be one of ${OBJECTIVES.join(', ')}`);
        }
        await s.loadPrices(await s.resolved());
        const result = await s.quote(objective as Objective);
        if (args.flags.has('json')) {
          io.out(JSON.stringify({ panel: (await s.view()).quote, ...result }, null, 2));
        } else {
          io.out(
            ['THE PANEL AS IT STANDS', formatPanelQuote(await s.view()), '', 'ALTERNATIVES', formatQuote(result, !args.flags.has('brief'))].join('\n'),
          );
        }
        return 0;
      }
      case 'apply-scenario': {
        const id = need(rest[0], 'scenario id');
        await s.loadPrices(await s.resolved());
        const r = await s.applyScenario(id);
        if (!r.ok) throw new Error(r.error);
        io.out(
          r.loaded
            ? `Loaded scenario "${id}" (${r.scenario.title}): ${r.scenario.summary}`
            : `Scenario "${id}" orders single boards: there is no panel to load.`,
        );
        break;
      }
      case 'export': {
        const out = string(args, 'out');
        const r = await s.exportFab({
          ...(out !== undefined ? { outDir: resolve(process.cwd(), out) } : {}),
          waive: args.flags.has('waive'),
        });
        if (!r.ok) {
          io.err(r.blocking ? `${formatIssues(r.blocking)}\n\nExport refused; fix the error(s) above or pass --waive.` : r.error);
          return 1;
        }
        io.out(`Exported panel fab outputs to ${r.outDir}:`);
        for (const f of [r.result.gerberZip, r.result.bomCsv, r.result.cplCsv, r.result.renderSvg, r.result.fabSvg]) io.out(`  ${f}`);
        io.out(`Placed by assembly: ${r.result.placed} component(s). Left off (bare instances): ${r.result.skipped}.`);
        for (const n of r.result.notes) io.out(`Note: ${n}`);
        if (r.waived.length > 0) io.out(`Waived ${r.waived.length} error(s):\n${formatIssues(r.waived)}`);
        return 0;
      }
      default:
        io.err(`Unknown panel command "${command}"\n\n${PANEL_USAGE}`);
        return 2;
    }
    await doc.save();
    return status;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    // Nothing here may rewrite the file: every command that changes the panel
    // has saved it explicitly above.
    session?.removeAllListeners();
  }
}
