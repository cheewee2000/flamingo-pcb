/**
 * @flamingo/panel - multi-board panelization and order cost model.
 *
 * This entry point is pure and browser-safe: no file system, no Node built-ins.
 * Everything that reads board files, hashes them or writes fab output lives
 * under `@flamingo/panel/node`.
 */

export type {
  Rotation,
  Side,
  Separation,
  PanelSource,
  PanelInstance,
  RailSettings,
  TabSettings,
  FiducialSettings,
  ToolingHoleSettings,
  PanelSettings,
  Panel,
  Box,
} from './types.js';
export { SIDES } from './types.js';

export { PANEL_EXTENSION, DEFAULT_SETTINGS, newPanel, serializePanel, parsePanel, mergeSettings , isRotationStep } from './panel.js';

export type { PanelOp, PanelOpResult, PanelOpError, SettingsPatch, InstancePlacement } from './ops.js';
export { applyPanelOp, suggestSourceKey, nextInstanceId } from './ops.js';

export { History, HISTORY_CAP } from './history.js';

export type { CostCurve, CostPoint, Impossible, PanelCurve } from './curve.js';
export { costCurve, curveKey, priceCurve, parsePanelCurve, CURVE_QUANTITIES, ENTERED_KEPT, POINTS_KEPT } from './curve.js';

export type { Sourced, SizeRange, AssemblyType, AssemblyLimits, PanelLimits } from './config.js';
export { settingsFromLimits, listSourced } from './config.js';

export type { Transform } from './transform.js';
export {
  rotate90,
  boxOf,
  boxCorners,
  boxWidth,
  boxHeight,
  unionBox,
  rotatedBox,
  rotatedSize,
  instanceTransform,
  applyTransform,
  applyTransformAll,
  rotateSide,
  unrotateSide,
  oppositeSide,
  atForRotationAboutCentre,
} from './transform.js';

export type { Edge } from './poly.js';
export { normalizeRotation, rotatePoint, sideNormals, sideFacing, edgesOf, ccw, closestPoints, closestSegmentPoints } from './poly.js';

export type { EdgeInfo, Overhang, EdgeKeepout, PartLine, SourceGeometry } from './source.js';
export { resolveSourceGeometry } from './source.js';

export type { ResolvedSource, ResolvedSources } from './resolved.js';
export { findSource } from './resolved.js';

export type {
  PlacedOverhang,
  PlacedInstance,
  UnplacedInstance,
  RailSide,
  Rail,
  Frame,
  Tab,
  Fiducial,
  ToolingHole,
  ScoreLine,
  PanelGeometry,
} from './geometry.js';
export {
  effectiveSpacing,
  usesTabs,
  placeInstances,
  computeFrame,
  edgeSpans,
  tabCentres,
  computeGeometry,
  tabCounts,
} from './geometry.js';

export { panelRules, tighterLimits } from './rules.js';

export type { Severity, IssueCode, PanelIssue } from './check.js';
export { checkPanel, hasErrors, targetLayers, usedLayerCounts, assemblyFit } from './check.js';

export type { SizeLimit, ArrangeOptions, ArrangeOk, ArrangeFail, ArrangeResult } from './layout.js';
export { arrange, sizeLimit } from './layout.js';

export type { MergedLabel, MergedPanel } from './merge.js';
export { mergePanel, mergedRefdes, assemblyBoard } from './merge.js';

export type { QtyPrice, AreaTier, JointTier, PerSide, AttritionRule, AssemblyFees, FeeTable } from './fees.js';
export { stepAtLeast } from './fees.js';

export type {
  JlcPart,
  PriceTier,
  OrderPart,
  OrderPiece,
  OrderAssembly,
  OrderConfig,
  CostCode,
  CostLine,
  CostBreakdown,
} from './cost.js';
export { computeCost, boardPrice, billedQuantity, tierPrice, JLC_PARTS_LIBRARY } from './cost.js';

export type { Received, PieceCount, Eligibility, PricedOrder, PanelQuote } from './order.js';
export {
  pieceParts,
  pieceSides,
  assemblyEligibility,
  priceOrder,
  quantitiesFor,
  receivedFor,
  countInstances,
  designsCharged,
  quotePanel,
} from './order.js';

export type {
  Objective,
  ScenarioKind,
  ScenarioLayout,
  ScenarioOrder,
  ScenarioLine,
  Scenario,
  RejectedScenario,
  QuoteResult,
  QuoteRequest,
} from './scenarios.js';
export { quoteOrder, layoutMatches, OBJECTIVES } from './scenarios.js';

export type { SourceView, LimitView, OrderMinimums, PanelView, BoardLoading, PanelLoading } from './view.js';

export { BOARD_COLORS, BOARD_TINT, boardColorAt, boardColor, tint } from './colors.js';

export type { FabRing, FabDrill, FabFiducial, FabOutline, FabScene } from './fabview.js';
export { FAB_COLORS, classifyRings, fabScene } from './fabview.js';
