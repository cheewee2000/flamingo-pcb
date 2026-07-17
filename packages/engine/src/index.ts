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
export { copperLayersOf, isCopper, padCopperLayers } from './layers.js';

// Re-export geometry functions
export {
  rotate,
  add,
  dist,
  segSegDistance,
  pointSegDistance,
  padWorld,
  padOutline,
  outlineToPolygon,
  bboxOf,
  boardBBox,
  polyIntersects,
  pointInPolygon,
  polyPolyDistance,
  polyGroupDistance,
  polyGroupIntersects,
  expandTrack,
  componentTransformPoints,
  componentTransformRotation,
} from './geometry.js';
export type { PolyGroup } from './geometry.js';

// Re-export ops
export type { Op, OpResult, OpError } from './ops.js';
export { applyOp } from './ops.js';

// Re-export connectivity
export type { RatLine } from './connectivity.js';
export { padAnchor, connectedGroups, ratsnest, isFullyRouted } from './connectivity.js';

// Re-export renderer
export type { RenderOpts } from './render.js';
export { renderSVG, LAYER_COLORS } from './render.js';

// Re-export zone fill
export { fillZone, fillAllZones, bufferPolygon } from './zonefill.js';

// Re-export DRC
export type { RuleSet } from './drc/rules.js';
export { RULESETS } from './drc/rules.js';
export type { DrcViolation, CopperItem } from './drc/types.js';
export { runDRC, buildCopperItems, groupFillRings } from './drc/drc.js';
