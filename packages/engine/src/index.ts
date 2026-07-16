// Re-export types
export type {
  LayerId,
  Point,
  PathSeg,
  Pad,
  SilkItem,
  Footprint,
  ComponentInst,
  Net,
  NetClass,
  Track,
  Via,
  Zone,
  Keepout,
  MountingHole,
  SilkText,
  Board,
} from './types.js';

// Re-export board functions
export { newBoard, serializeBoard, parseBoard } from './board.js';

// Re-export layer functions
export { copperLayersOf, isCopper } from './layers.js';
