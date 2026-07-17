/**
 * Flamingo Fab - Specctra SES (session) import
 *
 * Parses a Freerouting `.ses` routing result back into engine Tracks + Vias.
 *
 * Resolution semantics: Specctra `(resolution <unit> <value>)` means there are
 * `<value>` coordinate units per `<unit>`. Freerouting typically emits
 * `(resolution um 10)`, i.e. 10 units per micrometre, so each integer
 * coordinate is 1/10 µm. We therefore convert a raw coordinate C to mm by:
 *   mm = (C / value) * (unit -> mm factor)
 * with um->mm = 1/1000. The resolution inside the `(routes ...)` block governs
 * the wire/via coordinates and widths.
 *
 * Via drill/diameter are recovered from our own padstack naming convention
 * `V_<drillUm>_<diaUm>` (emitted by dsn.ts) — those numbers are always µm and
 * independent of the SES resolution.
 */

import type { Board, LayerId, Track, Via } from '@flamingo/engine';

export interface ImportSESResult {
  tracks: Omit<Track, 'id'>[];
  vias: Omit<Via, 'id'>[];
}

// ---------------------------------------------------------------------------
// S-expression parser (tolerant: atoms, quoted strings, nested lists)
// ---------------------------------------------------------------------------

type SExpr = string | SExpr[];

function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '(' || ch === ')') {
      tokens.push(ch);
      i++;
    } else if (ch === '"') {
      // quoted string — capture verbatim (spaces allowed), drop the quotes
      let j = i + 1;
      let val = '';
      while (j < n && s[j] !== '"') {
        val += s[j];
        j++;
      }
      tokens.push('\0' + val); // sentinel prefix marks a quoted string token
      i = j + 1;
    } else if (/\s/.test(ch)) {
      i++;
    } else {
      let j = i;
      let val = '';
      while (j < n && !/\s/.test(s[j]) && s[j] !== '(' && s[j] !== ')' && s[j] !== '"') {
        val += s[j];
        j++;
      }
      tokens.push(val);
      i = j;
    }
  }
  return tokens;
}

function parse(tokens: string[]): SExpr {
  let pos = 0;
  function parseList(): SExpr {
    const list: SExpr[] = [];
    while (pos < tokens.length) {
      const t = tokens[pos++];
      if (t === '(') {
        list.push(parseList());
      } else if (t === ')') {
        return list;
      } else {
        list.push(t);
      }
    }
    return list;
  }
  // Skip to first '('
  while (pos < tokens.length && tokens[pos] !== '(') pos++;
  if (pos >= tokens.length) throw new Error('importSES: no s-expression found');
  pos++; // consume '('
  return parseList();
}

function isList(e: SExpr): e is SExpr[] {
  return Array.isArray(e);
}

/** Bare atom value (strip the quoted-string sentinel if present). */
function atom(e: SExpr): string {
  if (typeof e !== 'string') throw new Error('importSES: expected atom, got list');
  return e[0] === '\0' ? e.slice(1) : e;
}

function head(e: SExpr): string | null {
  if (isList(e) && e.length > 0 && typeof e[0] === 'string') {
    return e[0][0] === '\0' ? e[0].slice(1) : e[0];
  }
  return null;
}

/** Find the first direct child list whose head equals `name`. */
function child(list: SExpr[], name: string): SExpr[] | null {
  for (const e of list) {
    if (isList(e) && head(e) === name) return e;
  }
  return null;
}

/** Find all direct child lists whose head equals `name`. */
function children(list: SExpr[], name: string): SExpr[][] {
  const out: SExpr[][] = [];
  for (const e of list) {
    if (isList(e) && head(e) === name) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const UNIT_TO_MM: Record<string, number> = {
  um: 1 / 1000,
  mm: 1,
  cm: 10,
  inch: 25.4,
  mil: 0.0254,
};

function resolutionFactor(routes: SExpr[]): number {
  const res = child(routes, 'resolution');
  if (!res) return 1 / 1000; // default: assume um 1
  const unit = atom(res[1]);
  const value = Number(atom(res[2]));
  const unitMm = UNIT_TO_MM[unit];
  if (unitMm === undefined) throw new Error(`importSES: unknown resolution unit "${unit}"`);
  if (!Number.isFinite(value) || value === 0) {
    throw new Error(`importSES: invalid resolution value "${atom(res[2])}"`);
  }
  return unitMm / value;
}

// ---------------------------------------------------------------------------
// Via padstack name -> drill/diameter (mm)
// ---------------------------------------------------------------------------

function viaDimsFromName(name: string): { drill: number; diameter: number } {
  const m = /^V_(\d+)_(\d+)$/.exec(name);
  if (!m) {
    // Unknown padstack name: fall back to a sane default via (0.3 / 0.6 mm).
    return { drill: 0.3, diameter: 0.6 };
  }
  return { drill: Number(m[1]) / 1000, diameter: Number(m[2]) / 1000 };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function importSES(ses: string, b?: Board): ImportSESResult {
  const root = parse(tokenize(ses)); // contents of the top-level (session ...)
  if (!isList(root)) throw new Error('importSES: malformed session');

  const routes = child(root, 'routes');
  if (!routes) throw new Error('importSES: no (routes ...) block found');

  const factor = resolutionFactor(routes);
  const networkOut = child(routes, 'network_out');
  if (!networkOut) return { tracks: [], vias: [] };

  // When a board is supplied, only keep nets that actually exist on it
  // (defensive — freerouting only ever emits nets we declared).
  const knownNets = b ? new Set(b.nets.map((n) => n.name)) : null;

  const tracks: Omit<Track, 'id'>[] = [];
  const vias: Omit<Via, 'id'>[] = [];

  for (const net of children(networkOut, 'net')) {
    const netName = atom(net[1]);
    if (knownNets && !knownNets.has(netName)) continue;

    for (const wire of children(net, 'wire')) {
      const path = child(wire, 'path');
      if (!path) continue;
      const layer = atom(path[1]) as LayerId;
      const width = Number(atom(path[2])) * factor;
      const nums: number[] = [];
      for (let i = 3; i < path.length; i++) {
        const e = path[i];
        if (typeof e === 'string') nums.push(Number(atom(e)) * factor);
      }
      // consecutive (x,y) pairs -> line tracks
      for (let i = 0; i + 3 < nums.length; i += 2) {
        tracks.push({
          layer,
          width,
          net: netName,
          seg: {
            type: 'line',
            start: { x: nums[i], y: nums[i + 1] },
            end: { x: nums[i + 2], y: nums[i + 3] },
          },
        });
      }
    }

    for (const via of children(net, 'via')) {
      const padName = atom(via[1]);
      const x = Number(atom(via[2])) * factor;
      const y = Number(atom(via[3])) * factor;
      const { drill, diameter } = viaDimsFromName(padName);
      vias.push({ at: { x, y }, drill, diameter, net: netName });
    }
  }

  return { tracks, vias };
}
