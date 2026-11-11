/**
 * Flamingo Panel - merging a panel into one Board.
 *
 * The fab writers take a Board, so a panel is fabricated by building the Board
 * it amounts to: every instance's copper, holes and silkscreen moved into
 * panel space, plus the panel's own rails, mouse-bite holes, tooling holes and
 * fiducials.
 *
 *  - Refdes are prefixed per instance (`S1_U2`), so BOM and CPL rows stay
 *    unique and traceable to a board on the panel.
 *  - Net names are prefixed per instance (`S1/GND`): the GND of one board and
 *    the GND of its neighbour are not connected, and nothing may treat them as
 *    one net.
 *  - Copper pours are filled on each source board, against its own outline,
 *    and the finished fill is moved. Re-pouring on the panel would clip to the
 *    panel frame instead of the board and flood the gaps.
 *  - Silkscreen refdes labels are placed on the source board and moved, so a
 *    board on a panel carries exactly the legend it carries alone.
 */

import type {
  Board,
  ComponentInst,
  Keepout,
  MountingHole,
  Net,
  NetClass,
  PathSeg,
  Point,
  SilkLine,
  SilkText,
  Track,
  Via,
  Zone,
} from '@flamingo/engine';
import { componentLabelPlacement, fillAllZones, isAssembled } from '@flamingo/engine';
import { targetLayers } from './check.js';
import type { PanelLimits } from './config.js';
import type { Fiducial, PanelGeometry } from './geometry.js';
import { computeGeometry } from './geometry.js';
import type { ResolvedSources } from './resolved.js';
import { panelRules } from './rules.js';
import { applyTransform, boxCorners, type Transform } from './transform.js';
import type { Panel } from './types.js';

export interface MergedLabel {
  text: string;
  at: Point;
  height: number;
  rotation: number;
}

export interface MergedPanel {
  /** The whole panel as one board. Zones carry their fill. */
  board: Board;
  /** Contours to route: the panel outline and every opening. */
  profile: Point[][];
  /** V-cut score lines, edge to edge (empty unless the panel is V-cut). */
  scores: Array<{ start: Point; end: Point }>;
  fiducials: Fiducial[];
  /** Silkscreen label for each merged refdes, as the source board would draw it. */
  labels: Map<string, MergedLabel>;
  /** Merged refdes of every component on an instance that ships bare. */
  bare: Set<string>;
  /** Merged refdes -> where it came from. */
  origin: Map<string, { instance: string; source: string; refdes: string }>;
  /** Things the caller should tell the user about. */
  notes: string[];
}

/** The refdes a component gets on the panel. */
export function mergedRefdes(instanceId: string, refdes: string): string {
  return `${instanceId}_${refdes}`;
}

function normDeg(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

function moveSeg(t: Transform, seg: PathSeg): PathSeg {
  if (seg.type === 'line') {
    return { type: 'line', start: applyTransform(t, seg.start), end: applyTransform(t, seg.end) };
  }
  // A rotation keeps the sense of an arc.
  return {
    type: 'arc',
    start: applyTransform(t, seg.start),
    end: applyTransform(t, seg.end),
    center: applyTransform(t, seg.center),
    cw: seg.cw,
  };
}

function rectOutline(b: { minX: number; minY: number; maxX: number; maxY: number }): PathSeg[] {
  const c = boxCorners(b);
  return c.map((start, i) => ({ type: 'line' as const, start, end: c[(i + 1) % 4]! }));
}

/**
 * Build the Board a panel amounts to. Throws when the panel cannot be merged
 * at all (no instances, unresolved layer count); everything that is merely
 * wrong with the panel is `checkPanel`'s business, not this function's.
 */
export function mergePanel(
  panel: Panel,
  sources: ResolvedSources,
  limits: PanelLimits,
  geometry: PanelGeometry = computeGeometry(panel, sources),
): MergedPanel {
  if (!geometry.frame || geometry.instances.length === 0) {
    throw new Error('the panel has no instances to fabricate');
  }
  if (geometry.unplaced.length > 0) {
    const u = geometry.unplaced[0]!;
    throw new Error(`instance ${u.id} cannot be placed: ${u.reason}`);
  }
  const layers = targetLayers(panel, sources);
  if (layers === null) {
    throw new Error('the boards on the panel have different layer counts and the panel is not promoted');
  }

  const notes: string[] = [];
  const onPanel = new Set(panel.instances.map((i) => i.source));
  const rules = panelRules(layers, sources.filter((s) => onPanel.has(s.key)));
  if (rules.id === 'jlcpcb-4l-adv') {
    notes.push(
      'the panel is made to jlcpcb-4l-adv (advanced vias); JLCPCB charges extra for that tier and the quote does not include it',
    );
  }
  const filledBySource = new Map<string, Board>();
  const labelsBySource = new Map<string, Map<string, MergedLabel>>();
  for (const src of sources) {
    if (!src.board) continue;
    if (src.board.copperLayers > layers) {
      throw new Error(`${src.key} has ${src.board.copperLayers} layers; the panel has ${layers}`);
    }
    filledBySource.set(src.key, src.board.zones.length > 0 ? fillAllZones(src.board) : src.board);
    const labels = new Map<string, MergedLabel>();
    for (const c of src.board.components) {
      const lp = componentLabelPlacement(src.board, c);
      labels.set(c.refdes, { text: c.refdes, at: lp.at, height: lp.height, rotation: lp.rotation });
    }
    labelsBySource.set(src.key, labels);
  }

  const components: ComponentInst[] = [];
  const nets: Net[] = [];
  const netClasses: NetClass[] = [];
  const tracks: Track[] = [];
  const vias: Via[] = [];
  const zones: Zone[] = [];
  const keepouts: Keepout[] = [];
  const holes: MountingHole[] = [];
  const silk: SilkText[] = [];
  const silkLines: SilkLine[] = [];
  const labels = new Map<string, MergedLabel>();
  const bare = new Set<string>();
  const origin = new Map<string, { instance: string; source: string; refdes: string }>();
  const classSeen = new Set<string>();

  for (const inst of geometry.instances) {
    const board = filledBySource.get(inst.source);
    if (!board) throw new Error(`instance ${inst.id}: source ${inst.source} has no board`);
    const t = inst.transform;
    const rot = t.rotation;
    const move = (p: Point): Point => applyTransform(t, p);
    const netName = (n: string): string => `${inst.id}/${n}`;
    const className = (n: string): string => `${inst.source}/${n}`;
    const srcLabels = labelsBySource.get(inst.source)!;

    for (const cls of board.netClasses) {
      const name = className(cls.name);
      if (classSeen.has(name)) continue;
      classSeen.add(name);
      netClasses.push({ ...cls, name });
    }

    for (const c of board.components) {
      const refdes = mergedRefdes(inst.id, c.refdes);
      components.push({ ...c, refdes, at: move(c.at), rotation: normDeg(c.rotation + rot) });
      origin.set(refdes, { instance: inst.id, source: inst.source, refdes: c.refdes });
      if (!inst.populate) bare.add(refdes);
      const lp = srcLabels.get(c.refdes);
      if (lp) labels.set(refdes, { text: lp.text, at: move(lp.at), height: lp.height, rotation: normDeg(lp.rotation + rot) });
    }

    for (const n of board.nets) {
      nets.push({
        name: netName(n.name),
        class: className(n.class),
        pins: n.pins.map((pin) => {
          const dot = pin.indexOf('.');
          return dot < 0 ? pin : `${mergedRefdes(inst.id, pin.slice(0, dot))}${pin.slice(dot)}`;
        }),
      });
    }

    for (const tr of board.tracks) {
      tracks.push({ ...tr, id: `${inst.id}/${tr.id}`, net: netName(tr.net), seg: moveSeg(t, tr.seg) });
    }
    for (const v of board.vias) {
      vias.push({ ...v, id: `${inst.id}/${v.id}`, net: netName(v.net), at: move(v.at) });
    }
    for (const z of board.zones) {
      zones.push({
        ...z,
        id: `${inst.id}/${z.id}`,
        net: netName(z.net),
        polygon: z.polygon.map(move),
        fill: (z.fill ?? []).map((ring) => ring.map(move)),
      });
    }
    for (const k of board.keepouts) {
      keepouts.push({ ...k, id: `${inst.id}/${k.id}`, polygon: k.polygon.map(move) });
    }
    for (const h of board.holes) {
      holes.push({
        ...h,
        id: `${inst.id}/${h.id}`,
        at: move(h.at),
        ...(h.slotLength !== undefined ? { rotation: normDeg((h.rotation ?? 0) + rot) } : {}),
      });
    }
    for (const s of board.silk) {
      silk.push({ ...s, id: `${inst.id}/${s.id}`, at: move(s.at), rotation: normDeg(s.rotation + rot) });
    }
    for (const l of board.silkLines) {
      silkLines.push({ ...l, id: `${inst.id}/${l.id}`, start: move(l.start), end: move(l.end) });
    }
  }

  // The panel's own drills: mouse bites and tooling holes, all non-plated.
  let n = 0;
  for (const tab of geometry.tabs) {
    for (const at of tab.holes) {
      const d = panel.settings.tabs.holeDiameter;
      holes.push({ id: `panel/bite${++n}`, at, drill: d, padDiameter: d, plated: false });
    }
  }
  geometry.toolingHoles.forEach((h, i) => {
    holes.push({ id: `panel/tooling${i + 1}`, at: h.at, drill: h.diameter, padDiameter: h.diameter, plated: false });
  });

  // Silkscreen dividers, on both sides so the cut lines show whichever way up the board lies.
  const lineWidth = limits.silkDivider.lineWidth.value;
  geometry.dividers.forEach((poly, i) => {
    for (let j = 0; j < poly.length - 1; j++) {
      for (const layer of ['F.Silk', 'B.Silk'] as const) {
        silkLines.push({
          id: `panel/divider${i + 1}.${j + 1}.${layer}`,
          layer,
          start: poly[j]!,
          end: poly[j + 1]!,
          width: lineWidth,
        });
      }
    }
  });

  // One LCSC part under two BOM comments makes JLCPCB stop and ask. Two boards
  // that name the same part differently would do that, so the first name wins.
  const commentOf = (c: ComponentInst): string => c.fields.value || c.fields.description || c.lcsc;
  const firstComment = new Map<string, string>();
  for (let i = 0; i < components.length; i++) {
    const c = components[i]!;
    if (!isAssembled(c) || bare.has(c.refdes)) continue;
    const comment = commentOf(c);
    const first = firstComment.get(c.lcsc);
    if (first === undefined) {
      firstComment.set(c.lcsc, comment);
    } else if (first !== comment) {
      components[i] = { ...c, fields: { ...c.fields, value: first } };
      const note = `${c.lcsc} is called "${comment}" on ${origin.get(c.refdes)!.source} and "${first}" elsewhere; the BOM uses "${first}" for all of them`;
      if (!notes.includes(note)) notes.push(note);
    }
  }

  const board: Board = {
    formatVersion: 1,
    name: panel.name,
    copperLayers: layers,
    outline: rectOutline(geometry.frame.outer),
    keepouts,
    holes,
    components,
    nets,
    netClasses,
    tracks,
    vias,
    zones,
    silk,
    silkLines,
    dimensions: [],
    rules: rules.id,
  };

  return {
    board,
    profile: geometry.profile,
    scores: geometry.scores.map((s) => ({ start: s.start, end: s.end })),
    fiducials: geometry.fiducials,
    labels,
    bare,
    origin,
    notes,
  };
}

/** The part of the merged board that gets assembled: bare instances' components removed. */
export function assemblyBoard(merged: MergedPanel): Board {
  return { ...merged.board, components: merged.board.components.filter((c) => !merged.bare.has(c.refdes)) };
}
