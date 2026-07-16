import type { Board, LayerId } from './types.js';

/**
 * Get the copper layer IDs for a board based on its layer count.
 * @param b - Board
 * @returns Array of copper LayerIds in order from top to bottom
 */
export function copperLayersOf(b: Board): LayerId[] {
  switch (b.copperLayers) {
    case 2:
      return ['F.Cu', 'B.Cu'];
    case 4:
      return ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
    case 6:
      return ['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu'];
  }
}

/**
 * Check if a LayerId represents a copper layer.
 * @param l - LayerId to check
 * @returns true if the layer is a copper layer
 */
export function isCopper(l: LayerId): boolean {
  return (
    l === 'F.Cu' ||
    l === 'In1.Cu' ||
    l === 'In2.Cu' ||
    l === 'In3.Cu' ||
    l === 'In4.Cu' ||
    l === 'B.Cu'
  );
}
