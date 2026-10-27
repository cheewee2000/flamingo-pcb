/**
 * 2D mechanical drawings of the board: DXF (AutoCAD R12, ASCII) and SVG.
 *
 * Both draw the same geometry, grouped by export element:
 *  - board: the outline as one closed polyline;
 *  - comps: one body rectangle per part — the courtyard's (else the pads')
 *    extent in the footprint frame, rotated/mirrored with the part;
 *  - vias / pth / mnt: drill circles, or a closed capsule polyline for a slot.
 *
 * Coordinates are board millimetres, y-up, scaled to inches on request. The
 * DXF keeps y-up (CAD convention); the SVG flips to y-down for display.
 */

import type { Board, Point } from '@flamingo/engine';
import {
  allHoles,
  capsulePolygon,
  componentTransformPoints,
  holeSlotCenterline,
  outlineToPolygon,
  padWorld,
} from '@flamingo/engine';
import { componentBox } from './step.js';
import type { DxfLayers, ExportElement, ExportInclude, ExportUnits } from './export-opts.js';
import { INCLUDE_ALL } from './export-opts.js';

export type Shape = { kind: 'poly'; pts: Point[] } | { kind: 'circle'; at: Point; r: number };

export interface DrawingOptions {
  include?: Partial<ExportInclude>;
  units?: ExportUnits;
}

export interface DxfOptions extends DrawingOptions {
  layers?: DxfLayers;
}

/** DXF layer per element when `layers: 'layered'`, with its ACI color. */
export const DXF_LAYERS: Record<ExportElement, { name: string; color: number }> = {
  board: { name: 'BOARD_OUTLINE', color: 7 },
  comps: { name: 'COMPONENTS', color: 3 },
  vias: { name: 'VIAS', color: 1 },
  pth: { name: 'PTH', color: 5 },
  mnt: { name: 'MOUNTING', color: 6 },
};

const SVG_STYLE: Record<ExportElement, { id: string; stroke: string }> = {
  board: { id: 'board-outline', stroke: '#111111' },
  comps: { id: 'components', stroke: '#2e7d4f' },
  vias: { id: 'vias', stroke: '#d11d1d' },
  pth: { id: 'pth', stroke: '#1f5fbf' },
  mnt: { id: 'mounting', stroke: '#8a3ab9' },
};

/** A drill: circle when round, closed capsule outline when slotted. */
function drillShape(start: Point, end: Point, r: number): Shape {
  if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) return { kind: 'circle', at: start, r };
  return { kind: 'poly', pts: capsulePolygon(start, end, r) };
}

/** Geometry per element, in board mm. Elements left out of `include` are empty. */
export function drawingShapes(board: Board, include: Partial<ExportInclude> = {}): Record<ExportElement, Shape[]> {
  const inc = { ...INCLUDE_ALL, ...include };
  const out: Record<ExportElement, Shape[]> = { board: [], comps: [], vias: [], pth: [], mnt: [] };
  let outline: Point[] = [];
  try {
    outline = outlineToPolygon(board.outline);
  } catch {
    outline = [];
  }
  if (inc.board && outline.length >= 3) out.board.push({ kind: 'poly', pts: outline });

  if (inc.comps) {
    for (const c of board.components) {
      // One rectangle per part: the bounding box of its courtyard (else its
      // pads) in the footprint's own frame, then rotated/mirrored with the
      // part. Bare-pad parts (test points, fiducials) have no body.
      if (!componentBox(c)) continue;
      const local = (c.footprint.courtyard ?? []).flat();
      if (local.length === 0) {
        for (const pad of c.footprint.pads) {
          const hw = pad.size.w / 2;
          const hh = pad.size.h / 2;
          const r = (pad.rotation * Math.PI) / 180;
          for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
            local.push({ x: pad.at.x + dx * Math.cos(r) - dy * Math.sin(r), y: pad.at.y + dx * Math.sin(r) + dy * Math.cos(r) });
          }
        }
      }
      if (local.length === 0) continue;
      const xs = local.map((p) => p.x);
      const ys = local.map((p) => p.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      if (!(x1 > x0) || !(y1 > y0)) continue;
      out.comps.push({
        kind: 'poly',
        pts: componentTransformPoints(c, [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ]),
      });
    }
  }

  if (inc.vias) {
    for (const v of board.vias) out.vias.push({ kind: 'circle', at: v.at, r: v.drill / 2 });
  }

  if (inc.pth) {
    for (const c of board.components) {
      for (const pad of c.footprint.pads) {
        if (!pad.drill) continue;
        const { at, rotation } = padWorld(c, pad);
        const d = pad.drill.diameter;
        const slotLen = pad.drill.slotLength ?? 0;
        if (slotLen > d) {
          const rad = (rotation * Math.PI) / 180;
          const half = (slotLen - d) / 2;
          const dx = Math.cos(rad) * half;
          const dy = Math.sin(rad) * half;
          out.pth.push(drillShape({ x: at.x - dx, y: at.y - dy }, { x: at.x + dx, y: at.y + dy }, d / 2));
        } else {
          out.pth.push({ kind: 'circle', at, r: d / 2 });
        }
      }
    }
  }

  if (inc.mnt) {
    for (const h of allHoles(board)) {
      const { start, end } = holeSlotCenterline(h);
      out.mnt.push(drillShape(start, end, h.drill / 2));
    }
  }
  return out;
}

function shapeCount(shapes: Record<ExportElement, Shape[]>): number {
  return Object.values(shapes).reduce((n, s) => n + s.length, 0);
}

function nothingToExport(): Error {
  return new Error('Nothing to export: the selected elements have no geometry on this board');
}

function scaleFor(units: ExportUnits | undefined): number {
  return units === 'in' ? 1 / 25.4 : 1;
}

function num(n: number): string {
  const s = n.toFixed(5).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

// ---------------------------------------------------------------------------
// DXF
// ---------------------------------------------------------------------------

/**
 * AutoCAD R12 ASCII DXF: closed POLYLINE/VERTEX/SEQEND for outlines and
 * slots, CIRCLE for round drills. `layered` puts each element on its own
 * layer (DXF_LAYERS); `single` puts everything on layer 0.
 */
export function exportDxf(board: Board, opts: DxfOptions = {}): string {
  const shapes = drawingShapes(board, opts.include);
  if (shapeCount(shapes) === 0) throw nothingToExport();
  const k = scaleFor(opts.units);
  const layered = (opts.layers ?? 'layered') === 'layered';

  const lines: string[] = [];
  const g = (code: number, value: string | number): void => {
    lines.push(String(code), typeof value === 'number' ? num(value) : value);
  };

  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$INSUNITS');
  g(70, opts.units === 'in' ? '1' : '4');
  g(9, '$MEASUREMENT');
  g(70, opts.units === 'in' ? '0' : '1');
  g(0, 'ENDSEC');

  const used = (Object.keys(shapes) as ExportElement[]).filter((e) => shapes[e].length > 0);
  const layerDefs = layered ? used.map((e) => DXF_LAYERS[e]) : [{ name: '0', color: 7 }];
  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LTYPE');
  g(70, '1');
  g(0, 'LTYPE');
  g(2, 'CONTINUOUS');
  g(70, '0');
  g(3, 'Solid line');
  g(72, '65');
  g(73, '0');
  g(40, '0.0');
  g(0, 'ENDTAB');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, String(layerDefs.length));
  for (const l of layerDefs) {
    g(0, 'LAYER');
    g(2, l.name);
    g(70, '0');
    g(62, String(l.color));
    g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (const e of used) {
    const layer = layered ? DXF_LAYERS[e].name : '0';
    for (const s of shapes[e]) {
      if (s.kind === 'circle') {
        g(0, 'CIRCLE');
        g(8, layer);
        g(10, s.at.x * k);
        g(20, s.at.y * k);
        g(30, '0.0');
        g(40, s.r * k);
        continue;
      }
      g(0, 'POLYLINE');
      g(8, layer);
      g(66, '1');
      g(70, '1'); // closed
      g(10, '0.0');
      g(20, '0.0');
      g(30, '0.0');
      for (const p of s.pts) {
        g(0, 'VERTEX');
        g(8, layer);
        g(10, p.x * k);
        g(20, p.y * k);
        g(30, '0.0');
      }
      g(0, 'SEQEND');
      g(8, layer);
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/**
 * Outline drawing as SVG at true scale: the document's width/height carry
 * the unit (mm or in), the viewBox is in that unit, y is flipped to y-down.
 * One `<g>` per element, hairline strokes, no fill.
 */
export function exportSvg(board: Board, opts: DrawingOptions = {}): string {
  const shapes = drawingShapes(board, opts.include);
  if (shapeCount(shapes) === 0) throw nothingToExport();
  const k = scaleFor(opts.units);
  const unit = opts.units === 'in' ? 'in' : 'mm';

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const grow = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const list of Object.values(shapes)) {
    for (const s of list) {
      if (s.kind === 'circle') {
        grow(s.at.x - s.r, s.at.y - s.r);
        grow(s.at.x + s.r, s.at.y + s.r);
      } else {
        for (const p of s.pts) grow(p.x, p.y);
      }
    }
  }
  const margin = 1; // mm
  const x0 = minX - margin;
  const y1 = maxY + margin;
  const w = (maxX - minX + 2 * margin) * k;
  const h = (maxY - minY + 2 * margin) * k;
  const X = (x: number): string => num((x - x0) * k);
  const Y = (y: number): string => num((y1 - y) * k);
  const stroke = num(0.1 * k);

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}${unit}" height="${num(h)}${unit}" viewBox="0 0 ${num(w)} ${num(h)}">`,
    `<title>${board.name.replace(/[<&>"]/g, '_')}</title>`,
  ];
  for (const e of Object.keys(shapes) as ExportElement[]) {
    if (shapes[e].length === 0) continue;
    const st = SVG_STYLE[e];
    out.push(`<g id="${st.id}" fill="none" stroke="${st.stroke}" stroke-width="${stroke}" stroke-linejoin="round">`);
    for (const s of shapes[e]) {
      if (s.kind === 'circle') {
        out.push(`<circle cx="${X(s.at.x)}" cy="${Y(s.at.y)}" r="${num(s.r * k)}"/>`);
      } else {
        out.push(`<polygon points="${s.pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')}"/>`);
      }
    }
    out.push('</g>');
  }
  out.push('</svg>', '');
  return out.join('\n');
}
