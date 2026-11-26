/**
 * Flamingo Engine - schematic generation
 *
 * Builds a readable schematic from a board's components and nets. Nothing is
 * stored: the board stays the single source of truth, and the sheet is laid
 * out again on every call.
 *
 * How the sheet is drawn:
 *
 * - **Blocks.** Every part with three or more pins (ICs, modules, connectors,
 *   switches) is drawn with its library symbol, and each connected pin carries
 *   a net label, a ground symbol or a supply bar. Pads on no net get a cross.
 * - **Small circuits.** Two-pin parts (R, C, L, D, ...) are drawn as real
 *   circuits. A net shared by two or more of them becomes a wire with the net
 *   name on it; parts hang from the wire up to their supply or down to
 *   ground, and parts in series continue the wire to the right. Decoupling
 *   capacitors of one supply are drawn side by side between two rails.
 * - **Groups.** Each small circuit is placed under the block it belongs to:
 *   the one sharing most signal nets with it, or for pure supply parts the
 *   nearest block on that supply on the board. Groups are then packed onto
 *   one sheet.
 *
 * A net that spans blocks is joined by name, as on any multi-block
 * schematic. `Schematic.pins` says how every pin is shown, so a caller (or a
 * test) can check the drawing against the netlist.
 */

import type { Board, ComponentInst } from '../types.js';
import type { Schematic, SchematicPin, SchematicPrim, SchematicSymbol, SymbolPin } from './types.js';
import { DIR_VEC, emptyBox, genericSymbol, growBox, naturalCompare, textWidth, turn, type Box } from './symbol.js';

export interface SchematicOpts {
  /** Library symbol for a component; a generic box is drawn when it returns nothing usable. */
  symbolFor?: (c: ComponentInst) => SchematicSymbol | undefined;
  /** Sheet title. Defaults to the board name. */
  title?: string;
}

const FONT = 7;
const CAPTION_FONT = 9;
const TITLE_FONT = 14;
/** Most two-pin parts one wire is drawn through; busier nets are joined by label. */
const MAX_WIRE_PINS = 8;
const MAX_LADDER = 10;
const CLUSTER_PAD = 12;
const CLUSTER_GAP = 16;
const SHEET_MARGIN = 24;

type NetKind = 'ground' | 'rail' | 'signal';

const GROUND_RE = /^(?:[ADP]?GND\w*|\w*GND|VSS\w*|EARTH|0V)$/i;
// A supply keyword must end the name or be followed by a digit or separator, so VSYNC and VSENSE stay signals.
const RAIL_RE =
  /^(?:\+.+|\d+V\d*|\d+\.\d+V|(?:V(?:CC|DD|EE|BUS|IN|BAT|BATT|SYS|M|MOT|REF|PP|OUT|USB|DDA|DDIO|CCIO)|[AD]VDD|[AD]VCC)(?:[_\d.+-].*)?)$/i;
const POWER_CLASS_RE = /power|supply|pwr|rail/i;

/** Ground, supply rail or signal, from the net's name and its class name. */
export function netKind(name: string, className = ''): NetKind {
  if (GROUND_RE.test(name)) return 'ground';
  if (RAIL_RE.test(name) || POWER_CLASS_RE.test(className)) return 'rail';
  return 'signal';
}

/** Refdes prefixes never drawn as an in-line two-pin part, whatever their pin count. */
const BLOCK_PREFIX_RE = /^(?:J|P|CN|CON|X|SW|S|K|BT|U|IC|M|TP|H)\d/i;

// ---------------------------------------------------------------------------
// Drawing groups
// ---------------------------------------------------------------------------

function shiftPrim(p: SchematicPrim, dx: number, dy: number): SchematicPrim {
  switch (p.t) {
    case 'line':
      return { ...p, x1: p.x1 + dx, y1: p.y1 + dy, x2: p.x2 + dx, y2: p.y2 + dy };
    case 'circle':
      return { ...p, cx: p.cx + dx, cy: p.cy + dy };
    default:
      return { ...p, x: p.x + dx, y: p.y + dy };
  }
}

class Group {
  prims: SchematicPrim[] = [];
  box: Box = emptyBox();

  get w(): number {
    return Number.isFinite(this.box.x0) ? this.box.x1 - this.box.x0 : 0;
  }
  get h(): number {
    return Number.isFinite(this.box.y0) ? this.box.y1 - this.box.y0 : 0;
  }

  line(x1: number, y1: number, x2: number, y2: number, cls = 'wire'): void {
    this.prims.push({ t: 'line', x1, y1, x2, y2, cls });
    growBox(this.box, x1, y1);
    growBox(this.box, x2, y2);
  }

  circle(cx: number, cy: number, r: number, cls: string): void {
    this.prims.push({ t: 'circle', cx, cy, r, cls });
    growBox(this.box, cx - r, cy - r);
    growBox(this.box, cx + r, cy + r);
  }

  /** Text at a baseline point. `rotation` is 0 or -90 (reads bottom to top). */
  text(x: number, y: number, text: string, cls: string, anchor: 'start' | 'middle' | 'end' = 'start', size = FONT, rotation = 0): void {
    if (text === '') return;
    this.prims.push({ t: 'text', x, y, text, size, anchor, cls, ...(rotation ? { rotation } : {}) });
    const w = textWidth(text, size);
    const before = anchor === 'start' ? 0 : anchor === 'middle' ? w / 2 : w;
    if (rotation === 0) {
      growBox(this.box, x - before, y - size);
      growBox(this.box, x - before + w, y + size * 0.25);
    } else {
      growBox(this.box, x - size, y + before - w);
      growBox(this.box, x + size * 0.25, y + before);
    }
  }

  cross(x: number, y: number): void {
    this.line(x - 2.5, y - 2.5, x + 2.5, y + 2.5, 'nc');
    this.line(x - 2.5, y + 2.5, x + 2.5, y - 2.5, 'nc');
  }

  dot(x: number, y: number): void {
    this.circle(x, y, 1.6, 'dot');
  }

  symbol(sym: SchematicSymbol, x: number, y: number, cx: number, cy: number, turns: 0 | 1 | 2 | 3, texts: boolean, refdes: string): void {
    this.prims.push({ t: 'symbol', symbol: sym, x, y, cx, cy, turns, texts, refdes });
    const b = sym.bbox;
    for (const [px, py] of [
      [b.x0, b.y0],
      [b.x1, b.y0],
      [b.x0, b.y1],
      [b.x1, b.y1],
    ] as const) {
      const [tx, ty] = turn(px - cx, py - cy, turns);
      growBox(this.box, x + tx, y + ty);
    }
    if (!texts) return;
    for (const s of sym.shapes) {
      if (s.kind !== 'text') continue;
      const w = textWidth(s.text, s.size);
      const before = s.anchor === 'start' ? 0 : s.anchor === 'middle' ? w / 2 : w;
      growBox(this.box, x + s.x - cx - before, y + s.y - cy - s.size);
      growBox(this.box, x + s.x - cx - before + w, y + s.y - cy + s.size * 0.25);
    }
  }

  /** Add `child` so that its top-left corner lands on (x, y). */
  add(child: Group, x: number, y: number): void {
    if (child.prims.length === 0) return;
    const dx = x - child.box.x0;
    const dy = y - child.box.y0;
    for (const p of child.prims) this.prims.push(shiftPrim(p, dx, dy));
    growBox(this.box, x, y);
    growBox(this.box, x + child.w, y + child.h);
  }
}

// ---------------------------------------------------------------------------
// Netlist analysis
// ---------------------------------------------------------------------------

interface Part {
  c: ComponentInst;
  ref: string;
  sym: SchematicSymbol;
  generic: boolean;
  /** Pad numbers that exist on the footprint. */
  pads: Set<string>;
  /** Pad number -> net name. */
  netOf: Map<string, string>;
}

interface End {
  kind: 'wire' | 'label' | 'ground' | 'rail' | 'nc';
  net: string | null;
  pin: SymbolPin;
}

/** A two-pin part drawn in line. */
interface Sat {
  part: Part;
  ends: [End, End];
  /** Pin-to-pin distance. */
  length: number;
  /** Body half-width across the pin axis. */
  halfWidth: number;
}

interface Unit {
  /** Parts drawn in this unit, for placing it near its block. */
  parts: Part[];
  signalNets: Set<string>;
  railNets: Set<string>;
  sortKey: string;
  build: (ctx: Ctx) => Group;
  /** Set on a lone supply-to-ground part, so several can be merged into a ladder. */
  ladder?: { key: string; sat: Sat };
}

interface Ctx {
  pins: Map<string, SchematicPin>;
}

function record(ctx: Ctx, part: Part, pin: SymbolPin, net: string | null, shown: SchematicPin['shown']): void {
  const key = `${part.ref}.${pin.number}`;
  if (!ctx.pins.has(key)) ctx.pins.set(key, { pin: key, net, shown });
}

function shortValue(c: ComponentInst): string {
  const v = (c.fields.value ?? '').trim();
  return v.length > 20 ? `${v.slice(0, 19)}…` : v;
}

function symbolUsable(sym: SchematicSymbol | undefined, netted: Iterable<string>): sym is SchematicSymbol {
  if (!sym || sym.pins.length === 0) return false;
  const numbers = new Set(sym.pins.map((p) => p.number));
  for (const n of netted) if (!numbers.has(n)) return false;
  return true;
}

function isInline(part: Part): boolean {
  if (BLOCK_PREFIX_RE.test(part.ref)) return false;
  const [a, b] = part.sym.pins;
  if (part.sym.pins.length !== 2 || !a || !b || a.number === b.number) return false;
  const horizontal = a.at.y === b.at.y && ((a.dir === 'left' && b.dir === 'right') || (a.dir === 'right' && b.dir === 'left'));
  const vertical = a.at.x === b.at.x && ((a.dir === 'up' && b.dir === 'down') || (a.dir === 'down' && b.dir === 'up'));
  return horizontal || vertical;
}

// ---------------------------------------------------------------------------
// Two-pin part drawing
// ---------------------------------------------------------------------------

/** Quarter turns that map the vector from pin `from` to the other pin onto `want`. */
function turnsFor(sat: Sat, from: 0 | 1, want: [number, number]): 0 | 1 | 2 | 3 {
  const a = sat.ends[from].pin.at;
  const b = sat.ends[from === 0 ? 1 : 0].pin.at;
  const dx = Math.sign(b.x - a.x);
  const dy = Math.sign(b.y - a.y);
  for (const t of [0, 1, 2, 3] as const) {
    const [tx, ty] = turn(dx, dy, t);
    if (tx === want[0] && ty === want[1]) return t;
  }
  return 0;
}

function placeSat(g: Group, sat: Sat, from: 0 | 1, want: [number, number], midX: number, midY: number): void {
  const a = sat.ends[0].pin.at;
  const b = sat.ends[1].pin.at;
  g.symbol(sat.part.sym, midX, midY, (a.x + b.x) / 2, (a.y + b.y) / 2, turnsFor(sat, from, want), false, sat.part.ref);
}

function inlineCaption(sat: Sat): string {
  const v = shortValue(sat.part.c);
  return v ? `${sat.part.ref} ${v}` : sat.part.ref;
}

/** Width a horizontal part needs: its own length, or its caption if wider. */
function hSpan(sat: Sat): number {
  return Math.max(sat.length, Math.ceil(textWidth(inlineCaption(sat), FONT)) + 6);
}

/**
 * Draw `sat` horizontally in [x, x + span] on the line y, pin `left` facing
 * left, with lead wires out to both ends of the span and its caption above.
 */
function hPart(g: Group, sat: Sat, left: 0 | 1, x: number, y: number, span = hSpan(sat)): void {
  const xl = x + (span - sat.length) / 2;
  const xr = xl + sat.length;
  if (xl > x) g.line(x, y, xl, y);
  if (x + span > xr) g.line(xr, y, x + span, y);
  placeSat(g, sat, left, [1, 0], (xl + xr) / 2, y);
  g.text((xl + xr) / 2, y - sat.halfWidth - 3, inlineCaption(sat), 'ref', 'middle');
}

/** Draw `sat` vertically from (x, y) down to (x, y + length), pin `top` up. Returns its right extent. */
function vPart(g: Group, sat: Sat, top: 0 | 1, x: number, y: number): number {
  placeSat(g, sat, top, [0, 1], x, y + sat.length / 2);
  const tx = x + sat.halfWidth + 3;
  const mid = y + sat.length / 2;
  const value = shortValue(sat.part.c);
  g.text(tx, value ? mid - 1 : mid + 2.5, sat.part.ref, 'ref');
  g.text(tx, mid + 7, value, 'value');
  return tx + Math.max(textWidth(sat.part.ref, FONT), textWidth(value, FONT));
}

function groundBars(g: Group, x: number, y: number, dir: [number, number], scale = 1): void {
  // Three bars across `dir`, shrinking away from the wire.
  const [dx, dy] = dir;
  const bars: Array<[number, number]> = [
    [0, 5 * scale],
    [2.5, 3.2 * scale],
    [5, 1.4 * scale],
  ];
  for (const [off, half] of bars) {
    const cx = x + dx * off;
    const cy = y + dy * off;
    g.line(cx - dy * half, cy - dx * half, cx + dy * half, cy + dx * half, 'power');
  }
}

function termDown(g: Group, ctx: Ctx, sat: Sat, i: 0 | 1, x: number, y: number): void {
  const e = sat.ends[i];
  if (e.kind === 'nc') {
    g.cross(x, y);
    record(ctx, sat.part, e.pin, null, 'nc');
    return;
  }
  g.line(x, y, x, y + 4);
  if (e.kind === 'ground') {
    groundBars(g, x, y + 4, [0, 1]);
    if (e.net !== 'GND') g.text(x, y + 17, e.net ?? '', 'power-text', 'middle');
  } else {
    g.text(x, y + 11, e.net ?? '', e.kind === 'rail' ? 'power-text' : 'net', 'middle');
  }
  record(ctx, sat.part, e.pin, e.net, e.kind === 'wire' ? 'label' : e.kind);
}

function termUp(g: Group, ctx: Ctx, sat: Sat, i: 0 | 1, x: number, y: number): void {
  const e = sat.ends[i];
  if (e.kind === 'nc') {
    g.cross(x, y);
    record(ctx, sat.part, e.pin, null, 'nc');
    return;
  }
  if (e.kind === 'rail') {
    g.line(x, y, x, y - 6);
    g.line(x - 5, y - 6, x + 5, y - 6, 'power');
    g.text(x, y - 9, e.net ?? '', 'power-text', 'middle');
  } else {
    g.line(x, y, x, y - 4);
    g.text(x, y - 6, e.net ?? '', e.kind === 'ground' ? 'power-text' : 'net', 'middle');
  }
  record(ctx, sat.part, e.pin, e.net, e.kind === 'wire' ? 'label' : e.kind);
}

function termSide(g: Group, ctx: Ctx, sat: Sat, i: 0 | 1, x: number, y: number, side: -1 | 1): void {
  const e = sat.ends[i];
  if (e.kind === 'nc') {
    g.cross(x, y);
    record(ctx, sat.part, e.pin, null, 'nc');
    return;
  }
  g.line(x, y, x + side * 4, y);
  g.text(x + side * 6, y + 2.5, e.net ?? '', e.kind === 'rail' || e.kind === 'ground' ? 'power-text' : 'net', side < 0 ? 'end' : 'start');
  record(ctx, sat.part, e.pin, e.net, e.kind === 'wire' ? 'label' : e.kind);
}

/** A two-pin part with a label or power symbol on both ends. */
function buildSingle(ctx: Ctx, sat: Sat): Group {
  const g = new Group();
  const [a, b] = sat.ends;
  const groundIdx = a.kind === 'ground' ? 0 : b.kind === 'ground' ? 1 : -1;
  const railIdx = a.kind === 'rail' ? 0 : b.kind === 'rail' ? 1 : -1;
  let top: 0 | 1 | -1 = -1;
  if (groundIdx >= 0 && a.kind !== b.kind) top = groundIdx === 0 ? 1 : 0;
  else if (railIdx >= 0 && a.kind !== b.kind) top = railIdx as 0 | 1;
  if (top >= 0) {
    const t = top as 0 | 1;
    vPart(g, sat, t, 0, 0);
    termUp(g, ctx, sat, t, 0, 0);
    termDown(g, ctx, sat, t === 0 ? 1 : 0, 0, sat.length);
    return g;
  }
  const span = hSpan(sat);
  hPart(g, sat, 0, 0, 0, span);
  termSide(g, ctx, sat, 0, 0, 0, -1);
  termSide(g, ctx, sat, 1, span, 0, 1);
  return g;
}

/** Parts between the same supply and ground, side by side between two rails. */
function buildLadder(ctx: Ctx, sats: Sat[]): Group {
  const g = new Group();
  const maxLen = Math.max(...sats.map((s) => s.length));
  const bottom = maxLen + 20;
  let x = 0;
  const xs: number[] = [];
  for (const sat of sats) {
    const top: 0 | 1 = sat.ends[0].kind === 'rail' ? 0 : 1;
    const px = x + sat.halfWidth + 2;
    const y0 = 10 + (maxLen - sat.length) / 2;
    g.line(px, 0, px, y0);
    g.line(px, y0 + sat.length, px, bottom);
    const right = vPart(g, sat, top, px, y0);
    record(ctx, sat.part, sat.ends[top].pin, sat.ends[top].net, 'rail');
    record(ctx, sat.part, sat.ends[top === 0 ? 1 : 0].pin, sat.ends[top === 0 ? 1 : 0].net, 'ground');
    xs.push(px);
    x = right + 6;
  }
  const first = xs[0]!;
  const last = xs[xs.length - 1]!;
  g.line(first, 0, last, 0);
  g.line(first, bottom, last, bottom);
  xs.slice(0, -1).forEach((px) => {
    g.dot(px, 0);
    g.dot(px, bottom);
  });
  const top: 0 | 1 = sats[0]!.ends[0].kind === 'rail' ? 0 : 1;
  const rail = sats[0]!.ends[top].net ?? '';
  const ground = sats[0]!.ends[top === 0 ? 1 : 0].net ?? '';
  g.line(first, 0, first, -6);
  g.line(first - 5, -6, first + 5, -6, 'power');
  g.text(first, -9, rail, 'power-text', 'middle');
  g.line(first, bottom, first, bottom + 4);
  groundBars(g, first, bottom + 4, [0, 1]);
  if (ground !== 'GND') g.text(first, bottom + 17, ground, 'power-text', 'middle');
  return g;
}

interface Bus {
  net: string;
  ups: Sat[];
  downs: Sat[];
  sides: Sat[];
}

interface Chain {
  buses: Bus[];
  /** links[i] joins buses[i] and buses[i + 1]; more than one means parallel parts. */
  links: Sat[][];
}

function endOn(sat: Sat, net: string): 0 | 1 {
  return sat.ends[0].kind === 'wire' && sat.ends[0].net === net ? 0 : 1;
}

/** One or more wire nets in a row, joined by series parts, with parts hanging off them. */
function buildChain(ctx: Ctx, chain: Chain): Group {
  const g = new Group();
  const first = chain.buses[0]!;
  const lastBus = chain.buses[chain.buses.length - 1]!;
  const leftLeaf = first.sides.shift();
  const rightLeaf = lastBus.sides.shift();
  let x = 0;

  if (leftLeaf) {
    const on = endOn(leftLeaf, first.net);
    const other: 0 | 1 = on === 0 ? 1 : 0;
    const span = hSpan(leftLeaf);
    hPart(g, leftLeaf, other, 0, 0, span);
    termSide(g, ctx, leftLeaf, other, 0, 0, -1);
    record(ctx, leftLeaf.part, leftLeaf.ends[on].pin, first.net, 'wire');
    x = span;
  }

  chain.buses.forEach((bus, i) => {
    const x0 = x;
    const hasRight = i < chain.buses.length - 1 || (bus === lastBus && rightLeaf !== undefined);
    g.text(x + 2, -3, bus.net, 'net');
    x += Math.max(10, Math.ceil(textWidth(bus.net, FONT)) + 6);

    // A side part there was no room for at the chain's ends hangs down, with its far net as a label.
    const downs = [...bus.downs, ...bus.sides];
    const cols = Math.max(bus.ups.length, downs.length);
    const attach: Array<{ x: number; up: boolean; down: boolean }> = [];
    for (let c = 0; c < cols; c++) {
      const up = bus.ups[c];
      const down = downs[c];
      const px = x + Math.max(up?.halfWidth ?? 0, down?.halfWidth ?? 0) + 2;
      let right = px;
      if (up) {
        const on = endOn(up, bus.net);
        const far: 0 | 1 = on === 0 ? 1 : 0;
        g.line(px, 0, px, -10);
        right = Math.max(right, vPart(g, up, far, px, -10 - up.length));
        termUp(g, ctx, up, far, px, -10 - up.length);
        record(ctx, up.part, up.ends[on].pin, bus.net, 'wire');
      }
      if (down) {
        const on = endOn(down, bus.net);
        const far: 0 | 1 = on === 0 ? 1 : 0;
        g.line(px, 0, px, 10);
        right = Math.max(right, vPart(g, down, on, px, 10));
        termDown(g, ctx, down, far, px, 10 + down.length);
        record(ctx, down.part, down.ends[on].pin, bus.net, 'wire');
      }
      attach.push({ x: px, up: up !== undefined, down: down !== undefined });
      x = right + 8;
    }

    const x1 = hasRight ? x : attach.length > 0 ? attach[attach.length - 1]!.x : x;
    if (x1 > x0) g.line(x0, 0, x1, 0);
    for (const a of attach) {
      const ways = (a.x > x0 ? 1 : 0) + (a.x < x1 ? 1 : 0) + (a.up ? 1 : 0) + (a.down ? 1 : 0);
      if (ways >= 3) g.dot(a.x, 0);
    }

    const links = chain.links[i];
    if (links && links.length > 0) {
      const span = Math.max(...links.map(hSpan));
      links.forEach((link, k) => {
        const on = endOn(link, bus.net);
        const pitch = Math.max(...links.map((l) => l.halfWidth)) * 2 + FONT + 8;
        const y = -k * pitch;
        hPart(g, link, on, x, y, span);
        if (k > 0) {
          g.line(x, 0, x, y);
          g.line(x + span, 0, x + span, y);
        }
        record(ctx, link.part, link.ends[on].pin, bus.net, 'wire');
        const far: 0 | 1 = on === 0 ? 1 : 0;
        record(ctx, link.part, link.ends[far].pin, link.ends[far].net, 'wire');
      });
      if (links.length > 1) {
        g.dot(x, 0);
        g.dot(x + span, 0);
      }
      x += span;
    }
  });

  if (rightLeaf) {
    const on = endOn(rightLeaf, lastBus.net);
    const other: 0 | 1 = on === 0 ? 1 : 0;
    const span = hSpan(rightLeaf);
    hPart(g, rightLeaf, on, x, 0, span);
    termSide(g, ctx, rightLeaf, other, x + span, 0, 1);
    record(ctx, rightLeaf.part, rightLeaf.ends[on].pin, lastBus.net, 'wire');
  }
  return g;
}

// ---------------------------------------------------------------------------
// Blocks (parts with three or more pins)
// ---------------------------------------------------------------------------

function buildBlock(ctx: Ctx, part: Part, kinds: Map<string, NetKind>): Group {
  const g = new Group();
  g.symbol(part.sym, 0, 0, 0, 0, 0, true, part.ref);
  for (const pin of part.sym.pins) {
    if (!part.pads.has(pin.number) && !part.netOf.has(pin.number)) continue;
    const net = part.netOf.get(pin.number) ?? null;
    const { x, y } = pin.at;
    if (net === null) {
      g.cross(x, y);
      record(ctx, part, pin, null, 'nc');
      continue;
    }
    const [dx, dy] = DIR_VEC[pin.dir];
    const kind = kinds.get(net) ?? 'signal';
    const ex = x + dx * 10;
    const ey = y + dy * 10;
    g.line(x, y, ex, ey);
    let textAt = 12;
    let name = net;
    if (kind === 'ground') {
      groundBars(g, ex, ey, [dx, dy], 0.75);
      textAt = 18;
      if (net === 'GND') name = '';
    } else if (kind === 'rail') {
      g.line(ex - dy * 3.5, ey - dx * 3.5, ex + dy * 3.5, ey + dx * 3.5, 'power');
      textAt = 13;
    }
    const cls = kind === 'signal' ? 'net' : 'power-text';
    if (dx !== 0) g.text(x + dx * textAt, y + 2.5, name, cls, dx < 0 ? 'end' : 'start');
    else g.text(x + 2.5, y + dy * textAt, name, cls, dy < 0 ? 'start' : 'end', FONT, -90);
    record(ctx, part, pin, net, kind === 'signal' ? 'label' : kind);
  }
  return g;
}

function caption(part: Part): Group {
  const g = new Group();
  const value = (part.c.fields.value ?? '').trim();
  g.text(0, 0, value ? `${part.ref}  ${value}` : part.ref, 'caption', 'start', CAPTION_FONT);
  const note = (part.c.fields.role ?? part.c.fields.description ?? '').trim();
  if (note) g.text(0, 10, note.length > 90 ? `${note.slice(0, 89)}…` : note, 'note');
  return g;
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

function flow(units: Group[], maxWidth: number): Group {
  const g = new Group();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const u of units) {
    if (x > 0 && x + u.w > maxWidth) {
      x = 0;
      y += rowH + 18;
      rowH = 0;
    }
    g.add(u, x, y);
    x += u.w + 24;
    rowH = Math.max(rowH, u.h);
  }
  return g;
}

/** Shelf packing; short groups are stacked in columns inside a tall shelf. */
function pack(clusters: Group[]): Group {
  const sheet = new Group();
  const todo = [...clusters].sort((a, b) => b.h - a.h || b.w - a.w);
  const area = todo.reduce((s, c) => s + (c.w + CLUSTER_GAP) * (c.h + CLUSTER_GAP), 0);
  const target = Math.max(...todo.map((c) => c.w), Math.sqrt(area * 1.7));
  let y = 0;
  while (todo.length > 0) {
    const shelfH = todo[0]!.h;
    let x = 0;
    for (;;) {
      const lead = todo.findIndex((c) => x === 0 || x + c.w <= target);
      if (lead < 0) break;
      const [c] = todo.splice(lead, 1);
      sheet.add(c!, x, y);
      const colW = c!.w;
      let colY = c!.h + CLUSTER_GAP;
      for (;;) {
        const next = todo.findIndex((n) => n.w <= colW && colY + n.h <= shelfH);
        if (next < 0) break;
        const [n] = todo.splice(next, 1);
        sheet.add(n!, x, y + colY);
        colY += n!.h + CLUSTER_GAP;
      }
      x += colW + CLUSTER_GAP;
    }
    y += shelfH + CLUSTER_GAP;
  }
  return sheet;
}

function framed(inner: Group): Group {
  const g = new Group();
  g.prims.push({ t: 'rect', x: 0, y: 0, w: inner.w + CLUSTER_PAD * 2, h: inner.h + CLUSTER_PAD * 2, cls: 'frame', rx: 4 });
  growBox(g.box, 0, 0);
  growBox(g.box, inner.w + CLUSTER_PAD * 2, inner.h + CLUSTER_PAD * 2);
  g.add(inner, CLUSTER_PAD, CLUSTER_PAD);
  return g;
}

export function buildSchematic(board: Board, opts: SchematicOpts = {}): Schematic {
  const ctx: Ctx = { pins: new Map() };
  const generic: string[] = [];

  // -- nets ----------------------------------------------------------------
  const kinds = new Map<string, NetKind>(board.nets.map((n) => [n.name, netKind(n.name, n.class)]));
  const netOfPin = new Map<string, string>();
  for (const n of board.nets) for (const p of n.pins) netOfPin.set(p, n.name);

  // -- parts ---------------------------------------------------------------
  const parts: Part[] = [];
  for (const c of [...board.components].sort((a, b) => naturalCompare(a.refdes, b.refdes))) {
    const pads = new Set(c.footprint.pads.map((p) => p.number));
    const netOf = new Map<string, string>();
    for (const pad of pads) {
      const net = netOfPin.get(`${c.refdes}.${pad}`);
      if (net !== undefined) netOf.set(pad, net);
    }
    if (pads.size === 0) continue;
    const given = opts.symbolFor?.(c);
    const usable = symbolUsable(given, netOf.keys());
    if (!usable) generic.push(c.refdes);
    parts.push({ c, ref: c.refdes, sym: usable ? given : genericSymbol([...pads]), generic: !usable, pads, netOf });
  }

  const inline = parts.filter(isInline);
  const inlineSet = new Set(inline);
  const blocks = parts.filter((p) => !inlineSet.has(p));

  // -- two-pin parts: what each end connects to ----------------------------
  const satPinsOnNet = new Map<string, number>();
  for (const p of inline) {
    const nets = p.sym.pins.map((pin) => p.netOf.get(pin.number));
    if (nets[0] !== undefined && nets[0] === nets[1]) continue; // both pins on one net: shown by label
    for (const n of nets) if (n !== undefined && kinds.get(n) === 'signal') satPinsOnNet.set(n, (satPinsOnNet.get(n) ?? 0) + 1);
  }
  const isWireNet = (n: string): boolean => {
    const count = satPinsOnNet.get(n) ?? 0;
    return count >= 2 && count <= MAX_WIRE_PINS;
  };

  const sats: Sat[] = inline.map((part) => {
    const [a, b] = part.sym.pins as [SymbolPin, SymbolPin];
    const same = part.netOf.get(a.number) !== undefined && part.netOf.get(a.number) === part.netOf.get(b.number);
    const end = (pin: SymbolPin): End => {
      const net = part.netOf.get(pin.number);
      if (net === undefined) return { kind: 'nc', net: null, pin };
      const kind = kinds.get(net) ?? 'signal';
      if (kind !== 'signal') return { kind, net, pin };
      return { kind: !same && isWireNet(net) ? 'wire' : 'label', net, pin };
    };
    const horizontal = a.at.y === b.at.y;
    const bb = part.sym.bbox;
    const halfWidth = horizontal ? Math.max(a.at.y - bb.y0, bb.y1 - a.at.y) : Math.max(a.at.x - bb.x0, bb.x1 - a.at.x);
    return {
      part,
      ends: [end(a), end(b)],
      length: Math.abs(horizontal ? b.at.x - a.at.x : b.at.y - a.at.y),
      halfWidth: Math.max(3, halfWidth),
    };
  });

  // -- chains --------------------------------------------------------------
  const wireNets = [...new Set(sats.flatMap((s) => s.ends.filter((e) => e.kind === 'wire').map((e) => e.net!)))].sort(naturalCompare);
  const linkSats = sats.filter((s) => s.ends[0].kind === 'wire' && s.ends[1].kind === 'wire');
  const neighbours = new Map<string, Set<string>>(wireNets.map((n) => [n, new Set()]));
  for (const l of linkSats) {
    neighbours.get(l.ends[0].net!)!.add(l.ends[1].net!);
    neighbours.get(l.ends[1].net!)!.add(l.ends[0].net!);
  }
  const visited = new Set<string>();
  const netChains: string[][] = [];
  const startOrder = [...wireNets].sort((a, b) => Math.min(neighbours.get(a)!.size, 2) - Math.min(neighbours.get(b)!.size, 2) || naturalCompare(a, b));
  for (const start of startOrder) {
    if (visited.has(start)) continue;
    const chain = [start];
    visited.add(start);
    for (let cur = start; ; ) {
      const next = [...neighbours.get(cur)!].filter((n) => !visited.has(n)).sort(naturalCompare)[0];
      if (next === undefined) break;
      chain.push(next);
      visited.add(next);
      cur = next;
    }
    netChains.push(chain);
  }
  const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const chainPairs = new Set<string>();
  for (const ch of netChains) for (let i = 0; i + 1 < ch.length; i++) chainPairs.add(pairKey(ch[i]!, ch[i + 1]!));
  // A series part that closes a loop or branches is drawn on its own, joined by net labels.
  for (const l of linkSats) {
    if (chainPairs.has(pairKey(l.ends[0].net!, l.ends[1].net!))) continue;
    l.ends[0].kind = 'label';
    l.ends[1].kind = 'label';
  }

  const units: Unit[] = [];
  const unitNets = (list: Sat[]): { signalNets: Set<string>; railNets: Set<string> } => {
    const signalNets = new Set<string>();
    const railNets = new Set<string>();
    for (const s of list) {
      for (const e of s.ends) {
        if (e.net === null) continue;
        if (e.kind === 'rail') railNets.add(e.net);
        else if (e.kind !== 'ground') signalNets.add(e.net);
      }
    }
    return { signalNets, railNets };
  };

  for (const nets of netChains) {
    const buses: Bus[] = nets.map((net) => ({ net, ups: [], downs: [], sides: [] }));
    const links: Sat[][] = nets.slice(0, -1).map(() => []);
    const members: Sat[] = [];
    for (const s of sats) {
      const wires = s.ends.filter((e) => e.kind === 'wire');
      if (wires.length === 0) continue;
      if (wires.length === 2) {
        const i = nets.findIndex((n, k) => k + 1 < nets.length && pairKey(n, nets[k + 1]!) === pairKey(s.ends[0].net!, s.ends[1].net!));
        if (i >= 0) {
          links[i]!.push(s);
          members.push(s);
        }
        continue;
      }
      const bus = buses.find((b) => b.net === wires[0]!.net);
      if (!bus) continue;
      const far = s.ends[endOn(s, bus.net) === 0 ? 1 : 0];
      (far.kind === 'rail' ? bus.ups : far.kind === 'ground' ? bus.downs : bus.sides).push(s);
      members.push(s);
    }
    if (members.length === 0) continue;
    units.push({
      parts: members.map((s) => s.part),
      ...unitNets(members),
      sortKey: `1${nets[0]}`,
      build: (c) => buildChain(c, { buses, links }),
    });
  }
  for (const s of sats) {
    if (s.ends.some((e) => e.kind === 'wire')) continue;
    const rail = s.ends.find((e) => e.kind === 'rail');
    const ground = s.ends.find((e) => e.kind === 'ground');
    units.push({
      parts: [s.part],
      ...unitNets([s]),
      sortKey: `2${s.part.ref}`,
      build: (c) => buildSingle(c, s),
      ...(rail && ground ? { ladder: { key: `${rail.net}\u0000${ground.net}`, sat: s } } : {}),
    });
  }

  // -- which block each unit belongs to ------------------------------------
  const blocksOnNet = new Map<string, Part[]>();
  for (const b of blocks) {
    for (const net of new Set(b.netOf.values())) {
      if (!blocksOnNet.has(net)) blocksOnNet.set(net, []);
      blocksOnNet.get(net)!.push(b);
    }
  }
  const distance = (u: Unit, b: Part): number => {
    const cx = u.parts.reduce((s, p) => s + p.c.at.x, 0) / u.parts.length;
    const cy = u.parts.reduce((s, p) => s + p.c.at.y, 0) / u.parts.length;
    return Math.hypot(cx - b.c.at.x, cy - b.c.at.y);
  };
  const nearest = (u: Unit, list: Part[]): Part | undefined =>
    [...list].sort((a, b) => distance(u, a) - distance(u, b) || naturalCompare(a.ref, b.ref))[0];
  const owner = (u: Unit): Part | undefined => {
    const shared = new Map<Part, number>();
    for (const net of u.signalNets) for (const b of blocksOnNet.get(net) ?? []) shared.set(b, (shared.get(b) ?? 0) + 1);
    if (shared.size > 0) {
      return [...shared.entries()].sort(
        ([a, na], [b, nb]) => nb - na || b.sym.pins.length - a.sym.pins.length || distance(u, a) - distance(u, b) || naturalCompare(a.ref, b.ref),
      )[0]![0];
    }
    const onRails = [...u.railNets].flatMap((net) => blocksOnNet.get(net) ?? []);
    return nearest(u, onRails.length > 0 ? onRails : blocks);
  };
  const owned = new Map<Part | undefined, Unit[]>();
  for (const u of units) {
    const o = owner(u);
    if (!owned.has(o)) owned.set(o, []);
    owned.get(o)!.push(u);
  }

  const drawUnits = (list: Unit[]): Group[] => {
    const out: Array<{ key: string; g: Group }> = [];
    const ladders = new Map<string, Sat[]>();
    for (const u of list) {
      if (u.ladder) {
        if (!ladders.has(u.ladder.key)) ladders.set(u.ladder.key, []);
        ladders.get(u.ladder.key)!.push(u.ladder.sat);
      }
    }
    const merged = new Set<Sat>();
    for (const [key, group] of ladders) {
      if (group.length < 2) continue;
      group.sort((a, b) => naturalCompare(a.part.ref, b.part.ref));
      const chunks: Sat[][] = [];
      for (let i = 0; i < group.length; i += MAX_LADDER) chunks.push(group.slice(i, i + MAX_LADDER));
      // Never leave one part over for a ladder of its own.
      if (chunks.length > 1 && chunks[chunks.length - 1]!.length === 1) chunks[chunks.length - 2]!.push(...chunks.pop()!);
      chunks.forEach((chunk, i) => {
        out.push({ key: `0${key}${String(i).padStart(4, '0')}`, g: buildLadder(ctx, chunk) });
        chunk.forEach((s) => merged.add(s));
      });
    }
    for (const u of list) {
      if (u.ladder && merged.has(u.ladder.sat)) continue;
      out.push({ key: u.sortKey, g: u.build(ctx) });
    }
    return out.sort((a, b) => naturalCompare(a.key, b.key)).map((o) => o.g);
  };

  // -- groups --------------------------------------------------------------
  const clusters: Group[] = [];
  for (const b of blocks) {
    const inner = new Group();
    const cap = caption(b);
    inner.add(cap, 0, 0);
    const block = buildBlock(ctx, b, kinds);
    inner.add(block, 0, cap.h + 8);
    const mine = drawUnits(owned.get(b) ?? []);
    if (mine.length > 0) inner.add(flow(mine, Math.max(block.w, 420)), 0, inner.h + 18);
    clusters.push(framed(inner));
  }
  const orphans = drawUnits(owned.get(undefined) ?? []);
  if (orphans.length > 0) {
    const inner = new Group();
    inner.text(0, CAPTION_FONT, 'Other parts', 'caption', 'start', CAPTION_FONT);
    inner.add(flow(orphans, 600), 0, inner.h + 10);
    clusters.push(framed(inner));
  }

  // -- sheet ---------------------------------------------------------------
  const title = opts.title ?? board.name;
  const head = new Group();
  head.text(0, TITLE_FONT, title, 'title', 'start', TITLE_FONT);
  head.text(
    0,
    TITLE_FONT + 11,
    `Schematic generated from the board netlist · ${parts.length} components · ${board.nets.length} nets · nets with the same name are connected`,
    'note',
  );
  const body = clusters.length > 0 ? pack(clusters) : new Group();
  const sheet = new Group();
  sheet.add(head, SHEET_MARGIN, SHEET_MARGIN);
  sheet.add(body, SHEET_MARGIN, SHEET_MARGIN + head.h + 14);
  const width = Math.ceil(Math.max(sheet.box.x1, SHEET_MARGIN + head.w) + SHEET_MARGIN);
  const height = Math.ceil(sheet.box.y1 + SHEET_MARGIN);
  const prims: SchematicPrim[] = [
    { t: 'rect', x: 0, y: 0, w: width, h: height, cls: 'paper' },
    { t: 'rect', x: 8, y: 8, w: width - 16, h: height - 16, cls: 'border' },
    ...sheet.prims,
  ];

  return {
    width,
    height,
    prims,
    pins: [...ctx.pins.values()].sort((a, b) => naturalCompare(a.pin, b.pin)),
    generic: generic.sort(naturalCompare),
  };
}
