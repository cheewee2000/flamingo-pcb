import { describe, it, expect } from 'vitest';
import { newBoard } from '../src/index.js';
import type { Board, ComponentInst, Footprint, Pad, Track } from '../src/index.js';
import { widenTracks } from '../src/widen.js';
import { netIslands } from '../src/connectivity.js';

function makeFootprint(pads: Pad[]): Footprint {
  return { name: 'test-fp', lcsc: 'C0', pads, silk: [], courtyard: [] };
}

function smdPad(number: string, at = { x: 0, y: 0 }): Pad {
  return { number, shape: 'rect', at, rotation: 0, size: { w: 0.3, h: 0.9 }, layer: 'top' };
}

function makeComponent(refdes: string, at: { x: number; y: number }, pads: Pad[]): ComponentInst {
  return { refdes, lcsc: 'C1', footprint: makeFootprint(pads), at, rotation: 0, side: 'top', fields: {} };
}

function track(id: string, net: string, width: number, x1: number, y1: number, x2: number, y2: number): Track {
  return { id, layer: 'F.Cu', width, net, seg: { type: 'line', start: { x: x1, y: y1 }, end: { x: x2, y: y2 } } };
}

/** Board with a fat net class and one thin track between two pads, plus an optional mid-run obstacle. */
function fixture(withObstacle: boolean): Board {
  const b = newBoard('widen-test', 2);
  // A real outline: tracks are contained by it, which must NOT read as an
  // edge violation (regression: polyPolyDistance returns 0 for containment).
  const c = [
    { x: -5, y: -5 },
    { x: 25, y: -5 },
    { x: 25, y: 5 },
    { x: -5, y: 5 },
  ];
  b.outline = c.map((p, i) => ({ type: 'line' as const, start: p, end: c[(i + 1) % 4] }));
  b.netClasses.push({ name: 'fat', trackWidth: 0.5, clearance: 0.2, viaDrill: 0.4, viaDiameter: 0.8 });
  b.components.push(makeComponent('R1', { x: 0, y: 0 }, [smdPad('1')]));
  b.components.push(makeComponent('R2', { x: 20, y: 0 }, [smdPad('1')]));
  b.nets.push({ name: 'PWR', class: 'fat', pins: ['R1.1', 'R2.1'] });
  b.tracks.push(track('t1', 'PWR', 0.25, 0, 0, 20, 0));
  if (withObstacle) {
    // Other-net track running parallel very close to the middle of the run:
    // 0.25 wide at y=0.35 => gap to a 0.5-wide PWR track would be 0.35 - 0.25 - 0.125 = -0.025 (blocked),
    // while the 0.25-wide original keeps 0.1 of slack... make it block only the widened width.
    b.nets.push({ name: 'SIG', class: 'default', pins: [] });
    b.tracks.push(track('t2', 'SIG', 0.25, 8, 0.5, 12, 0.5));
  }
  return b;
}

describe('widenTracks', () => {
  it('widens a clear thin track fully to class width', () => {
    const b = fixture(false);
    const res = widenTracks(b);
    expect(res.tracksWidened).toBe(1);
    expect(res.splits).toBe(0);
    const pwr = b.tracks.filter((t) => t.net === 'PWR');
    expect(pwr).toHaveLength(1);
    expect(pwr[0].width).toBeCloseTo(0.5, 6);
  });

  it('splits around an obstruction, keeping the escape width only where needed', () => {
    const b = fixture(true);
    const res = widenTracks(b);
    expect(res.tracksWidened).toBe(1);
    expect(res.splits).toBeGreaterThan(0);
    const pwr = b.tracks.filter((t) => t.net === 'PWR');
    expect(pwr.length).toBeGreaterThan(1);
    const widths = new Set(pwr.map((t) => t.width));
    expect(widths.has(0.5)).toBe(true); // most of the run got fat
    expect(widths.has(0.25)).toBe(true); // the span next to SIG stayed thin
    // Pieces chain endpoint-to-endpoint: connectivity must still see one island.
    const islands = netIslands(b, b.nets.find((n) => n.name === 'PWR')!);
    expect(islands).toHaveLength(1);
    // The thin spans must be near the obstacle (x 8..12), not at the far ends.
    for (const t of pwr) {
      if (t.width === 0.25 && t.seg.type === 'line') {
        expect(t.seg.start.x).toBeGreaterThan(5);
        expect(t.seg.end.x).toBeLessThan(15);
      }
    }
  });

  it('respects the nets filter', () => {
    const b = fixture(false);
    const res = widenTracks(b, ['OTHER']);
    expect(res.tracksWidened).toBe(0);
    expect(b.tracks[0].width).toBeCloseTo(0.25, 6);
  });
});

describe('netIslands', () => {
  it('reports islands with their member track ids, orphans included', () => {
    const b = fixture(false);
    // Two islands: pads at x=0 and x=20 joined... first make them disjoint.
    b.tracks.length = 0;
    b.tracks.push(track('a', 'PWR', 0.25, 0, 0, 5, 0)); // touches R1.1
    b.tracks.push(track('b', 'PWR', 0.25, 20, 0, 15, 0)); // touches R2.1
    b.tracks.push(track('c', 'PWR', 0.25, 9, 5, 11, 5)); // orphan copper
    const islands = netIslands(b, b.nets.find((n) => n.name === 'PWR')!);
    expect(islands).toHaveLength(3);
    const withPins = islands.filter((g) => g.pins.length > 0);
    expect(withPins).toHaveLength(2);
    const orphan = islands.find((g) => g.pins.length === 0)!;
    expect(orphan.trackIds).toEqual(['c']);
  });
});
