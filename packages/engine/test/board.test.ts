import { describe, it, expect } from 'vitest';
import {
  newBoard,
  serializeBoard,
  parseBoard,
  copperLayersOf,
  isCopper,
} from '../src/index.js';

describe('Board', () => {
  describe('newBoard', () => {
    it('creates a 2-layer board with default netClass and rules', () => {
      const board = newBoard('test', 2);
      expect(board.name).toBe('test');
      expect(board.copperLayers).toBe(2);
      expect(board.formatVersion).toBe(1);
      expect(board.rules).toBe('jlcpcb-2l');
      expect(board.netClasses).toHaveLength(1);
      expect(board.netClasses[0]).toEqual({
        name: 'default',
        trackWidth: 0.25,
        clearance: 0.2,
        viaDrill: 0.3,
        viaDiameter: 0.6,
      });
      expect(board.outline).toEqual([]);
      expect(board.keepouts).toEqual([]);
      expect(board.holes).toEqual([]);
      expect(board.components).toEqual([]);
      expect(board.nets).toEqual([]);
      expect(board.tracks).toEqual([]);
      expect(board.vias).toEqual([]);
      expect(board.zones).toEqual([]);
      expect(board.silk).toEqual([]);
      expect(board.silkLines).toEqual([]);
    });

    it('creates a 4-layer board with correct rules', () => {
      const board = newBoard('test4l', 4);
      expect(board.copperLayers).toBe(4);
      expect(board.rules).toBe('jlcpcb-4l');
    });

    it('creates a 6-layer board with correct rules', () => {
      const board = newBoard('test6l', 6);
      expect(board.copperLayers).toBe(6);
      expect(board.rules).toBe('jlcpcb-6l');
    });
  });

  describe('serializeBoard & parseBoard', () => {
    it('round-trips a board through serialize→parse', () => {
      const board = newBoard('roundtrip', 2);
      const json = serializeBoard(board);
      const parsed = parseBoard(json);
      expect(parsed).toEqual(board);
    });

    it('serializes to valid JSON', () => {
      const board = newBoard('json-test', 2);
      const json = serializeBoard(board);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('preserves board data through round-trip', () => {
      const board = newBoard('preserve', 4);
      board.nets.push({
        name: 'GND',
        class: 'default',
        pins: ['U1.1', 'U1.2'],
      });
      board.tracks.push({
        id: 'T1',
        layer: 'F.Cu',
        width: 0.25,
        net: 'GND',
        seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
      });
      const json = serializeBoard(board);
      const parsed = parseBoard(json);
      expect(parsed.nets).toEqual(board.nets);
      expect(parsed.tracks).toEqual(board.tracks);
    });

    it('round-trips silk lines', () => {
      const board = newBoard('silklines', 2);
      board.silkLines.push({
        id: 'SL1',
        layer: 'F.Silk',
        start: { x: 0, y: 0 },
        end: { x: 10, y: 0 },
        width: 0.15,
      });
      const parsed = parseBoard(serializeBoard(board));
      expect(parsed.silkLines).toEqual(board.silkLines);
    });

    it('defaults silkLines to [] when loading an older board that omits the field', () => {
      const board = newBoard('legacy', 2);
      const obj = JSON.parse(serializeBoard(board));
      delete obj.silkLines; // simulate a board saved before silkLines existed
      const parsed = parseBoard(JSON.stringify(obj));
      expect(parsed.silkLines).toEqual([]);
    });
  });

  describe('parseBoard validation', () => {
    it('rejects non-JSON input', () => {
      expect(() => parseBoard('not json')).toThrow();
    });

    it('rejects non-object JSON', () => {
      expect(() => parseBoard('[]')).toThrow();
      expect(() => parseBoard('123')).toThrow();
      expect(() => parseBoard('"string"')).toThrow();
    });

    it('rejects missing formatVersion', () => {
      const invalid = { name: 'test', copperLayers: 2 };
      expect(() => parseBoard(JSON.stringify(invalid))).toThrow();
    });

    it('rejects wrong formatVersion', () => {
      const board = newBoard('test', 2);
      const json = serializeBoard(board);
      const parsed = JSON.parse(json);
      parsed.formatVersion = 2;
      expect(() => parseBoard(JSON.stringify(parsed))).toThrow();
    });

    it('rejects missing required arrays', () => {
      const board = newBoard('test', 2);
      const json = serializeBoard(board);
      const parsed = JSON.parse(json);
      delete parsed.nets;
      expect(() => parseBoard(JSON.stringify(parsed))).toThrow();
    });
  });

  describe('copperLayersOf', () => {
    it('returns correct layers for 2-layer board', () => {
      const board = newBoard('test2l', 2);
      const layers = copperLayersOf(board);
      expect(layers).toEqual(['F.Cu', 'B.Cu']);
    });

    it('returns correct layers for 4-layer board', () => {
      const board = newBoard('test4l', 4);
      const layers = copperLayersOf(board);
      expect(layers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    });

    it('returns correct layers for 6-layer board', () => {
      const board = newBoard('test6l', 6);
      const layers = copperLayersOf(board);
      expect(layers).toEqual([
        'F.Cu',
        'In1.Cu',
        'In2.Cu',
        'In3.Cu',
        'In4.Cu',
        'B.Cu',
      ]);
    });
  });

  describe('isCopper', () => {
    it('returns true for copper layer ids', () => {
      expect(isCopper('F.Cu')).toBe(true);
      expect(isCopper('B.Cu')).toBe(true);
      expect(isCopper('In1.Cu')).toBe(true);
      expect(isCopper('In2.Cu')).toBe(true);
      expect(isCopper('In3.Cu')).toBe(true);
      expect(isCopper('In4.Cu')).toBe(true);
    });

    it('returns false for non-copper layer ids', () => {
      expect(isCopper('F.Silk')).toBe(false);
      expect(isCopper('B.Silk')).toBe(false);
      expect(isCopper('F.Mask')).toBe(false);
      expect(isCopper('B.Mask')).toBe(false);
      expect(isCopper('F.Paste')).toBe(false);
      expect(isCopper('B.Paste')).toBe(false);
      expect(isCopper('Edge')).toBe(false);
    });
  });
});
