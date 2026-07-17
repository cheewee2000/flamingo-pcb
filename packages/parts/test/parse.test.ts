import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEasyedaFootprint } from '../src/easyeda-parse.js';
import type { Pad } from '@flamingo/engine';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(lcsc: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${lcsc}.json`), 'utf8'));
}
function padByNumber(pads: Pad[], n: string): Pad {
  const p = pads.find((x) => x.number === n);
  if (!p) throw new Error(`no pad ${n}`);
  return p;
}

// EasyEDA -> Flamingo conversion constant: 1 unit = 10 mil = 0.254 mm.
// Coords are relative to dataStr.head.x/y, and canvas y-down -> our y-up (negate Y).

describe('parseEasyedaFootprint', () => {
  it('C25804 (0603 resistor): 2 SMD rect pads, hand-converted position', () => {
    const { footprint, info } = parseEasyedaFootprint(fixture('C25804'));
    expect(footprint.pads).toHaveLength(2);
    // origin (4000,3000). pad "1" raw x=3997.034 y=3000.
    // x = (3997.034-4000)*0.254 = -0.753364 ; y = -(3000-3000)*0.254 = 0
    const p1 = padByNumber(footprint.pads, '1');
    expect(p1.shape).toBe('rect');
    expect(p1.at.x).toBeCloseTo(-0.753364, 4);
    expect(p1.at.y).toBeCloseTo(0, 4);
    // size w=3.1751*0.254=0.806475 h=3.4016*0.254=0.864006
    expect(p1.size.w).toBeCloseTo(0.806475, 4);
    expect(p1.size.h).toBeCloseTo(0.864006, 4);
    expect(p1.layer).toBe('top');
    expect(p1.drill).toBeUndefined();
    // courtyard + silk present
    expect(footprint.courtyard.length).toBeGreaterThan(0);
    expect(footprint.silk.length).toBeGreaterThan(0);
    // PartInfo derivation (from symbol dataStr head.c_para)
    expect(info.mpn).toBe('0603WAF1002T5E');
    expect(info.mfr).toContain('UNI-ROYAL');
    expect(info.package).toBe('R0603');
    expect(info.basic).toBe(true);
    expect(info.datasheet).toBeTruthy();
  });

  it('C2150 (SOT-23-3): 3 rect pads, hand-converted position', () => {
    const { footprint, info } = parseEasyedaFootprint(fixture('C2150'));
    expect(footprint.pads).toHaveLength(3);
    // pad "3" raw x=3996.063 y=3000, origin (4000,3000) => x=(3996.063-4000)*0.254=-0.999998
    const p3 = padByNumber(footprint.pads, '3');
    expect(p3.at.x).toBeCloseTo(-0.999998, 4);
    expect(p3.at.y).toBeCloseTo(0, 4);
    expect(p3.shape).toBe('rect');
    expect(info.basic).toBe(true);
    expect(footprint.courtyard.length).toBeGreaterThan(0);
  });

  it('C2040 (RP2040 LQFN-56): 57 pads incl. EP, rotated pad, hand-converted position', () => {
    const { footprint } = parseEasyedaFootprint(fixture('C2040'));
    expect(footprint.pads).toHaveLength(57);
    // pad "1" raw (3970.768,3002.7565) — origin (3984.252,3012.9925)
    // x=(3970.768-3984.252)*0.254=-3.424936 ; y=-(3002.7565-3012.9925)*0.254=2.599944
    const p1 = padByNumber(footprint.pads, '1');
    expect(p1.at.x).toBeCloseTo(-3.424936, 3);
    expect(p1.at.y).toBeCloseTo(2.599944, 3);
    // pad "56" has EasyEDA rotation 270 -> our y-up CCW = -270 normalized = 90
    const p56 = padByNumber(footprint.pads, '56');
    expect(p56.rotation).toBeCloseTo(90, 3);
    expect(footprint.silk.length).toBeGreaterThan(0);
  });

  it('C2913204 (ESP32-S3-WROOM): 49 pads, extended part', () => {
    const { footprint, info } = parseEasyedaFootprint(fixture('C2913204'));
    expect(footprint.pads).toHaveLength(49);
    // pad "1" raw (3995.551,3000) origin (4030,3035.0195)
    // x=(3995.551-4030)*0.254=-8.750046 ; y=-(3000-3035.0195)*0.254=8.894953
    const p1 = padByNumber(footprint.pads, '1');
    expect(p1.at.x).toBeCloseTo(-8.750046, 3);
    expect(p1.at.y).toBeCloseTo(8.894953, 3);
    expect(info.mpn).toBe('ESP32-S3-WROOM-1-N8R2');
    expect(info.basic).toBe(false);
    expect(footprint.courtyard.length).toBeGreaterThan(0);
  });

  it('C165948 (USB-C receptacle): THT pads with drill+slot, polygon pads', () => {
    const { footprint } = parseEasyedaFootprint(fixture('C165948'));
    expect(footprint.pads).toHaveLength(16);
    // THT pad "2": layer 11 -> 'through', holeRadius=1.5748 -> drill dia=2*1.5748*0.254=0.799998
    // holeLength=5.5118 -> slotLength=5.5118*0.254=1.399997
    const p2 = padByNumber(footprint.pads, '2');
    expect(p2.layer).toBe('through');
    expect(p2.drill).toBeDefined();
    expect(p2.drill!.diameter).toBeCloseTo(0.8, 3);
    expect(p2.drill!.plated).toBe(true);
    expect(p2.drill!.slotLength).toBeCloseTo(1.4, 3);
    // at least one polygon-shaped pad (USB-C castellated shield fingers)
    expect(footprint.pads.some((p) => p.shape === 'polygon' && p.polygon && p.polygon.length > 0)).toBe(true);
  });

  it('C8734 (STM32 LQFP-48): 48 pads, silk arc present', () => {
    const { footprint } = parseEasyedaFootprint(fixture('C8734'));
    expect(footprint.pads).toHaveLength(48);
    expect(footprint.silk.some((s) => s.kind === 'arc')).toBe(true);
  });

  it('ARC sweep flag maps to visually-consistent cw (corner arcs bow outward)', () => {
    // Quarter arc "M 10 0 A 10 10 0 0 1 0 10" about head origin (0,0):
    // sweep=1 goes positive-angle in the y-down canvas frame, from (10,0) to
    // (0,10) through (7.07,7.07) -- center is the origin, arc bows away from it.
    // In our y-up frame that's start (2.54,0) -> end (0,-2.54) through
    // (1.796,-1.796): the angle *decreases* (0deg -> -90deg), i.e. clockwise,
    // so cw must be true (cw = sweep flag). The old `cw: !fS` bowed every such
    // arc toward the wrong side ("radius flipped on the corners").
    const synthetic = {
      packageDetail: {
        dataStr: {
          head: { x: 0, y: 0 },
          shape: ['ARC~1~3~~M 10 0 A 10 10 0 0 1 0 10~~gge1'],
        },
      },
    };
    const { footprint } = parseEasyedaFootprint(synthetic);
    const arc = footprint.silk.find((s) => s.kind === 'arc');
    expect(arc).toBeDefined();
    if (arc?.kind !== 'arc') throw new Error('unreachable');
    expect(arc.start.x).toBeCloseTo(2.54, 4);
    expect(arc.start.y).toBeCloseTo(0, 4);
    expect(arc.end.x).toBeCloseTo(0, 4);
    expect(arc.end.y).toBeCloseTo(-2.54, 4);
    expect(arc.center.x).toBeCloseTo(0, 4);
    expect(arc.center.y).toBeCloseTo(0, 4);
    expect(arc.cw).toBe(true);
  });

  it('never throws on unknown cosmetic shapes (all fixtures parse)', () => {
    for (const l of ['C25804', 'C2150', 'C2040', 'C2913204', 'C165948', 'C8734']) {
      expect(() => parseEasyedaFootprint(fixture(l))).not.toThrow();
    }
  });

  it('C5656610 (ICS-43434): SOLIDREGION arc paths do not explode the courtyard bbox', () => {
    // Real shape strings from the ICS-43434 package (cache C5656610.json). The
    // body SOLIDREGIONs on layer 100 use SVG path arcs ("A rx ry rot laf sf x y");
    // a naive number-pairing parser folds the arc's 5 non-coordinate params in as
    // fake vertices, producing courtyard points hundreds of mm from the part.
    const synthetic = {
      packageDetail: {
        dataStr: {
          head: { x: 4003.954, y: 2992.0275 },
          shape: [
            'PAD~RECT~3998.89~2995.571~2.3622~2.0472~1~~1~0~3997.8661 2996.752 3997.8661 2994.3898 3999.9133 2994.3898 3999.9133 2996.752~90~gge42~0~~Y~0~0~0.1969~3998.8897,2995.5709',
            'PAD~RECT~4002.126~2995.571~2.3622~2.0472~1~~2~0~4001.1023 2996.752 4001.1023 2994.3898 4003.1494 2994.3898 4003.1494 2996.752~90~gge62~0~~Y~0~0~0.1969~4002.1258,2995.5709',
            'PAD~RECT~4002.126~2988.484~2.3622~2.0472~1~~4~0~4001.1023 2989.6654 4001.1023 2987.3032 4003.1494 2987.3032 4003.1494 2989.6654~90~gge68~0~~Y~0~0~0.1969~4002.1258,2988.4843',
            // Plain rectangular body region (no arcs).
            'SOLIDREGION~99~~M 4011.1417 2997.2441 L 3997.3622 2997.2441 L 3997.3622 2986.811 L 4011.1417 2986.811 Z~solid~gge6~~~~0',
            // Body regions with 7-parameter SVG arc commands (the bug trigger).
            'SOLIDREGION~100~~M 4003.8531 2991.6431 L 4004.8464 2991.6431 L 4004.8468 2991.6428 A 2.2165 2.2165 0 0 1 4006.6448 2989.8447 L 4006.6448 2988.8548 L 4006.6408 2988.8508 A 3.2008 3.2008 0 0 0 4003.8531 2991.6385 L 4003.8531 2991.6431 Z ~solid~gge263~~~~0',
            'SOLIDREGION~100~~M 4007.414 2988.8512 L 4007.414 2989.8446 L 4007.4144 2989.845 A 2.2165 2.2165 0 0 1 4009.2125 2991.643 L 4010.2024 2991.643 L 4010.2064 2991.639 A 3.2008 3.2008 0 0 0 4007.4187 2988.8512 L 4007.414 2988.8512 Z~solid~gge332~~~~0',
          ],
        },
      },
    };

    const { footprint } = parseEasyedaFootprint(synthetic);
    expect(footprint.courtyard.length).toBeGreaterThan(0);

    // Pad bbox (pads are the ground-truth extent of the part).
    const padPts = footprint.pads.flatMap((p) => [
      { x: p.at.x - p.size.w / 2, y: p.at.y - p.size.h / 2 },
      { x: p.at.x + p.size.w / 2, y: p.at.y + p.size.h / 2 },
    ]);
    const padMinX = Math.min(...padPts.map((p) => p.x));
    const padMaxX = Math.max(...padPts.map((p) => p.x));
    const padMinY = Math.min(...padPts.map((p) => p.y));
    const padMaxY = Math.max(...padPts.map((p) => p.y));

    // Every courtyard vertex must stay within 20mm of the pad bbox. With the bug
    // present, arc params leak in as vertices hundreds of mm away and this fails.
    const M = 20;
    for (const poly of footprint.courtyard) {
      for (const pt of poly) {
        expect(pt.x).toBeGreaterThanOrEqual(padMinX - M);
        expect(pt.x).toBeLessThanOrEqual(padMaxX + M);
        expect(pt.y).toBeGreaterThanOrEqual(padMinY - M);
        expect(pt.y).toBeLessThanOrEqual(padMaxY + M);
      }
    }
  });

  it('warns once and skips unknown shape types, parses valid pads', () => {
    // Minimal synthetic API response with one valid PAD and two unknown WIDGET shapes
    const synthetic = {
      packageDetail: {
        dataStr: {
          head: { x: 4000, y: 3000 },
          shape: [
            // Valid PAD: RECT shape at (4000,3000) with width 3.937, height 2.5591, top layer, pad number "1"
            'PAD~RECT~4000~3000~3.937~2.5591~1~~1~0~3998.0315 2998.7205 4001.9685 2998.7205 4001.9685 3001.2795 3998.0315 3001.2795~0~gge1~0~~Y',
            // Bogus shape type (first occurrence): should warn
            'WIDGET~foo~bar',
            // Another bogus shape type (same type, should NOT warn again)
            'WIDGET~baz~qux',
          ],
        },
      },
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { footprint } = parseEasyedaFootprint(synthetic);
      // Should not throw
      expect(footprint).toBeDefined();
      // Should parse the one valid PAD
      expect(footprint.pads).toHaveLength(1);
      expect(footprint.pads[0]!.number).toBe('1');
      expect(footprint.pads[0]!.shape).toBe('rect');
      // Should warn exactly once for WIDGET (not twice, even though there are 2 instances)
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('parseEasyedaFootprint: skipping unsupported shape "WIDGET"');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
