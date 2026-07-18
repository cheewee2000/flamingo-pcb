/**
 * Flamingo Engine - SVG renderer
 * Units: mm (board space, y-up). Output: SVG (y-down), point-flipped per-vertex.
 *
 * This is the renderer used by the screenshot MCP tool and the golden/
 * snapshot tests -- the signature, color table, and default layer order
 * below are binding (see .superpowers/sdd/task-6-brief.md).
 */

import type { Board, LayerId, Point, PathSeg, Pad, ComponentInst, Keepout, SilkItem } from './types.js';
import {
  padOutline,
  padWorld,
  outlineToPolygon,
  boardBBox,
  componentTransformPoints,
  componentTransformRotation,
  isSlot,
  holeSlotCenterline,
  capsulePolygon,
} from './geometry.js';
import { copperLayersOf, padCopperLayers } from './layers.js';
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
  /** Overlay each pad's number at its center (default off). */
  showPadLabels?: boolean;
  /** Overlay, offset below each pad, the name of the net that pad belongs to (default off). */
  showNetLabels?: boolean;
}

// ---------------------------------------------------------------------------
// Label pseudo-layers. These are NOT physical LayerIds -- they are display-only
// overlays the screenshot tool / UI toggle. They live here (not in the LayerId
// enum) so DRC, gerber export, etc. never see them. `splitLabelLayers` maps a
// raw token list (which may mix real LayerIds with these) onto RenderOpts.
// ---------------------------------------------------------------------------

export const LABEL_PADS_LAYER = 'labels:pads';
export const LABEL_NETS_LAYER = 'labels:nets';

export interface SplitLayers {
  /** Physical layers to render, or undefined for "all layers". */
  layers?: LayerId[];
  showPadLabels: boolean;
  showNetLabels: boolean;
}

/**
 * Split a raw layer-token list -- which may include the two label
 * pseudo-layers ('labels:pads', 'labels:nets') alongside real LayerIds -- into
 * physical LayerIds plus the two label flags.
 *
 * `undefined` (no explicit selection) means "show everything": all physical
 * layers AND both label layers. An explicit list shows only the layers/labels
 * it names.
 */
export function splitLabelLayers(layers?: string[]): SplitLayers {
  if (layers === undefined) return { layers: undefined, showPadLabels: true, showNetLabels: true };
  const physical: LayerId[] = [];
  let showPadLabels = false;
  let showNetLabels = false;
  for (const l of layers) {
    if (l === LABEL_PADS_LAYER) showPadLabels = true;
    else if (l === LABEL_NETS_LAYER) showNetLabels = true;
    else physical.push(l as LayerId);
  }
  return { layers: physical, showPadLabels, showNetLabels };
}

// ---------------------------------------------------------------------------
// Color table (binding -- the UI copies these; do not rename/retint casually.
// Exported as LAYER_COLORS so packages/ui/test/consistency.test.ts can assert
// the UI's independent copies -- src/renderer.ts's COPPER_COLOR and
// src/panels.ts's LAYER_SWATCH_COLORS -- stay in sync with this table.)
// ---------------------------------------------------------------------------

export const LAYER_COLORS: Partial<Record<LayerId, string>> = {
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
// Label overlay colors -- deliberately distinct from silk (#F2EDA1/#E8B2A7) and
// the cyan highlight (#00FFFF) so pad numbers and net names read as their own
// layer. The UI (packages/ui/src/renderer.ts) keeps matching copies.
const PAD_LABEL_COLOR = '#22D3EE';
const NET_LABEL_COLOR = '#FACC15';
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

// Label font height (mm): scales with the pad's smaller dimension so the text
// tracks pad size, but clamped so it never shrinks into illegibility or grows
// to swamp the board. Shared by the SVG renderer and the UI canvas renderer.
export const LABEL_FONT_MIN_MM = 0.35;
export const LABEL_FONT_MAX_MM = 1.2;

export function labelFontMm(pad: Pad): number {
  const minDim = Math.min(pad.size.w, pad.size.h);
  const scaled = minDim * 0.6;
  return Math.max(LABEL_FONT_MIN_MM, Math.min(LABEL_FONT_MAX_MM, scaled));
}

/** Approximate glyph advance as a fraction of font size for the monospace label font. */
const LABEL_GLYPH_ASPECT = 0.62;
/** Hard floor: below this the text is unreadable, so stop shrinking and accept it. */
const LABEL_FONT_FLOOR_MM = 0.22;

/**
 * Layout for one pad-number label so neighbors don't overlap on fine-pitch
 * parts: run the text along the pad's LONG axis (in world space — the
 * component's rotation is folded in), and shrink the font until the text
 * fits inside the pad. `vertical` means "draw rotated 90°, reading upward".
 * Shared by the SVG renderer and the UI canvas renderer so screenshots and
 * the live view agree.
 */
export function padLabelLayout(
  pad: Pad,
  componentRotation: number,
): { vertical: boolean; fontMm: number; worldW: number; worldH: number } {
  // Pad dims in world space: a 90°/270° component rotation swaps w/h.
  const swap = Math.round(((componentRotation % 180) + 180) % 180) === 90;
  const worldW = swap ? pad.size.h : pad.size.w;
  const worldH = swap ? pad.size.w : pad.size.h;

  const chars = Math.max(1, String(pad.number).length);
  let fontMm = labelFontMm(pad);
  const textLen = (f: number): number => f * LABEL_GLYPH_ASPECT * chars;

  // Prefer horizontal; go vertical when the pad is taller than wide and the
  // text doesn't fit horizontally but fits (or fits better) vertically.
  let vertical = false;
  if (textLen(fontMm) > worldW && worldH > worldW) vertical = true;

  const along = vertical ? worldH : worldW;
  const cross = vertical ? worldW : worldH;
  // Shrink to fit: text run within the long axis, glyph height within the short axis.
  fontMm = Math.min(fontMm, along / (LABEL_GLYPH_ASPECT * chars), cross * 1.1);
  fontMm = Math.max(fontMm, LABEL_FONT_FLOOR_MM);

  return { vertical, fontMm, worldW, worldH };
}

/** Map of "REFDES.PAD" -> net name, for net-label lookups. */
export function padNetMap(b: Board): Map<string, string> {
  const m = new Map<string, string>();
  for (const net of b.nets) {
    for (const ref of net.pins) m.set(ref, net.name);
  }
  return m;
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
  const cu = copperLayersOf(b);
  const layerOrder = cu.slice().reverse();

  for (const layer of layerOrder) {
    if (!layerOn(layer)) continue;
    const color = LAYER_COLORS[layer]!;

    // zones on this layer
    const zones = b.zones.filter((z) => z.layer === layer);
    for (const z of zones) {
      if (z.fill && z.fill.length > 0) {
        // Winding-encoded rings (outer CCW + hole CW, see zonefill.ts): render
        // as one even-odd path so holes cut through the solid copper.
        const d = z.fill
          .map((poly) => 'M ' + poly.map((p) => `${pt(p)}`).join(' L ') + ' Z')
          .join(' ');
        parts.push(
          `<path d="${d}" fill="${color}" fill-opacity="0.55" fill-rule="evenodd" stroke="none"/>`,
        );
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
          if (!padCopperLayers(pad, c.side, cu).includes(layer)) continue;
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

  // ---- mounting holes (round holes flash circles; milled slots draw stadiums) ----
  for (const h of b.holes) {
    const p = svg(h.at);
    if (isSlot(h)) {
      const { start, end } = holeSlotCenterline(h);
      const annulus = polygonPoints(capsulePolygon(start, end, h.padDiameter / 2));
      const drill = polygonPoints(capsulePolygon(start, end, h.drill / 2));
      if (h.plated) {
        parts.push(`<polygon points="${annulus}" fill="${THROUGH_PAD_COLOR}"/>`);
        parts.push(`<polygon points="${drill}" fill="${HOLE_COLOR}"/>`);
      } else {
        parts.push(`<polygon points="${drill}" fill="none" stroke="${EDGE_COLOR}" stroke-width="0.1"/>`);
      }
    } else if (h.plated) {
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

    // board-level silk lines (mechanical reference outlines) on this side
    for (const line of b.silkLines) {
      if (line.layer !== silkLayer) continue;
      const s = svg(line.start);
      const e = svg(line.end);
      parts.push(
        `<line x1="${fmt(s.x)}" y1="${fmt(s.y)}" x2="${fmt(e.x)}" y2="${fmt(e.y)}" stroke="${color}" stroke-width="${fmt(line.width)}" stroke-linecap="round"/>`,
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

  // ---- label overlays (pad numbers + net names), drawn above copper/silk ----
  if (opts.showPadLabels || opts.showNetLabels) {
    const netByPin = opts.showNetLabels ? padNetMap(b) : null;
    for (const c of b.components) {
      for (const pad of c.footprint.pads) {
        const center = padWorld(c, pad).at;
        const font = labelFontMm(pad);
        if (opts.showPadLabels) {
          const { vertical, fontMm } = padLabelLayout(pad, c.rotation);
          const p = svg(center);
          const rot = vertical ? ` transform="rotate(-90 ${fmt(p.x)} ${fmt(p.y)})"` : '';
          parts.push(
            `<text x="${fmt(p.x)}" y="${fmt(p.y)}" font-family="monospace" font-size="${fmt(fontMm)}" text-anchor="middle" dominant-baseline="central" fill="${PAD_LABEL_COLOR}"${rot}>${escapeXml(pad.number)}</text>`,
          );
        }
        if (netByPin) {
          const netName = netByPin.get(`${c.refdes}.${pad.number}`);
          if (netName) {
            const layout = padLabelLayout(pad, c.rotation);
            if (layout.vertical) {
              // Fine-pitch pad: hang the net name below the pad, reading
              // upward, sized like the pad number so columns don't collide.
              const p = svg({ x: center.x, y: center.y - (layout.worldH / 2 + 0.15) });
              parts.push(
                `<text x="${fmt(p.x)}" y="${fmt(p.y)}" font-family="monospace" font-size="${fmt(layout.fontMm)}" text-anchor="end" dominant-baseline="central" fill="${NET_LABEL_COLOR}" transform="rotate(-90 ${fmt(p.x)} ${fmt(p.y)})">${escapeXml(netName)}</text>`,
              );
            } else {
              // Offset below the pad (world y-up: -y) so it clears the pad number.
              const offset = Math.min(pad.size.w, pad.size.h) / 2 + font;
              const p = svg({ x: center.x, y: center.y - offset });
              parts.push(
                `<text x="${fmt(p.x)}" y="${fmt(p.y)}" font-family="monospace" font-size="${fmt(font)}" text-anchor="middle" dominant-baseline="central" fill="${NET_LABEL_COLOR}">${escapeXml(netName)}</text>`,
              );
            }
          }
        }
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
