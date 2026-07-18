import { describe, expect, it } from 'vitest';
import type { ComponentInst, SilkText } from '@flamingo/engine';
import { boardSilkTextSpec, footprintSilkTextSpec, placeSilkText, silkTextPlaneDims } from '../src/viewer3d/silktext.js';

const BOARD_T = 1.6;
/** Silk line work sits ±0.08 off the faces; text must clear it. */
const SILK_LINE_Z = 0.08;

function makeComponent(over: Partial<ComponentInst>): ComponentInst {
  return {
    refdes: 'U1',
    lcsc: 'C1',
    footprint: { name: 'fp', lcsc: 'C1', pads: [], silk: [], courtyard: [] },
    at: { x: 0, y: 0 },
    rotation: 0,
    side: 'top',
    fields: {},
    ...over,
  };
}

describe('placeSilkText', () => {
  const spec = { text: 'HELLO', height: 1, at: { x: 3, y: -4 }, rotationDeg: 0, side: 'top' as const };

  it('centers a top-side plane on the anchor, above the silk line work, unflipped', () => {
    const p = placeSilkText(spec, 4, BOARD_T);
    expect(p.center.x).toBe(3);
    expect(p.center.y).toBe(-4);
    expect(p.center.z).toBeGreaterThan(BOARD_T + SILK_LINE_Z);
    expect(p.flipY).toBe(false);
    expect(p.rotZ).toBe(0);
    // Plane wraps the measured run with padding proportional to the height.
    expect(p.width).toBeCloseTo(4.5, 6);
    expect(p.height).toBeCloseTo(1.5, 6);
  });

  it('drops a bottom-side plane below the back silk line work and flips it about local y', () => {
    const p = placeSilkText({ ...spec, side: 'bottom' }, 4, BOARD_T);
    expect(p.center.z).toBeLessThan(-SILK_LINE_Z);
    // The flip (π about local y, before rotZ) faces the plane -z and mirrors
    // glyphs x -> -x before rotation — the same mirror the Gerber legend's
    // strokeText applies — so back text reads correctly from below.
    expect(p.flipY).toBe(true);
  });

  it('mirrors top and bottom lift symmetrically about the board faces', () => {
    const top = placeSilkText(spec, 4, BOARD_T);
    const bot = placeSilkText({ ...spec, side: 'bottom' }, 4, BOARD_T);
    expect(top.center.z - BOARD_T).toBeCloseTo(-bot.center.z, 9);
  });

  it('converts the world rotation to radians CCW about +z', () => {
    expect(placeSilkText({ ...spec, rotationDeg: 90 }, 4, BOARD_T).rotZ).toBeCloseTo(Math.PI / 2, 9);
    expect(placeSilkText({ ...spec, rotationDeg: -45 }, 4, BOARD_T).rotZ).toBeCloseTo(-Math.PI / 4, 9);
  });

  it('sizes the plane from the measured width plus em-proportional padding', () => {
    const d = silkTextPlaneDims(6, 2);
    expect(d.width).toBeCloseTo(7, 6); // 6 + 2 * 0.25em * 2mm
    expect(d.height).toBeCloseTo(3, 6); // 1.5em * 2mm
  });
});

describe('boardSilkTextSpec', () => {
  it('maps a standalone SilkText through unchanged, deriving side from the layer', () => {
    const s: SilkText = { id: 's1', layer: 'B.Silk', at: { x: 1, y: 2 }, text: 'v0.7', height: 1.2, rotation: 15 };
    const spec = boardSilkTextSpec(s);
    expect(spec).toEqual({ text: 'v0.7', height: 1.2, at: { x: 1, y: 2 }, rotationDeg: 15, side: 'bottom' });
    expect(boardSilkTextSpec({ ...s, layer: 'F.Silk' }).side).toBe('top');
  });
});

describe('footprintSilkTextSpec', () => {
  const item = { kind: 'text', at: { x: 2, y: 1 }, text: 'PWR', height: 0.8, rotation: 30 } as const;

  it('applies the component transform for a top-side part', () => {
    const c = makeComponent({ at: { x: 10, y: 5 }, rotation: 90 });
    const spec = footprintSilkTextSpec(c, item);
    // rotate (2,1) by 90 CCW -> (-1,2), then translate by (10,5).
    expect(spec.at.x).toBeCloseTo(9, 9);
    expect(spec.at.y).toBeCloseTo(7, 9);
    expect(spec.rotationDeg).toBeCloseTo(120, 9);
    expect(spec.side).toBe('top');
    expect(spec.text).toBe('PWR');
    expect(spec.height).toBe(0.8);
  });

  it('honors the engine mirror rule on a rotated back-side component', () => {
    const c = makeComponent({ at: { x: 10, y: 5 }, rotation: 90, side: 'bottom' });
    const spec = footprintSilkTextSpec(c, item);
    // mirror x: (2,1)->(-2,1); rotate 90 CCW: (-1,-2); translate: (9,3).
    expect(spec.at.x).toBeCloseTo(9, 9);
    expect(spec.at.y).toBeCloseTo(3, 9);
    // mirrored local rotation negates: -30 + 90 = 60.
    expect(spec.rotationDeg).toBeCloseTo(60, 9);
    expect(spec.side).toBe('bottom');
  });
});
