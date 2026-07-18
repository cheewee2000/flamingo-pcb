/**
 * Flamingo Server - screenshot tool
 *
 * Renders a Board to a PNG buffer via the engine's SVG renderer + resvg-js,
 * so Claude (and the /api/render.png HTTP route) can get visual feedback on
 * the board it's designing. Composes engine.RenderOpts: ratsnest and DRC
 * markers are computed here (from the connectivity/DRC engines) and passed
 * through as `ratsnest`/`drcMarkers`, both on by default so an agent sees
 * unrouted nets and rule violations without having to ask for them.
 */

import { Resvg } from '@resvg/resvg-js';
import type { Board } from '@flamingo/engine';
import { fillAllZones, ratsnest, renderSVG, runDRC, splitLabelLayers } from '@flamingo/engine';

export interface ScreenshotOpts {
  /**
   * Layers/labels to render. May include the real LayerIds plus the two label
   * pseudo-layers 'labels:pads' and 'labels:nets'. Omit for "show everything":
   * all physical layers AND both label overlays (see `splitLabelLayers`).
   */
  layers?: string[];
  region?: { minX: number; minY: number; maxX: number; maxY: number };
  highlightNet?: string;
  widthPx?: number;
  /** Overlay unrouted airwires (default true). */
  showRatsnest?: boolean;
  /** Overlay DRC violation markers (default true). */
  showDrc?: boolean;
}

export const DEFAULT_WIDTH_PX = 1200;
export const MAX_WIDTH_PX = 2400;

/** Clamp a requested render width to (0, MAX_WIDTH_PX], falling back to DEFAULT_WIDTH_PX. */
export function resolveWidthPx(widthPx?: number): number {
  if (widthPx === undefined || !Number.isFinite(widthPx) || widthPx <= 0) return DEFAULT_WIDTH_PX;
  return Math.min(widthPx, MAX_WIDTH_PX);
}

/**
 * Render `b` to a PNG buffer. Always computes ratsnest when `showRatsnest`
 * (default true) and runs DRC when `showDrc` (default true), so Claude sees
 * unrouted nets and rule violations by default.
 */
export function renderPNG(b: Board, opts: ScreenshotOpts = {}): Buffer {
  // The live board never carries zone fills (only the export path fills a
  // copy), so pour the zones here — screenshots should show real copper, and
  // ratsnest/DRC below then also see the filled board.
  if (b.zones.some((z) => !z.fill)) b = fillAllZones(b);
  const widthPx = resolveWidthPx(opts.widthPx);
  const showRatsnest = opts.showRatsnest !== false;
  const showDrc = opts.showDrc !== false;
  const { layers, showPadLabels, showNetLabels } = splitLabelLayers(opts.layers);

  const svg = renderSVG(b, {
    layers,
    region: opts.region,
    highlightNet: opts.highlightNet,
    widthPx,
    showRatsnest,
    showPadLabels,
    showNetLabels,
    ratsnest: showRatsnest ? ratsnest(b) : undefined,
    drcMarkers: showDrc ? runDRC(b).map((v) => v.at) : undefined,
  });

  const resvg = new Resvg(svg);
  return resvg.render().asPng();
}

/** Decode width/height from a PNG buffer's IHDR chunk (8-byte sig + 4-byte length + "IHDR" + 4-byte width + 4-byte height, big-endian). */
export function pngDimensions(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
