/**
 * The websocket pushes boards whose zones never carry `fill` (the server only
 * fills a throwaway copy during export). prepareBoard is the UI's ingest step
 * that computes fills client-side so the 2D canvas draws real pours instead of
 * the faint bare-polygon fallback.
 */
import { describe, it, expect } from 'vitest';
import { newBoard } from '@flamingo/engine';
import type { Board } from '@flamingo/engine';
import { prepareBoard } from '../src/board-prep.js';

/** 20x20 outline with an F.Cu GND zone over most of it. */
function zoneBoard(): Board {
  const b = newBoard('zonetest', 2);
  b.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
    { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
    { type: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 } },
    { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
  ];
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

describe('prepareBoard', () => {
  it('computes zone fills so the 2D canvas draws real pours', () => {
    const prepared = prepareBoard(zoneBoard());
    expect(prepared.zones[0]!.fill).toBeDefined();
    expect(prepared.zones[0]!.fill!.length).toBeGreaterThan(0);
  });

  it('returns the board as-is when there are no zones', () => {
    const b = newBoard('nozones', 2);
    expect(prepareBoard(b)).toBe(b);
  });
});
