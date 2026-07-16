/**
 * One-off script: render a small synthetic board and write the SVG to
 * .superpowers/sdd/task-6-sample.svg for the controller to eyeball.
 * NOT part of `npm test`.
 *
 *   npm run build -w @flamingo/engine   # then:
 *   node --experimental-strip-types packages/engine/scripts/render-sample.ts
 *
 * Imports the compiled dist so it runs under node --experimental-strip-types
 * (which does not rewrite ".js" specifiers to their ".ts" sources).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { newBoard } from '../dist/board.js';
import { renderSVG } from '../dist/render.js';
import type { Board, Footprint, ComponentInst } from '../dist/types.js';

function footprint(): Footprint {
  return {
    name: 'R0603',
    lcsc: 'C25804',
    pads: [
      { number: '1', shape: 'rect', at: { x: -1, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' },
      { number: '2', shape: 'rect', at: { x: 1, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' },
    ],
    silk: [{ kind: 'line', start: { x: -1.5, y: 1 }, end: { x: 1.5, y: 1 }, width: 0.15 }],
    courtyard: [],
  };
}

function component(): ComponentInst {
  return {
    refdes: 'R1',
    lcsc: 'C25804',
    footprint: footprint(),
    at: { x: 10, y: 12 },
    rotation: 0,
    side: 'top',
    fields: { value: '10k' },
  };
}

function sampleBoard(): Board {
  const b: Board = newBoard('sample', 2);
  b.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
    { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
    { type: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 } },
    { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
  ];
  b.components = [component()];
  b.nets = [{ name: 'NET1', class: 'default', pins: ['R1.1', 'R1.2'] }];
  b.tracks = [
    {
      id: 'T1',
      layer: 'F.Cu',
      width: 0.25,
      net: 'NET1',
      seg: { type: 'line', start: { x: 9, y: 12 }, end: { x: 5, y: 12 } },
    },
  ];
  b.vias = [{ id: 'V1', at: { x: 5, y: 12 }, drill: 0.3, diameter: 0.6, net: 'NET1' }];
  b.zones = [
    {
      id: 'Z1',
      layer: 'B.Cu',
      net: 'GND',
      polygon: [
        { x: 2, y: 2 },
        { x: 18, y: 2 },
        { x: 18, y: 18 },
        { x: 2, y: 18 },
      ],
      clearance: 0.2,
      minWidth: 0.2,
      thermal: { gap: 0.5, spokeWidth: 0.25 },
    },
  ];
  b.keepouts = [
    {
      id: 'K1',
      layers: 'all',
      polygon: [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 3 },
        { x: 0, y: 3 },
      ],
      keepout: { copper: true, via: true },
    },
  ];
  b.holes = [{ id: 'H1', at: { x: 1, y: 19 }, drill: 0.8, padDiameter: 1.6, plated: true }];
  b.silk = [{ id: 'S1', layer: 'F.Silk', at: { x: 10, y: 5 }, text: 'FLAMINGO', height: 1, rotation: 0 }];
  return b;
}

const svg = renderSVG(sampleBoard(), {
  ratsnest: [{ net: 'NET1', from: { x: 9, y: 12 }, to: { x: 15, y: 15 } }],
  highlightNet: 'NET1',
  drcMarkers: [{ x: 16, y: 4 }],
});

const outDir = join(import.meta.dirname, '..', '..', '..', '.superpowers', 'sdd');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'task-6-sample.svg');
writeFileSync(outPath, svg);
console.log(`Wrote ${outPath} (${svg.length} bytes)`);
