/**
 * Flamingo Engine - SVG renderer
 * Units: mm (board space, y-up). Output: SVG (y-down), point-flipped per-vertex.
 *
 * This is the renderer used by the screenshot MCP tool and the golden/
 * snapshot tests -- the signature, color table, and default layer order
 * below are binding (see .superpowers/sdd/task-6-brief.md).
 */

import type { Board, LayerId, Point, PathSeg, Pad, ComponentInst, Keepout, SilkItem } from './types.js';
import { padOutline, padWorld, outlineToPolygon, boardBBox, rotate, add } from './geometry.js';
import { copperLayersOf } from './layers.js';
import type { RatLine } from './connectivity.js';

export interface RenderOpts {
  layers?: LayerId[];
  showRatsnest?: boolean;
  ratsnest?: RatLine[];
  background?: string;
  widthPx?: number;
  region?: { minX: number; minY: number; maxX: number; maxY: number };
  highlightNet?: string;
  drcMarkers?: Point[];
}

// ---------------------------------------------------------------------------
// Color table (binding -- the UI copies these; do not rename/retint casually)
// ---------------------------------------------------------------------------

const COPPER_COLOR: Partial<Record<LayerId, string>> = {
  'F.Cu': '#C83434',
  'In1.Cu': '#7FC87F',
  'In2.Cu': '#CE7D2C',
  'In3.Cu': '#9C6BC8',
  'In4.Cu': '#C8B96B',
  'B.Cu': '#4D7FC4',
};

const SILK_COLOR: Record<'F.Silk' | 'B.Silk', string> = {
  'F.Silk': '#F2EDA1',
  'B.Silk': '#E8B2A7',
};

const EDGE_COLOR = '#D0D2CD';
const THROUGH_PAD_COLOR = '#B8B85A';
const HOLE_COLOR = '#222';
const RATSNEST_COLOR = '#ffffff66';
const HIGHLIGHT_COLOR = '#00FFFF';
const DRC_COLOR = '#FF0000';
const KEEPOUT_COLOR = '#FF6600';
const DEFAULT_BACKGROUND = '#1a1a1a';
const DEFAULT_WIDTH_PX = 1200;
const MARGIN_MM = 2;

// ---------------------------------------------------------------------------
// Number / coordinate formatting (fixed 4dp -- snapshot-stable)
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  const r = n.toFixed(4);
  return r === '-0.0000' ? '0.0000' : r;
}

/** Component placement transform for local points: mirror x (bottom side), rotate, translate. */
function componentTransformPoints(c: ComponentInst, pts: Point[]): Point[] {
  const mirror = c.side === 'bottom';
  return pts.map((pt) => {
    const mirrored = mirror ? { x: -pt.x, y: pt.y } : pt;
    const rotated = rotate(mirrored, c.rotation);
    return add(rotated, c.at);
  });
}

/** World-space rotation (deg CCW) of a footprint-local angle, honoring the mirror rule. */
function componentTransformRotation(c: ComponentInst, localRotationDeg: number): number {
  const mirror = c.side === 'bottom';
  return (mirror ? -localRotationDeg : localRotationDeg) + c.rotation;
}

// ---------------------------------------------------------------------------
// SVG string builder
// ---------------------------------------------------------------------------

export function renderSVG(b: Board, opts: RenderOpts = {}): string {
  const rawBBox = opts.region ?? boardBBox(b);
  const vbMinX = rawBBox.minX - MARGIN_MM;
  const vbMinY = rawBBox.minY - MARGIN_MM;
  let vbWidth = rawBBox.maxX - rawBBox.minX + 2 * MARGIN_MM;
  let vbHeight = rawBBox.maxY - rawBBox.minY + 2 * MARGIN_MM;
  if (vbWidth <= 0) vbWidth = 2 * MARGIN_MM;
  if (vbHeight <= 0) vbHeight = 2 * MARGIN_MM;

  // Per-point flip: world (x,y), y-up -> svg (x, H-y). H chosen so the flipped
  // range lands exactly on [vbMinY, vbMinY+vbHeight]. Physical/visual sense
  // (CW/CCW) is preserved by this relabeling -- see render.ts header note in
  // the task-6 report for the derivation; arc sweep-flags and text rotation
  // signs below are computed accordingly (no extra mirroring needed for the
  // flip itself).
  const H = 2 * vbMinY + vbHeight;

  function svg(p: Point): Point {
    return { x: p.x, y: H - p.y };
  }

  function pt(p: Point): string {
    const s = svg(p);
    return `${fmt(s.x)},${fmt(s.y)}`;
  }

  function polygonPoints(pts: Point[]): string {
    return pts.map((p) => pt(p)).join(' ');
  }

  /** SVG path 'A' command data for a circular arc; `cw` = visually clockwise in the true (unflipped) board view. */
  function arcPathD(start: Point, end: Point, center: Point, cw: boolean): string {
    const r = Math.hypot(start.x - center.x, start.y - center.y);
    const a0 = Math.atan2(start.y - center.y, start.x - center.x);
    const a1 = Math.atan2(end.y - center.y, end.x - center.x);
    const twoPi = 2 * Math.PI;
    let sweep = cw ? (((a0 - a1) % twoPi) + twoPi) % twoPi : (((a1 - a0) % twoPi) + twoPi) % twoPi;
    if (sweep < 1e-9) sweep = twoPi;
    const largeArc = sweep > Math.PI ? 1 : 0;
    const sweepFlag = cw ? 1 : 0;
    const s = svg(start);
    const e = svg(end);
    return `M ${fmt(s.x)} ${fmt(s.y)} A ${fmt(r)} ${fmt(r)} 0 ${largeArc} ${sweepFlag} ${fmt(e.x)} ${fmt(e.y)}`;
  }

  function segPathD(seg: PathSeg): string {
    if (seg.type === 'line') {
      const s = svg(seg.start);
      const e = svg(seg.end);
      return `M ${fmt(s.x)} ${fmt(s.y)} L ${fmt(e.x)} ${fmt(e.y)}`;
    }
    return arcPathD(seg.start, seg.end, seg.center, seg.cw);
  }

  const layerSet = opts.layers ? new Set(opts.layers) : null;
  function layerOn(l: LayerId): boolean {
    return !layerSet || layerSet.has(l);
  }

  const parts: string[] = [];

  // ---- background ----
  const bg = opts.background ?? DEFAULT_BACKGROUND;
  if (bg) {
    parts.push(
      `<rect x="${fmt(vbMinX)}" y="${fmt(vbMinY)}" width="${fmt(vbWidth)}" height="${fmt(vbHeight)}" fill="${bg}"/>`,
    );
  }

  // ---- defs (keepout hatch pattern) ----
  parts.push(
    `<defs><pattern id="keepout-hatch" patternUnits="userSpaceOnUse" width="1" height="1" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1" stroke="${KEEPOUT_COLOR}" stroke-width="0.2"/></pattern></defs>`,
  );

  // ---- copper layers, bottom-up: B.Cu -> inner layers -> F.Cu ----
  const layerOrder = copperLayersOf(b).slice().reverse();

  for (const layer of layerOrder) {
    if (!layerOn(layer)) continue;
    const color = COPPER_COLOR[layer]!;

    // zones on this layer
    const zones = b.zones.filter((z) => z.layer === layer);
    for (const z of zones) {
      if (z.fill && z.fill.length > 0) {
        for (const poly of z.fill) {
          parts.push(
            `<polygon points="${polygonPoints(poly)}" fill="${color}" fill-opacity="0.55" stroke="none"/>`,
          );
        }
      } else {
        parts.push(
          `<polygon points="${polygonPoints(z.polygon)}" fill="${color}" fill-opacity="0.25" stroke="none"/>`,
        );
      }
    }

    // tracks on this layer
    const tracks = b.tracks.filter((t) => t.layer === layer);
    for (const t of tracks) {
      parts.push(
        `<path d="${segPathD(t.seg)}" stroke="${color}" stroke-width="${fmt(t.width)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }

    // SMD pads physically on this layer (F.Cu / B.Cu only)
    if (layer === 'F.Cu' || layer === 'B.Cu') {
      for (const c of b.components) {
        for (const pad of c.footprint.pads) {
          if (pad.layer === 'through') continue;
          const physicalSide: 'top' | 'bottom' =
            c.side === 'bottom' ? (pad.layer === 'top' ? 'bottom' : 'top') : pad.layer;
          const physicalLayer: LayerId = physicalSide === 'top' ? 'F.Cu' : 'B.Cu';
          if (physicalLayer !== layer) continue;
          const outline = padOutline(c, pad);
          parts.push(`<polygon points="${polygonPoints(outline)}" fill="${color}"/>`);
        }
      }
    }
  }

  // ---- through-hole pads (span all copper layers; single fixed color) ----
  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      if (pad.layer !== 'through') continue;
      const outline = padOutline(c, pad);
      parts.push(`<polygon points="${polygonPoints(outline)}" fill="${THROUGH_PAD_COLOR}"/>`);
      if (pad.drill) {
        const world = padWorld(c, pad);
        const r = pad.drill.diameter / 2;
        const p = svg(world.at);
        parts.push(`<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(r)}" fill="${HOLE_COLOR}"/>`);
      }
    }
  }

  // ---- vias (span all copper layers; through-hole style) ----
  for (const v of b.vias) {
    const p = svg(v.at);
    parts.push(`<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(v.diameter / 2)}" fill="${THROUGH_PAD_COLOR}"/>`);
    parts.push(`<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(v.drill / 2)}" fill="${HOLE_COLOR}"/>`);
  }

  // ---- mounting holes ----
  for (const h of b.holes) {
    const p = svg(h.at);
    if (h.plated) {
      parts.push(
        `<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(h.padDiameter / 2)}" fill="${THROUGH_PAD_COLOR}"/>`,
      );
      parts.push(`<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(h.drill / 2)}" fill="${HOLE_COLOR}"/>`);
    } else {
      parts.push(
        `<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(h.drill / 2)}" fill="none" stroke="${EDGE_COLOR}" stroke-width="0.1"/>`,
      );
    }
  }

  // ---- silk (bottom-up: B.Silk then F.Silk) ----
  const silkSides: ('B.Silk' | 'F.Silk')[] = ['B.Silk', 'F.Silk'];
  for (const silkLayer of silkSides) {
    if (!layerOn(silkLayer)) continue;
    const side: 'top' | 'bottom' = silkLayer === 'F.Silk' ? 'top' : 'bottom';
    const color = SILK_COLOR[silkLayer];

    // footprint silk items, per component on this side
    for (const c of b.components) {
      if (c.side !== side) continue;
      const mirror = c.side === 'bottom';
      for (const item of c.footprint.silk) {
        parts.push(...renderSilkItem(item, c, mirror, color));
      }
      // refdes label: always rendered, at the component's origin, 1mm font.
      const at = svg(componentTransformPoints(c, [{ x: 0, y: 0 }])[0]);
      parts.push(
        `<text x="${fmt(at.x)}" y="${fmt(at.y)}" font-family="monospace" font-size="1.0000" text-anchor="middle" fill="${color}">${escapeXml(c.refdes)}</text>`,
      );
    }

    // board-level silk text on this side
    for (const s of b.silk) {
      if (s.layer !== silkLayer) continue;
      const p = svg(s.at);
      const svgRot = -s.rotation;
      const rotAttr = svgRot !== 0 ? ` transform="rotate(${fmt(svgRot)} ${fmt(p.x)} ${fmt(p.y)})"` : '';
      parts.push(
        `<text x="${fmt(p.x)}" y="${fmt(p.y)}" font-family="monospace" font-size="${fmt(s.height)}" text-anchor="middle" fill="${color}"${rotAttr}>${escapeXml(s.text)}</text>`,
      );
    }
  }

  function renderSilkItem(item: SilkItem, c: ComponentInst, mirror: boolean, color: string): string[] {
    const out: string[] = [];
    switch (item.kind) {
      case 'line': {
        const [ws, we] = componentTransformPoints(c, [item.start, item.end]);
        const s = svg(ws);
        const e = svg(we);
        out.push(
          `<line x1="${fmt(s.x)}" y1="${fmt(s.y)}" x2="${fmt(e.x)}" y2="${fmt(e.y)}" stroke="${color}" stroke-width="${fmt(item.width)}" stroke-linecap="round"/>`,
        );
        break;
      }
      case 'arc': {
        const [ws, we, wc] = componentTransformPoints(c, [item.start, item.end, item.center]);
        const effectiveCw = mirror ? !item.cw : item.cw;
        out.push(
          `<path d="${arcPathD(ws, we, wc, effectiveCw)}" stroke="${color}" stroke-width="${fmt(item.width)}" fill="none" stroke-linecap="round"/>`,
        );
        break;
      }
      case 'circle': {
        const [wc] = componentTransformPoints(c, [item.center]);
        const p = svg(wc);
        out.push(
          `<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(item.radius)}" stroke="${color}" stroke-width="${fmt(item.width)}" fill="none"/>`,
        );
        break;
      }
      case 'text': {
        const [wat] = componentTransformPoints(c, [item.at]);
        const p = svg(wat);
        const worldRot = componentTransformRotation(c, item.rotation);
        const svgRot = -worldRot;
        const rotAttr = svgRot !== 0 ? ` transform="rotate(${fmt(svgRot)} ${fmt(p.x)} ${fmt(p.y)})"` : '';
        out.push(
          `<text x="${fmt(p.x)}" y="${fmt(p.y)}" font-family="monospace" font-size="${fmt(item.height)}" text-anchor="middle" fill="${color}"${rotAttr}>${escapeXml(item.text)}</text>`,
        );
        break;
      }
    }
    return out;
  }

  // ---- Edge (board outline) ----
  if (layerOn('Edge') && b.outline.length > 0) {
    const poly = outlineToPolygon(b.outline);
    parts.push(`<polygon points="${polygonPoints(poly)}" fill="none" stroke="${EDGE_COLOR}" stroke-width="0.1"/>`);
  }

  // ---- keepouts (hatched) ----
  for (const k of b.keepouts) {
    if (!keepoutApplies(k, layerSet)) continue;
    parts.push(
      `<polygon points="${polygonPoints(k.polygon)}" fill="url(#keepout-hatch)" fill-opacity="0.6" stroke="${KEEPOUT_COLOR}" stroke-width="0.1"/>`,
    );
  }

  // ---- ratsnest (dashed) ----
  const showRat = !!opts.ratsnest && opts.ratsnest.length > 0 && opts.showRatsnest !== false;
  if (showRat) {
    for (const line of opts.ratsnest!) {
      const s = svg(line.from);
      const e = svg(line.to);
      parts.push(
        `<line x1="${fmt(s.x)}" y1="${fmt(s.y)}" x2="${fmt(e.x)}" y2="${fmt(e.y)}" stroke="${RATSNEST_COLOR}" stroke-width="0.1" stroke-dasharray="0.5,0.5"/>`,
      );
    }
  }

  // ---- highlight overlay ----
  if (opts.highlightNet) {
    const net = opts.highlightNet;

    for (const t of b.tracks) {
      if (t.net !== net) continue;
      parts.push(
        `<path d="${segPathD(t.seg)}" stroke="${HIGHLIGHT_COLOR}" stroke-width="${fmt(t.width + 0.1)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }

    for (const v of b.vias) {
      if (v.net !== net) continue;
      const p = svg(v.at);
      parts.push(
        `<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(v.diameter / 2 + 0.1)}" fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="0.1"/>`,
      );
    }

    const netObj = b.nets.find((n) => n.name === net);
    if (netObj) {
      for (const ref of netObj.pins) {
        const resolved = resolvePin(b, ref);
        if (!resolved) continue;
        const outline = padOutline(resolved.comp, resolved.pad);
        parts.push(
          `<polygon points="${polygonPoints(outline)}" fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="0.1"/>`,
        );
      }
    }
  }

  // ---- DRC markers ----
  if (opts.drcMarkers) {
    for (const m of opts.drcMarkers) {
      const p = svg(m);
      parts.push(
        `<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="0.5000" fill="none" stroke="${DRC_COLOR}" stroke-width="0.15"/>`,
      );
    }
  }

  const widthPx = opts.widthPx ?? DEFAULT_WIDTH_PX;
  const heightPx = (widthPx * vbHeight) / vbWidth;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(widthPx)}" height="${fmt(heightPx)}" viewBox="${fmt(vbMinX)} ${fmt(vbMinY)} ${fmt(vbWidth)} ${fmt(vbHeight)}">` +
    parts.join('') +
    `</svg>`
  );
}

function keepoutApplies(k: Keepout, layerSet: Set<LayerId> | null): boolean {
  if (!layerSet) return true;
  if (k.layers === 'all') return true;
  return k.layers.some((l) => layerSet.has(l));
}

function resolvePin(b: Board, ref: string): { comp: ComponentInst; pad: Pad } | undefined {
  const dot = ref.indexOf('.');
  if (dot === -1) return undefined;
  const refdes = ref.slice(0, dot);
  const padNumber = ref.slice(dot + 1);
  const comp = b.components.find((c) => c.refdes === refdes);
  if (!comp) return undefined;
  const pad = comp.footprint.pads.find((p) => p.number === padNumber);
  if (!pad) return undefined;
  return { comp, pad };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
