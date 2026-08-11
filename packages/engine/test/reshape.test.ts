import { describe, it, expect } from 'vitest';
import { rubberBandReshape, dragSegmentReshape } from '../src/reroute.js';
import type { Board } from '../src/types.js';

// Two line tracks on F.Cu forming an L: A(0,0)->(0,5) and (0,5)->(5,5). Net N.
function board(): Board {
  return {
    name: 't', copperLayers: 2, rules: 'jlcpcb-2l', outline: [], components: [],
    nets: [{ name: 'N', class: 'default', pins: [] }],
    netClasses: [{ name: 'default', trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }],
    tracks: [
      { id: 'a', layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 5 } } },
      { id: 'b', layer: 'F.Cu', width: 0.25, net: 'N', seg: { type: 'line', start: { x: 0, y: 5 }, end: { x: 5, y: 5 } } },
    ],
    vias: [], zones: [], keepouts: [], holes: [], silk: [], dimensions: [],
  } as unknown as Board;
}

describe('rubberBandReshape', () => {
  it('moves one endpoint and re-solves that track on 45deg, keeping the far vertex', () => {
    // Move track a's start (0,0) -> (2,0). Far vertex (0,5) stays.
    const r = rubberBandReshape(board(), [{ trackId: 'a', end: 'start', newAt: { x: 2, y: 0 } }]);
    expect(r.removeIds).toEqual(['a']);
    // route45((0,5)->(2,0)) elbow: dx=2, dy=-5, diag-first -> (0,5)->(2,3)->(2,0)
    expect(r.add.map((t) => t.seg)).toEqual([
      { type: 'line', start: { x: 0, y: 5 }, end: { x: 2, y: 3 } },
      { type: 'line', start: { x: 2, y: 3 }, end: { x: 2, y: 0 } },
    ]);
    expect(r.add.every((t) => t.net === 'N' && t.layer === 'F.Cu' && t.width === 0.25)).toBe(true);
  });

  it('skips arc tracks', () => {
    const b = board();
    (b.tracks[0].seg as { type: string }).type = 'arc';
    const r = rubberBandReshape(b, [{ trackId: 'a', end: 'start', newAt: { x: 2, y: 0 } }]);
    expect(r.removeIds).toEqual([]);
    expect(r.add).toEqual([]);
  });

  it('drops a track whose reshape is degenerate', () => {
    // Move a.start to its own far vertex (0,5): zero-length -> removed, nothing added.
    const r = rubberBandReshape(board(), [{ trackId: 'a', end: 'start', newAt: { x: 0, y: 5 } }]);
    expect(r.removeIds).toEqual(['a']);
    expect(r.add).toEqual([]);
  });
});

describe('dragSegmentReshape', () => {
  it('translates the dragged segment and re-solves the neighbor at the shared vertex', () => {
    // Drag track b by (0,+2): b becomes (0,7)->(5,7); neighbor a's end (0,5) follows to (0,7).
    const r = dragSegmentReshape(board(), 'b', { x: 0, y: 2 });
    expect(new Set(r.removeIds)).toEqual(new Set(['a', 'b']));
    const segs = r.add.map((t) => t.seg);
    // dragged b translated:
    expect(segs).toContainEqual({ type: 'line', start: { x: 0, y: 7 }, end: { x: 5, y: 7 } });
    // neighbor a re-solved (0,0)->(0,7) stays vertical (one segment):
    expect(segs).toContainEqual({ type: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 7 } });
  });
});
