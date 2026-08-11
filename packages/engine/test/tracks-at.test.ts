import { describe, it, expect } from 'vitest';
import { tracksAtPoint, tracksAtPad } from '../src/connectivity.js';
import type { Board } from '../src/types.js';

// Minimal board: one 2-pad component (R1 pads "1"/"2") and two line tracks on
// F.Cu, one touching R1.1's anchor, one arc that must be excluded.
function fixture(): Board {
  const pads = [
    { number: '1', at: { x: -1, y: 0 }, size: { x: 0.6, y: 0.6 }, shape: 'rect' as const, layer: 'top' as const, rotation: 0 },
    { number: '2', at: { x: 1, y: 0 }, size: { x: 0.6, y: 0.6 }, shape: 'rect' as const, layer: 'top' as const, rotation: 0 },
  ];
  return {
    name: 't', copperLayers: 2, rules: 'jlcpcb-2l',
    outline: [], components: [{
      refdes: 'R1', lcsc: '', side: 'top', at: { x: 0, y: 0 }, rotation: 0,
      footprint: { name: 'r', pads, courtyard: [], silk: [], holes: [] },
      fields: {},
    }],
    nets: [{ name: 'N', class: 'default', pins: ['R1.1', 'R1.2'] }],
    netClasses: [{ name: 'default', trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }],
    tracks: [
      { id: 'tLine', layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'line', start: { x: -1, y: 0 }, end: { x: -1, y: 5 } } },
      { id: 'tArc', layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'arc', start: { x: -1, y: 0 }, end: { x: 0, y: 1 }, center: { x: 0, y: 0 }, cw: false } },
    ],
    vias: [], zones: [], keepouts: [], holes: [], silk: [], dimensions: [],
  } as unknown as Board;
}

describe('tracksAtPoint', () => {
  it('returns the line-track endpoint coincident with the point (arc excluded)', () => {
    const hits = tracksAtPoint(fixture(), { x: -1, y: 0 }, 'F.Cu');
    expect(hits).toEqual([{ trackId: 'tLine', end: 'start' }]);
  });
  it('returns nothing on a different layer', () => {
    expect(tracksAtPoint(fixture(), { x: -1, y: 0 }, 'B.Cu')).toEqual([]);
  });
  it('honors the net filter', () => {
    expect(tracksAtPoint(fixture(), { x: -1, y: 0 }, 'F.Cu', 'OTHER')).toEqual([]);
  });
  it('matches within epsilon but not beyond', () => {
    expect(tracksAtPoint(fixture(), { x: -1.005, y: 0 }, 'F.Cu')).toHaveLength(1);
    expect(tracksAtPoint(fixture(), { x: -1.02, y: 0 }, 'F.Cu')).toHaveLength(0);
  });
});

describe('tracksAtPad', () => {
  it('finds the line track touching R1.1', () => {
    const hits = tracksAtPad(fixture(), 'R1', '1');
    expect(hits).toEqual([{ trackId: 'tLine', end: 'start', layer: 'F.Cu' }]);
  });
  it('returns nothing for a pad with no tracks', () => {
    expect(tracksAtPad(fixture(), 'R1', '2')).toEqual([]);
  });
});
