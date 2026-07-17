import { describe, it, expect } from 'vitest';
import { applyOp, serializeBoard, parseBoard } from '../src/index.js';
import type { Op } from '../src/index.js';
import { newBoard } from '../src/index.js';
import type {
  Board,
  Footprint,
  ComponentInst,
  Pad,
  Net,
  NetClass,
} from '../src/index.js';

function makeFootprint(padNumbers: string[]): Footprint {
  const pads: Pad[] = padNumbers.map((number, i) => ({
    number,
    shape: 'rect',
    at: { x: i, y: 0 },
    rotation: 0,
    size: { w: 0.5, h: 0.5 },
    layer: 'top',
  }));
  return { name: 'test-fp', lcsc: 'C0', pads, silk: [], courtyard: [] };
}

function makeComponent(
  refdes: string,
  overrides: Partial<ComponentInst> = {},
): ComponentInst {
  return {
    refdes,
    lcsc: 'C1',
    footprint: makeFootprint(['1', '2']),
    at: { x: 0, y: 0 },
    rotation: 0,
    side: 'top',
    fields: {},
    ...overrides,
  };
}

function baseBoard(): Board {
  const b = newBoard('test', 2);
  b.components.push(makeComponent('R1'));
  b.components.push(makeComponent('R2'));
  b.nets.push({ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] });
  return b;
}

describe('applyOp', () => {
  describe('purity', () => {
    it('does not mutate the input board', () => {
      const board = baseBoard();
      const snapshot = structuredClone(board);
      const result = applyOp(board, { op: 'setOutline', outline: [] });
      expect(result.ok).toBe(true);
      expect(board).toEqual(snapshot);
    });

    it('returns a distinct board object (not same reference)', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'setOutline', outline: [] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board).not.toBe(board);
      }
    });

    it('does not mutate input board even on error', () => {
      const board = baseBoard();
      const snapshot = structuredClone(board);
      const result = applyOp(board, { op: 'moveComponent', refdes: 'NOPE', at: { x: 1, y: 1 } });
      expect(result.ok).toBe(false);
      expect(board).toEqual(snapshot);
    });
  });

  describe('placeComponent', () => {
    it('adds a new component', () => {
      const board = baseBoard();
      const fp = makeFootprint(['1', '2', '3']);
      const result = applyOp(board, {
        op: 'placeComponent',
        refdes: 'C1',
        lcsc: 'C99999',
        footprint: fp,
        at: { x: 5, y: 5 },
        rotation: 90,
        side: 'top',
        fields: { value: '10uF' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const comp = result.board.components.find((c) => c.refdes === 'C1');
        expect(comp).toBeDefined();
        expect(comp?.lcsc).toBe('C99999');
        expect(comp?.at).toEqual({ x: 5, y: 5 });
        expect(comp?.rotation).toBe(90);
        expect(comp?.fields.value).toBe('10uF');
        expect(result.createdIds).toEqual([]);
      }
    });

    it('rejects duplicate refdes', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'placeComponent',
        refdes: 'R1',
        lcsc: 'C99999',
        footprint: makeFootprint(['1', '2']),
        at: { x: 5, y: 5 },
        rotation: 0,
        side: 'top',
        fields: {},
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/R1/);
      }
    });

    it('deep-clones op payload so mutations do not corrupt board snapshot', () => {
      const board = baseBoard();
      const fp = makeFootprint(['1', '2', '3']);
      const result = applyOp(board, {
        op: 'placeComponent',
        refdes: 'C1',
        lcsc: 'C99999',
        footprint: fp,
        at: { x: 5, y: 5 },
        rotation: 90,
        side: 'top',
        fields: { value: '10uF' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const compBeforeMutation = result.board.components.find((c) => c.refdes === 'C1')!;
        const padXBeforeMutation = compBeforeMutation.footprint.pads[0].at.x;

        // Mutate the original footprint object
        fp.pads[0].at.x = 999;

        // Verify the board's component footprint pad is unchanged
        const compAfterMutation = result.board.components.find((c) => c.refdes === 'C1')!;
        expect(compAfterMutation.footprint.pads[0].at.x).toBe(padXBeforeMutation);
        expect(compAfterMutation.footprint.pads[0].at.x).toBe(0);
      }
    });
  });

  describe('moveComponent', () => {
    it('applies partial updates (only at)', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'moveComponent',
        refdes: 'R1',
        at: { x: 10, y: 20 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const comp = result.board.components.find((c) => c.refdes === 'R1')!;
        expect(comp.at).toEqual({ x: 10, y: 20 });
        expect(comp.rotation).toBe(0); // unchanged
        expect(comp.side).toBe('top'); // unchanged
      }
    });

    it('applies partial updates (only rotation and side)', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'moveComponent',
        refdes: 'R1',
        rotation: 180,
        side: 'bottom',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const comp = result.board.components.find((c) => c.refdes === 'R1')!;
        expect(comp.at).toEqual({ x: 0, y: 0 }); // unchanged
        expect(comp.rotation).toBe(180);
        expect(comp.side).toBe('bottom');
      }
    });

    it('rejects unknown refdes', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'moveComponent',
        refdes: 'NOPE',
        at: { x: 1, y: 1 },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOPE/);
    });
  });

  describe('removeComponent', () => {
    it('removes the component and strips its pins from nets (keeps empty nets)', () => {
      const board = baseBoard();
      board.nets.push({ name: 'NET2', class: 'default', pins: ['R1.2'] });
      const result = applyOp(board, { op: 'removeComponent', refdes: 'R1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.components.find((c) => c.refdes === 'R1')).toBeUndefined();
        const net1 = result.board.nets.find((n) => n.name === 'NET1')!;
        expect(net1.pins).toEqual(['R2.1']);
        const net2 = result.board.nets.find((n) => n.name === 'NET2')!;
        expect(net2).toBeDefined();
        expect(net2.pins).toEqual([]); // kept, not dropped
      }
    });

    it('keeps tracks referencing the removed component net', () => {
      const board = baseBoard();
      board.tracks.push({
        id: 'T1',
        layer: 'F.Cu',
        width: 0.25,
        net: 'NET1',
        seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
      });
      const result = applyOp(board, { op: 'removeComponent', refdes: 'R1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.tracks).toHaveLength(1); // tracks remain
      }
    });

    it('rejects unknown refdes', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'removeComponent', refdes: 'NOPE' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOPE/);
    });
  });

  describe('setOutline', () => {
    it('sets the board outline', () => {
      const board = baseBoard();
      const outline = [
        { type: 'line' as const, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      ];
      const result = applyOp(board, { op: 'setOutline', outline });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.board.outline).toEqual(outline);
    });
  });

  describe('addKeepout', () => {
    it('adds a keepout with a generated id', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addKeepout',
        keepout: {
          layers: 'all',
          polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
          keepout: { copper: true, via: true },
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.keepouts).toHaveLength(1);
        expect(result.board.keepouts[0].id).toBeTruthy();
        expect(result.createdIds).toEqual([result.board.keepouts[0].id]);
      }
    });
  });

  describe('addZone', () => {
    it('adds a zone with a generated id and no fill', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addZone',
        zone: {
          layer: 'F.Cu',
          net: 'NET1',
          polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
          clearance: 0.2,
          minWidth: 0.2,
          thermal: { gap: 0.5, spokeWidth: 0.25 },
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.zones).toHaveLength(1);
        expect(result.board.zones[0].id).toBeTruthy();
        expect(result.board.zones[0].fill).toBeUndefined();
        expect(result.createdIds).toEqual([result.board.zones[0].id]);
      }
    });
  });

  describe('addHole', () => {
    it('adds a mounting hole with a generated id', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addHole',
        hole: { at: { x: 1, y: 1 }, drill: 3.2, padDiameter: 6, plated: true },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.holes).toHaveLength(1);
        expect(result.createdIds).toEqual([result.board.holes[0].id]);
      }
    });

    it('carries slotLength and rotation through the op and a serialize round-trip', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addHole',
        hole: { at: { x: 2, y: 3 }, drill: 2, padDiameter: 2, plated: false, slotLength: 15, rotation: 90 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const hole = result.board.holes[0];
      expect(hole.slotLength).toBe(15);
      expect(hole.rotation).toBe(90);
      // The op log is serialized for persistence + undo/redo, so the slot
      // fields must survive a serialize -> parse round-trip.
      const round = parseBoard(serializeBoard(result.board));
      expect(round.holes[0].slotLength).toBe(15);
      expect(round.holes[0].rotation).toBe(90);
    });
  });

  describe('addSilkText', () => {
    it('adds silk text with a generated id', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addSilkText',
        text: { layer: 'F.Silk', at: { x: 0, y: 0 }, text: 'HELLO', height: 1, rotation: 0 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.silk).toHaveLength(1);
        expect(result.createdIds).toEqual([result.board.silk[0].id]);
      }
    });
  });

  describe('addSilkLine', () => {
    it('adds a silk line with a generated id', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addSilkLine',
        line: { layer: 'F.Silk', start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, width: 0.15 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.silkLines).toHaveLength(1);
        expect(result.createdIds).toEqual([result.board.silkLines[0].id]);
        expect(result.board.silkLines[0]).toMatchObject({
          layer: 'F.Silk',
          start: { x: 0, y: 0 },
          end: { x: 5, y: 0 },
          width: 0.15,
        });
      }
    });
  });

  describe('setComponentFields', () => {
    it('merges the patch into fields without clobbering other keys', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'setComponentFields',
        refdes: 'R1',
        fields: { value: '47k', role: 'pull-up on TEST' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const comp = result.board.components.find((c) => c.refdes === 'R1')!;
        expect(comp.fields.value).toBe('47k');
        expect(comp.fields.role).toBe('pull-up on TEST');
      }
      expect(applyOp(board, { op: 'setComponentFields', refdes: 'NOPE', fields: {} }).ok).toBe(false);
    });
  });

  describe('editHole', () => {
    it('patches hole geometry and demotes a slot to a round hole when slotLength <= drill', () => {
      const board = baseBoard();
      board.holes.push({ id: 'SLOT1', at: { x: 10, y: 10 }, drill: 2, padDiameter: 2, plated: false, slotLength: 44, rotation: 0 });

      const widened = applyOp(board, { op: 'editHole', id: 'SLOT1', hole: { drill: 4 } });
      expect(widened.ok).toBe(true);
      if (widened.ok) {
        const h = widened.board.holes.find((x) => x.id === 'SLOT1')!;
        expect(h.drill).toBe(4);
        expect(h.slotLength).toBe(44);
        expect(h.at).toEqual({ x: 10, y: 10 });
      }

      const demoted = applyOp(board, { op: 'editHole', id: 'SLOT1', hole: { slotLength: 0 } });
      expect(demoted.ok).toBe(true);
      if (demoted.ok) {
        expect(demoted.board.holes.find((x) => x.id === 'SLOT1')!.slotLength).toBeUndefined();
      }

      expect(applyOp(board, { op: 'editHole', id: 'SLOT1', hole: { drill: 0 } }).ok).toBe(false);
      expect(applyOp(board, { op: 'editHole', id: 'NOPE', hole: {} }).ok).toBe(false);
    });
  });

  describe('editKeepout', () => {
    it('patches polygon and flags, rejects degenerate polygons and unknown ids', () => {
      const board = baseBoard();
      board.keepouts.push({
        id: 'KO1',
        layers: 'all',
        polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }],
        keepout: { copper: true, via: true },
      });
      const edited = applyOp(board, {
        op: 'editKeepout',
        id: 'KO1',
        keepout: { polygon: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 8 }, { x: 0, y: 8 }], keepout: { copper: true, via: false } },
      });
      expect(edited.ok).toBe(true);
      if (edited.ok) {
        const k = edited.board.keepouts.find((x) => x.id === 'KO1')!;
        expect(k.polygon[2]).toEqual({ x: 20, y: 8 });
        expect(k.keepout.via).toBe(false);
      }
      expect(applyOp(board, { op: 'editKeepout', id: 'KO1', keepout: { polygon: [{ x: 0, y: 0 }] } }).ok).toBe(false);
      expect(applyOp(board, { op: 'editKeepout', id: 'NOPE', keepout: {} }).ok).toBe(false);
    });
  });

  describe('moveComponents', () => {
    it('moves several components in one op and rejects unknown refdes atomically', () => {
      const board = baseBoard();
      const r2 = structuredClone(board.components.find((c) => c.refdes === 'R1')!);
      r2.refdes = 'R2';
      board.components.push(r2);

      const moved = applyOp(board, {
        op: 'moveComponents',
        moves: [
          { refdes: 'R1', at: { x: 10, y: 20 } },
          { refdes: 'R2', at: { x: 30, y: 40 } },
        ],
      });
      expect(moved.ok).toBe(true);
      if (moved.ok) {
        expect(moved.board.components.find((c) => c.refdes === 'R1')!.at).toEqual({ x: 10, y: 20 });
        expect(moved.board.components.find((c) => c.refdes === 'R2')!.at).toEqual({ x: 30, y: 40 });
      }

      const bad = applyOp(board, {
        op: 'moveComponents',
        moves: [
          { refdes: 'R1', at: { x: 1, y: 1 } },
          { refdes: 'NOPE', at: { x: 2, y: 2 } },
        ],
      });
      expect(bad.ok).toBe(false);
      // Atomic: R1 must not have moved on the failed op's input board.
      expect(board.components.find((c) => c.refdes === 'R1')!.at).not.toEqual({ x: 1, y: 1 });
    });
  });

  describe('addDimension', () => {
    it('adds a dimension with a generated id, and removeItem deletes it', () => {
      const board = baseBoard();
      const added = applyOp(board, {
        op: 'addDimension',
        dimension: { a: { x: 0, y: 0 }, b: { x: 66, y: 0 }, offset: -4 },
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      expect(added.board.dimensions).toHaveLength(1);
      expect(added.createdIds).toEqual([added.board.dimensions[0].id]);
      expect(added.board.dimensions[0]).toMatchObject({ a: { x: 0, y: 0 }, b: { x: 66, y: 0 }, offset: -4 });

      const removed = applyOp(added.board, { op: 'removeItem', id: added.board.dimensions[0].id });
      expect(removed.ok).toBe(true);
      if (removed.ok) expect(removed.board.dimensions).toHaveLength(0);
    });
  });

  describe('removeItem', () => {
    function boardWithItems(): Board {
      const board = baseBoard();
      board.keepouts.push({ id: 'K1', layers: 'all', polygon: [], keepout: { copper: true, via: true } });
      board.zones.push({
        id: 'Z1', layer: 'F.Cu', net: 'NET1', polygon: [], clearance: 0.2, minWidth: 0.2,
        thermal: { gap: 0.5, spokeWidth: 0.25 },
      });
      board.holes.push({ id: 'H1', at: { x: 0, y: 0 }, drill: 3, padDiameter: 6, plated: true });
      board.silk.push({ id: 'S1', layer: 'F.Silk', at: { x: 0, y: 0 }, text: 'X', height: 1, rotation: 0 });
      board.silkLines.push({ id: 'SL1', layer: 'F.Silk', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 0.15 });
      board.tracks.push({ id: 'T1', layer: 'F.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } });
      board.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NET1' });
      return board;
    }

    it.each(['K1', 'Z1', 'H1', 'S1', 'SL1', 'T1', 'V1'])('removes item %s by id', (id) => {
      const board = boardWithItems();
      const result = applyOp(board, { op: 'removeItem', id });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const allIds = [
          ...result.board.keepouts.map((k) => k.id),
          ...result.board.zones.map((z) => z.id),
          ...result.board.holes.map((h) => h.id),
          ...result.board.silk.map((s) => s.id),
          ...result.board.silkLines.map((s) => s.id),
          ...result.board.tracks.map((t) => t.id),
          ...result.board.vias.map((v) => v.id),
        ];
        expect(allIds).not.toContain(id);
      }
    });

    it('rejects unknown id', () => {
      const board = boardWithItems();
      const result = applyOp(board, { op: 'removeItem', id: 'NOPE' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOPE/);
    });
  });

  describe('connectPins', () => {
    it('creates a net if absent (class default) and connects pins', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'connectPins', net: 'NEWNET', pins: ['R1.2', 'R2.2'] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const net = result.board.nets.find((n) => n.name === 'NEWNET');
        expect(net).toBeDefined();
        expect(net?.class).toBe('default');
        expect(net?.pins).toEqual(expect.arrayContaining(['R1.2', 'R2.2']));
      }
    });

    it('appends pins to an existing net', () => {
      const board = baseBoard();
      board.components.push(makeComponent('R3'));
      const result = applyOp(board, { op: 'connectPins', net: 'NET1', pins: ['R3.1'] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const net = result.board.nets.find((n) => n.name === 'NET1')!;
        expect(net.pins).toEqual(expect.arrayContaining(['R1.1', 'R2.1', 'R3.1']));
      }
    });

    it('is a no-op (not an error) when pin already in the same net', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'connectPins', net: 'NET1', pins: ['R1.1'] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const net = result.board.nets.find((n) => n.name === 'NET1')!;
        expect(net.pins).toEqual(['R1.1', 'R2.1']); // no duplicate
      }
    });

    it('rejects a pin already belonging to a different net, naming the conflicting net', () => {
      const board = baseBoard();
      board.nets.push({ name: 'NET2', class: 'default', pins: ['R2.2'] });
      const result = applyOp(board, { op: 'connectPins', net: 'NET1', pins: ['R2.2'] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/NET2/);
        expect(result.error).toMatch(/R2\.2/);
      }
    });

    it('rejects invalid pin format', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'connectPins', net: 'NET1', pins: ['garbage'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/garbage/);
    });

    it('rejects unknown refdes in pin', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'connectPins', net: 'NET1', pins: ['NOPE.1'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOPE/);
    });

    it('rejects unknown pad number on the footprint', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'connectPins', net: 'NET1', pins: ['R1.99'] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/99/);
        expect(result.error).toMatch(/R1/);
      }
    });
  });

  describe('disconnectPins', () => {
    it('removes pins from whatever nets contain them', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'disconnectPins', pins: ['R1.1'] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const net = result.board.nets.find((n) => n.name === 'NET1')!;
        expect(net.pins).toEqual(['R2.1']);
      }
    });

    it('rejects unknown pins (not connected to any net)', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'disconnectPins', pins: ['R1.2'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/R1\.2/);
    });
  });

  describe('renameNet', () => {
    it('renames a net and updates tracks/vias/zones', () => {
      const board = baseBoard();
      board.tracks.push({ id: 'T1', layer: 'F.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } });
      board.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NET1' });
      board.zones.push({ id: 'Z1', layer: 'F.Cu', net: 'NET1', polygon: [], clearance: 0.2, minWidth: 0.2, thermal: { gap: 0.5, spokeWidth: 0.25 } });
      const result = applyOp(board, { op: 'renameNet', from: 'NET1', to: 'NET1_RENAMED' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.nets.find((n) => n.name === 'NET1')).toBeUndefined();
        expect(result.board.nets.find((n) => n.name === 'NET1_RENAMED')).toBeDefined();
        expect(result.board.tracks[0].net).toBe('NET1_RENAMED');
        expect(result.board.vias[0].net).toBe('NET1_RENAMED');
        expect(result.board.zones[0].net).toBe('NET1_RENAMED');
      }
    });

    it('rejects when from net is missing', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'renameNet', from: 'NOPE', to: 'NEW' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOPE/);
    });

    it('rejects when to net already exists', () => {
      const board = baseBoard();
      board.nets.push({ name: 'NET2', class: 'default', pins: [] });
      const result = applyOp(board, { op: 'renameNet', from: 'NET1', to: 'NET2' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NET2/);
    });
  });

  describe('createNetClass', () => {
    const netClass: NetClass = { name: 'power', trackWidth: 0.5, clearance: 0.3, viaDrill: 0.4, viaDiameter: 0.8 };

    it('adds a new net class', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'createNetClass', netClass });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.netClasses.find((c) => c.name === 'power')).toEqual(netClass);
      }
    });

    it('rejects a duplicate net class name', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'createNetClass', netClass: { ...netClass, name: 'default' } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/default/);
    });
  });

  describe('assignNetClass', () => {
    it('assigns a net class to a net', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'assignNetClass', net: 'NET1', class: 'default' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.nets.find((n) => n.name === 'NET1')?.class).toBe('default');
      }
    });

    it('rejects unknown net', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'assignNetClass', net: 'NOPE', class: 'default' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOPE/);
    });

    it('rejects unknown net class', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'assignNetClass', net: 'NET1', class: 'NOPE' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOPE/);
    });
  });

  describe('addTrack', () => {
    it('adds a track with a generated id', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addTrack',
        track: { layer: 'F.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.tracks).toHaveLength(1);
        expect(result.createdIds).toEqual([result.board.tracks[0].id]);
      }
    });

    it('rejects unknown net', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addTrack',
        track: { layer: 'F.Cu', width: 0.25, net: 'NOPE', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOPE/);
    });

    it('rejects a layer invalid for the stackup', () => {
      const board = baseBoard(); // 2-layer
      const result = applyOp(board, {
        op: 'addTrack',
        track: { layer: 'In3.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/In3\.Cu/);
    });
  });

  describe('addVia', () => {
    it('adds a via with a generated id', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addVia',
        via: { at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NET1' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.vias).toHaveLength(1);
        expect(result.createdIds).toEqual([result.board.vias[0].id]);
      }
    });

    it('rejects unknown net', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addVia',
        via: { at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NOPE' },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOPE/);
    });
  });

  describe('addTracks (bulk)', () => {
    it('adds multiple tracks and vias, returning createdIds in input order', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addTracks',
        tracks: [
          { layer: 'F.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
          { layer: 'B.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 1, y: 1 }, end: { x: 2, y: 2 } } },
        ],
        vias: [
          { at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NET1' },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.tracks).toHaveLength(2);
        expect(result.board.vias).toHaveLength(1);
        expect(result.createdIds).toEqual([
          result.board.tracks[0].id,
          result.board.tracks[1].id,
          result.board.vias[0].id,
        ]);
      }
    });

    it('rejects and mutates nothing when one track has an invalid layer', () => {
      const board = baseBoard(); // 2-layer
      const result = applyOp(board, {
        op: 'addTracks',
        tracks: [
          { layer: 'F.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
          { layer: 'In2.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 1, y: 1 }, end: { x: 2, y: 2 } } },
        ],
        vias: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/In2\.Cu/);
    });

    it('rejects when a via references an unknown net', () => {
      const board = baseBoard();
      const result = applyOp(board, {
        op: 'addTracks',
        tracks: [],
        vias: [{ at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NOPE' }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOPE/);
    });
  });

  describe('unroute', () => {
    function boardWithTwoNetsRouted(): Board {
      const board = baseBoard();
      board.nets.push({ name: 'NET2', class: 'default', pins: ['R1.2', 'R2.2'] });
      board.tracks.push(
        { id: 'T1', layer: 'F.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
        { id: 'T2', layer: 'F.Cu', width: 0.25, net: 'NET2', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
      );
      board.vias.push(
        { id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NET1' },
        { id: 'V2', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NET2' },
      );
      return board;
    }

    it('scoped to one net removes only that net tracks and vias', () => {
      const board = boardWithTwoNetsRouted();
      const result = applyOp(board, { op: 'unroute', net: 'NET1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.tracks.map((t) => t.id)).toEqual(['T2']);
        expect(result.board.vias.map((v) => v.id)).toEqual(['V2']);
      }
    });

    it('without net removes all tracks and vias', () => {
      const board = boardWithTwoNetsRouted();
      const result = applyOp(board, { op: 'unroute' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.tracks).toEqual([]);
        expect(result.board.vias).toEqual([]);
      }
    });
  });

  describe('setBoardMeta', () => {
    it('updates the name', () => {
      const board = baseBoard();
      const result = applyOp(board, { op: 'setBoardMeta', name: 'renamed-board' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.board.name).toBe('renamed-board');
    });

    it('changes copperLayers and updates rules when all layers remain valid', () => {
      const board = baseBoard(); // 2-layer
      const result = applyOp(board, { op: 'setBoardMeta', copperLayers: 4 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.board.copperLayers).toBe(4);
        expect(result.board.rules).toBe('jlcpcb-4l');
      }
    });

    it('rejects a copperLayers change that would orphan a track on an invalid layer', () => {
      const board = baseBoard(); // 2-layer, going to 4 is fine, but let's set up 4->2 orphaning
      board.copperLayers = 4;
      board.rules = 'jlcpcb-4l';
      board.tracks.push({ id: 'T1', layer: 'In2.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } });
      const result = applyOp(board, { op: 'setBoardMeta', copperLayers: 2 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/In2\.Cu/);
        expect(result.error).toMatch(/T1/);
      }
    });

    it('rejects a copperLayers change that would orphan a zone on an invalid layer', () => {
      const board = baseBoard();
      board.zones.push({ id: 'Z1', layer: 'B.Cu', net: 'NET1', polygon: [], clearance: 0.2, minWidth: 0.2, thermal: { gap: 0.5, spokeWidth: 0.25 } });
      // 2-layer board already has F.Cu/B.Cu valid; force an invalid scenario differently:
      board.copperLayers = 4;
      board.rules = 'jlcpcb-4l';
      board.zones[0] = { ...board.zones[0], layer: 'In1.Cu' };
      const result = applyOp(board, { op: 'setBoardMeta', copperLayers: 2 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/In1\.Cu/);
    });

    it('allows a copperLayers change when vias are present (always through-hole valid)', () => {
      const board = baseBoard();
      board.vias.push({ id: 'V1', at: { x: 0, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NET1' });
      const result = applyOp(board, { op: 'setBoardMeta', copperLayers: 4 });
      expect(result.ok).toBe(true);
    });
  });
});
