/**
 * Do-not-place parts (`fields.dnp`) are fabricated but never assembled: they
 * stay out of the BOM and CPL, out of the part count the quote prices, and
 * do not make a board two-sided.
 */
import { describe, expect, it } from 'vitest';
import { newBoard } from '@flamingo/engine';
import { mergePanel } from '../src/merge.js';
import { buildPanelFab } from '../src/node/exportPanelFab.js';
import { applyPanelOp } from '../src/ops.js';
import { newPanel } from '../src/panel.js';
import type { Panel } from '../src/types.js';
import { LIMITS, R0603, EDGE_CONN, comp, rectOutline, resolved } from './helpers.js';

function faceBoard() {
  const b = newBoard('face', 2);
  b.outline = rectOutline(40, 30);
  b.components.push(comp('R1', R0603, 20, 15));
  // A connector on the back that this build leaves off.
  b.components.push(comp('J1', EDGE_CONN, 20, 10, { side: 'bottom', fields: { value: 'USB-C', package: 'USB-C-EDGE', dnp: true } }));
  return b;
}

function panelOf(key: string, n: number): Panel {
  let r = applyPanelOp(newPanel('p'), { op: 'addSource', source: { key, path: 'face.flamingo', hash: 'h', name: 'face', needed: n } });
  if (!r.ok) throw new Error(r.error);
  let p = r.panel;
  for (let i = 0; i < n; i++) {
    const a = applyPanelOp(p, { op: 'addInstance', source: key, at: { x: 10 + i * 44, y: 10 } });
    if (!a.ok) throw new Error(a.error);
    p = a.panel;
  }
  return p;
}

describe('do-not-place parts on a panel', () => {
  const src = resolved('F', faceBoard());

  it('are not counted as parts, and do not make the board two-sided', () => {
    expect(src.geometry!.parts.map((p) => p.refdes)).toEqual([['R1']]);
    expect(src.geometry!.hasBottomParts).toBe(false);
  });

  it('are fabricated but left out of the merged BOM and CPL', () => {
    const p = panelOf('F', 2);
    const merged = mergePanel(p, [src], LIMITS);
    expect(merged.board.components.some((c) => c.refdes === 'F1_J1')).toBe(true);
    const built = buildPanelFab(p, [src], LIMITS);
    expect(built.bom).toContain('F1_R1');
    expect(built.bom).not.toContain('J1');
    expect(built.cpl).not.toContain('J1');
  });
});
