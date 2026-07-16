import { describe, it, expect } from 'vitest';
import { newBoard } from '../src/index.js';
import type { Board, Footprint, ComponentInst, Pad, Track, Via } from '../src/index.js';
import {
  padAnchor,
  connectedGroups,
  ratsnest,
  isFullyRouted,
} from '../src/connectivity.js';

function makeFootprint(pads: Pad[]): Footprint {
  return { name: 'test-fp', lcsc: 'C0', pads, silk: [], courtyard: [] };
}

function throughPad(number: string, at = { x: 0, y: 0 }): Pad {
  return {
    number,
    shape: 'circle',
    at,
    rotation: 0,
    size: { w: 0.5, h: 0.5 },
    drill: { diameter: 0.3, plated: true },
    layer: 'through',
  };
}

function smdPad(number: string, side: 'top' | 'bottom', at = { x: 0, y: 0 }): Pad {
  return {
    number,
    shape: 'rect',
    at,
    rotation: 0,
    size: { w: 0.5, h: 0.5 },
    layer: side,
  };
}

function makeComponent(
  refdes: string,
  at: { x: number; y: number },
  pads: Pad[],
  overrides: Partial<ComponentInst> = {},
): ComponentInst {
  return {
    refdes,
    lcsc: 'C1',
    footprint: makeFootprint(pads),
    at,
    rotation: 0,
    side: 'top',
    fields: {},
    ...overrides,
  };
}

function baseBoard(): Board {
  return newBoard('test', 2);
}

describe('padAnchor', () => {
  it('returns the world center of a pad', () => {
    const b = baseBoard();
    b.components.push(makeComponent('R1', { x: 5, y: 5 }, [throughPad('1', { x: 1, y: 0 })]));
    const p = padAnchor(b, 'R1.1');
    expect(p.x).toBeCloseTo(6, 6);
    expect(p.y).toBeCloseTo(5, 6);
  });
});

describe('connectedGroups', () => {
  it('two pads joined by a single track spanning them form one group', () => {
    const b = baseBoard();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 10, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.nets.push({ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] });
    const track: Track = {
      id: 't1',
      layer: 'F.Cu',
      width: 0.25,
      net: 'NET1',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    };
    b.tracks.push(track);

    const groups = connectedGroups(b, b.nets[0]);
    expect(groups.length).toBe(1);
    expect(groups[0].sort()).toEqual(['R1.1', 'R2.1']);
  });

  it('two pads with no connecting track form two separate groups (split net)', () => {
    const b = baseBoard();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 10, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.nets.push({ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] });

    const groups = connectedGroups(b, b.nets[0]);
    expect(groups.length).toBe(2);
  });

  it('a via joins a F.Cu track stub to a B.Cu track stub reaching the other pad', () => {
    const b = baseBoard();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 10, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.nets.push({ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] });

    const trackTop: Track = {
      id: 't1',
      layer: 'F.Cu',
      width: 0.25,
      net: 'NET1',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
    };
    const trackBottom: Track = {
      id: 't2',
      layer: 'B.Cu',
      width: 0.25,
      net: 'NET1',
      seg: { type: 'line', start: { x: 5, y: 0 }, end: { x: 10, y: 0 } },
    };
    const via: Via = { id: 'v1', at: { x: 5, y: 0 }, drill: 0.3, diameter: 0.6, net: 'NET1' };
    b.tracks.push(trackTop, trackBottom);
    b.vias.push(via);

    const groups = connectedGroups(b, b.nets[0]);
    expect(groups.length).toBe(1);
    expect(groups[0].sort()).toEqual(['R1.1', 'R2.1']);
  });

  it('an SMD pad on a bottom-side component only connects via a B.Cu track', () => {
    // R1 has a through pad (matches any copper layer). R2 is a bottom-side
    // component whose footprint-local 'top' pad flips to B.Cu due to the
    // bottom-side mirror convention.
    function board(): Board {
      const bb = baseBoard();
      bb.components.push(makeComponent('R1', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
      bb.components.push(
        makeComponent('R2', { x: 10, y: 0 }, [smdPad('1', 'top', { x: 0, y: 0 })], {
          side: 'bottom',
        }),
      );
      bb.nets.push({ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] });
      return bb;
    }

    // A track on F.Cu does NOT connect them, because R2's pad is physically
    // on B.Cu (bottom-side flip), not F.Cu.
    const bTop = board();
    bTop.tracks.push({
      id: 't1',
      layer: 'F.Cu',
      width: 0.25,
      net: 'NET1',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    });
    expect(connectedGroups(bTop, bTop.nets[0]).length).toBe(2);

    // A track on B.Cu DOES connect them.
    const bBottom = board();
    bBottom.tracks.push({
      id: 't2',
      layer: 'B.Cu',
      width: 0.25,
      net: 'NET1',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    });
    expect(connectedGroups(bBottom, bBottom.nets[0]).length).toBe(1);
  });

  it('a net with 0 or 1 pins is a single group', () => {
    const b = baseBoard();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.nets.push({ name: 'NET0', class: 'default', pins: [] });
    b.nets.push({ name: 'NET1', class: 'default', pins: ['R1.1'] });

    expect(connectedGroups(b, b.nets[0])).toEqual([]);
    expect(connectedGroups(b, b.nets[1]).length).toBe(1);
  });
});

describe('ratsnest', () => {
  it('is empty when the net is fully connected by a track', () => {
    const b = baseBoard();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 10, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.nets.push({ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] });
    b.tracks.push({
      id: 't1',
      layer: 'F.Cu',
      width: 0.25,
      net: 'NET1',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    });

    expect(ratsnest(b)).toEqual([]);
  });

  it('a split net (two pads, no track) produces exactly one ratline', () => {
    const b = baseBoard();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 10, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.nets.push({ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] });

    const lines = ratsnest(b);
    expect(lines.length).toBe(1);
    expect(lines[0].net).toBe('NET1');
    const pts = [lines[0].from, lines[0].to].sort((a, c) => a.x - c.x);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[1]).toEqual({ x: 10, y: 0 });
  });

  it('three isolated groups produce exactly 2 MST ratlines picking the shortest edges', () => {
    const b = baseBoard();
    // Three pins in a line: A at x=0, B at x=1, C at x=10.
    // MST should connect A-B (dist 1) and B-C (dist 9), never A-C (dist 10) as
    // a substitute, and total ratlines = groups - 1 = 2.
    b.components.push(makeComponent('A', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('B', { x: 1, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('C', { x: 10, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.nets.push({ name: 'NET1', class: 'default', pins: ['A.1', 'B.1', 'C.1'] });

    const lines = ratsnest(b);
    expect(lines.length).toBe(2);
    const lengths = lines
      .map((l) => Math.hypot(l.to.x - l.from.x, l.to.y - l.from.y))
      .sort((x, y) => x - y);
    expect(lengths[0]).toBeCloseTo(1, 6);
    expect(lengths[1]).toBeCloseTo(9, 6);
  });
});

describe('isFullyRouted', () => {
  it('reports no unconnected nets when everything is routed', () => {
    const b = baseBoard();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 10, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.nets.push({ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] });
    b.tracks.push({
      id: 't1',
      layer: 'F.Cu',
      width: 0.25,
      net: 'NET1',
      seg: { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    });

    expect(isFullyRouted(b)).toEqual([]);
  });

  it('reports unconnected=1 for a split 2-pin net and unconnected=2 for a 3-group net', () => {
    const b = baseBoard();
    b.components.push(makeComponent('R1', { x: 0, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('R2', { x: 10, y: 0 }, [throughPad('1', { x: 0, y: 0 })]));
    b.nets.push({ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] });

    b.components.push(makeComponent('A', { x: 0, y: 5 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('B', { x: 1, y: 5 }, [throughPad('1', { x: 0, y: 0 })]));
    b.components.push(makeComponent('C', { x: 10, y: 5 }, [throughPad('1', { x: 0, y: 0 })]));
    b.nets.push({ name: 'NET2', class: 'default', pins: ['A.1', 'B.1', 'C.1'] });

    const result = isFullyRouted(b);
    expect(result).toEqual(
      expect.arrayContaining([
        { net: 'NET1', unconnected: 1 },
        { net: 'NET2', unconnected: 2 },
      ]),
    );
    expect(result.length).toBe(2);
  });
});
