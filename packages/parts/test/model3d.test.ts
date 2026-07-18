import { describe, it, expect } from 'vitest';
import { extractModel3d } from '../src/easyeda-parse.js';

// Inline SVGNODE fixture copied from a real cached part (C165948): the footprint
// origin (head.x/y) and the model's c_origin differ, z is negative, and the
// model is rotated 180deg -- so this exercises every branch of the conversion.
// 1 EasyEDA unit = 0.254 mm; originMm is origin-relative with Y negated.
const SVGNODE =
  'SVGNODE~' +
  JSON.stringify({
    gId: 'g1_outline',
    nodeName: 'g',
    nodeType: 1,
    layerid: '19',
    attrs: {
      c_width: '35.19678',
      c_height: '31.1023',
      c_rotation: '0,0,180',
      z: '-3.3465',
      c_origin: '4000.689,3001.7482',
      uuid: '617b05f9bba7410b96c001093d8189e4',
      c_etype: 'outline3D',
      id: 'g1_outline',
      title: 'FOO',
      layerid: '19',
    },
    childNodes: [],
  });

function part(shape: string[]): unknown {
  return {
    success: true,
    result: {
      packageDetail: { dataStr: { head: { x: 4000.689, y: 2997.4175 }, shape } },
    },
  };
}

describe('extractModel3d', () => {
  it('extracts the outline3D model with footprint-local mm coordinates', () => {
    const m = extractModel3d(part(['PAD~ELLIPSE~4000~3000~1~1~1', SVGNODE]));
    expect(m).not.toBeNull();
    expect(m!.uuid).toBe('617b05f9bba7410b96c001093d8189e4');
    // origin-relative, Y negated: x=(4000.689-4000.689)*0.254=0
    expect(m!.originMm.x).toBeCloseTo(0, 4);
    // y = -(3001.7482-2997.4175)*0.254 = -1.1000
    expect(m!.originMm.y).toBeCloseTo(-1.09999778, 4);
    // z = -3.3465 * 0.254 = -0.85001 (sign preserved)
    expect(m!.zMm).toBeCloseTo(-0.850011, 4);
    expect(m!.rotationDeg).toEqual({ x: 0, y: 0, z: 180 });
    expect(m!.widthMm).toBeCloseTo(8.939982, 4);
    expect(m!.heightMm).toBeCloseTo(7.8999842, 4);
  });

  it('accepts a bare result object (no envelope)', () => {
    const bare = {
      packageDetail: { dataStr: { head: { x: 4000.689, y: 2997.4175 }, shape: [SVGNODE] } },
    };
    expect(extractModel3d(bare)?.uuid).toBe('617b05f9bba7410b96c001093d8189e4');
  });

  it('returns null when there is no outline3D SVGNODE', () => {
    expect(extractModel3d(part(['PAD~ELLIPSE~4000~3000~1~1~1']))).toBeNull();
  });

  it('prefers the projection-outline center over a stale c_origin', () => {
    // Real C0805 cap data (C29277): head/pads centered at 4000,3000; the
    // projection polyline is centered there too, but c_origin is stale at
    // 3994.437 (-1.413mm) — the shift that misplaced caps in the 3D view.
    const staleCap =
      'SVGNODE~' +
      JSON.stringify({
        gId: 'g1_outline',
        nodeName: 'g',
        nodeType: 1,
        layerid: '19',
        attrs: {
          c_width: '7.874',
          c_height: '5.1181',
          c_rotation: '0,0,0',
          z: '0',
          c_origin: '3994.437,3000',
          uuid: 'b87ab0c5465a48b3a1c9a6dac8d30bc5',
          c_etype: 'outline3D',
          id: 'g1_outline',
          title: 'C0805_L2.0-W1.3-H1.3',
          layerid: '19',
        },
        childNodes: [
          {
            gId: 'g1_outline_line0',
            nodeName: 'polyline',
            nodeType: 1,
            attrs: {
              fill: 'none',
              id: 'g1_outline_line0',
              c_shapetype: 'line',
              points: '3996.063 2997.4409 4003.937 2997.4409 4003.937 3002.559 3996.063 3002.559',
            },
          },
        ],
      });
    const bare = {
      packageDetail: { dataStr: { head: { x: 4000, y: 3000 }, shape: [staleCap] } },
    };
    const m = extractModel3d(bare);
    // Outline bbox center is (4000, 2999.99995) -> ~(0, 0) mm, NOT c_origin's -1.413mm.
    expect(m!.originMm.x).toBeCloseTo(0, 4);
    expect(m!.originMm.y).toBeCloseTo(0, 4);
  });

  it('falls back to c_origin when the SVGNODE has no projection outline', () => {
    // The main fixture has childNodes: [] — its expectations above already pin
    // the c_origin fallback; this just states the intent explicitly.
    const m = extractModel3d(part([SVGNODE]));
    expect(m!.originMm.y).toBeCloseTo(-1.09999778, 4);
  });

  it('rejects an SVGNODE whose uuid is not 32 hex chars', () => {
    const bad = SVGNODE.replace('617b05f9bba7410b96c001093d8189e4', 'not-a-uuid');
    expect(extractModel3d(part([bad]))).toBeNull();
  });
});
