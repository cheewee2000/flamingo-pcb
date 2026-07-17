import type { Board, LayerId, Pad } from './types.js';

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

/**
 * The physical copper layer(s) `pad` occupies in world space, for a
 * component mounted on `side`, honoring the bottom-side flip: a
 * footprint-local 'top' pad on a bottom-side component is physically on
 * B.Cu, and vice versa. A 'through' pad occupies every copper layer on the
 * board -- pass `copperLayers` as `copperLayersOf(board)`.
 *
 * Centralizes what used to be six independently-maintained copies of this
 * logic (engine drc.ts/zonefill.ts/connectivity.ts/render.ts, fab
 * gerber.ts, ui renderer.ts).
 * @param pad - Pad to resolve
 * @param side - Mounting side of the pad's component ('top' or 'bottom')
 * @param copperLayers - The board's copper layers in order, i.e. copperLayersOf(board)
 * @returns Array of LayerId the pad physically occupies
 */
export function padCopperLayers(pad: Pad, side: 'top' | 'bottom', copperLayers: LayerId[]): LayerId[] {
  if (pad.layer === 'through') return copperLayers;
  const physicalSide: 'top' | 'bottom' =
    side === 'bottom' ? (pad.layer === 'top' ? 'bottom' : 'top') : pad.layer;
  return [physicalSide === 'top' ? 'F.Cu' : 'B.Cu'];
}
