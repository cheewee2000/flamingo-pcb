import { describe, it, expect } from 'vitest';
import { fillAllZones, newBoard } from '@flamingo/engine';
import type { Board, ComponentInst, Footprint } from '@flamingo/engine';
import { DEFAULT_WIDTH_PX, MAX_WIDTH_PX, pngDimensions, renderPNG, resolveWidthPx } from '../src/screenshot.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeFootprint(overrides: Partial<Footprint> = {}): Footprint {
  return {
    name: 'test-fp',
    lcsc: 'C0',
    pads: [
      { number: '1', shape: 'rect', at: { x: -1, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' },
      { number: '2', shape: 'rect', at: { x: 1, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' },
    ],
    silk: [],
    courtyard: [],
    ...overrides,
  };
}

function makeComponent(overrides: Partial<ComponentInst> = {}): ComponentInst {
  return {
    refdes: 'R1',
    lcsc: 'C0',
    footprint: makeFootprint(),
    at: { x: 10, y: 10 },
    rotation: 0,
    side: 'top',
    fields: {},
    ...overrides,
  };
}

/** A 2-layer board with an outline, one component, and one net that is NOT routed
 * (2 pins, no track/via) -- so ratsnest() finds an airwire between R1.1 and R2.1. */
function unroutedBoard(): Board {
  const b = newBoard('screenshot-test', 2);
  b.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
    { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
    { type: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 } },
    { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
  ];
  b.components = [
    makeComponent({ refdes: 'R1', at: { x: 5, y: 10 } }),
    makeComponent({ refdes: 'R2', at: { x: 15, y: 10 } }),
  ];
  b.nets = [{ name: 'NET1', class: 'default', pins: ['R1.1', 'R2.1'] }];
  return b;
}

/** A board that also has an obvious DRC violation: two pads of different nets overlapping. */
function drcViolatingBoard(): Board {
  const b = unroutedBoard();
  b.components.push(makeComponent({ refdes: 'R3', at: { x: 5.1, y: 10 } }));
  b.nets.push({ name: 'NET2', class: 'default', pins: ['R3.1'] });
  return b;
}

function cleanBoard(): Board {
  const b = newBoard('clean-test', 2);
  b.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
    { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
    { type: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 } },
    { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
  ];
  return b;
}

/** cleanBoard + one F.Cu GND zone covering most of the outline. */
function zoneBoard(): Board {
  const b = cleanBoard();
  b.nets = [{ name: 'GND', class: 'default', pins: [] }];
  b.zones = [
    {
      id: 'z1',
      layer: 'F.Cu',
      net: 'GND',
      polygon: [
        { x: 2, y: 2 },
        { x: 18, y: 2 },
        { x: 18, y: 18 },
        { x: 2, y: 18 },
      ],
      clearance: 0.3,
      minWidth: 0.25,
      thermal: { gap: 0.3, spokeWidth: 0.4 },
    },
  ];
  return b;
}

describe('resolveWidthPx', () => {
  it('defaults to DEFAULT_WIDTH_PX when omitted', () => {
    expect(resolveWidthPx(undefined)).toBe(DEFAULT_WIDTH_PX);
  });

  it('caps at MAX_WIDTH_PX', () => {
    expect(resolveWidthPx(99999)).toBe(MAX_WIDTH_PX);
  });

  it('passes through a valid width under the cap', () => {
    expect(resolveWidthPx(600)).toBe(600);
  });

  it('falls back to default for zero/negative/non-finite widths', () => {
    expect(resolveWidthPx(0)).toBe(DEFAULT_WIDTH_PX);
    expect(resolveWidthPx(-10)).toBe(DEFAULT_WIDTH_PX);
    expect(resolveWidthPx(Number.NaN)).toBe(DEFAULT_WIDTH_PX);
  });
});

describe('renderPNG', () => {
  it('returns a Buffer with valid PNG magic bytes', () => {
    const png = renderPNG(cleanBoard());
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it('honors widthPx (checked via the IHDR width field)', () => {
    const png600 = renderPNG(cleanBoard(), { widthPx: 600 });
    const png300 = renderPNG(cleanBoard(), { widthPx: 300 });
    expect(pngDimensions(png600).width).toBe(600);
    expect(pngDimensions(png300).width).toBe(300);
  });

  it('caps widthPx at 2400', () => {
    const png = renderPNG(cleanBoard(), { widthPx: 5000 });
    expect(pngDimensions(png).width).toBe(2400);
  });

  it('defaults to 1200px wide', () => {
    const png = renderPNG(cleanBoard());
    expect(pngDimensions(png).width).toBe(1200);
  });

  it('showRatsnest changes the output vs. showRatsnest:false on a board with an unrouted net', () => {
    const board = unroutedBoard();
    const withRat = renderPNG(board, { showRatsnest: true, showDrc: false });
    const withoutRat = renderPNG(board, { showRatsnest: false, showDrc: false });
    expect(withRat.equals(withoutRat)).toBe(false);
  });

  it('showRatsnest defaults to true (same bytes as explicit true)', () => {
    const board = unroutedBoard();
    const withDefault = renderPNG(board, { showDrc: false });
    const withExplicit = renderPNG(board, { showRatsnest: true, showDrc: false });
    expect(withDefault.equals(withExplicit)).toBe(true);
  });

  it('showDrc changes the output vs. showDrc:false on a board with a DRC violation', () => {
    const board = drcViolatingBoard();
    const withDrc = renderPNG(board, { showDrc: true, showRatsnest: false });
    const withoutDrc = renderPNG(board, { showDrc: false, showRatsnest: false });
    expect(withDrc.equals(withoutDrc)).toBe(false);
  });

  it('showDrc defaults to true (same bytes as explicit true)', () => {
    const board = drcViolatingBoard();
    const withDefault = renderPNG(board, { showRatsnest: false });
    const withExplicit = renderPNG(board, { showDrc: true, showRatsnest: false });
    expect(withDefault.equals(withExplicit)).toBe(true);
  });

  it('layers filter changes the output', () => {
    const board = unroutedBoard();
    const all = renderPNG(board, { showRatsnest: false, showDrc: false });
    const edgeOnly = renderPNG(board, { showRatsnest: false, showDrc: false, layers: ['Edge'] });
    expect(all.equals(edgeOnly)).toBe(false);
  });

  it('includes both label overlays by default (differs from an explicit no-label layer list)', () => {
    // unroutedBoard has pads and a net, so the label overlays draw something.
    const board = unroutedBoard();
    const withLabels = renderPNG(board, { showRatsnest: false, showDrc: false });
    const noLabels = renderPNG(board, {
      showRatsnest: false,
      showDrc: false,
      layers: ['F.Cu', 'B.Cu', 'F.Silk', 'B.Silk', 'Edge'],
    });
    expect(withLabels.equals(noLabels)).toBe(false);
  });

  it('fills copper zones before rendering (same bytes as a pre-filled board)', () => {
    const board = zoneBoard();
    // Guard: the fixture's zone must actually produce a non-empty fill,
    // otherwise both renders would be trivially equal.
    const preFilled = fillAllZones(board);
    expect(preFilled.zones[0]!.fill!.length).toBeGreaterThan(0);

    const auto = renderPNG(board, { showRatsnest: false, showDrc: false });
    const explicit = renderPNG(preFilled, { showRatsnest: false, showDrc: false });
    expect(auto.equals(explicit)).toBe(true);
  });

  it('label pseudo-layers can be requested explicitly via the layers list', () => {
    const board = unroutedBoard();
    const padsOnly = renderPNG(board, {
      showRatsnest: false,
      showDrc: false,
      layers: ['F.Cu', 'B.Cu', 'F.Silk', 'B.Silk', 'Edge', 'labels:pads'],
    });
    const noLabels = renderPNG(board, {
      showRatsnest: false,
      showDrc: false,
      layers: ['F.Cu', 'B.Cu', 'F.Silk', 'B.Silk', 'Edge'],
    });
    expect(padsOnly.equals(noLabels)).toBe(false);
  });
});

describe('pngDimensions', () => {
  it('reads width/height matching a known render', () => {
    const png = renderPNG(cleanBoard(), { widthPx: 800 });
    const { width, height } = pngDimensions(png);
    expect(width).toBe(800);
    expect(height).toBeGreaterThan(0);
  });
});
