import { describe, expect, it } from 'vitest';
import { DIMS_KEY, LABEL_NETS_KEY, SILK_KEY, ZONES_KEY, soloCopperLayer, soloedCopperLayer } from '../src/state.js';

const copper = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
const allOn = Object.fromEntries([...copper, ZONES_KEY, SILK_KEY, LABEL_NETS_KEY, DIMS_KEY].map((k) => [k, true]));

describe('show only one copper layer', () => {
  it('keeps that layer and its zones, hides other copper and every overlay', () => {
    const vis = soloCopperLayer(allOn, copper, 'In2.Cu');
    expect(vis).toEqual({
      'F.Cu': false,
      'In1.Cu': false,
      'In2.Cu': true,
      'B.Cu': false,
      [ZONES_KEY]: true,
      [SILK_KEY]: false,
      [LABEL_NETS_KEY]: false,
      [DIMS_KEY]: false,
    });
    expect(soloedCopperLayer(vis, copper)).toBe('In2.Cu');
  });

  it('reports no solo layer when several or none are shown', () => {
    expect(soloedCopperLayer(allOn, copper)).toBeNull();
    expect(soloedCopperLayer({ ...allOn, 'F.Cu': false, 'In1.Cu': false, 'In2.Cu': false, 'B.Cu': false }, copper)).toBeNull();
    expect(soloedCopperLayer({ 'F.Cu': true, 'B.Cu': false }, ['F.Cu', 'B.Cu'])).toBe('F.Cu');
  });
});
