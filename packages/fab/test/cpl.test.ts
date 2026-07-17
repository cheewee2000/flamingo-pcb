import { describe, it, expect } from 'vitest';
import { newBoard } from '@flamingo/engine';
import type { Board, ComponentInst, Footprint } from '@flamingo/engine';
import { generateCPL } from '../src/cpl.js';

function footprint(name: string, lcsc: string): Footprint {
  return { name, lcsc, pads: [], silk: [], courtyard: [] };
}

function comp(refdes: string, overrides: Partial<ComponentInst> = {}): ComponentInst {
  return {
    refdes,
    lcsc: 'C1',
    footprint: footprint('R0603', 'C1'),
    at: { x: 12.3456789, y: 4.5 },
    rotation: 0,
    side: 'top',
    fields: {},
    ...overrides,
  };
}

function boardWith(components: ComponentInst[]): Board {
  const b = newBoard('cpltest', 2);
  b.components.push(...components);
  return b;
}

describe('generateCPL', () => {
  it('has the exact required header', () => {
    const csv = generateCPL(boardWith([]));
    expect(csv.split('\r\n')[0]).toBe('Designator,Mid X,Mid Y,Layer,Rotation');
  });

  it('one row per component, mid X/Y from component.at at 4 decimal places, no unit suffix', () => {
    const csv = generateCPL(boardWith([comp('R1')]));
    const lines = csv.trim().split('\r\n');
    expect(lines[1]).toBe('R1,12.3457,4.5000,Top,0');
  });

  it('top side rotation is rot % 360 normalized to [0,360)', () => {
    const csv = generateCPL(boardWith([comp('R1', { rotation: 45 })]));
    expect(csv).toContain('R1,12.3457,4.5000,Top,45');
  });

  it('top side negative rotation normalizes into [0,360)', () => {
    const csv = generateCPL(boardWith([comp('R1', { rotation: -30 })]));
    expect(csv).toContain(',Top,330');
  });

  it('top side rotation >= 360 wraps', () => {
    const csv = generateCPL(boardWith([comp('R1', { rotation: 405 })]));
    expect(csv).toContain(',Top,45');
  });

  it('bottom side layer is "Bottom"', () => {
    const csv = generateCPL(boardWith([comp('R1', { side: 'bottom' })]));
    expect(csv).toContain(',Bottom,');
  });

  it('bottom side rotation is (360 - rot) % 360 -- rot 270 bottom -> 90', () => {
    const csv = generateCPL(boardWith([comp('R1', { side: 'bottom', rotation: 270 })]));
    expect(csv).toContain('R1,12.3457,4.5000,Bottom,90');
  });

  it('bottom side rotation 0 -> 0', () => {
    const csv = generateCPL(boardWith([comp('R1', { side: 'bottom', rotation: 0 })]));
    expect(csv).toContain(',Bottom,0');
  });

  it('bottom side rotation 90 -> 270', () => {
    const csv = generateCPL(boardWith([comp('R1', { side: 'bottom', rotation: 90 })]));
    expect(csv).toContain(',Bottom,270');
  });

  it('bottom side negative rotation -90 normalizes to 90', () => {
    const csv = generateCPL(boardWith([comp('R1', { side: 'bottom', rotation: -90 })]));
    expect(csv).toContain('R1,12.3457,4.5000,Bottom,90');
  });

  it('bottom side rotation >= 360 wraps: 450 -> 270', () => {
    const csv = generateCPL(boardWith([comp('R1', { side: 'bottom', rotation: 450 })]));
    expect(csv).toContain('R1,12.3457,4.5000,Bottom,270');
  });

  it('emits one row per component in board order', () => {
    const csv = generateCPL(boardWith([comp('R1'), comp('R2', { at: { x: 1, y: 2 } })]));
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]!.startsWith('R1,')).toBe(true);
    expect(lines[2]!.startsWith('R2,')).toBe(true);
  });

  it('uses CRLF line endings', () => {
    const csv = generateCPL(boardWith([comp('R1'), comp('R2')]));
    expect(csv).not.toMatch(/[^\r]\n/);
  });

  it('produces an empty-body CSV (just the header) for a board with no components', () => {
    const csv = generateCPL(boardWith([]));
    expect(csv).toBe('Designator,Mid X,Mid Y,Layer,Rotation\r\n');
  });
});
