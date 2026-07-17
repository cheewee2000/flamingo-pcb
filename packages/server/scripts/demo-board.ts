#!/usr/bin/env node
/**
 * Build a small demo Board (for Task 9 UI viewer verification) purely
 * through engine Ops -- the same path the MCP server tools use -- and
 * write it to .superpowers/sdd/demo/board.flamingo.
 *
 * Contents:
 *  - a 30x20mm rounded-rectangle outline
 *  - two real footprints parsed from packages/parts/test/fixtures via
 *    parseEasyedaFootprint: R1 (C25804, 0603 resistor) and Q1 (C2150, SOT-23-3)
 *  - net SIG: R1 pad 1 <-> Q1 pad 1, routed with one track + one via
 *  - net GND: R1 pad 2 <-> Q1 pad 3, left UNROUTED so the ratsnest shows a line
 *  - one keepout near a board corner
 *  - one board-level silk text label
 *
 * Run with: npx tsx packages/server/scripts/demo-board.ts
 * (tsx isn't a repo devDependency; `npx tsx` fetches it on demand -- see the
 * task-9 report for how this was actually invoked in verification.)
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Board, Op, PathSeg } from '@flamingo/engine';
import { applyOp, newBoard, padWorld, serializeBoard } from '@flamingo/engine';
import { parseEasyedaFootprint } from '@flamingo/parts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', '..', 'parts', 'test', 'fixtures');
const outPath = join(here, '..', '..', '..', '.superpowers', 'sdd', 'demo', 'board.flamingo');

function fixture(lcsc: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, `${lcsc}.json`), 'utf8'));
}

function apply(board: Board, op: Op): Board {
  const result = applyOp(board, op);
  if (!result.ok) throw new Error(`demo-board: op "${op.op}" failed: ${result.error}`);
  return result.board;
}

/** Rounded-rectangle outline (line + arc PathSegs), corners cut to radius `r`. */
function roundedRectOutline(w: number, h: number, r: number): PathSeg[] {
  const hw = w / 2;
  const hh = h / 2;
  const segs: PathSeg[] = [];
  // Corners, CCW starting from the bottom edge's right end, arcs sweep CCW (cw:false).
  segs.push({ type: 'line', start: { x: hw - r, y: -hh }, end: { x: -hw + r, y: -hh } });
  segs.push({ type: 'arc', start: { x: -hw + r, y: -hh }, end: { x: -hw, y: -hh + r }, center: { x: -hw + r, y: -hh + r }, cw: false });
  segs.push({ type: 'line', start: { x: -hw, y: -hh + r }, end: { x: -hw, y: hh - r } });
  segs.push({ type: 'arc', start: { x: -hw, y: hh - r }, end: { x: -hw + r, y: hh }, center: { x: -hw + r, y: hh - r }, cw: false });
  segs.push({ type: 'line', start: { x: -hw + r, y: hh }, end: { x: hw - r, y: hh } });
  segs.push({ type: 'arc', start: { x: hw - r, y: hh }, end: { x: hw, y: hh - r }, center: { x: hw - r, y: hh - r }, cw: false });
  segs.push({ type: 'line', start: { x: hw, y: hh - r }, end: { x: hw, y: -hh + r } });
  segs.push({ type: 'arc', start: { x: hw, y: -hh + r }, end: { x: hw - r, y: -hh }, center: { x: hw - r, y: -hh + r }, cw: false });
  return segs;
}

function main(): void {
  let board = newBoard('demo', 2);

  board = apply(board, { op: 'setOutline', outline: roundedRectOutline(30, 20, 2) });

  const { footprint: r1fp } = parseEasyedaFootprint(fixture('C25804'));
  board = apply(board, {
    op: 'placeComponent',
    refdes: 'R1',
    lcsc: 'C25804',
    footprint: r1fp,
    at: { x: -8, y: 0 },
    rotation: 0,
    side: 'top',
    fields: { value: '10k', package: 'R0603', basic: true },
  });

  const { footprint: q1fp } = parseEasyedaFootprint(fixture('C2150'));
  board = apply(board, {
    op: 'placeComponent',
    refdes: 'Q1',
    lcsc: 'C2150',
    footprint: q1fp,
    at: { x: 6, y: 3 },
    rotation: 0,
    side: 'top',
    fields: { value: 'MMBT3904', package: 'SOT-23-3', basic: true },
  });

  const r1 = board.components.find((c) => c.refdes === 'R1')!;
  const q1 = board.components.find((c) => c.refdes === 'Q1')!;
  const r1pad1 = r1.footprint.pads.find((p) => p.number === '1')!;
  const r1pad2 = r1.footprint.pads.find((p) => p.number === '2')!;
  const q1pad1 = q1.footprint.pads.find((p) => p.number === '1')!;
  const q1pad3 = q1.footprint.pads.find((p) => p.number === '3')!;

  // Net SIG: routed (one track + one via sitting at the track's start).
  board = apply(board, { op: 'connectPins', net: 'SIG', pins: ['R1.1', 'Q1.1'] });
  const sigStart = padWorld(r1, r1pad1).at;
  const sigEnd = padWorld(q1, q1pad1).at;
  board = apply(board, {
    op: 'addTrack',
    track: { layer: 'F.Cu', width: 0.25, net: 'SIG', seg: { type: 'line', start: sigStart, end: sigEnd } },
  });
  board = apply(board, {
    op: 'addVia',
    via: { at: sigStart, drill: 0.3, diameter: 0.6, net: 'SIG' },
  });

  // Net GND: connected (same net) but left unrouted -- ratsnest will draw a
  // dashed line between R1 pad 2 and Q1 pad 3.
  board = apply(board, { op: 'connectPins', net: 'GND', pins: ['R1.2', 'Q1.3'] });
  void padWorld(r1, r1pad2); // (positions only needed if we routed it -- kept for clarity that these are the unrouted pins)
  void padWorld(q1, q1pad3);

  // A keepout near the top-right corner, clear of both components.
  board = apply(board, {
    op: 'addKeepout',
    keepout: {
      layers: 'all',
      polygon: [
        { x: 9, y: 6 },
        { x: 13, y: 6 },
        { x: 13, y: 9 },
        { x: 9, y: 9 },
      ],
      keepout: { copper: true, via: true },
    },
  });

  // Board-level silk label.
  board = apply(board, {
    op: 'addSilkText',
    text: { layer: 'F.Silk', at: { x: 0, y: -8 }, text: 'DEMO v1', height: 1.2, rotation: 0 },
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serializeBoard(board), 'utf8');
  console.log(`demo-board: wrote ${outPath}`);
  console.log(
    `  components=${board.components.length} nets=${board.nets.length} tracks=${board.tracks.length} vias=${board.vias.length} keepouts=${board.keepouts.length} silk=${board.silk.length}`,
  );
}

main();
