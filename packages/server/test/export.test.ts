import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newBoard } from '@flamingo/engine';
import type { Board, ComponentInst } from '@flamingo/engine';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';
import { exportFileName, INCLUDE_ALL, parseExportQuery } from '../src/export-opts.js';
import { drawingShapes, exportDxf, exportSvg } from '../src/drawing.js';
import { exportStep } from '../src/step.js';

function part(refdes: string, side: 'top' | 'bottom', at: { x: number; y: number }): ComponentInst {
  return {
    refdes,
    lcsc: 'C0',
    footprint: {
      name: 'test-fp',
      lcsc: 'C0',
      pads: [
        { number: '1', shape: 'circle', at: { x: -1, y: 0 }, rotation: 0, size: { w: 1.6, h: 1.6 }, layer: 'through', drill: { diameter: 0.8, plated: true } },
        { number: '2', shape: 'circle', at: { x: 1, y: 0 }, rotation: 0, size: { w: 1.6, h: 1.6 }, layer: 'through', drill: { diameter: 0.8, plated: true } },
      ],
      silk: [],
      courtyard: [
        [
          { x: -2, y: -1 },
          { x: 2, y: -1 },
          { x: 2, y: 1 },
          { x: -2, y: 1 },
        ],
      ],
    },
    at,
    rotation: 90,
    side,
    fields: {},
  };
}

function testBoard(): Board {
  const board = newBoard('exp test', 2);
  board.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 30, y: 0 } },
    { type: 'line', start: { x: 30, y: 0 }, end: { x: 30, y: 20 } },
    { type: 'line', start: { x: 30, y: 20 }, end: { x: 0, y: 20 } },
    { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
  ];
  board.holes.push({ id: 'h1', at: { x: 3, y: 3 }, drill: 3.2, padDiameter: 6, plated: false });
  board.vias.push({ id: 'v1', at: { x: 20, y: 15 }, drill: 0.3, diameter: 0.6, net: 'GND', layers: ['F.Cu', 'B.Cu'] } as Board['vias'][number]);
  board.components.push(part('J1', 'top', { x: 10, y: 10 }), part('J2', 'bottom', { x: 20, y: 5 }));
  return board;
}

const faces = (step: string): number => [...step.matchAll(/ADVANCED_FACE\(/g)].length;

describe('parseExportQuery', () => {
  it('defaults to everything, both sides, layered mm', () => {
    expect(parseExportQuery(new URLSearchParams())).toEqual({
      detail: false,
      include: INCLUDE_ALL,
      side: 'both',
      layers: 'layered',
      units: 'mm',
    });
  });

  it('parses include, detail and options; rejects unknown or empty values', () => {
    const q = parseExportQuery(new URLSearchParams('detail=hd&include=board,mnt&side=top&layers=single&units=in'));
    expect(q.detail).toBe(true);
    expect(q.include).toEqual({ board: true, comps: false, vias: false, pth: false, mnt: true });
    expect(q.side).toBe('top');
    expect(q.layers).toBe('single');
    expect(q.units).toBe('in');
    expect(parseExportQuery(new URLSearchParams('mode=detail')).detail).toBe(true);
    expect(() => parseExportQuery(new URLSearchParams('include='))).toThrow(/at least one/);
    expect(() => parseExportQuery(new URLSearchParams('include=board,traces'))).toThrow(/traces/);
    expect(() => parseExportQuery(new URLSearchParams('units=cm'))).toThrow(/units/);
  });
});

describe('exportFileName', () => {
  const inc = (keys: string[]) => Object.fromEntries(Object.keys(INCLUDE_ALL).map((k) => [k, keys.includes(k)])) as typeof INCLUDE_ALL;
  it('names STEP / STEP HD / 2D drawings', () => {
    expect(exportFileName('exp test', 'step', { detail: false, include: INCLUDE_ALL })).toBe('exp_test.step');
    expect(exportFileName('exp test', 'step', { detail: true, include: INCLUDE_ALL })).toBe('exp_test-hd.step');
    expect(exportFileName('b', 'dxf', { detail: false, include: inc(['board']) })).toBe('b-outline.dxf');
    expect(exportFileName('b', 'svg', { detail: false, include: inc(['board', 'comps']) })).toBe('b-outline+components.svg');
    expect(exportFileName('b', 'dxf', { detail: false, include: inc(['comps']) })).toBe('b-components.dxf');
  });
});

describe('exportStep options', () => {
  it('skips the drills of excluded hole classes', () => {
    const board = testBoard();
    const all = faces(exportStep(board, { include: { comps: false } }));
    const noVias = faces(exportStep(board, { include: { comps: false, vias: false } }));
    const noHoles = faces(exportStep(board, { include: { comps: false, vias: false, pth: false, mnt: false } }));
    expect(noVias).toBeLessThan(all);
    expect(noHoles).toBeLessThan(noVias);
  });

  it('limits component bodies to the chosen side', () => {
    const board = testBoard();
    const top = exportStep(board, { side: 'top' });
    expect(top).toContain("MANIFOLD_SOLID_BREP('J1'");
    expect(top).not.toContain("MANIFOLD_SOLID_BREP('J2'");
    const bottom = exportStep(board, { side: 'bottom' });
    expect(bottom).not.toContain("MANIFOLD_SOLID_BREP('J1'");
    expect(bottom).toContain("MANIFOLD_SOLID_BREP('J2'");
  });

  it('can export components without the board body', () => {
    const step = exportStep(testBoard(), { include: { board: false, comps: true } });
    expect(step).not.toContain("MANIFOLD_SOLID_BREP('exp test'");
    expect(step).toContain("MANIFOLD_SOLID_BREP('J1'");
  });
});

describe('2D drawings', () => {
  it('collects outline, rotated courtyards and drills per element', () => {
    const s = drawingShapes(testBoard());
    expect(s.board).toHaveLength(1);
    expect(s.comps).toHaveLength(2);
    // J1 is rotated 90°: its 4×2 courtyard becomes 2 wide × 4 tall.
    const xs = (s.comps[0] as { pts: { x: number; y: number }[] }).pts.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2);
    expect(s.vias).toEqual([{ kind: 'circle', at: { x: 20, y: 15 }, r: 0.15 }]);
    expect(s.pth).toHaveLength(4);
    expect(s.mnt).toHaveLength(1);
  });

  it('writes an R12 DXF with one layer per element, or everything on layer 0', () => {
    const dxf = exportDxf(testBoard());
    expect(dxf).toContain('AC1009');
    for (const l of ['BOARD_OUTLINE', 'COMPONENTS', 'VIAS', 'PTH', 'MOUNTING']) expect(dxf).toContain(`\n${l}\n`);
    expect([...dxf.matchAll(/^CIRCLE$/gm)]).toHaveLength(6); // 1 via + 4 pad drills + 1 mounting hole
    expect([...dxf.matchAll(/^POLYLINE$/gm)]).toHaveLength(3); // outline + 2 courtyards
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);

    const single = exportDxf(testBoard(), { layers: 'single', include: { comps: false, vias: false, pth: false, mnt: false } });
    expect(single).not.toContain('BOARD_OUTLINE');
    expect([...single.matchAll(/^POLYLINE$/gm)]).toHaveLength(1);
  });

  it('scales to inches', () => {
    const dxf = exportDxf(testBoard(), { units: 'in', include: { board: false, comps: false, pth: false, mnt: false } });
    // Via at (20, 15) mm, radius 0.15 mm.
    expect(dxf).toContain(`10\n${(20 / 25.4).toFixed(5).replace(/0+$/, '')}\n`);
    expect(dxf).toContain(`40\n${(0.15 / 25.4).toFixed(5).replace(/0+$/, '')}\n`);
  });

  it('writes a true-scale SVG with a group per element', () => {
    const svg = exportSvg(testBoard());
    expect(svg).toMatch(/width="32mm" height="22mm" viewBox="0 0 32 22"/);
    expect(svg).toContain('<g id="board-outline"');
    expect(svg).toContain('<g id="components"');
    expect(exportSvg(testBoard(), { units: 'in' })).toMatch(/width="1\.25984in"/);
  });

  it('refuses an export with no geometry', () => {
    expect(() => exportDxf(newBoard('empty', 2))).toThrow(/Nothing to export/);
  });
});

describe('GET /api/export.*', () => {
  let started: StartedServer | null = null;
  afterEach(async () => {
    await started?.close();
    started = null;
  });

  async function serve(board: Board): Promise<string> {
    await started?.close();
    const uiDistDir = join(tmpdir(), `flamingo-export-no-ui-${process.pid}-${Math.random().toString(36).slice(2)}`);
    started = await startServer(new Doc(board), 0, { uiDistDir });
    return `http://localhost:${started.port}`;
  }

  it('serves STEP, DXF and SVG with the modal filenames', async () => {
    const base = await serve(testBoard());
    const step = await fetch(`${base}/api/export.step?include=board,comps,mnt&side=top`);
    expect(step.status).toBe(200);
    expect(step.headers.get('content-disposition')).toContain('filename="exp_test.step"');
    expect(await step.text()).not.toContain("MANIFOLD_SOLID_BREP('J2'");

    const dxf = await fetch(`${base}/api/export.dxf?include=board&layers=single&units=mm`);
    expect(dxf.status).toBe(200);
    expect(dxf.headers.get('content-disposition')).toContain('filename="exp_test-outline.dxf"');

    const svg = await fetch(`${base}/api/export.svg?include=board,comps`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-disposition')).toContain('filename="exp_test-outline+components.svg"');
  });

  it('answers 400 on bad options and 500 with a message when nothing can be exported', async () => {
    const base = await serve(testBoard());
    const bad = await fetch(`${base}/api/export.dxf?include=`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/at least one/);

    const emptyBase = await serve(newBoard('empty', 2));
    const empty = await fetch(`${emptyBase}/api/export.step`);
    expect(empty.status).toBe(500);
    expect(((await empty.json()) as { error: string }).error).toMatch(/Nothing to export/);
  });
});
