import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importSES } from '../src/ses.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(here, 'fixtures', 'sample.ses'), 'utf8');

describe('importSES', () => {
  it('scales coordinates/widths from (resolution um 10) back to mm', () => {
    const { tracks } = importSES(SAMPLE);
    const n1 = tracks.filter((t) => t.net === 'N1');
    expect(n1).toHaveLength(1);
    const t = n1[0]!;
    expect(t.layer).toBe('F.Cu');
    expect(t.width).toBeCloseTo(0.25, 9);
    expect(t.seg.type).toBe('line');
    if (t.seg.type === 'line') {
      expect(t.seg.start.x).toBeCloseTo(4.25, 9);
      expect(t.seg.start.y).toBeCloseTo(5.0, 9);
      expect(t.seg.end.x).toBeCloseTo(10.75, 9);
      expect(t.seg.end.y).toBeCloseTo(5.0, 9);
    }
  });

  it('parses quoted net names with spaces', () => {
    const { tracks } = importSES(SAMPLE);
    const my = tracks.filter((t) => t.net === 'MY NET');
    expect(my.length).toBeGreaterThan(0);
    expect(my.every((t) => t.layer === 'B.Cu')).toBe(true);
  });

  it('splits a multi-point wire path into n-1 line tracks', () => {
    const { tracks } = importSES(SAMPLE);
    const my = tracks.filter((t) => t.net === 'MY NET');
    // 3 points -> 2 tracks
    expect(my).toHaveLength(2);
    const [a, b] = my;
    if (a!.seg.type === 'line') {
      expect(a!.seg.start.x).toBeCloseTo(0, 9);
      expect(a!.seg.end.x).toBeCloseTo(5, 9);
    }
    if (b!.seg.type === 'line') {
      expect(b!.seg.start.x).toBeCloseTo(5, 9);
      expect(b!.seg.end.y).toBeCloseTo(5, 9);
    }
  });

  it('recovers via drill/diameter from the V_<drill>_<dia> padstack name', () => {
    const { vias } = importSES(SAMPLE);
    expect(vias).toHaveLength(1);
    const v = vias[0]!;
    expect(v.net).toBe('N1');
    expect(v.at.x).toBeCloseTo(7.5, 9);
    expect(v.at.y).toBeCloseTo(5.0, 9);
    expect(v.drill).toBeCloseTo(0.3, 9);
    expect(v.diameter).toBeCloseTo(0.6, 9);
  });

  it('total counts: 3 tracks, 1 via', () => {
    const { tracks, vias } = importSES(SAMPLE);
    expect(tracks).toHaveLength(3);
    expect(vias).toHaveLength(1);
  });
});
