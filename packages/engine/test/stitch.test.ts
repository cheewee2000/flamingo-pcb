import { describe, it, expect } from 'vitest';
import { newBoard, fillAllZones, pointInPolygon } from '../src/index.js';
import type { Board, ComponentInst } from '../src/types.js';
import { planZoneStitching } from '../src/stitch.js';

/**
 * 40×20 board, GND zones on both layers. A vertical other-net track wall on
 * F.Cu splits the top pour into two islands; the GND pad sits in the left
 * one, so the right F.Cu island is orphaned. The B.Cu pour is one connected
 * island (through-pad), so the orphan must get a via inside the right half.
 */
function makeBoard(): Board {
  const b = newBoard('stitchtest', 2);
  b.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
    { type: 'line', start: { x: 40, y: 0 }, end: { x: 40, y: 20 } },
    { type: 'line', start: { x: 40, y: 20 }, end: { x: 0, y: 20 } },
    { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
  ];
  const gndPad: ComponentInst = {
    refdes: 'J1',
    lcsc: 'C0',
    footprint: {
      name: 'th-pad',
      lcsc: 'C0',
      pads: [
        {
          number: '1',
          shape: 'circle',
          at: { x: 0, y: 0 },
          rotation: 0,
          size: { w: 2, h: 2 },
          layer: 'through',
          drill: { diameter: 1 },
        },
      ],
      silk: [],
      courtyard: [],
    },
    at: { x: 5, y: 10 },
    rotation: 0,
    side: 'top',
    fields: {},
  };
  b.components = [gndPad];
  b.nets = [
    { name: 'GND', class: 'default', pins: ['J1.1'] },
    { name: 'SIG', class: 'default', pins: [] },
  ];
  // Wall splitting the F.Cu pour at x=20, y 0..20.
  b.tracks = [
    {
      id: 'wall',
      net: 'SIG',
      layer: 'F.Cu',
      width: 0.5,
      seg: { type: 'line', start: { x: 20, y: -1 }, end: { x: 20, y: 21 } },
    },
  ];
  const ring = [
    { x: 1, y: 1 },
    { x: 39, y: 1 },
    { x: 39, y: 19 },
    { x: 1, y: 19 },
  ];
  const zoneDefaults = { clearance: 0.3, minWidth: 0.2, thermal: { gap: 0.3, spokeWidth: 0.4 } };
  b.zones = [
    { id: 'zt', layer: 'F.Cu', net: 'GND', polygon: ring, ...zoneDefaults },
    { id: 'zb', layer: 'B.Cu', net: 'GND', polygon: ring, ...zoneDefaults },
  ];
  return b;
}

describe('planZoneStitching', () => {
  it('stitches an orphaned island through the opposite connected pour', () => {
    const plan = planZoneStitching(makeBoard());
    expect(plan.vias.length).toBe(1);
    const via = plan.vias[0];
    expect(via.net).toBe('GND');
    // In the right (orphaned) half, clear of the wall and edges.
    expect(via.at.x).toBeGreaterThan(21);
    expect(via.at.x).toBeLessThan(39);
    expect(via.at.y).toBeGreaterThan(1);
    expect(via.at.y).toBeLessThan(19);
    expect(plan.unfixed).toHaveLength(0);
  });

  it('the planned via lands inside both layers filled copper', () => {
    const board = makeBoard();
    const plan = planZoneStitching(board);
    const filled = fillAllZones(board);
    for (const z of filled.zones) {
      const anyRing = (z.fill ?? []).some((ring) => pointInPolygon(plan.vias[0].at, ring));
      expect(anyRing).toBe(true);
    }
  });

  it('leaves already-connected pours alone', () => {
    const board = makeBoard();
    board.tracks = []; // no wall: single connected island per layer
    const plan = planZoneStitching(board);
    expect(plan.vias).toHaveLength(0);
    expect(plan.unfixed).toHaveLength(0);
  });

  it('ignores sub-threshold slivers but reports them', () => {
    const board = makeBoard();
    const plan = planZoneStitching(board, { minIslandArea: 1000 });
    expect(plan.vias).toHaveLength(0);
    expect(plan.ignoredSlivers).toBeGreaterThan(0);
  });
});
