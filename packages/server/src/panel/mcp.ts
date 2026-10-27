/**
 * Panel MCP tools. Registered on the same McpServer as the board tools (see
 * mcp.ts), following the same patterns: zod input schemas with a description
 * on every field, text results, `isError` only for real failures. Check
 * findings and quotes are data, not errors.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PanelOp, PanelOpError, PanelOpResult, Rotation, SettingsPatch } from '@flamingo/panel';
import { OBJECTIVES } from '@flamingo/panel';
import {
  ESTIMATE_LEGEND,
  fmt,
  formatArrange,
  formatIssues,
  formatPanelQuote,
  formatQuote,
  formatView,
} from './format.js';
import type { PanelSession } from './session.js';

function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function error(e: string): CallToolResult {
  return { content: [{ type: 'text', text: `ERROR: ${e}` }], isError: true };
}

function applied(r: PanelOpResult | PanelOpError, onOk: (r: PanelOpResult) => string): CallToolResult {
  return r.ok ? text(onOk(r)) : error(r.error);
}

const rotationSchema = z.number().finite();

export const PANEL_TOOL_NAMES = [
  'panel_new',
  'panel_open',
  'panel_save',
  'panel_get_state',
  'panel_add_board',
  'panel_remove_board',
  'panel_refresh_boards',
  'panel_set_quantity',
  'panel_add_instance',
  'panel_remove_instance',
  'panel_move_instance',
  'panel_rotate_instance',
  'panel_set_populate',
  'panel_pin',
  'panel_set_settings',
  'panel_arrange',
  'panel_check',
  'panel_screenshot',
  'panel_undo',
  'panel_redo',
  'quote_order',
  'panel_cost_curve',
  'panel_apply_scenario',
  'export_panel_fab',
] as const;

export function registerPanelTools(server: McpServer, session: PanelSession): void {
  server.registerTool(
    'panel_new',
    {
      description:
        'Create a new, empty panel (a .flamboyance file next to the boards), replacing whatever panel is loaded. A panel holds copies ("instances") of one or more board files for fabrication and assembly as one piece. The board currently open in the editor is not affected.',
      inputSchema: {
        name: z.string().describe('Panel name; also the file name'),
        path: z
          .string()
          .optional()
          .describe('File to create, absolute or relative to the project directory. Defaults to "<name>.flamboyance" in the project directory'),
      },
    },
    async ({ name, path }) => {
      const r = await session.create(name, path);
      return r.ok ? text(`Created panel "${name}" — saved to ${r.filePath}`) : error(r.error);
    },
  );

  server.registerTool(
    'panel_open',
    {
      description: 'Open a panel file, replacing whatever panel is loaded.',
      inputSchema: {
        path: z.string().describe('Path to a .flamboyance file, absolute or relative to the project directory'),
      },
    },
    async ({ path }) => {
      const r = await session.open(path);
      if (!r.ok) return error(r.error);
      return text(`Opened ${r.filePath}\n${formatView(await session.view())}`);
    },
  );

  server.registerTool(
    'panel_save',
    { description: 'Save the current panel to disk immediately.', inputSchema: {} },
    async () => {
      const r = await session.save();
      return r.ok ? text(`Saved ${r.filePath}`) : error(r.error);
    },
  );

  server.registerTool(
    'panel_get_state',
    {
      description:
        'Summary of the current panel: size, settings, boards with their quantities, every instance with position, rotation, populated/bare, pinned and blocked edges, plus check and cost totals.',
      inputSchema: {},
    },
    async () => text(formatView(await session.view())),
  );

  server.registerTool(
    'panel_add_board',
    {
      description:
        'Add a board file to the panel as a source. The panel stores its path and a content hash, not a copy, so later edits to the board mark the panel stale. Adds no instance yet: use panel_add_instance, or set quantities and let quote_order / panel_apply_scenario decide.',
      inputSchema: {
        path: z.string().describe('Path to a .flamingo board file, absolute or relative to the project directory'),
        key: z
          .string()
          .optional()
          .describe('Short label for this board, e.g. "S" or "M": 1-4 characters, uppercase letter first. Instances are named S1, S2, ... and merged refdes S1_U2. Defaults to the first letter of the board name'),
        needed: z.number().int().min(0).optional().describe('Assembled boards of this design you must end up with (default 1)'),
      },
    },
    async ({ path, key, needed }) => {
      const r = await session.addBoard(path, { key, needed });
      if (!r.ok) return error(r.error);
      return text(`Added board ${r.key} = "${r.name}" (${fmt(r.width)} x ${fmt(r.height)} mm, ${r.layers}-layer)`);
    },
  );

  server.registerTool(
    'panel_remove_board',
    {
      description: 'Remove a board from the panel, together with all of its instances.',
      inputSchema: { board: z.string().describe('Board key, e.g. "S"') },
    },
    ({ board }) => applied(session.apply({ op: 'removeSource', key: board }), () => `Removed board ${board} and its instances`),
  );

  server.registerTool(
    'panel_refresh_boards',
    {
      description:
        'Accept the source boards as they are on disk now: records their current content hash, which clears the "stale" warning. The panel always fabricates the boards as they are on disk; refreshing only acknowledges that you have seen the change.',
      inputSchema: {
        boards: z.array(z.string()).optional().describe('Board keys to refresh (omit for all)'),
      },
    },
    async ({ boards }) => {
      const r = await session.refreshSources(boards);
      if (!r.ok) return error(r.error);
      return text(r.refreshed.length === 0 ? 'Nothing to refresh: no board changed.' : `Refreshed ${r.refreshed.join(', ')}`);
    },
  );

  server.registerTool(
    'panel_set_quantity',
    {
      description: 'Set how many boards of a design are needed.',
      inputSchema: {
        board: z.string().describe('Board key, e.g. "S"'),
        needed: z.number().int().min(0).describe('Assembled boards you must end up with'),
      },
    },
    ({ board, needed }) =>
      applied(session.apply({ op: 'setQuantity', key: board, needed }), (r) => {
        const s = r.panel.sources.find((x) => x.key === board)!;
        return `${board}: need ${s.needed}`;
      }),
  );

  server.registerTool(
    'panel_add_instance',
    {
      description:
        'Put one more copy of a board on the panel. Without a position it lands at the origin unpinned: run panel_arrange afterwards. With a position it is placed there.',
      inputSchema: {
        board: z.string().describe('Board key, e.g. "S"'),
        x: z.number().optional().describe('X of the bottom-left corner of the instance bounding box, panel mm'),
        y: z.number().optional().describe('Y of the bottom-left corner of the instance bounding box, panel mm (y-up)'),
        rotation: rotationSchema.optional().describe('Rotation in degrees CCW, any angle (default 0)'),
        populate: z.boolean().optional().describe('true = assemble it, false = ship it bare (default true)'),
        pinned: z.boolean().optional().describe('Pin it so arrange leaves it alone (default: true when a position is given)'),
      },
    },
    ({ board, x, y, rotation, populate, pinned }) => {
      const positioned = x !== undefined || y !== undefined;
      const op: PanelOp = {
        op: 'addInstance',
        source: board,
        ...(positioned ? { at: { x: x ?? 0, y: y ?? 0 } } : {}),
        ...(rotation !== undefined ? { rotation: rotation as Rotation } : {}),
        ...(populate !== undefined ? { populate } : {}),
        pinned: pinned ?? positioned,
      };
      return applied(session.apply(op), (r) => {
        const inst = r.panel.instances.find((i) => i.id === r.created[0])!;
        return `Added ${inst.id} at (${fmt(inst.at.x)}, ${fmt(inst.at.y)}) rot ${inst.rotation}, ${inst.populate ? 'populated' : 'bare'}${inst.pinned ? ', pinned' : ''}`;
      });
    },
  );

  server.registerTool(
    'panel_remove_instance',
    {
      description: 'Remove one instance from the panel.',
      inputSchema: { id: z.string().describe('Instance id, e.g. "M3"') },
    },
    ({ id }) => applied(session.apply({ op: 'removeInstance', id }), () => `Removed ${id}`),
  );

  server.registerTool(
    'panel_move_instance',
    {
      description:
        'Move an instance. Moving pins it, so a later panel_arrange works around it; pass pin:false to leave it free.',
      inputSchema: {
        id: z.string().describe('Instance id, e.g. "M3"'),
        x: z.number().describe('X of the bottom-left corner of the instance bounding box, panel mm'),
        y: z.number().describe('Y of the bottom-left corner of the instance bounding box, panel mm (y-up)'),
        pin: z.boolean().optional().describe('Pin the instance where it lands (default true)'),
      },
    },
    ({ id, x, y, pin }) =>
      applied(session.apply({ op: 'moveInstance', id, at: { x, y }, pin: pin ?? true }), (r) => {
        const inst = r.panel.instances.find((i) => i.id === id)!;
        return `Moved ${id} to (${fmt(x)}, ${fmt(y)})${inst.pinned ? ', pinned' : ''}`;
      }),
  );

  server.registerTool(
    'panel_rotate_instance',
    {
      description:
        'Rotate an instance about the centre of its bounding box, by any angle. Give either an absolute rotation or an amount to turn by (default: 90 CCW).',
      inputSchema: {
        id: z.string().describe('Instance id, e.g. "M3"'),
        rotation: rotationSchema.optional().describe('Absolute rotation in degrees CCW, any angle'),
        by: z.number().finite().optional().describe('Degrees to turn by, CCW positive, any angle (default 90)'),
      },
    },
    async ({ id, rotation, by }) =>
      applied(await session.rotateInstance(id, { rotation: rotation as Rotation | undefined, by }), (r) => {
        const inst = r.panel.instances.find((i) => i.id === id)!;
        return `Rotated ${id} to ${inst.rotation}, now at (${fmt(inst.at.x)}, ${fmt(inst.at.y)})`;
      }),
  );

  server.registerTool(
    'panel_set_populate',
    {
      description:
        'Choose whether an instance is assembled. A bare instance is fabricated like the others, but every part on it is do-not-place: it is left out of the BOM and the placement list and gets no solder paste.',
      inputSchema: {
        id: z.string().describe('Instance id, e.g. "M3"'),
        populate: z.boolean().describe('true = assemble, false = ship bare'),
      },
    },
    ({ id, populate }) =>
      applied(session.apply({ op: 'setPopulate', id, populate }), () => `${id} is now ${populate ? 'populated' : 'bare'}`),
  );

  server.registerTool(
    'panel_pin',
    {
      description: 'Pin or unpin an instance. Pinned instances are never moved by panel_arrange.',
      inputSchema: {
        id: z.string().describe('Instance id, e.g. "M3"'),
        pinned: z.boolean().optional().describe('true = pin, false = unpin (default true)'),
      },
    },
    ({ id, pinned }) =>
      applied(session.apply({ op: 'setPinned', id, pinned: pinned ?? true }), () => `${id} is now ${pinned ?? true ? 'pinned' : 'unpinned'}`),
  );

  server.registerTool(
    'panel_set_settings',
    {
      description:
        'Change panel settings. Only the fields given change. copperLayers promotes the panel: boards with fewer layers are then fabricated at that count, which is how boards with different layer counts can share a panel.',
      inputSchema: {
        separation: z
          .enum(['mouse-bite', 'solid-tab', 'silk-divider', 'v-cut'])
          .optional()
          .describe('mouse-bite: routed gaps bridged by perforated tabs. solid-tab: plain tabs. silk-divider: no routing, boards drawn in silkscreen inside one rectangular outline (one design as far as JLCPCB is concerned; you cut them apart). v-cut: boards abut and JLCPCB scores a straight V-groove along every shared edge, across the whole panel, so they snap apart by hand; boards must be plain rectangles lined up in rows and columns, the panel at least 70 x 70 mm, and only Standard PCBA takes it (spacing and tabs are ignored)'),
        spacing: z.number().positive().optional().describe('Gap between boards, and between boards and rails, in mm'),
        railTop: z.number().min(0).optional().describe('Top rail width in mm (0 = none)'),
        railBottom: z.number().min(0).optional().describe('Bottom rail width in mm (0 = none)'),
        railLeft: z.number().min(0).optional().describe('Left rail width in mm (0 = none)'),
        railRight: z.number().min(0).optional().describe('Right rail width in mm (0 = none)'),
        tabWidth: z.number().positive().optional().describe('Tab width along the board edge in mm'),
        tabPitch: z.number().positive().optional().describe('Target distance between tabs along an edge in mm'),
        fiducials: z.boolean().optional().describe('Place fiducials on the rails'),
        toolingHoles: z.boolean().optional().describe('Place tooling holes on the rails'),
        copperLayers: z
          .union([z.literal('auto'), z.literal(2), z.literal(4), z.literal(6)])
          .optional()
          .describe('"auto" (all boards must agree) or the layer count to fabricate the panel at'),
        rotationStep: z
          .number()
          .optional()
          .describe('Angle step panel_arrange may turn boards by, in degrees; must divide 360. 90 (default) tries each board as it is and a quarter turn from it; 36 lets pentagons nest, 60 hexagons, 45 or 30 for a finer search. Any angle can still be set on an instance by hand'),
        name: z.string().optional().describe('Rename the panel'),
      },
    },
    (a) => {
      const rails = {
        ...(a.railTop !== undefined ? { top: a.railTop } : {}),
        ...(a.railBottom !== undefined ? { bottom: a.railBottom } : {}),
        ...(a.railLeft !== undefined ? { left: a.railLeft } : {}),
        ...(a.railRight !== undefined ? { right: a.railRight } : {}),
      };
      const tabs = {
        ...(a.tabWidth !== undefined ? { width: a.tabWidth } : {}),
        ...(a.tabPitch !== undefined ? { pitch: a.tabPitch } : {}),
      };
      const settings: SettingsPatch = {
        ...(a.separation !== undefined ? { separation: a.separation } : {}),
        ...(a.spacing !== undefined ? { spacing: a.spacing } : {}),
        ...(Object.keys(rails).length > 0 ? { rails } : {}),
        ...(Object.keys(tabs).length > 0 ? { tabs } : {}),
        ...(a.fiducials !== undefined ? { fiducials: { enabled: a.fiducials } } : {}),
        ...(a.toolingHoles !== undefined ? { toolingHoles: { enabled: a.toolingHoles } } : {}),
        ...(a.copperLayers !== undefined ? { copperLayers: a.copperLayers } : {}),
        ...(a.rotationStep !== undefined ? { rotationStep: a.rotationStep } : {}),
      };
      const ops: PanelOp[] = [];
      if (Object.keys(settings).length > 0) ops.push({ op: 'setSettings', settings });
      if (a.name !== undefined) ops.push({ op: 'setName', name: a.name });
      if (ops.length === 0) return error('no setting given');
      return applied(session.apply(ops.length === 1 ? ops[0]! : { op: 'transaction', ops }), (r) => {
        const s = r.panel.settings;
        return (
          `Settings: ${s.separation}, spacing ${fmt(s.spacing)} mm, rails top ${fmt(s.rails.top)} bottom ${fmt(s.rails.bottom)} ` +
          `left ${fmt(s.rails.left)} right ${fmt(s.rails.right)} mm, layers ${s.copperLayers}, ` +
          `fiducials ${s.fiducials.enabled ? 'on' : 'off'}, tooling holes ${s.toolingHoles.enabled ? 'on' : 'off'}`
        );
      });
    },
  );

  server.registerTool(
    'panel_arrange',
    {
      description:
        'Auto-layout: pack every unpinned instance into the smallest panel that respects spacing, blocked-edge clearances and the size limit. Rectangular boards are tried as they are and turned 90 degrees; boards that are not rectangles, or any board when rotationStep is not 90, are nested by their real outline at every multiple of the step (plus the quarter turns), so pentagons interlock. Pinned instances stay put. If the instances do not fit, the panel is left unchanged and the reason and the smallest panel that would fit are reported (as data, not as a tool error).',
      inputSchema: {
        rotate: z.boolean().optional().describe('Allow turning instances (default true)'),
        rotationStep: z
          .number()
          .optional()
          .describe('Angle step to try for this run, degrees, dividing 360 (e.g. 36 for pentagons, 60 for hexagons, 30 or 15 for a finer search); default settings.rotationStep (90)'),
      },
    },
    async ({ rotate, rotationStep }) =>
      text(formatArrange(await session.arrange({ rotate, ...(rotationStep !== undefined ? { rotationStep } : {}) }))),
  );

  server.registerTool(
    'panel_check',
    {
      description:
        'Check the panel: stale or unreadable source boards, boards with DRC violations of their own, layer-count and rules mismatches (with the option to promote), overlaps, spacing, blocked edges (a courtyard overhanging the outline, a keepout at the edge) and their clearance, instances nothing holds, fab and assembly size limits. Findings are returned as data, never as a tool error. Errors stop export_panel_fab unless waived.',
      inputSchema: {},
    },
    async () => text(formatIssues(await session.check())),
  );

  server.registerTool(
    'panel_screenshot',
    {
      description:
        'Render the panel to a PNG so you can see it, in one of two views. view "layout" (default) is the schematic the panel view edits: each board design has its own colour, the same as in the panel view, and colour means nothing else; state is drawn, not coloured: bare boards are hatched with a dashed outline, blocked edges are heavy with a comb of ticks, tabs are solid bars, instances with errors or warnings get a second outline, size limits are long-dash rectangles. view "fab" is what comes back from the fab: green laminate where material stays (boards, tabs, rails a shade lighter), white where the router cuts it away, mouse-bite and tooling holes punched through at true size, fiducials as copper dots, V-cut scores as dark lines, silk dividers as white lines; a red (error) or amber (warning) "!" badge flags issues, with the count above the panel.',
      inputSchema: {
        widthPx: z.number().int().positive().optional().describe('Image width in px (default 1200, at most 2400)'),
        view: z
          .enum(['layout', 'fab'])
          .optional()
          .describe('"layout" (default): the editable schematic, coloured by design. "fab": the fabricated panel, material, routed openings and drilled holes.'),
      },
    },
    async ({ widthPx, view: render }): Promise<CallToolResult> => {
      const png = await session.renderPng(widthPx, render);
      const view = await session.view();
      const f = view.geometry.frame;
      const errors = view.issues.filter((i) => i.severity === 'error').length;
      const warnings = view.issues.filter((i) => i.severity === 'warning').length;
      const summary = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}px, panel ${f ? `${fmt(f.width)} x ${fmt(f.height)} mm` : 'empty'}, ${view.geometry.instances.length} instance(s), ${view.geometry.tabs.length} tab(s), ${errors} error(s), ${warnings} warning(s)`;
      return {
        content: [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: summary },
        ],
      };
    },
  );

  server.registerTool(
    'panel_undo',
    { description: 'Undo the last panel-modifying operation.', inputSchema: {} },
    () => (session.undo() ? text('Undid last panel operation.') : error('Nothing to undo.')),
  );

  server.registerTool(
    'panel_redo',
    { description: 'Redo the last undone panel operation.', inputSchema: {} },
    () => (session.redo() ? text('Redid last undone panel operation.') : error('Nothing to redo.')),
  );

  server.registerTool(
    'panel_cost_curve',
    {
      description:
        'How the cost changes with quantity: for each of a set of quantities (1 to 100), the cheapest way to order that many of every design on the panel, with its total and cost per board. Shows where a few more boards come almost free (the panel has room) and where they tip into another panel or assembly setup. Every amount is an estimate from the local fee table; nothing is sent to JLCPCB.',
      inputSchema: {
        objective: z
          .enum(OBJECTIVES)
          .optional()
          .describe('What "cheapest" means at each quantity: total (default), or perBoard'),
        quantities: z
          .array(z.number().int().positive())
          .optional()
          .describe('Quantities to price (default 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100 plus every quantity the boards have been set to)'),
      },
    },
    async ({ objective, quantities }) => {
      const curve = await session.costCurve(objective ?? 'total', quantities);
      const lines = [
        `Cost by quantity (${curve.designs.join(', ')}; ~ = estimate; cheapest by ${curve.objective}):`,
        '  qty   per board      total  way',
      ];
      for (const p of curve.points) {
        lines.push(`  ${String(p.quantity).padStart(3)}  ${(p.estimate ? '~' : '') + `$${p.perBoard.toFixed(2)}`.padStart(9)}  ${`$${p.total.toFixed(2)}`.padStart(9)}  ${p.way.title}`);
      }
      for (const i of curve.impossible) lines.push(`  ${String(i.quantity).padStart(3)}  not possible: ${i.reason}`);
      const kept = curve.points.length + curve.impossible.length - curve.priced;
      lines.push(`${curve.priced} priced now${kept > 0 ? `, ${kept} from the panel file` : ''}.`);
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'quote_order',
    {
      description:
        'Compare ways to order the boards on the panel, from their needed quantities: separate orders per design, each design on its own panel, one merged mouse-bite panel (different-designs fee), one silkscreen-divided board, different panel counts, and split versus promote when layer counts differ. Returns ranked scenarios with total, cost per board, boards received per design, warnings and itemized fees. Every amount marked ~ is an ESTIMATE. Prices come from a local fee table; nothing is sent to JLCPCB and nothing is ordered. Also reports the cost of the panel exactly as it stands.',
      inputSchema: {
        objective: z
          .enum(OBJECTIVES as unknown as [string, ...string[]])
          .optional()
          .describe('Ranking: "total" (default), "per-board" (cost per board asked for and delivered), or "overage" (fewest boards beyond what was asked for)'),
        detail: z.boolean().optional().describe('Include the itemized fee lines of every scenario (default true)'),
      },
    },
    async ({ objective, detail }) => {
      const result = await session.quote((objective as 'total' | 'per-board' | 'overage' | undefined) ?? 'total');
      const view = await session.view();
      return text(
        [
          'THE PANEL AS IT STANDS',
          formatPanelQuote(view),
          '',
          'ALTERNATIVES',
          formatQuote(result, detail !== false),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'panel_apply_scenario',
    {
      description:
        'Load the panel a quote_order scenario implies onto the panel: replaces every instance and sets the separation, rails and layer count the scenario uses. One undo step. Scenarios made of single boards have no panel to load.',
      inputSchema: {
        id: z.string().describe('Scenario id from quote_order, e.g. "merged-needed-x2"'),
        objective: z.enum(OBJECTIVES as unknown as [string, ...string[]]).optional().describe('Objective the quote was ranked by (does not change the scenario)'),
      },
    },
    async ({ id, objective }) => {
      const r = await session.applyScenario(id, (objective as 'total' | 'per-board' | 'overage' | undefined) ?? 'total');
      if (!r.ok) return error(r.error);
      if (!r.loaded) return text(`Scenario "${id}" (${r.scenario.title}) orders single boards: there is no panel to load. The panel was left unchanged.`);
      return text(
        `Loaded scenario "${id}" (${r.scenario.title}): ${r.scenario.summary}. ` +
          `Panel ${fmt(r.scenario.layout!.width)} x ${fmt(r.scenario.layout!.height)} mm, ${r.scenario.layout!.instances.length} instance(s).`,
      );
    },
  );

  server.registerTool(
    'export_panel_fab',
    {
      description:
        'Export the fabrication fileset for the panel: gerbers.zip (Gerber X2 + Excellon for the whole panel, including rails, routed profile, mouse-bite and tooling holes, fiducials, and on a V-cut panel the score lines drawn edge to edge on the profile (GKO) layer with a V-CUT label beside each), bom.csv and cpl.csv merged across instances with designators prefixed per instance (S1_U2, M3_R5) and positions in panel coordinates, plus panel.render.svg (the layout view) and panel.fab.svg (the fabricated view: material, routed openings, drilled holes). Parts of bare instances are left out of BOM and CPL. Runs panel_check first and refuses (isError) on any error unless waive is true. Writes files only; nothing is uploaded or ordered.',
      inputSchema: {
        outDir: z
          .string()
          .optional()
          .describe('Output directory, absolute or relative to the project directory. Defaults to "<panel file dir>/fab/<panel name>"'),
        waive: z.boolean().optional().describe('Export even if the check finds errors (default false)'),
      },
    },
    async ({ outDir, waive }) => {
      const r = await session.exportFab({ outDir, waive });
      if (!r.ok) {
        if (r.blocking) {
          return error(`${formatIssues(r.blocking)}\n\nExport refused; fix the error(s) above or pass waive:true to export anyway.`);
        }
        return error(`export_panel_fab failed: ${r.error}`);
      }
      const lines = [
        `Exported panel fab outputs to ${r.outDir}:`,
        `  ${r.result.gerberZip} (${r.result.gerberFiles.length} files)`,
        `  ${r.result.bomCsv}`,
        `  ${r.result.cplCsv}`,
        `  ${r.result.renderSvg}`,
        `  ${r.result.fabSvg}`,
        `Placed by assembly: ${r.result.placed} component(s). Left off (bare instances): ${r.result.skipped}.`,
      ];
      for (const n of r.result.notes) lines.push(`Note: ${n}`);
      if (r.waived.length > 0) lines.push('', `Waived ${r.waived.length} error(s):`, formatIssues(r.waived));
      const warnings = r.issues.filter((i) => i.severity === 'warning');
      if (warnings.length > 0) lines.push('', 'Warnings:', ...warnings.map((w) => `  [${w.code}] ${w.message}`));
      return text(lines.join('\n'));
    },
  );
}

export { ESTIMATE_LEGEND };
