import { describe, it, expect } from 'vitest';
import { newBoard } from '@flamingo/engine';
import type { Board } from '@flamingo/engine';
import { exportStep } from '../src/step.js';

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
