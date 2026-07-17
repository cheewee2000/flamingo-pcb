import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  Board,
  ComponentInst,
  DrcViolation,
  Footprint,
  Keepout,
  LayerId,
  MountingHole,
  NetClass,
  Op,
  OpError,
  OpResult,
  PathSeg,
  Point,
  SilkText,
  Track,
  Via,
  Zone,
} from '@flamingo/engine';
import {
  boardBBox,
  fillAllZones,
  isFullyRouted,
  newBoard,
  parseBoard,
  ratsnest,
  runDRC,
} from '@flamingo/engine';
import { exportDSN, exportFab, importSES } from '@flamingo/fab';
import type { ImportSESResult } from '@flamingo/fab';
import type { PartInfo, SearchOpts } from '@flamingo/parts';
import type { Doc } from './document.js';
import type { RouteRunner } from './route.js';
import { pngDimensions, renderPNG } from './screenshot.js';

/**
 * Parts API injected into the MCP context so tests can supply a mock (no
 * network access from the test suite) while production wires up the real
 * `fetchPart`/`searchParts` from `@flamingo/parts`.
 */
export interface PartsApi {
  fetchPart(lcsc: string): Promise<{ footprint: Footprint; info: PartInfo }>;
  searchParts(query: string, opts?: SearchOpts): Promise<PartInfo[]>;
}

export interface McpContext {
  doc: Doc;
  projectDir: string;
  partsApi: PartsApi;
  /**
   * Freerouting runner, injected so tests can mock the autorouter (no java /
   * jar in the unit suite). Production wires up the real runner from route.ts.
   */
  route: RouteRunner;
}

// ---------------------------------------------------------------------------
// Small formatting / result helpers
// ---------------------------------------------------------------------------

/** Round to a sane display precision (mm values), trimming FP noise. */
function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(error: string): CallToolResult {
  return { content: [{ type: 'text', text: `ERROR: ${error}` }], isError: true };
}

/** Apply an Op via ctx.doc and turn the OpResult/OpError into a CallToolResult. */
function applyAndReport(
  ctx: McpContext,
  op: Op,
  onOk: (result: OpResult) => string,
): CallToolResult {
  const result = ctx.doc.apply(op);
  if (!result.ok) return errorResult((result as OpError).error);
  return textResult(onOk(result));
}

function formatComponent(c: ComponentInst): string {
  const pkg = c.fields.package ?? c.footprint.name ?? '?';
  const value = c.fields.value ? ` ${c.fields.value}` : '';
  return `${c.refdes} (${c.lcsc}, ${pkg}${value}) at (${fmt(c.at.x)}, ${fmt(c.at.y)}) rot ${fmt(c.rotation)} ${c.side}`;
}

// ---------------------------------------------------------------------------
// get_board_state / describe_connections summaries
// ---------------------------------------------------------------------------

function summarizeBoardState(board: Board): string {
  const lines: string[] = [];
  lines.push(`Board "${board.name}" — ${board.copperLayers}-layer (${board.rules})`);

  if (board.outline.length > 0) {
    const bbox = boardBBox(board);
    lines.push(
      `Outline: ${fmt(bbox.maxX - bbox.minX)} x ${fmt(bbox.maxY - bbox.minY)} mm ` +
        `(bbox ${fmt(bbox.minX)},${fmt(bbox.minY)} to ${fmt(bbox.maxX)},${fmt(bbox.maxY)})`,
    );
  } else {
    lines.push('Outline: none');
  }

  lines.push(`Components (${board.components.length}):`);
  if (board.components.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of board.components) lines.push(`  ${formatComponent(c)}`);
  }

  const unrouted = new Map(isFullyRouted(board).map((u) => [u.net, u.unconnected]));
  lines.push(`Nets (${board.nets.length}):`);
  if (board.nets.length === 0) {
    lines.push('  (none)');
  } else {
    for (const net of board.nets) {
      const status = unrouted.has(net.name)
        ? `unrouted (${unrouted.get(net.name)} island${unrouted.get(net.name) === 1 ? '' : 's'} unconnected)`
        : 'routed';
      lines.push(`  ${net.name} [${net.class}]: ${net.pins.length} pin(s) — ${status}`);
    }
  }

  lines.push(
    `Tracks: ${board.tracks.length}, Vias: ${board.vias.length}, Zones: ${board.zones.length}, ` +
      `Keepouts: ${board.keepouts.length}, Mounting holes: ${board.holes.length}, Silk texts: ${board.silk.length}`,
  );

  return lines.join('\n');
}

function describeConnections(board: Board): string {
  if (board.nets.length === 0) return 'No nets defined.';
  const unrouted = new Map(isFullyRouted(board).map((u) => [u.net, u.unconnected]));
  return board.nets
    .map((net) => {
      const pins = net.pins.length > 0 ? net.pins.join(', ') : '(no pins)';
      const status = unrouted.has(net.name)
        ? `unrouted (${unrouted.get(net.name)} island${unrouted.get(net.name) === 1 ? '' : 's'} unconnected)`
        : 'routed';
      return `${net.name}: ${pins} — ${status}`;
    })
    .join('\n');
}

function formatDrcReport(violations: DrcViolation[]): string {
  if (violations.length === 0) return 'DRC clean: 0 violations.';
  const lines: string[] = [`DRC found ${violations.length} violation(s):`];
  for (const v of violations) {
    const itemsStr = v.items.length > 0 ? v.items.join(', ') : '(none)';
    lines.push(`[${v.rule}] ${v.message} — at (${fmt(v.at.x)}, ${fmt(v.at.y)}); items: ${itemsStr}`);
  }
  return lines.join('\n');
}

/**
 * Resolve the output directory for export_fab: an explicit `outDir` (absolute
 * as-is, else joined onto projectDir); otherwise `<dirname(current board
 * file)>/fab`, falling back to `<projectDir>/fab` for a board that has never
 * been saved (no filePath yet). Shared between the export_fab MCP tool and
 * the POST /api/export HTTP route so both pick the same default.
 */
export function resolveFabOutDir(ctx: McpContext, outDir?: string): string {
  if (outDir) return isAbsolute(outDir) ? outDir : join(ctx.projectDir, outDir);
  const base = ctx.doc.filePath ? dirname(ctx.doc.filePath) : ctx.projectDir;
  return join(base, 'fab');
}

// ---------------------------------------------------------------------------
// Rounded-rect outline construction
// ---------------------------------------------------------------------------

/**
 * Build a CCW rounded-rect outline with bottom-left corner at (0,0). With
 * `cornerRadius` 0 this is 4 line segs; otherwise 4 lines + 4 quarter-circle
 * arcs (cw:false — see geometry.ts tessellateArc: sweeping start->end angle
 * increasing is the CCW/`cw:false` convention).
 */
function buildRectOutline(width: number, height: number, cornerRadius = 0): PathSeg[] {
  const r = Math.max(0, Math.min(cornerRadius, width / 2, height / 2));
  if (r <= 0) {
    return [
      { type: 'line', start: { x: 0, y: 0 }, end: { x: width, y: 0 } },
      { type: 'line', start: { x: width, y: 0 }, end: { x: width, y: height } },
      { type: 'line', start: { x: width, y: height }, end: { x: 0, y: height } },
      { type: 'line', start: { x: 0, y: height }, end: { x: 0, y: 0 } },
    ];
  }
  return [
    { type: 'line', start: { x: r, y: 0 }, end: { x: width - r, y: 0 } },
    {
      type: 'arc',
      start: { x: width - r, y: 0 },
      end: { x: width, y: r },
      center: { x: width - r, y: r },
      cw: false,
    },
    { type: 'line', start: { x: width, y: r }, end: { x: width, y: height - r } },
    {
      type: 'arc',
      start: { x: width, y: height - r },
      end: { x: width - r, y: height },
      center: { x: width - r, y: height - r },
      cw: false,
    },
    { type: 'line', start: { x: width - r, y: height }, end: { x: r, y: height } },
    {
      type: 'arc',
      start: { x: r, y: height },
      end: { x: 0, y: height - r },
      center: { x: r, y: height - r },
      cw: false,
    },
    { type: 'line', start: { x: 0, y: height - r }, end: { x: 0, y: r } },
    {
      type: 'arc',
      start: { x: 0, y: r },
      end: { x: r, y: 0 },
      center: { x: r, y: r },
      cw: false,
    },
  ];
}

function buildPolygonOutline(points: Point[]): PathSeg[] {
  const segs: PathSeg[] = [];
  for (let i = 0; i < points.length; i++) {
    const start = points[i]!;
    const end = points[(i + 1) % points.length]!;
    segs.push({ type: 'line', start, end });
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const LAYER_IDS = [
  'F.Cu',
  'In1.Cu',
  'In2.Cu',
  'In3.Cu',
  'In4.Cu',
  'B.Cu',
  'F.Silk',
  'B.Silk',
  'F.Mask',
  'B.Mask',
  'F.Paste',
  'B.Paste',
  'Edge',
] as const;
const layerIdSchema = z.enum(LAYER_IDS);

const pointSchema = z.object({ x: z.number().describe('X in mm'), y: z.number().describe('Y in mm') });

const pathSegSchema = z.union([
  z.object({
    type: z.literal('line'),
    start: pointSchema,
    end: pointSchema,
  }),
  z.object({
    type: z.literal('arc'),
    start: pointSchema,
    end: pointSchema,
    center: pointSchema,
    cw: z.boolean().describe('true = clockwise sweep from start to end, false = counter-clockwise'),
  }),
]);

const sideSchema = z.enum(['top', 'bottom']);

const regionSchema = z.object({
  minX: z.number().describe('Region min X in mm'),
  minY: z.number().describe('Region min Y in mm'),
  maxX: z.number().describe('Region max X in mm'),
  maxY: z.number().describe('Region max Y in mm'),
});

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

/**
 * Build a fresh McpServer wired to `ctx`. Called once per HTTP request in
 * stateless mode (see http.ts) -- cheap since it just registers closures over
 * `ctx`, no board state lives on the McpServer itself.
 */
export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'flamingo', version: '0.1.0' });

  server.registerTool(
    'new_board',
    {
      description: 'Create a new, empty PCB board, replacing whatever board is currently loaded.',
      inputSchema: {
        name: z.string().describe('Board name'),
        copperLayers: z
          .union([z.literal(2), z.literal(4), z.literal(6)])
          .describe('Number of copper layers: 2, 4, or 6'),
      },
    },
    async ({ name, copperLayers }) => {
      const board = newBoard(name, copperLayers);
      const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'board';
      const filePath = join(ctx.projectDir, `${safeName}.flamingo`);
      ctx.doc.resetBoard(board, filePath, true);
      try {
        await ctx.doc.save();
      } catch (err) {
        return errorResult(`board created but failed to save: ${err instanceof Error ? err.message : String(err)}`);
      }
      return textResult(`Created new board "${name}" (${copperLayers}-layer) — saved to ${filePath}`);
    },
  );

  server.registerTool(
    'open_board',
    {
      description: 'Open a board file, replacing whatever board is currently loaded.',
      inputSchema: {
        path: z.string().describe('Path to a .flamingo board file, absolute or relative to the project directory'),
      },
    },
    async ({ path }) => {
      const abs = isAbsolute(path) ? path : join(ctx.projectDir, path);
      let data: string;
      try {
        data = await readFile(abs, 'utf8');
      } catch (err) {
        return errorResult(`could not read "${abs}": ${err instanceof Error ? err.message : String(err)}`);
      }
      let board: Board;
      try {
        board = parseBoard(data);
      } catch (err) {
        return errorResult(`invalid board file "${abs}": ${err instanceof Error ? err.message : String(err)}`);
      }
      // open_board is a pure read of an already-on-disk file -- must not
      // mark the doc dirty or schedule a debounced rewrite of the file it
      // just read (see Doc.resetBoard's `persist` param).
      ctx.doc.resetBoard(board, abs, false);
      return textResult(`Opened "${abs}" — board "${board.name}", ${board.copperLayers}-layer, ${board.components.length} component(s)`);
    },
  );

  server.registerTool(
    'save_board',
    { description: 'Save the current board to disk immediately.', inputSchema: {} },
    async () => {
      try {
        await ctx.doc.save();
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      return textResult('Saved.');
    },
  );

  server.registerTool(
    'get_board_state',
    {
      description:
        'Get a compact human-readable summary of the current board: name, layers, outline, components, nets with routed status, and item counts.',
      inputSchema: {},
    },
    () => textResult(summarizeBoardState(ctx.doc.board)),
  );

  server.registerTool(
    'describe_connections',
    { description: 'Get a plain-English, per-net description of what is connected to what.', inputSchema: {} },
    () => textResult(describeConnections(ctx.doc.board)),
  );

  server.registerTool(
    'parts_search',
    {
      description:
        'Search LCSC/EasyEDA parts by keyword. NOTE: search is keyword/relevance-ranked, not parametric — an exact or near-exact MPN (e.g. "0603WAF1002T5E") or descriptive terms work much better than a parametric query like "10k 0603".',
      inputSchema: {
        query: z.string().describe('Search keywords — prefer an MPN or descriptive terms'),
        limit: z.number().int().positive().max(100).optional().describe('Max results to return (default 25)'),
      },
    },
    async ({ query, limit }) => {
      let results: PartInfo[];
      try {
        results = await ctx.partsApi.searchParts(query, limit !== undefined ? { limit } : undefined);
      } catch (err) {
        return errorResult(`parts_search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (results.length === 0) return textResult('No results.');
      const lines = results.map((p) => {
        const stock = p.stock !== undefined ? `stock ${p.stock}` : 'stock unknown';
        return `${p.lcsc} | ${p.description || p.mpn} ${p.package ? p.package : ''} | ${p.basic ? 'Basic' : 'Extended'} | ${stock} | ${p.mfr} ${p.mpn}`.replace(/\s+/g, ' ');
      });
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'parts_get',
    {
      description:
        'Fetch full part info and footprint pad list for an LCSC part (so you know pin numbers before wiring it up).',
      inputSchema: { lcsc: z.string().describe('LCSC part number, e.g. "C25804"') },
    },
    async ({ lcsc }) => {
      let footprint: Footprint;
      let info: PartInfo;
      try {
        ({ footprint, info } = await ctx.partsApi.fetchPart(lcsc));
      } catch (err) {
        return errorResult(`parts_get failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const lines: string[] = [];
      lines.push(
        `${info.lcsc} | ${info.mpn} | ${info.mfr} | ${info.package} | ${info.basic ? 'Basic' : 'Extended'}${info.description ? ` | ${info.description}` : ''}`,
      );
      lines.push(`Footprint: ${footprint.name} (${footprint.pads.length} pad(s))`);
      for (const pad of footprint.pads) {
        const drill = pad.drill ? `, drill ${fmt(pad.drill.diameter)}mm${pad.drill.plated ? '' : ' (unplated)'}` : '';
        lines.push(
          `  pad ${pad.number}: ${pad.shape} at (${fmt(pad.at.x)}, ${fmt(pad.at.y)}) size ${fmt(pad.size.w)}x${fmt(pad.size.h)}mm, ${pad.layer}${drill}`,
        );
      }
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'place_component',
    {
      description:
        'Fetch a part\'s footprint by LCSC number and place it on the board under a reference designator. Position is auto-assigned if x/y are omitted.',
      inputSchema: {
        lcsc: z.string().describe('LCSC part number to fetch the footprint for, e.g. "C25804"'),
        refdes: z.string().describe('Reference designator, e.g. "R1", "U3" — must be unique on the board'),
        x: z.number().optional().describe('X position in mm. Omit to auto-place.'),
        y: z.number().optional().describe('Y position in mm. Omit to auto-place.'),
        rotation: z.number().optional().describe('Rotation in degrees CCW (default 0)'),
        side: sideSchema.optional().describe('Board side (default "top")'),
        value: z.string().optional().describe('Value field override, e.g. "10k", "100nF"'),
      },
    },
    async ({ lcsc, refdes, x, y, rotation, side, value }) => {
      let footprint: Footprint;
      let info: PartInfo;
      try {
        ({ footprint, info } = await ctx.partsApi.fetchPart(lcsc));
      } catch (err) {
        return errorResult(`could not fetch part "${lcsc}": ${err instanceof Error ? err.message : String(err)}`);
      }
      const n = ctx.doc.board.components.length;
      const at: Point = { x: x ?? 5 + 5 * n, y: y ?? 5 };
      const op: Op = {
        op: 'placeComponent',
        refdes,
        lcsc,
        footprint,
        at,
        rotation: rotation ?? 0,
        side: side ?? 'top',
        fields: {
          value: value ?? info.description ?? undefined,
          description: info.description,
          mfr: info.mfr,
          package: info.package,
          basic: info.basic,
        },
      };
      return applyAndReport(ctx, op, (result) => {
        const comp = result.board.components.find((c) => c.refdes === refdes)!;
        return `Placed ${formatComponent(comp)}`;
      });
    },
  );

  server.registerTool(
    'move_component',
    {
      description: 'Move, rotate, and/or flip an existing component.',
      inputSchema: {
        refdes: z.string().describe('Reference designator of the component to move'),
        x: z.number().optional().describe('New X position in mm (omit to keep current X)'),
        y: z.number().optional().describe('New Y position in mm (omit to keep current Y)'),
        rotation: z.number().optional().describe('New rotation in degrees CCW (omit to keep current)'),
        side: sideSchema.optional().describe('New board side (omit to keep current)'),
      },
    },
    ({ refdes, x, y, rotation, side }) => {
      let at: Point | undefined;
      if (x !== undefined || y !== undefined) {
        const comp = ctx.doc.board.components.find((c) => c.refdes === refdes);
        if (!comp) return errorResult(`Unknown refdes "${refdes}"`);
        at = { x: x ?? comp.at.x, y: y ?? comp.at.y };
      }
      const op: Op = { op: 'moveComponent', refdes, at, rotation, side };
      return applyAndReport(ctx, op, (result) => {
        const comp = result.board.components.find((c) => c.refdes === refdes)!;
        return `Moved ${formatComponent(comp)}`;
      });
    },
  );

  server.registerTool(
    'remove_component',
    {
      description: 'Remove a component from the board (also drops its pins from any nets).',
      inputSchema: { refdes: z.string().describe('Reference designator of the component to remove') },
    },
    ({ refdes }) => {
      const op: Op = { op: 'removeComponent', refdes };
      return applyAndReport(ctx, op, () => `Removed ${refdes}`);
    },
  );

  server.registerTool(
    'connect_pins',
    {
      description: 'Connect one or more pins to a net (creating the net if it does not already exist).',
      inputSchema: {
        net: z.string().describe('Net name, e.g. "GND", "VCC" — created if it does not exist'),
        pins: z.array(z.string()).min(1).describe('Pin refs in "REFDES.PADNUMBER" form, e.g. ["R1.1", "C1.2"]'),
      },
    },
    ({ net, pins }) => {
      const op: Op = { op: 'connectPins', net, pins };
      return applyAndReport(ctx, op, () => `Connected ${pins.join(', ')} to net "${net}"`);
    },
  );

  server.registerTool(
    'disconnect_pins',
    {
      description: 'Remove one or more pins from whatever net they belong to.',
      inputSchema: {
        pins: z.array(z.string()).min(1).describe('Pin refs in "REFDES.PADNUMBER" form to disconnect'),
      },
    },
    ({ pins }) => {
      const op: Op = { op: 'disconnectPins', pins };
      return applyAndReport(ctx, op, () => `Disconnected ${pins.join(', ')}`);
    },
  );

  server.registerTool(
    'create_net_class',
    {
      description: 'Define a net class with track/via routing rules.',
      inputSchema: {
        name: z.string().describe('Net class name'),
        trackWidth: z.number().describe('Default track width in mm'),
        clearance: z.number().describe('Minimum copper clearance in mm'),
        viaDrill: z.number().describe('Via drill diameter in mm'),
        viaDiameter: z.number().describe('Via pad diameter in mm'),
      },
    },
    ({ name, trackWidth, clearance, viaDrill, viaDiameter }) => {
      const netClass: NetClass = { name, trackWidth, clearance, viaDrill, viaDiameter };
      const op: Op = { op: 'createNetClass', netClass };
      return applyAndReport(ctx, op, () => `Created net class "${name}"`);
    },
  );

  server.registerTool(
    'assign_net_class',
    {
      description: 'Assign an existing net to an existing net class.',
      inputSchema: {
        net: z.string().describe('Net name'),
        class: z.string().describe('Net class name (must already exist — see create_net_class)'),
      },
    },
    ({ net, class: className }) => {
      const op: Op = { op: 'assignNetClass', net, class: className };
      return applyAndReport(ctx, op, () => `Assigned net "${net}" to class "${className}"`);
    },
  );

  server.registerTool(
    'set_board_outline',
    {
      description:
        'Set the board outline. For "rect", give width/height (and optional cornerRadius for rounded corners). For "polygon", give a list of vertices (closed automatically). For "path", give a raw list of line/arc PathSegs.',
      inputSchema: {
        shape: z.enum(['rect', 'polygon', 'path']).describe('Outline shape kind'),
        width: z.number().optional().describe('Rect width in mm (required for shape="rect")'),
        height: z.number().optional().describe('Rect height in mm (required for shape="rect")'),
        cornerRadius: z.number().optional().describe('Rect corner radius in mm; 0 or omitted = square corners'),
        points: z.array(pointSchema).min(3).optional().describe('Polygon vertices in mm (required for shape="polygon")'),
        segs: z.array(pathSegSchema).min(1).optional().describe('Raw PathSeg list (required for shape="path")'),
      },
    },
    ({ shape, width, height, cornerRadius, points, segs }) => {
      let outline: PathSeg[];
      if (shape === 'rect') {
        if (width === undefined || height === undefined) {
          return errorResult('shape="rect" requires both width and height');
        }
        outline = buildRectOutline(width, height, cornerRadius ?? 0);
      } else if (shape === 'polygon') {
        if (!points) return errorResult('shape="polygon" requires points');
        outline = buildPolygonOutline(points);
      } else {
        if (!segs) return errorResult('shape="path" requires segs');
        outline = segs as PathSeg[];
      }
      const op: Op = { op: 'setOutline', outline };
      return applyAndReport(ctx, op, () => `Set board outline (${outline.length} segment(s))`);
    },
  );

  server.registerTool(
    'add_keepout',
    {
      description: 'Add a keepout area blocking copper and/or vias.',
      inputSchema: {
        layers: z.union([z.literal('all'), z.array(layerIdSchema)]).describe('Layers this keepout applies to, or "all"'),
        polygon: z.array(pointSchema).min(3).describe('Polygon vertices in mm'),
        copper: z.boolean().optional().describe('Block copper pours/tracks in this area (default true)'),
        via: z.boolean().optional().describe('Block vias in this area (default true)'),
      },
    },
    ({ layers, polygon, copper, via }) => {
      const keepout: Omit<Keepout, 'id'> = {
        layers,
        polygon,
        keepout: { copper: copper ?? true, via: via ?? true },
      };
      const op: Op = { op: 'addKeepout', keepout };
      return applyAndReport(ctx, op, (result) => `Added keepout ${result.createdIds[0]}`);
    },
  );

  server.registerTool(
    'add_zone',
    {
      description: 'Add a copper pour zone for a net on a layer.',
      inputSchema: {
        layer: layerIdSchema.describe('Copper layer for this zone'),
        net: z.string().describe('Net name this zone pours copper for'),
        polygon: z.array(pointSchema).min(3).describe('Zone outline vertices in mm'),
        clearance: z.number().describe('Clearance from other copper in mm'),
        minWidth: z.number().describe('Minimum copper width in mm'),
        thermalGap: z.number().describe('Thermal relief gap in mm'),
        thermalSpokeWidth: z.number().describe('Thermal relief spoke width in mm'),
      },
    },
    ({ layer, net, polygon, clearance, minWidth, thermalGap, thermalSpokeWidth }) => {
      const zone: Omit<Zone, 'id' | 'fill'> = {
        layer,
        net,
        polygon,
        clearance,
        minWidth,
        thermal: { gap: thermalGap, spokeWidth: thermalSpokeWidth },
      };
      const op: Op = { op: 'addZone', zone };
      return applyAndReport(ctx, op, (result) => `Added zone ${result.createdIds[0]} for net "${net}"`);
    },
  );

  server.registerTool(
    'add_mounting_hole',
    {
      description: 'Add a mounting hole.',
      inputSchema: {
        x: z.number().describe('X position in mm'),
        y: z.number().describe('Y position in mm'),
        drill: z.number().describe('Drill diameter in mm'),
        padDiameter: z.number().describe('Pad/annular ring diameter in mm (>= drill)'),
        plated: z.boolean().optional().describe('Plated (copper-lined) hole (default true)'),
      },
    },
    ({ x, y, drill, padDiameter, plated }) => {
      const hole: Omit<MountingHole, 'id'> = { at: { x, y }, drill, padDiameter, plated: plated ?? true };
      const op: Op = { op: 'addHole', hole };
      return applyAndReport(ctx, op, (result) => `Added mounting hole ${result.createdIds[0]} at (${fmt(x)}, ${fmt(y)})`);
    },
  );

  server.registerTool(
    'add_silk_text',
    {
      description: 'Add silkscreen text.',
      inputSchema: {
        layer: z.enum(['F.Silk', 'B.Silk']).describe('Silkscreen layer'),
        x: z.number().describe('X position in mm'),
        y: z.number().describe('Y position in mm'),
        text: z.string().describe('Text content'),
        height: z.number().describe('Text height in mm'),
        rotation: z.number().optional().describe('Rotation in degrees CCW (default 0)'),
      },
    },
    ({ layer, x, y, text, height, rotation }) => {
      const silkText: Omit<SilkText, 'id'> = { layer, at: { x, y }, text, height, rotation: rotation ?? 0 };
      const op: Op = { op: 'addSilkText', text: silkText };
      return applyAndReport(ctx, op, (result) => `Added silk text ${result.createdIds[0]}: "${text}"`);
    },
  );

  server.registerTool(
    'remove_item',
    {
      description: 'Remove a keepout, zone, mounting hole, silk text, track, or via by id.',
      inputSchema: { id: z.string().describe('Item id, as returned by its creating tool') },
    },
    ({ id }) => {
      const op: Op = { op: 'removeItem', id };
      return applyAndReport(ctx, op, () => `Removed item ${id}`);
    },
  );

  server.registerTool(
    'add_track',
    {
      description:
        'Add a straight copper track (a single line segment; the underlying engine addTrack op also supports arcs, but this tool is line-segment-only for simplicity) to an existing net on a copper layer. Width defaults to the net\'s class trackWidth if omitted.',
      inputSchema: {
        layer: layerIdSchema.describe('Copper layer for this track'),
        width: z
          .number()
          .optional()
          .describe("Track width in mm (default: the net's class trackWidth)"),
        net: z.string().describe('Net name this track belongs to (must already exist)'),
        start: pointSchema.describe('Track start point in mm'),
        end: pointSchema.describe('Track end point in mm'),
      },
    },
    ({ layer, width, net, start, end }) => {
      const netObj = ctx.doc.board.nets.find((n) => n.name === net);
      const netClass = netObj ? ctx.doc.board.netClasses.find((c) => c.name === netObj.class) : undefined;
      const track: Omit<Track, 'id'> = {
        layer,
        width: width ?? netClass?.trackWidth ?? 0.25,
        net,
        seg: { type: 'line', start, end },
      };
      const op: Op = { op: 'addTrack', track };
      return applyAndReport(
        ctx,
        op,
        (result) => `Added track ${result.createdIds[0]} on ${layer} for net "${net}", width ${fmt(track.width)}mm`,
      );
    },
  );

  server.registerTool(
    'add_via',
    {
      description:
        "Add a via (a plated through-hole that joins copper layers) to an existing net. drill/diameter default from the net's class viaDrill/viaDiameter if omitted.",
      inputSchema: {
        x: z.number().describe('X position in mm'),
        y: z.number().describe('Y position in mm'),
        net: z.string().describe('Net name this via belongs to (must already exist)'),
        drill: z.number().optional().describe("Via drill diameter in mm (default: the net's class viaDrill)"),
        diameter: z
          .number()
          .optional()
          .describe("Via pad diameter in mm (default: the net's class viaDiameter)"),
      },
    },
    ({ x, y, net, drill, diameter }) => {
      const netObj = ctx.doc.board.nets.find((n) => n.name === net);
      const netClass = netObj ? ctx.doc.board.netClasses.find((c) => c.name === netObj.class) : undefined;
      const via: Omit<Via, 'id'> = {
        at: { x, y },
        drill: drill ?? netClass?.viaDrill ?? 0.3,
        diameter: diameter ?? netClass?.viaDiameter ?? 0.6,
        net,
      };
      const op: Op = { op: 'addVia', via };
      return applyAndReport(
        ctx,
        op,
        (result) => `Added via ${result.createdIds[0]} at (${fmt(x)}, ${fmt(y)}) for net "${net}"`,
      );
    },
  );

  server.registerTool(
    'get_ratsnest',
    { description: 'Get the current ratsnest (unrouted airwire) lines.', inputSchema: {} },
    () => {
      const lines = ratsnest(ctx.doc.board);
      if (lines.length === 0) return textResult('No unrouted connections.');
      const text = lines
        .map(
          (l) =>
            `${l.net}: (${fmt(l.from.x)}, ${fmt(l.from.y)}) -> (${fmt(l.to.x)}, ${fmt(l.to.y)})`,
        )
        .join('\n');
      return textResult(text);
    },
  );

  server.registerTool(
    'run_drc',
    {
      description:
        'Run design rule checks (DRC) against the current board using the fab ruleset matching its layer count (JLCPCB 2/4/6-layer capabilities). Checks clearance, track width, drill/annular/via-diameter minimums, copper-to-edge, keepouts, hole-to-hole spacing, courtyard overlap, silk-over-pad, unconnected nets, and outline issues. Returns a report of violations (an empty report means the board is DRC-clean) -- violations are reported as data, not a tool error.',
      inputSchema: {},
    },
    () => textResult(formatDrcReport(runDRC(ctx.doc.board))),
  );

  server.registerTool(
    'undo',
    { description: 'Undo the last board-modifying operation.', inputSchema: {} },
    () => {
      const board = ctx.doc.undo();
      if (board === null) return errorResult('Nothing to undo.');
      return textResult('Undid last operation.');
    },
  );

  server.registerTool(
    'redo',
    { description: 'Redo the last undone operation.', inputSchema: {} },
    () => {
      const board = ctx.doc.redo();
      if (board === null) return errorResult('Nothing to redo.');
      return textResult('Redid last undone operation.');
    },
  );

  server.registerTool(
    'unroute',
    {
      description:
        'Remove routed tracks and vias. Give a net name to unroute just that net, or omit to unroute the whole board.',
      inputSchema: {
        net: z.string().optional().describe('Net to unroute (omit to unroute all nets)'),
      },
    },
    ({ net }) => {
      const op: Op = { op: 'unroute', net };
      return applyAndReport(ctx, op, () =>
        net ? `Unrouted net "${net}".` : 'Unrouted all nets.',
      );
    },
  );

  server.registerTool(
    'autoroute',
    {
      description:
        'Autoroute the board with Freerouting. Give a list of nets to route only those (existing routes on other nets are respected as obstacles), or omit to route the whole board. Requires a Java runtime; the freerouting.jar is downloaded on first use.',
      inputSchema: {
        nets: z
          .array(z.string())
          .optional()
          .describe('Nets to route (omit to route every net on the board)'),
        passes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max autorouter passes (default 20)'),
      },
    },
    async ({ nets, passes }) => {
      const netList = nets && nets.length > 0 ? nets : undefined;

      // 1. Unroute the nets we are about to (re)route so freerouting starts fresh.
      if (netList) {
        for (const n of netList) {
          const r = ctx.doc.apply({ op: 'unroute', net: n });
          if (!r.ok) return errorResult((r as OpError).error);
        }
      } else {
        const r = ctx.doc.apply({ op: 'unroute' });
        if (!r.ok) return errorResult((r as OpError).error);
      }

      // 2. Export DSN, 3. run freerouting, 4. import SES.
      const board = ctx.doc.board;
      const dsn = exportDSN(board, netList ? { nets: netList } : {});
      let ses: string;
      try {
        ses = await ctx.route.run(dsn, passes !== undefined ? { passes } : undefined);
      } catch (err) {
        return errorResult(`autoroute failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      let tracks: ImportSESResult['tracks'];
      let vias: ImportSESResult['vias'];
      try {
        ({ tracks, vias } = importSES(ses, board));
      } catch (err) {
        return errorResult(`autoroute failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 5. Apply the routed geometry.
      const applyRes = ctx.doc.apply({ op: 'addTracks', tracks, vias });
      if (!applyRes.ok) return errorResult((applyRes as OpError).error);

      const routedCount = netList
        ? netList.length
        : ctx.doc.board.nets.filter((n) => n.pins.length >= 2).length;
      const remaining = isFullyRouted(ctx.doc.board);
      const remainingStr =
        remaining.length === 0
          ? 'All nets fully routed.'
          : `Unrouted remaining: ${remaining
              .map((u) => `${u.net} (${u.unconnected})`)
              .join(', ')}`;
      return textResult(
        `Routed ${routedCount} net(s): ${tracks.length} tracks, ${vias.length} vias added. ${remainingStr}`,
      );
    },
  );

  server.registerTool(
    'export_fab',
    {
      description:
        'Export the fabrication fileset for JLCPCB: gerbers.zip (Gerber X2 + Excellon drills), bom.csv, cpl.csv, plus a bonus board.render.svg reference image. Runs DRC first and refuses to export (isError) if it finds unwaived violations -- pass waiveDrc:true to export anyway. Defaults outDir to "<directory of the current board file>/fab".',
      inputSchema: {
        outDir: z
          .string()
          .optional()
          .describe('Output directory, absolute or relative to the project directory. Defaults to "<board file dir>/fab"'),
        waiveDrc: z
          .boolean()
          .optional()
          .describe('Export even if DRC finds violations (default false -- export is refused on any violation)'),
      },
    },
    async ({ outDir, waiveDrc }) => {
      const board = ctx.doc.board;
      const filled = fillAllZones(board);
      const violations = runDRC(filled);
      if (violations.length > 0 && !waiveDrc) {
        return errorResult(
          `${formatDrcReport(violations)}\n\nExport refused; fix the violation(s) above or pass waiveDrc:true to export anyway.`,
        );
      }

      const targetDir = resolveFabOutDir(ctx, outDir);
      let result: { gerberZip: string; bomCsv: string; cplCsv: string };
      try {
        result = await exportFab(board, targetDir);
      } catch (err) {
        return errorResult(`export_fab failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const lines = [
        `Exported fab outputs to ${targetDir}:`,
        `  ${result.gerberZip}`,
        `  ${result.bomCsv}`,
        `  ${result.cplCsv}`,
      ];
      if (violations.length > 0) {
        lines.push('', `Waived ${violations.length} DRC violation(s):`, formatDrcReport(violations));
      }
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'screenshot',
    {
      description:
        'Render the current board to a PNG image so you can see it. Unrouted airwires (ratsnest) and DRC violation markers are shown by default -- pass showRatsnest:false / showDrc:false to hide them. Filter to specific layers, zoom to a region, or highlight one net.',
      inputSchema: {
        layers: z.array(layerIdSchema).optional().describe('Layers to render (omit for all layers)'),
        region: regionSchema.optional().describe('Zoom to this mm bounding box (omit for the whole board)'),
        highlightNet: z.string().optional().describe('Net name to highlight in cyan'),
        widthPx: z.number().int().positive().optional().describe('Image width in px (default 1200, capped at 2400)'),
        showRatsnest: z.boolean().optional().describe('Overlay unrouted airwires (default true)'),
        showDrc: z.boolean().optional().describe('Overlay DRC violation markers (default true)'),
      },
    },
    ({ layers, region, highlightNet, widthPx, showRatsnest, showDrc }): CallToolResult => {
      const board = ctx.doc.board;
      const png = renderPNG(board, { layers, region, highlightNet, widthPx, showRatsnest, showDrc });
      const { width, height } = pngDimensions(png);

      const drcCount = showDrc === false ? 0 : runDRC(board).length;
      const ratCount = showRatsnest === false ? 0 : ratsnest(board).length;
      const layerStr = layers && layers.length > 0 ? layers.join(',') : 'all layers';
      const summary = `${width}x${height}px, layers: ${layerStr}, ${drcCount} DRC marker(s), ${ratCount} ratline(s)`;

      return {
        content: [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: summary },
        ],
      };
    },
  );

  return server;
}
