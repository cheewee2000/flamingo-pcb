import { describe, it, expect } from 'vitest';
import { newBoard } from '@flamingo/engine';
import type { Board } from '@flamingo/engine';
import { exportStep, exportStepDetail } from '../src/step.js';
import type { MeshGroup } from '../src/objmesh.js';

function rectBoard(): Board {
  const board = newBoard('steptest', 2);
  board.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 30, y: 0 } },
    { type: 'line', start: { x: 30, y: 0 }, end: { x: 30, y: 20 } },
    { type: 'line', start: { x: 30, y: 20 }, end: { x: 0, y: 20 } },
    { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
  ];
  board.holes.push({ id: 'h1', at: { x: 5, y: 5 }, drill: 2.2, padDiameter: 4, plated: false });
  return board;
}

describe('exportStep', () => {
  it('emits a structurally sound AP214 faceted-brep file with the board solid', () => {
    const step = exportStep(rectBoard());
    expect(step.startsWith('ISO-10303-21;')).toBe(true);
    expect(step).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN");
    expect(step).toContain("FACETED_BREP('steptest'");
    expect(step).toContain('CLOSED_SHELL');
    expect(step).toContain('SHAPE_DEFINITION_REPRESENTATION');
    expect(step.trim().endsWith('END-ISO-10303-21;')).toBe(true);

    // Every #n reference must point at a defined entity (ids are 1..max).
    const defined = new Set([...step.matchAll(/^#(\d+)=/gm)].map((m) => Number(m[1])));
    const referenced = [...step.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    for (const ref of referenced) expect(defined.has(ref)).toBe(true);

    // The mounting hole must produce inner wall faces: more faces than a plain
    // 6-face prism (2 triangulated caps + 4 outer walls).
    const faceCount = [...step.matchAll(/FACE_SURFACE/g)].length;
    expect(faceCount).toBeGreaterThan(20);
  });

  it('handles a board without an outline by emitting no solids', () => {
    const step = exportStep(newBoard('empty', 2));
    expect(step).toContain('SHAPE_REPRESENTATION');
    expect(step).not.toContain('FACETED_BREP');
  });
});

describe('exportStepDetail', () => {
  it('emits copper, silk, and mesh solids with presentation colors', () => {
    const board = rectBoard();
    board.tracks.push({
      id: 't1',
      net: 'N1',
      layer: 'F.Cu',
      width: 0.25,
      seg: { type: 'line', start: { x: 2, y: 2 }, end: { x: 20, y: 2 } },
    });
    board.silkLines.push({ id: 's1', layer: 'F.Silk', start: { x: 2, y: 18 }, end: { x: 20, y: 18 }, width: 0.15 });
    board.silk.push({ id: 'st1', layer: 'F.Silk', at: { x: 15, y: 10 }, text: 'HELLO', height: 1, rotation: 0 });
    board.components.push({
      refdes: 'U9',
      lcsc: 'C0',
      footprint: {
        name: 'test-fp',
        lcsc: 'C0',
        pads: [{ number: '1', shape: 'rect', at: { x: 0, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' }],
        silk: [],
        courtyard: [],
      },
      at: { x: 10, y: 10 },
      rotation: 0,
      side: 'top',
      fields: {},
    });

    // One fake world-placed mesh group standing in for a component model.
    const models = new Map<string, MeshGroup[]>([
      [
        'U9',
        [
          {
            color: [0.1, 0.2, 0.3],
            tris: [
              [
                { x: 1, y: 1, z: 1.6 },
                { x: 2, y: 1, z: 1.6 },
                { x: 1, y: 2, z: 2.6 },
              ],
            ],
          },
        ],
      ],
    ]);

    const step = exportStepDetail(board, models);
    expect(step).toContain("FACETED_BREP('steptest'");
    expect(step).toContain("FACETED_BREP('F.Cu'"); // track copper
    expect(step).toContain("FACETED_BREP('F.Silk'"); // stroked silk (line + text)
    expect(step).toContain("FACETED_BREP('U9'"); // the mesh solid
    expect(step).toContain('COLOUR_RGB');
    expect(step).toContain('STYLED_ITEM');
    expect(step).toContain('MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION');

    // Reference integrity: every #n reference must point at a defined entity.
    const defined = new Set([...step.matchAll(/^#(\d+)=/gm)].map((m) => Number(m[1])));
    const referenced = [...step.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    for (const ref of referenced) expect(defined.has(ref)).toBe(true);
  });
});
