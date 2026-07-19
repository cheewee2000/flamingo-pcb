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
  Dimension,
  SilkLine,
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
  isSlot,
  holeSlotCenterline,
  capsulePolygon,
} from './geometry.js';
export type { PolyGroup } from './geometry.js';

// Re-export component silk label placement (single source of truth for the
// refdes label anchor used by the SVG/canvas renderers, gerber legend, DRC)
export {
  componentBodyBBox,
  componentLabelPlacement,
  componentLabelRect,
  COMPONENT_LABEL_HEIGHT_MM,
  COMPONENT_LABEL_GAP_MM,
  COMPONENT_LABEL_CHAR_ADVANCE,
} from './labels.js';
export type { ComponentLabelPlacement, ComponentLabelPosition } from './labels.js';

// Re-export ops
export type { Op, OpResult, OpError } from './ops.js';
export { applyOp } from './ops.js';

// Re-export connectivity
export type { RatLine, NetIsland } from './connectivity.js';
export { padAnchor, connectedGroups, netIslands, ratsnest, isFullyRouted } from './connectivity.js';

// Re-export track widening
export type { WidenResult } from './widen.js';
export { widenTracks } from './widen.js';

// Re-export renderer
export type { RenderOpts, SplitLayers } from './render.js';
export {
  renderSVG,
  LAYER_COLORS,
  LABEL_PADS_LAYER,
  LABEL_NETS_LAYER,
  splitLabelLayers,
  labelFontMm,
  padLabelLayout,
  padNetMap,
  LABEL_FONT_MIN_MM,
  LABEL_FONT_MAX_MM,
} from './render.js';

// Re-export zone fill
export { fillZone, fillAllZones, bufferPolygon } from './zonefill.js';
export type { StitchOptions, StitchPlan } from './stitch.js';
export { planZoneStitching } from './stitch.js';

// Re-export DRC
export type { RuleSet } from './drc/rules.js';
export { RULESETS } from './drc/rules.js';
export type { DrcViolation, CopperItem } from './drc/types.js';
export { runDRC, buildCopperItems, groupFillRings } from './drc/drc.js';
