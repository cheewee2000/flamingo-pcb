import { describe, it, expect } from 'vitest';
import { newBoard } from '@flamingo/engine';
import type { Board, ComponentInst, Footprint } from '@flamingo/engine';
import { generateBOM } from '../src/bom.js';

function footprint(name: string, lcsc: string): Footprint {
  return { name, lcsc, pads: [], silk: [], courtyard: [] };
}

function comp(
  refdes: string,
  lcsc: string,
  overrides: Partial<ComponentInst> = {},
): ComponentInst {
  return {
    refdes,
    lcsc,
    footprint: footprint('R0603', lcsc),
    at: { x: 0, y: 0 },
    rotation: 0,
    side: 'top',
    fields: { value: '10k', package: '0603' },
    ...overrides,
  };
}

function boardWith(components: ComponentInst[]): Board {
  const b = newBoard('bomtest', 2);
  b.components.push(...components);
  return b;
}

describe('generateBOM', () => {
  it('has the exact required header', () => {
    const csv = generateBOM(boardWith([]));
    expect(csv.split('\r\n')[0]).toBe('Comment,Designator,Footprint,LCSC Part #');
  });

  it('groups identical lcsc+value components into one row with sorted designators', () => {
    const csv = generateBOM(
      boardWith([
        comp('R5', 'C25804'),
        comp('R1', 'C25804'),
        comp('R2', 'C25804'),
      ]),
    );
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('10k,"R1,R2,R5",0603,C25804');
  });

  it('sorts designators in natural order (R2 < R10)', () => {
    const csv = generateBOM(
      boardWith([comp('R10', 'C1'), comp('R2', 'C1'), comp('R1', 'C1')]),
    );
    const lines = csv.trim().split('\r\n');
    expect(lines[1]).toContain('"R1,R2,R10"');
  });

  it('keeps different lcsc+value combos in separate rows', () => {
    const csv = generateBOM(
      boardWith([
        comp('R1', 'C1', { fields: { value: '10k' } }),
        comp('R2', 'C1', { fields: { value: '1k' } }),
      ]),
    );
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
  });

  it('falls back to description then lcsc when value is missing', () => {
    const csv = generateBOM(
      boardWith([
        comp('U1', 'C2', { fields: { description: 'Some Chip', package: 'SOT-23' } }),
        comp('U2', 'C3', { fields: {}, footprint: footprint('QFN-32', 'C3') }),
      ]),
    );
    const lines = csv.trim().split('\r\n');
    expect(lines).toContain('Some Chip,U1,SOT-23,C2');
    expect(lines).toContain('C3,U2,QFN-32,C3');
  });

  it('uses footprint.name when fields.package is absent', () => {
    const csv = generateBOM(
      boardWith([comp('J1', 'C9', { fields: { value: 'Header' }, footprint: footprint('PinHeader_1x02', 'C9') })]),
    );
    expect(csv).toContain('Header,J1,PinHeader_1x02,C9');
  });

  it('quotes a field containing a comma (RFC-4180) and does not double-quote clean fields', () => {
    const csv = generateBOM(
      boardWith([comp('C1', 'C4', { fields: { value: '10uF, X7R', package: '0805' } })]),
    );
    expect(csv).toContain('"10uF, X7R",C1,0805,C4');
  });

  it('quotes a field containing a double quote, doubling the embedded quote', () => {
    const csv = generateBOM(
      boardWith([comp('C1', 'C4', { fields: { value: '10uF "special"', package: '0805' } })]),
    );
    expect(csv).toContain('"10uF ""special""",C1,0805,C4');
  });

  it('quotes a field containing a newline', () => {
    const csv = generateBOM(
      boardWith([comp('C1', 'C4', { fields: { value: 'line1\nline2', package: '0805' } })]),
    );
    expect(csv).toContain('"line1\nline2"');
  });

  it('uses CRLF line endings throughout', () => {
    const csv = generateBOM(
      boardWith([comp('R1', 'C1'), comp('R2', 'C2', { fields: { value: '1k' } })]),
    );
    expect(csv).not.toMatch(/[^\r]\n/); // every \n is preceded by \r
    expect(csv).toContain('\r\n');
  });

  it('produces an empty-body CSV (just the header) for a board with no components', () => {
    const csv = generateBOM(boardWith([]));
    expect(csv).toBe('Comment,Designator,Footprint,LCSC Part #\r\n');
  });
});
