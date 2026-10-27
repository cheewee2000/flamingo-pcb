import { describe, it, expect } from 'vitest';
import { BOARD_COLORS, boardColor, boardColorAt, tint } from '../src/colors.js';

describe('board colours', () => {
  it('gives each board its own colour, by position', () => {
    expect(boardColor(['S', 'M'], 'S')).toBe(BOARD_COLORS[0]);
    expect(boardColor(['S', 'M'], 'M')).toBe(BOARD_COLORS[1]);
    expect(new Set(BOARD_COLORS).size).toBe(BOARD_COLORS.length);
  });

  it('wraps after the palette and falls back to black for a board it does not know', () => {
    expect(boardColorAt(BOARD_COLORS.length)).toBe(BOARD_COLORS[0]);
    expect(boardColor(['S'], 'Q')).toBe('#000000');
  });

  it('never uses a grey, so a board cannot be mistaken for ink or paper', () => {
    for (const c of BOARD_COLORS) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!), c).toBeGreaterThan(60);
    }
  });

  it('tints toward white', () => {
    expect(tint('#000000', 0.5)).toBe('#808080');
    expect(tint('#0072B2', 0)).toBe('#ffffff');
    expect(tint('#0072B2', 1)).toBe('#0072b2');
    expect(tint('#0072B2')).toBe('#d1e6f1');
  });
});
