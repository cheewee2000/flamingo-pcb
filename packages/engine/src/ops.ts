import type {
  Board,
  ComponentInst,
  Footprint,
  Keepout,
  MountingHole,
  NetClass,
  Point,
  PathSeg,
  SilkText,
  Dimension,
  SilkLine,
  Track,
  Via,
  Zone,
} from './types.js';
import { copperLayersOf, isCopper } from './layers.js';

/**
 * Discriminated union of all board-mutating operations.
 * Later tasks (server, MCP, UI) construct these objects by name — the shape
 * is binding.
 */
export type Op =
  | {
      op: 'placeComponent';
      refdes: string;
      lcsc: string;
      footprint: Footprint;
      at: Point;
      rotation: number;
      side: 'top' | 'bottom';
      fields: ComponentInst['fields'];
    }
  | { op: 'moveComponent'; refdes: string; at?: Point; rotation?: number; side?: 'top' | 'bottom' }
  | { op: 'moveComponents'; moves: Array<{ refdes: string; at: Point }> }
  | { op: 'setComponentFields'; refdes: string; fields: Partial<ComponentInst['fields']> }
  | { op: 'editHole'; id: string; hole: Partial<Omit<MountingHole, 'id'>> }
  | { op: 'editKeepout'; id: string; keepout: Partial<Omit<Keepout, 'id'>> }
  | { op: 'removeComponent'; refdes: string }
  | { op: 'setOutline'; outline: PathSeg[] }
  | { op: 'addKeepout'; keepout: Omit<Keepout, 'id'> }
  | { op: 'addZone'; zone: Omit<Zone, 'id' | 'fill'> }
  | { op: 'addHole'; hole: Omit<MountingHole, 'id'> }
  | { op: 'addSilkText'; text: Omit<SilkText, 'id'> }
  | { op: 'addSilkLine'; line: Omit<SilkLine, 'id'> }
  | { op: 'addDimension'; dimension: Omit<Dimension, 'id'> }
  | { op: 'removeItem'; id: string }
  | { op: 'connectPins'; net: string; pins: string[] }
  | { op: 'disconnectPins'; pins: string[] }
  | { op: 'renameNet'; from: string; to: string }
  | { op: 'createNetClass'; netClass: NetClass }
  | { op: 'assignNetClass'; net: string; class: string }
  | { op: 'addTrack'; track: Omit<Track, 'id'> }
  | { op: 'addVia'; via: Omit<Via, 'id'> }
  | { op: 'addTracks'; tracks: Omit<Track, 'id'>[]; vias: Omit<Via, 'id'>[] }
  | { op: 'unroute'; net?: string }
  | { op: 'setBoardMeta'; name?: string; copperLayers?: 2 | 4 | 6 };

export interface OpResult {
  ok: true;
  board: Board;
  createdIds: string[];
}

export interface OpError {
  ok: false;
  error: string;
}

const RULES_MAP: Record<2 | 4 | 6, 'jlcpcb-2l' | 'jlcpcb-4l' | 'jlcpcb-6l'> = {
  2: 'jlcpcb-2l',
  4: 'jlcpcb-4l',
  6: 'jlcpcb-6l',
};

function ok(board: Board, createdIds: string[]): OpResult {
  return { ok: true, board, createdIds };
}

function err(error: string): OpError {
  return { ok: false, error };
}

const PIN_RE = /^([^.]+)\.([^.]+)$/;

function parsePin(pin: string): { refdes: string; pad: string } | null {
  const m = PIN_RE.exec(pin);
  if (!m) return null;
  return { refdes: m[1], pad: m[2] };
}

/**
 * Validate that a pin ref ("REFDES.PADNUMBER") is well-formed and refers to
 * an existing refdes + pad number on that component's footprint.
 */
function validatePinRef(board: Board, pin: string): OpError | null {
  const parsed = parsePin(pin);
  if (!parsed) {
    return err(`Invalid pin format "${pin}" (expected REFDES.PADNUMBER)`);
  }
  const comp = board.components.find((c) => c.refdes === parsed.refdes);
  if (!comp) {
    return err(`Unknown refdes "${parsed.refdes}" (in pin "${pin}")`);
  }
  const pad = comp.footprint.pads.find((p) => p.number === parsed.pad);
  if (!pad) {
    return err(`Pad "${parsed.pad}" not found on footprint of "${parsed.refdes}" (pin "${pin}")`);
  }
  return null;
}

/**
 * Apply a single Op to a Board, returning a new Board (structuredClone) or an
 * error. Never mutates the input board. Never throws for validation failures
 * — throwing is reserved for programmer errors.
 */
export function applyOp(b: Board, op: Op): OpResult | OpError {
  const board = structuredClone(b);
  op = structuredClone(op);
  const createdIds: string[] = [];

  switch (op.op) {
    case 'placeComponent': {
      if (board.components.some((c) => c.refdes === op.refdes)) {
        return err(`Component with refdes "${op.refdes}" already exists`);
      }
      const comp: ComponentInst = {
        refdes: op.refdes,
        lcsc: op.lcsc,
        footprint: op.footprint,
        at: op.at,
        rotation: op.rotation,
        side: op.side,
        fields: op.fields,
      };
      board.components.push(comp);
      return ok(board, createdIds);
    }

    case 'moveComponent': {
      const comp = board.components.find((c) => c.refdes === op.refdes);
      if (!comp) return err(`Unknown refdes "${op.refdes}"`);
      if (op.at !== undefined) comp.at = op.at;
      if (op.rotation !== undefined) comp.rotation = op.rotation;
      if (op.side !== undefined) comp.side = op.side;
      return ok(board, createdIds);
    }

    case 'moveComponents': {
      // Group move as ONE op so a single undo restores every position.
      // Validate all refs before touching anything.
      for (const move of op.moves) {
        if (!board.components.some((c) => c.refdes === move.refdes)) {
          return err(`Unknown refdes "${move.refdes}"`);
        }
      }
      for (const move of op.moves) {
        const comp = board.components.find((c) => c.refdes === move.refdes)!;
        comp.at = move.at;
      }
      return ok(board, createdIds);
    }

    case 'setComponentFields': {
      const comp = board.components.find((c) => c.refdes === op.refdes);
      if (!comp) return err(`Unknown refdes "${op.refdes}"`);
      comp.fields = { ...comp.fields, ...op.fields };
      return ok(board, createdIds);
    }

    case 'editHole': {
      const hole = board.holes.find((h) => h.id === op.id);
      if (!hole) return err(`No hole with id "${op.id}"`);
      const patch = op.hole;
      if (patch.drill !== undefined && !(patch.drill > 0)) return err('drill must be > 0');
      Object.assign(hole, patch);
      // A slotLength at or below the drill means "plain round hole".
      if (hole.slotLength !== undefined && hole.slotLength <= hole.drill) {
        delete hole.slotLength;
        delete hole.rotation;
      }
      return ok(board, createdIds);
    }

    case 'editKeepout': {
      const keepout = board.keepouts.find((k) => k.id === op.id);
      if (!keepout) return err(`No keepout with id "${op.id}"`);
      if (op.keepout.polygon !== undefined && op.keepout.polygon.length < 3) {
        return err('keepout polygon needs at least 3 points');
      }
      Object.assign(keepout, op.keepout);
      return ok(board, createdIds);
    }

    case 'removeComponent': {
      const idx = board.components.findIndex((c) => c.refdes === op.refdes);
      if (idx === -1) return err(`Unknown refdes "${op.refdes}"`);
      board.components.splice(idx, 1);
      const prefix = `${op.refdes}.`;
      for (const net of board.nets) {
        net.pins = net.pins.filter((p) => !p.startsWith(prefix));
      }
      return ok(board, createdIds);
    }

    case 'setOutline': {
      board.outline = op.outline;
      return ok(board, createdIds);
    }

    case 'addKeepout': {
      const id = globalThis.crypto.randomUUID();
      const keepout: Keepout = { id, ...op.keepout };
      board.keepouts.push(keepout);
      createdIds.push(id);
      return ok(board, createdIds);
    }

    case 'addZone': {
      const id = globalThis.crypto.randomUUID();
      const zone: Zone = { id, ...op.zone };
      board.zones.push(zone);
      createdIds.push(id);
      return ok(board, createdIds);
    }

    case 'addHole': {
      const id = globalThis.crypto.randomUUID();
      const hole: MountingHole = { id, ...op.hole };
      board.holes.push(hole);
      createdIds.push(id);
      return ok(board, createdIds);
    }

    case 'addSilkText': {
      const id = globalThis.crypto.randomUUID();
      const text: SilkText = { id, ...op.text };
      board.silk.push(text);
      createdIds.push(id);
      return ok(board, createdIds);
    }

    case 'addSilkLine': {
      const id = globalThis.crypto.randomUUID();
      const line: SilkLine = { id, ...op.line };
      board.silkLines.push(line);
      createdIds.push(id);
      return ok(board, createdIds);
    }

    case 'addDimension': {
      const id = globalThis.crypto.randomUUID();
      const dimension: Dimension = { id, ...op.dimension };
      board.dimensions.push(dimension);
      createdIds.push(id);
      return ok(board, createdIds);
    }

    case 'removeItem': {
      const collections: Array<{ id: string }[]> = [
        board.keepouts,
        board.zones,
        board.holes,
        board.silk,
        board.silkLines,
        board.tracks,
        board.vias,
        board.dimensions,
      ];
      for (const arr of collections) {
        const idx = arr.findIndex((item) => item.id === op.id);
        if (idx !== -1) {
          arr.splice(idx, 1);
          return ok(board, createdIds);
        }
      }
      return err(
        `No item with id "${op.id}" found in keepouts/zones/holes/silk/silkLines/tracks/vias/dimensions`,
      );
    }

    case 'connectPins': {
      for (const pin of op.pins) {
        const validationError = validatePinRef(board, pin);
        if (validationError) return validationError;
      }
      for (const pin of op.pins) {
        const conflicting = board.nets.find(
          (n) => n.name !== op.net && n.pins.includes(pin),
        );
        if (conflicting) {
          return err(`Pin "${pin}" already belongs to net "${conflicting.name}"`);
        }
      }
      let net = board.nets.find((n) => n.name === op.net);
      if (!net) {
        net = { name: op.net, class: 'default', pins: [] };
        board.nets.push(net);
      }
      for (const pin of op.pins) {
        if (!net.pins.includes(pin)) net.pins.push(pin);
      }
      return ok(board, createdIds);
    }

    case 'disconnectPins': {
      for (const pin of op.pins) {
        const inAnyNet = board.nets.some((n) => n.pins.includes(pin));
        if (!inAnyNet) return err(`Unknown pin "${pin}" (not connected to any net)`);
      }
      for (const net of board.nets) {
        net.pins = net.pins.filter((p) => !op.pins.includes(p));
      }
      return ok(board, createdIds);
    }

    case 'renameNet': {
      const net = board.nets.find((n) => n.name === op.from);
      if (!net) return err(`Unknown net "${op.from}"`);
      if (board.nets.some((n) => n.name === op.to)) {
        return err(`Net "${op.to}" already exists`);
      }
      net.name = op.to;
      for (const t of board.tracks) if (t.net === op.from) t.net = op.to;
      for (const v of board.vias) if (v.net === op.from) v.net = op.to;
      for (const z of board.zones) if (z.net === op.from) z.net = op.to;
      return ok(board, createdIds);
    }

    case 'createNetClass': {
      if (board.netClasses.some((c) => c.name === op.netClass.name)) {
        return err(`Net class "${op.netClass.name}" already exists`);
      }
      board.netClasses.push(op.netClass);
      return ok(board, createdIds);
    }

    case 'assignNetClass': {
      const net = board.nets.find((n) => n.name === op.net);
      if (!net) return err(`Unknown net "${op.net}"`);
      const cls = board.netClasses.find((c) => c.name === op.class);
      if (!cls) return err(`Unknown net class "${op.class}"`);
      net.class = op.class;
      return ok(board, createdIds);
    }

    case 'addTrack': {
      if (!board.nets.some((n) => n.name === op.track.net)) {
        return err(`Unknown net "${op.track.net}"`);
      }
      const validLayers = copperLayersOf(board);
      if (!validLayers.includes(op.track.layer)) {
        return err(
          `Layer "${op.track.layer}" is not valid for a ${board.copperLayers}-layer board`,
        );
      }
      const id = globalThis.crypto.randomUUID();
      const track: Track = { id, ...op.track };
      board.tracks.push(track);
      createdIds.push(id);
      return ok(board, createdIds);
    }

    case 'addVia': {
      if (!board.nets.some((n) => n.name === op.via.net)) {
        return err(`Unknown net "${op.via.net}"`);
      }
      const id = globalThis.crypto.randomUUID();
      const via: Via = { id, ...op.via };
      board.vias.push(via);
      createdIds.push(id);
      return ok(board, createdIds);
    }

    case 'addTracks': {
      const validLayers = copperLayersOf(board);
      for (const t of op.tracks) {
        if (!board.nets.some((n) => n.name === t.net)) {
          return err(`Unknown net "${t.net}"`);
        }
        if (!validLayers.includes(t.layer)) {
          return err(
            `Layer "${t.layer}" is not valid for a ${board.copperLayers}-layer board`,
          );
        }
      }
      for (const v of op.vias) {
        if (!board.nets.some((n) => n.name === v.net)) {
          return err(`Unknown net "${v.net}"`);
        }
      }
      const trackIds = op.tracks.map((t) => {
        const id = globalThis.crypto.randomUUID();
        board.tracks.push({ id, ...t });
        return id;
      });
      const viaIds = op.vias.map((v) => {
        const id = globalThis.crypto.randomUUID();
        board.vias.push({ id, ...v });
        return id;
      });
      createdIds.push(...trackIds, ...viaIds);
      return ok(board, createdIds);
    }

    case 'unroute': {
      if (op.net !== undefined) {
        const net = op.net;
        board.tracks = board.tracks.filter((t) => t.net !== net);
        board.vias = board.vias.filter((v) => v.net !== net);
      } else {
        board.tracks = [];
        board.vias = [];
      }
      return ok(board, createdIds);
    }

    case 'setBoardMeta': {
      if (op.name !== undefined) board.name = op.name;
      if (op.copperLayers !== undefined) {
        const newCopperLayers = op.copperLayers;
        const newValidLayers = copperLayersOf({
          ...board,
          copperLayers: newCopperLayers,
        } as Board);
        for (const t of board.tracks) {
          if (!newValidLayers.includes(t.layer)) {
            return err(
              `Track "${t.id}" uses layer "${t.layer}" which is invalid for a ${newCopperLayers}-layer board`,
            );
          }
        }
        for (const z of board.zones) {
          if (!newValidLayers.includes(z.layer)) {
            return err(
              `Zone "${z.id}" uses layer "${z.layer}" which is invalid for a ${newCopperLayers}-layer board`,
            );
          }
        }
        for (const k of board.keepouts) {
          if (k.layers === 'all') continue;
          for (const l of k.layers) {
            if (isCopper(l) && !newValidLayers.includes(l)) {
              return err(
                `Keepout "${k.id}" references layer "${l}" which is invalid for a ${newCopperLayers}-layer board`,
              );
            }
          }
        }
        // Vias are through-hole and are always valid regardless of stackup.
        board.copperLayers = newCopperLayers;
        board.rules = RULES_MAP[newCopperLayers];
      }
      return ok(board, createdIds);
    }

    default: {
      const _exhaustive: never = op;
      return err(`Unknown op: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
