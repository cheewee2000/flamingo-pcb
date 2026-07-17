import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { newBoard } from '@flamingo/engine';
import type { Board } from '@flamingo/engine';
import { generateGerbers } from '../src/gerber.js';
import { exportFab } from '../src/exportFab.js';

function boardWithOnePad(): Board {
  const b = newBoard('exporttest', 2);
  b.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { type: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    { type: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
    { type: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
  ];
  b.components.push({
    refdes: 'R1',
    lcsc: 'C25804',
    at: { x: 5, y: 5 },
    rotation: 0,
    side: 'top',
    fields: { value: '10k', package: '0603' },
    footprint: {
      name: 'R0603',
      lcsc: 'C25804',
      courtyard: [],
      silk: [],
      pads: [
        { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
        { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
      ],
    },
  });
  return b;
}

describe('exportFab', () => {
  let outDir: string | undefined;

  afterEach(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
    outDir = undefined;
  });

  it('creates outDir and writes gerbers.zip, bom.csv, cpl.csv, and a bonus board.render.svg', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'flamingo-exportfab-'));
    outDir = join(parent, 'nested', 'fab');
    const b = boardWithOnePad();

    const result = await exportFab(b, outDir);

    expect(result.gerberZip).toBe(join(outDir, 'gerbers.zip'));
    expect(result.bomCsv).toBe(join(outDir, 'bom.csv'));
    expect(result.cplCsv).toBe(join(outDir, 'cpl.csv'));

    for (const p of [result.gerberZip, result.bomCsv, result.cplCsv, join(outDir, 'board.render.svg')]) {
      const st = await stat(p);
      expect(st.isFile()).toBe(true);
    }

    const bom = await readFile(result.bomCsv, 'utf8');
    expect(bom).toContain('10k,R1,0603,C25804');

    const cpl = await readFile(result.cplCsv, 'utf8');
    expect(cpl).toContain('R1,5.0000,5.0000,Top,0');

    const svg = await readFile(join(outDir, 'board.render.svg'), 'utf8');
    expect(svg).toContain('<svg');

    outDir = parent;
  });

  it('zip contains every gerber/drill file generateGerbers produces', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'flamingo-exportfab-zip-'));
    const b = boardWithOnePad();
    const expected = [...generateGerbers(b).files.keys()];

    const result = await exportFab(b, outDir);

    const zip = new AdmZip(result.gerberZip);
    const zipNames = zip.getEntries().map((e) => e.entryName).sort();
    expect(zipNames).toEqual([...expected].sort());

    // spot-check one entry's content round-trips
    const gtl = zip.getEntry(`${b.name}.GTL`);
    expect(gtl).not.toBeNull();
    const content = gtl!.getData().toString('utf8');
    expect(content).toContain('%TF.FileFunction,Copper,L1,Top*%');
  });

  it('returns absolute paths', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'flamingo-exportfab-abs-'));
    const result = await exportFab(boardWithOnePad(), outDir);
    expect(result.gerberZip.startsWith('/')).toBe(true);
    expect(result.bomCsv.startsWith('/')).toBe(true);
    expect(result.cplCsv.startsWith('/')).toBe(true);
  });
});
