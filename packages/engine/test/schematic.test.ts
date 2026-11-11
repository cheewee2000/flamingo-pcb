import { describe, it, expect } from 'vitest';
import { buildSchematic, genericSymbol, netKind, newBoard, renderSchematicSVG } from '../src/index.js';
import type { Board, ComponentInst, SchematicSymbol } from '../src/index.js';

function part(refdes: string, pads: string[], at = { x: 0, y: 0 }, fields: ComponentInst['fields'] = {}): ComponentInst {
  return {
    refdes,
    lcsc: '',
    footprint: {
      name: 'fp',
      lcsc: '',
      pads: pads.map((number, i) => ({ number, shape: 'rect', at: { x: i, y: 0 }, rotation: 0, size: { w: 0.5, h: 0.5 }, layer: 'top' })),
      silk: [],
      courtyard: [],
    },
    at,
    rotation: 0,
    side: 'top',
    fields,
  };
}

/**
 * U1 with a reset pin: R1 pulls EN up and C1 holds it down (one wire, "EN").
 * R2 and R3 are in series from SIG through MID to OUT. C2 and C3 decouple
 * 3V3. R4 hangs off SIG with its other pin open. U1.4 is on no net.
 */
function testBoard(): Board {
  const b = newBoard('sch test', 2);
  b.components.push(
    part('U1', ['1', '2', '3', '4', '5'], { x: 10, y: 10 }, { value: 'MCU', role: 'The controller' }),
    part('J1', ['1', '2', '3'], { x: 40, y: 10 }),
    part('R1', ['1', '2'], { x: 8, y: 8 }, { value: '10k' }),
    part('C1', ['1', '2'], { x: 8, y: 9 }, { value: '1uF' }),
    part('R2', ['1', '2'], { x: 20, y: 10 }, { value: '33R' }),
    part('R3', ['1', '2'], { x: 22, y: 10 }, { value: '33R' }),
    part('C2', ['1', '2'], { x: 11, y: 11 }, { value: '100nF' }),
    part('C3', ['1', '2'], { x: 12, y: 11 }, { value: '10uF' }),
    part('R4', ['1', '2'], { x: 30, y: 10 }, { value: '0R' }),
  );
  b.nets.push(
    { name: '3V3', class: 'default', pins: ['U1.1', 'R1.1', 'C2.1', 'C3.1', 'J1.1'] },
    { name: 'GND', class: 'default', pins: ['U1.2', 'C1.2', 'C2.2', 'C3.2', 'J1.2'] },
    { name: 'EN', class: 'default', pins: ['U1.3', 'R1.2', 'C1.1'] },
    { name: 'SIG', class: 'default', pins: ['U1.5', 'R2.1', 'R4.1'] },
    { name: 'MID', class: 'default', pins: ['R2.2', 'R3.1'] },
    { name: 'OUT', class: 'default', pins: ['R3.2', 'J1.3'] },
  );
  return b;
}

const shownOf = (board: Board, opts = {}): Record<string, string> =>
  Object.fromEntries(buildSchematic(board, opts).pins.map((p) => [p.pin, `${p.shown}:${p.net ?? ''}`]));

describe('netKind', () => {
  it('tells ground, supply rails and signals apart by name', () => {
    for (const n of ['GND', 'AGND', 'PGND', 'VSS', 'GND_ISO']) expect(netKind(n)).toBe('ground');
    for (const n of ['3V3', '5V', '+12V', 'VCC', 'VBUS', 'VM', 'AVDD', 'VIN_RAW', '1.8V']) expect(netKind(n)).toBe('rail');
    for (const n of ['EN', 'VSYNC', 'VSENSE', 'VMON', 'SDA', 'IO5', 'V_SENSE', 'M1_2A']) expect(netKind(n)).toBe('signal');
  });

  it('takes a supply from the net class when the name does not say', () => {
    expect(netKind('SERVO_5V', 'supply')).toBe('rail');
    expect(netKind('SERVO_5V', 'default')).toBe('signal');
  });
});

describe('buildSchematic', () => {
  it('draws every pin of every net exactly once, on the right net', () => {
    const board = testBoard();
    const sch = buildSchematic(board);
    const seen = new Map(sch.pins.map((p) => [p.pin, p.net]));
    expect(seen.size).toBe(sch.pins.length);
    for (const net of board.nets) for (const pin of net.pins) expect(seen.get(pin), pin).toBe(net.name);
  });

  it('wires two-pin parts that share a net and labels the rest', () => {
    const shown = shownOf(testBoard());
    // EN: the pull-up and the capacitor meet on a wire; the block pin joins by label.
    expect(shown['R1.2']).toBe('wire:EN');
    expect(shown['C1.1']).toBe('wire:EN');
    expect(shown['U1.3']).toBe('label:EN');
    expect(shown['R1.1']).toBe('rail:3V3');
    expect(shown['C1.2']).toBe('ground:GND');
    // The series pair is joined through MID.
    expect(shown['R2.2']).toBe('wire:MID');
    expect(shown['R3.1']).toBe('wire:MID');
    expect(shown['R2.1']).toBe('wire:SIG');
    expect(shown['R3.2']).toBe('label:OUT');
    expect(shown['R4.2']).toBe('nc:');
    // Decoupling capacitors sit on power symbols; block power pins too.
    expect(shown['C2.1']).toBe('rail:3V3');
    expect(shown['C3.2']).toBe('ground:GND');
    expect(shown['U1.1']).toBe('rail:3V3');
    expect(shown['U1.2']).toBe('ground:GND');
    // A pad on no net is marked unconnected.
    expect(shown['U1.4']).toBe('nc:');
  });

  it('draws every pin when two-pin parts form a loop', () => {
    const b = newBoard('loop', 2);
    b.components.push(part('R1', ['1', '2']), part('R2', ['1', '2']), part('R3', ['1', '2']), part('C1', ['1', '2']));
    b.nets.push(
      { name: 'A', class: 'default', pins: ['R1.1', 'R3.2', 'C1.1'] },
      { name: 'B', class: 'default', pins: ['R1.2', 'R2.1'] },
      { name: 'C', class: 'default', pins: ['R2.2', 'R3.1'] },
      { name: 'GND', class: 'default', pins: ['C1.2'] },
    );
    const shown = shownOf(b);
    for (const net of b.nets) for (const pin of net.pins) expect(shown[pin]?.split(':')[1], pin).toBe(net.name);
    // Two of the three series parts are wired; the one closing the loop is joined by labels.
    expect(Object.values(shown).filter((v) => v.startsWith('label:'))).toHaveLength(2);
  });

  it('joins a net by label once more than eight two-pin parts sit on it', () => {
    const b = newBoard('bus', 2);
    b.components.push(part('U1', ['1', '2', '3']));
    const pins = ['U1.1'];
    for (let i = 1; i <= 9; i++) {
      b.components.push(part(`R${i}`, ['1', '2']));
      pins.push(`R${i}.1`);
    }
    b.nets.push({ name: 'BUS', class: 'default', pins });
    expect(shownOf(b)['R1.1']).toBe('label:BUS');
  });

  it('uses a library symbol when it has every connected pad, else a generic box', () => {
    const board = testBoard();
    const full = genericSymbol(['1', '2', '3', '4', '5'], { '3': 'EN' });
    const short: SchematicSymbol = genericSymbol(['1', '2', '3']);
    const withFull = buildSchematic(board, { symbolFor: (c) => (c.refdes === 'U1' ? full : undefined) });
    expect(withFull.generic).not.toContain('U1');
    expect(withFull.generic).toContain('J1');
    // U1.5 is on SIG, and the short symbol has no pin 5: it must not be used.
    const withShort = buildSchematic(board, { symbolFor: (c) => (c.refdes === 'U1' ? short : undefined) });
    expect(withShort.generic).toContain('U1');
    expect(withShort.pins.find((p) => p.pin === 'U1.5')?.net).toBe('SIG');
  });

  it('is deterministic and keeps everything on the sheet', () => {
    const a = buildSchematic(testBoard());
    const b = buildSchematic(testBoard());
    expect(renderSchematicSVG(a)).toBe(renderSchematicSVG(b));
    for (const p of a.prims) {
      if (p.t === 'line') {
        for (const [x, y] of [[p.x1, p.y1], [p.x2, p.y2]] as const) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(a.width);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(a.height);
        }
      }
    }
  });

  it('handles an empty board', () => {
    const sch = buildSchematic(newBoard('empty', 2));
    expect(sch.pins).toEqual([]);
    expect(renderSchematicSVG(sch)).toContain('empty');
  });
});

describe('renderSchematicSVG', () => {
  it('writes a true-scale SVG with refdes, values, roles and net names', () => {
    const sch = buildSchematic(testBoard(), { title: 'Sheet <1>' });
    const svg = renderSchematicSVG(sch);
    expect(svg).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="[\\d.]+mm" height="[\\d.]+mm" viewBox="0 0 ${sch.width} ${sch.height}">`));
    expect(svg).toContain('Sheet &lt;1&gt;');
    expect(svg).toContain('U1  MCU');
    expect(svg).toContain('The controller');
    expect(svg).toContain('>R1<'); // refdes beside a vertical part
    expect(svg).toContain('>10k<');
    for (const net of ['EN', 'MID', 'SIG', 'OUT', '3V3']) expect(svg).toContain(`>${net}<`);
    expect(svg).toContain('data-ref="C2"');
  });
});
