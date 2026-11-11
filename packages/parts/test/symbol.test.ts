import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEasyedaSymbol } from '../src/symbol-parse.js';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(lcsc: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${lcsc}.json`), 'utf8'));
}

describe('parseEasyedaSymbol', () => {
  it('reads a resistor: two in-line pins and a body box', () => {
    const sym = parseEasyedaSymbol(fixture('C25804'))!;
    expect(sym.pins.map((p) => [p.number, p.at.x, p.at.y, p.dir, p.length])).toEqual([
      ['2', 40, 0, 'right', 10],
      ['1', 0, 0, 'left', 10],
    ]);
    expect(sym.shapes).toEqual([{ kind: 'rect', x: 10, y: -4, w: 20, h: 8 }]);
    expect(sym.bbox).toEqual({ x0: 0, y0: -4, x1: 40, y1: 4 });
  });

  it('reads every pin of a module, with names, numbers and sides', () => {
    const sym = parseEasyedaSymbol(fixture('C2913204'))!;
    expect(sym.pins).toHaveLength(41);
    expect(new Set(sym.pins.map((p) => p.number)).size).toBe(41);
    const byNumber = Object.fromEntries(sym.pins.map((p) => [p.number, p]));
    expect(byNumber['1']!.name).toBe('GND');
    expect(byNumber['1']!.dir).toBe('left');
    expect(byNumber['2']!.name).toBe('3V3');
    expect(byNumber['3']!.name).toBe('EN');
    // Pin 41 has an empty rotation field in the library; its direction comes from its path.
    expect(byNumber['41']!.dir).toBe('right');
    expect(byNumber['1']!.nameText?.visible).toBe(true);
  });

  it('points each pin away from the body', () => {
    for (const id of ['C2040', 'C8734', 'C165948', 'C2150']) {
      const sym = parseEasyedaSymbol(fixture(id))!;
      const cx = (sym.bbox.x0 + sym.bbox.x1) / 2;
      const cy = (sym.bbox.y0 + sym.bbox.y1) / 2;
      for (const p of sym.pins) {
        if (p.dir === 'left') expect(p.at.x, `${id}.${p.number}`).toBeLessThan(cx);
        if (p.dir === 'right') expect(p.at.x, `${id}.${p.number}`).toBeGreaterThan(cx);
        if (p.dir === 'up') expect(p.at.y, `${id}.${p.number}`).toBeLessThan(cy);
        if (p.dir === 'down') expect(p.at.y, `${id}.${p.number}`).toBeGreaterThan(cy);
      }
    }
  });

  it('takes the direction from the pin path whichever end it is drawn from', () => {
    // Connection point (35, 20), path drawn from the body end out to it.
    const raw = { result: { dataStr: { shape: ['P~show~0~2~35~20~0~g1~0^^35~20^^M 25 20 h 10~#800^^0~21~20~0~2~end~~~#800^^0~29~16~0~2~start~~~#800^^0~48~20^^0~M 45 17 L 42 20 L 45 23'] } } };
    const pin = parseEasyedaSymbol(raw)!.pins[0]!;
    expect(pin.dir).toBe('right');
    expect(pin.length).toBe(10);
    expect(pin.nameText?.visible).toBe(false);
  });

  it('stacks the units of a multi-unit part', () => {
    const unit = (n: string): { dataStr: { shape: string[] } } => ({
      dataStr: { shape: ['R~10~-10~~~20~20~#880000~1~0~none~g~0', `P~show~0~${n}~0~0~180~g~0^^0~0^^M 0 0 h 10~#800^^1~12~3~0~IN${n}~start~~~#800^^1~8~-1~0~${n}~end~~~#800^^0~7~0^^0~M 10 3 L 13 0 L 10 -3`] },
    });
    const sym = parseEasyedaSymbol({ result: { dataStr: { shape: [] }, subparts: [unit('1'), unit('2')] } })!;
    expect(sym.pins.map((p) => [p.number, p.at.y])).toEqual([
      ['1', 0],
      ['2', 40],
    ]);
    expect(sym.shapes).toHaveLength(2);
  });

  it('yields null for a response with no symbol', () => {
    expect(parseEasyedaSymbol(null)).toBeNull();
    expect(parseEasyedaSymbol({ result: {} })).toBeNull();
    expect(parseEasyedaSymbol({ result: { dataStr: { shape: ['R~0~0~~~10~10~#000~1~0~none~g~0'] } } })).toBeNull();
  });
});
