import { describe, it, expect } from 'vitest';
import { genericSymbol, newBoard } from '@flamingo/engine';
import type { ComponentInst } from '@flamingo/engine';
import { boardSchematic, schematicFileBase, schematicPng, schematicSummary } from '../src/schematic.js';

function part(refdes: string, lcsc: string, pads: string[]): ComponentInst {
  return {
    refdes,
    lcsc,
    footprint: {
      name: 'fp',
      lcsc,
      pads: pads.map((number, i) => ({ number, shape: 'rect', at: { x: i, y: 0 }, rotation: 0, size: { w: 0.5, h: 0.5 }, layer: 'top' })),
      silk: [],
      courtyard: [],
    },
    at: { x: 0, y: 0 },
    rotation: 0,
    side: 'top',
    fields: {},
  };
}

describe('boardSchematic', () => {
  it('loads each distinct symbol once and falls back to a generic box', async () => {
    const board = newBoard('My Board', 2);
    board.components.push(part('U1', 'C1', ['1', '2', '3']), part('U2', 'C1', ['1', '2', '3']), part('U3', 'C2', ['1', '2', '3']), part('U4', 'C3', ['1', '2', '3']));
    board.nets.push({ name: 'A', class: 'default', pins: ['U1.1', 'U2.1', 'U3.1', 'U4.1', 'U4.9'] });
    const asked: string[] = [];
    const result = await boardSchematic(board, async (lcsc) => {
      asked.push(lcsc);
      if (lcsc === 'C1') return genericSymbol(['1', '2', '3'], { '1': 'IN' });
      if (lcsc === 'C3') throw new Error('offline');
      return null;
    });
    expect(asked.sort()).toEqual(['C1', 'C2', 'C3']);
    expect(result.schematic.generic).toEqual(['U3', 'U4']);
    expect(result.svg).toContain('>IN<');

    const summary = schematicSummary(board, result.schematic).join('\n');
    expect(summary).toContain('4 components, 1 nets; 12 pins drawn');
    expect(summary).toContain('generic box (no usable library symbol): U3, U4');
    // U4.9 is in the netlist but the footprint has no pad 9: say so rather than drop it silently.
    expect(summary).toContain('NOT DRAWN (pins on a net with no pad on the footprint): U4.9');

    expect(schematicPng(result).subarray(1, 4).toString()).toBe('PNG');
    expect(schematicFileBase(board.name)).toBe('My_Board-schematic');
  });
});
