/**
 * silkTextParams: the pure orientation/handedness math for silk labels under
 * the view flip. A label reads mirror-X exactly when its silk side is not the
 * side currently being viewed (front view shows back silk reversed, and vice
 * versa); the baseline angle is -worldRot when read directly and +worldRot when
 * read through the board. No canvas needed, so it runs in the node UI suite.
 */
import { describe, it, expect } from 'vitest';
import { silkTextParams } from '../src/renderer.js';

const TOP = false; // silkIsBottom === false
const BOTTOM = true;
const FRONT = false; // flipped === false
const BACK = true;

describe('silkTextParams - mirror flag (reads backwards when side != viewed side)', () => {
  it('front view: top silk reads forward, bottom silk reads mirrored', () => {
    expect(silkTextParams(FRONT, TOP, 0).mirror).toBe(false);
    expect(silkTextParams(FRONT, BOTTOM, 0).mirror).toBe(true);
  });

  it('back view: bottom silk reads forward, top silk reads mirrored', () => {
    expect(silkTextParams(BACK, BOTTOM, 0).mirror).toBe(false);
    expect(silkTextParams(BACK, TOP, 0).mirror).toBe(true);
  });
});

describe('silkTextParams - baseline angle', () => {
  const rad = (deg: number) => (deg * Math.PI) / 180;

  it('directly-viewed labels draw at -worldRot (world CCW -> screen y-down CW)', () => {
    // top silk in front view, and bottom silk in back view, are read directly.
    expect(silkTextParams(FRONT, TOP, 30).angleRad).toBeCloseTo(rad(-30), 12);
    expect(silkTextParams(BACK, BOTTOM, 30).angleRad).toBeCloseTo(rad(-30), 12);
  });

  it('through-the-board (mirrored) labels draw at +worldRot', () => {
    // bottom silk in front view, and top silk in back view, are seen mirrored.
    expect(silkTextParams(FRONT, BOTTOM, 30).angleRad).toBeCloseTo(rad(30), 12);
    expect(silkTextParams(BACK, TOP, 30).angleRad).toBeCloseTo(rad(30), 12);
  });

  it('rotation 0 is unaffected by sign, only the mirror flag differs', () => {
    expect(silkTextParams(FRONT, TOP, 0).angleRad).toBeCloseTo(0, 12);
    expect(silkTextParams(FRONT, BOTTOM, 0).angleRad).toBeCloseTo(0, 12);
  });
});
