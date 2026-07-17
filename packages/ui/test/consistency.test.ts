/**
 * Drift insurance: packages/ui keeps its own hand-copied layer-color tables
 * (Canvas draws differently from SVG, so a shared import isn't practical --
 * see the "COPIED from packages/engine/src/render.ts" comments in
 * src/renderer.ts and src/panels.ts). This test asserts those copies stay
 * byte-for-byte equal to the engine's binding LAYER_COLORS table so a future
 * edit to one and not the others fails CI instead of silently drifting.
 */
import { describe, it, expect } from 'vitest';
import { LAYER_COLORS } from '@flamingo/engine';
import { COPPER_COLOR } from '../src/renderer.js';
import { LAYER_SWATCH_COLORS } from '../src/panels.js';

describe('layer color table consistency', () => {
  it('renderer.ts COPPER_COLOR matches the engine LAYER_COLORS table', () => {
    expect(COPPER_COLOR).toEqual(LAYER_COLORS);
  });

  it('panels.ts LAYER_SWATCH_COLORS matches the engine LAYER_COLORS table', () => {
    expect(LAYER_SWATCH_COLORS).toEqual(LAYER_COLORS);
  });
});
