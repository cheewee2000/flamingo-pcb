/**
 * Flamingo Panel - board colours.
 *
 * Colour is used for one thing only: telling designs apart. Every instance of
 * a board carries that board's colour, on the plate, in the lists and in the
 * rendered picture. State (bare, pinned, blocked, in error) is still said with
 * line style, hatching and labels, so nothing depends on seeing colour.
 *
 * The palette is Okabe and Ito's, chosen to stay distinguishable with the
 * common forms of colour blindness, less its yellow, which does not hold up as
 * a line on white.
 */

export const BOARD_COLORS: readonly string[] = [
  '#0072B2', // blue
  '#E69F00', // orange
  '#009E73', // green
  '#CC79A7', // purple
  '#D55E00', // vermillion
  '#56B4E9', // sky
  '#8C7A00', // olive
];

/** Share of the colour in an instance's fill; the rest is paper. */
export const BOARD_TINT = 0.18;

/** Colour of the board at position `index` among a panel's sources. Wraps after the palette. */
export function boardColorAt(index: number): string {
  const n = BOARD_COLORS.length;
  return BOARD_COLORS[((index % n) + n) % n]!;
}

/** Colour of board `key`, by its position among the panel's sources. Unknown keys are black. */
export function boardColor(keys: readonly string[], key: string): string {
  const i = keys.indexOf(key);
  return i < 0 ? '#000000' : boardColorAt(i);
}

/** `color` mixed with white: what a translucent fill looks like on paper, as an opaque colour. */
export function tint(color: string, share: number = BOARD_TINT): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return color;
  const mix = (hex: string): string =>
    Math.round(255 + (parseInt(hex, 16) - 255) * share)
      .toString(16)
      .padStart(2, '0');
  return `#${mix(m[1]!)}${mix(m[2]!)}${mix(m[3]!)}`;
}
