import { describe, it, expect } from 'vitest';
import { applyOp } from '../src/ops.js';
import type { Board, Track } from '../src/types.js';

function board(): Board {
  return {
    name: 't', copperLayers: 2, rules: 'jlcpcb-2l', outline: [],
    components: [{
      refdes: 'R1', lcsc: '', side: 'top', at: { x: 0, y: 0 }, rotation: 0,
      footprint: { name: 'r', pads: [{ number: '1', at: { x: 0, y: 0 }, size: { w: 0.6, h: 0.6 }, shape: 'rect', layer: 'top', rotation: 0 }], courtyard: [], silk: [], holes: [] },
      fields: {},
    }],
    nets: [{ name: 'N', class: 'default', pins: ['R1.1'] }],
    netClasses: [{ name: 'default', trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }],
    tracks: [{ id: 'old', layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 5 } } }],
    vias: [], zones: [], keepouts: [], holes: [], silk: [], dimensions: [],
  } as unknown as Board;
}
const newTrack: Omit<Track, 'id'> = { layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 3, y: 3 } } };

describe('reshapeTracks op', () => {
  it('removes listed ids and adds new tracks with fresh ids', () => {
    const r = applyOp(board(), { op: 'reshapeTracks', remove: ['old'], add: [newTrack] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.board.tracks.some((t) => t.id === 'old')).toBe(false);
    expect(r.board.tracks).toHaveLength(1);
    expect(r.createdIds).toHaveLength(1);
    expect(r.board.tracks[0].seg).toEqual(newTrack.seg);
  });
  it('rejects an unknown net', () => {
    const r = applyOp(board(), { op: 'reshapeTracks', remove: [], add: [{ ...newTrack, net: 'ZZ' }] });
    expect(r.ok).toBe(false);
  });
  it('rejects an invalid layer and changes nothing', () => {
    const r = applyOp(board(), { op: 'reshapeTracks', remove: ['old'], add: [{ ...newTrack, layer: 'In1.Cu' }] });
    expect(r.ok).toBe(false);
  });
});

describe('transaction op', () => {
  it('applies sub-ops in order as one result', () => {
    const r = applyOp(board(), { op: 'transaction', ops: [
      { op: 'moveComponent', refdes: 'R1', at: { x: 1, y: 1 } },
      { op: 'reshapeTracks', remove: ['old'], add: [newTrack] },
    ] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.board.components[0].at).toEqual({ x: 1, y: 1 });
    expect(r.board.tracks.some((t) => t.id === 'old')).toBe(false);
    expect(r.createdIds).toHaveLength(1);
  });
  it('is atomic: a failing sub-op yields an error and no partial board', () => {
    const r = applyOp(board(), { op: 'transaction', ops: [
      { op: 'moveComponent', refdes: 'R1', at: { x: 9, y: 9 } },
      { op: 'reshapeTracks', remove: [], add: [{ ...newTrack, net: 'ZZ' }] }, // fails
    ] });
    expect(r.ok).toBe(false);
  });
  it('does not mutate the input board', () => {
    const b = board();
    applyOp(b, { op: 'transaction', ops: [{ op: 'moveComponent', refdes: 'R1', at: { x: 4, y: 4 } }] });
    expect(b.components[0].at).toEqual({ x: 0, y: 0 });
  });
});
