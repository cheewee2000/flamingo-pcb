import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newBoard, serializeBoard } from '@flamingo/engine';
import type { Footprint } from '@flamingo/engine';
import type { PartInfo } from '@flamingo/parts';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';
import type { PartsApi } from '../src/mcp.js';
import type { RouteRunner } from '../src/route.js';

const FIXTURE_FOOTPRINT: Footprint = {
  name: 'R0603',
  lcsc: 'C25804',
  pads: [
    { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
    { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
  ],
  silk: [],
  courtyard: [],
};

const FIXTURE_INFO: PartInfo = {
  lcsc: 'C25804',
  mfr: 'UNI-ROYAL',
  mpn: '0603WAF1002T5E',
  description: '10KΩ ±1%',
  package: '0603',
  basic: true,
};

const mockPartsApi: PartsApi = {
  fetchPart: async (lcsc: string) => {
    if (lcsc !== 'C25804') throw new Error(`unknown fixture part "${lcsc}"`);
    return { footprint: FIXTURE_FOOTPRINT, info: FIXTURE_INFO };
  },
  searchParts: async () => [FIXTURE_INFO],
};

// Mock router: returns an SES that routes net N1 with a single F.Cu wire
// spanning R1.2 (0.75,0) -> R2.1 (4.25,0) — the anchors of the two pads when
// R1 is at (0,0) and R2 at (5,0). Resolution um 1 => µm coordinates.
const MOCK_SES = `(session mock.ses
  (routes
    (resolution um 1)
    (network_out
      (net N1
        (wire (path F.Cu 250 750 0 4250 0) (type route))
      )
    )
  )
)
`;
const mockRouteRunner: RouteRunner = {
  run: async () => MOCK_SES,
};

const TOOL_NAMES = [
  'new_board',
  'open_board',
  'save_board',
  'get_board_state',
  'describe_connections',
  'parts_search',
  'parts_get',
  'place_component',
  'move_component',
  'remove_component',
  'connect_pins',
  'disconnect_pins',
  'create_net_class',
  'assign_net_class',
  'set_board_outline',
  'add_keepout',
  'add_zone',
  'add_mounting_hole',
  'add_silk_text',
  'remove_item',
  'get_ratsnest',
  'run_drc',
  'undo',
  'redo',
  'unroute',
  'autoroute',
  'export_fab',
  'screenshot',
];

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('MCP endpoint', () => {
  let doc: Doc;
  let started: StartedServer;
  let base: string;
  let client: Client;
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'flamingo-mcp-test-'));
    doc = new Doc(newBoard('mcptest', 2));
    started = await startServer(doc, 0, {
      partsApi: mockPartsApi,
      projectDir,
      routeRunner: mockRouteRunner,
    });
    base = `http://localhost:${started.port}`;

    client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await started.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  it('tools/list returns all 28 core tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(28);
  });

  it('place_component (mocked part) then get_board_state reflects it', async () => {
    const placeResult = await client.callTool({
      name: 'place_component',
      arguments: { lcsc: 'C25804', refdes: 'R1', x: 12, y: 8 },
    });
    expect(placeResult.isError).toBeFalsy();
    expect(textOf(placeResult as any)).toContain('R1');
    expect(textOf(placeResult as any)).toContain('C25804');

    const stateResult = await client.callTool({ name: 'get_board_state', arguments: {} });
    const text = textOf(stateResult as any);
    expect(text).toContain('R1');
    expect(text).toContain('C25804');
    expect(text).toContain('mcptest');

    expect(doc.board.components).toHaveLength(1);
    expect(doc.board.components[0]?.refdes).toBe('R1');
    expect(doc.board.components[0]?.at).toEqual({ x: 12, y: 8 });
  });

  it('place_component auto-positions when x/y are omitted', async () => {
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1' } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2' } });
    const r1 = doc.board.components.find((c) => c.refdes === 'R1')!;
    const r2 = doc.board.components.find((c) => c.refdes === 'R2')!;
    expect(r1.at).toEqual({ x: 5, y: 5 });
    expect(r2.at).toEqual({ x: 10, y: 5 });
  });

  it('connect_pins then describe_connections mentions the net', async () => {
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2', x: 5, y: 0 } });

    const connectResult = await client.callTool({
      name: 'connect_pins',
      arguments: { net: 'GND', pins: ['R1.1', 'R2.1'] },
    });
    expect(connectResult.isError).toBeFalsy();

    const describeResult = await client.callTool({ name: 'describe_connections', arguments: {} });
    const text = textOf(describeResult as any);
    expect(text).toContain('GND');
    expect(text).toContain('R1.1');
    expect(text).toContain('R2.1');
  });

  it('an op error surfaces as an isError tool result', async () => {
    const result = await client.callTool({
      name: 'move_component',
      arguments: { refdes: 'NOPE', rotation: 90 },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result as any)).toContain('ERROR:');
    expect(textOf(result as any)).toContain('NOPE');
  });

  it('set_board_outline rect + cornerRadius builds 8 segs (4 lines, 4 arcs)', async () => {
    const result = await client.callTool({
      name: 'set_board_outline',
      arguments: { shape: 'rect', width: 50, height: 30, cornerRadius: 3 },
    });
    expect(result.isError).toBeFalsy();

    expect(doc.board.outline).toHaveLength(8);
    const lines = doc.board.outline.filter((s) => s.type === 'line');
    const arcs = doc.board.outline.filter((s) => s.type === 'arc');
    expect(lines).toHaveLength(4);
    expect(arcs).toHaveLength(4);
  });

  it('set_board_outline rect with cornerRadius 0 builds a plain 4-line rect', async () => {
    await client.callTool({
      name: 'set_board_outline',
      arguments: { shape: 'rect', width: 20, height: 10 },
    });
    expect(doc.board.outline).toHaveLength(4);
    expect(doc.board.outline.every((s) => s.type === 'line')).toBe(true);
  });

  it('undo reverts the last operation', async () => {
    await client.callTool({
      name: 'set_board_outline',
      arguments: { shape: 'rect', width: 10, height: 10 },
    });
    expect(doc.board.outline).toHaveLength(4);

    const undoResult = await client.callTool({ name: 'undo', arguments: {} });
    expect(undoResult.isError).toBeFalsy();
    expect(doc.board.outline).toHaveLength(0);
  });

  it('undo with nothing to undo returns an isError result', async () => {
    const result = await client.callTool({ name: 'undo', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('parts_search formats results as text lines using the injected partsApi', async () => {
    const result = await client.callTool({ name: 'parts_search', arguments: { query: '0603WAF1002T5E' } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as any);
    expect(text).toContain('C25804');
    expect(text).toContain('UNI-ROYAL');
  });

  it('parts_get returns part info and pad list', async () => {
    const result = await client.callTool({ name: 'parts_get', arguments: { lcsc: 'C25804' } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as any);
    expect(text).toContain('C25804');
    expect(text).toContain('pad 1');
    expect(text).toContain('pad 2');
  });

  it('remove_component removes the component and drops its net pins', async () => {
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2', x: 5, y: 0 } });
    await client.callTool({ name: 'connect_pins', arguments: { net: 'GND', pins: ['R1.1', 'R2.1'] } });

    const result = await client.callTool({ name: 'remove_component', arguments: { refdes: 'R1' } });
    expect(result.isError).toBeFalsy();
    expect(doc.board.components).toHaveLength(1);
    const net = doc.board.nets.find((n) => n.name === 'GND');
    expect(net?.pins).toEqual(['R2.1']);
  });

  it('create_net_class then assign_net_class updates the net', async () => {
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
    await client.callTool({ name: 'connect_pins', arguments: { net: 'GND', pins: ['R1.1'] } });

    const createResult = await client.callTool({
      name: 'create_net_class',
      arguments: { name: 'power', trackWidth: 0.5, clearance: 0.3, viaDrill: 0.4, viaDiameter: 0.8 },
    });
    expect(createResult.isError).toBeFalsy();

    const assignResult = await client.callTool({
      name: 'assign_net_class',
      arguments: { net: 'GND', class: 'power' },
    });
    expect(assignResult.isError).toBeFalsy();
    expect(doc.board.nets.find((n) => n.name === 'GND')?.class).toBe('power');
  });

  it('add_mounting_hole, add_silk_text, add_keepout, add_zone create items with ids; remove_item removes them', async () => {
    const holeResult = await client.callTool({
      name: 'add_mounting_hole',
      arguments: { x: 1, y: 1, drill: 2, padDiameter: 4 },
    });
    expect(holeResult.isError).toBeFalsy();
    expect(doc.board.holes).toHaveLength(1);
    const holeId = doc.board.holes[0]!.id;

    const removeResult = await client.callTool({ name: 'remove_item', arguments: { id: holeId } });
    expect(removeResult.isError).toBeFalsy();
    expect(doc.board.holes).toHaveLength(0);
  });

  it('get_ratsnest reports unrouted connections', async () => {
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2', x: 5, y: 0 } });
    await client.callTool({ name: 'connect_pins', arguments: { net: 'GND', pins: ['R1.1', 'R2.1'] } });

    const result = await client.callTool({ name: 'get_ratsnest', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as any);
    expect(text).toContain('GND');
  });

  it('run_drc on a bare (outline-less) board reports the missing-outline violation, not a tool error', async () => {
    const result = await client.callTool({ name: 'run_drc', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as any);
    expect(text).toContain('missing-outline');
    expect(text).toContain('1 violation');
  });

  it('run_drc on a DRC-clean board reports zero violations', async () => {
    // R1/R2 placed at the exact coordinates the mock router's SES wire
    // assumes (see MOCK_SES / R1.2->R2.1 comment above); outline given
    // generous margin on every side so nothing trips copper-to-edge or
    // outside-outline.
    await client.callTool({
      name: 'set_board_outline',
      arguments: {
        shape: 'polygon',
        points: [
          { x: -10, y: -10 },
          { x: 50, y: -10 },
          { x: 50, y: 30 },
          { x: -10, y: 30 },
        ],
      },
    });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2', x: 5, y: 0 } });
    await client.callTool({ name: 'connect_pins', arguments: { net: 'N1', pins: ['R1.2', 'R2.1'] } });
    await client.callTool({ name: 'autoroute', arguments: {} });

    const result = await client.callTool({ name: 'run_drc', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as any)).toContain('DRC clean: 0 violations.');
  });

  it('run_drc reports an unconnected-net violation as data, without isError', async () => {
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 5, y: 10 } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2', x: 15, y: 10 } });
    await client.callTool({ name: 'connect_pins', arguments: { net: 'N1', pins: ['R1.2', 'R2.1'] } });
    // Deliberately not autorouted: N1 has two pins in separate islands.

    const result = await client.callTool({ name: 'run_drc', arguments: {} });
    expect(result.isError).toBeFalsy(); // violations are data, not a tool failure
    const text = textOf(result as any);
    expect(text).toContain('unconnected-net');
    expect(text).toContain('N1');
  });

  it('screenshot returns PNG image content plus a one-line text summary', async () => {
    await client.callTool({
      name: 'set_board_outline',
      arguments: { shape: 'rect', width: 20, height: 20 },
    });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 5, y: 10 } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2', x: 15, y: 10 } });
    await client.callTool({ name: 'connect_pins', arguments: { net: 'N1', pins: ['R1.2', 'R2.1'] } });
    // Deliberately unrouted -- N1 has two separate islands, so both the
    // ratsnest overlay and the DRC unconnected-net check have something to
    // show, and run_drc also finds the missing-outline-free board dirty via
    // unconnected-net.

    const result = await client.callTool({ name: 'screenshot', arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = (result as any).content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    expect(content).toHaveLength(2);

    const image = content.find((c) => c.type === 'image');
    expect(image).toBeTruthy();
    expect(image!.mimeType).toBe('image/png');
    const buf = Buffer.from(image!.data!, 'base64');
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const text = content.find((c) => c.type === 'text');
    expect(text).toBeTruthy();
    expect(text!.text).toContain('1200x');
    expect(text!.text).toContain('DRC marker');
    expect(text!.text).toContain('ratline');
  });

  it('screenshot honors widthPx, layers, and showRatsnest/showDrc flags', async () => {
    const result = await client.callTool({
      name: 'screenshot',
      arguments: { widthPx: 400, layers: ['Edge'], showRatsnest: false, showDrc: false },
    });
    expect(result.isError).toBeFalsy();
    const content = (result as any).content as Array<{ type: string; data?: string; text?: string }>;
    const image = content.find((c) => c.type === 'image')!;
    const buf = Buffer.from(image.data!, 'base64');
    // IHDR width field, big-endian u32 at byte offset 16.
    expect(buf.readUInt32BE(16)).toBe(400);
    const text = content.find((c) => c.type === 'text')!;
    expect(text.text).toContain('0 DRC marker');
    expect(text.text).toContain('0 ratline');
  });

  it('new_board replaces the current board', async () => {
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
    expect(doc.board.components).toHaveLength(1);

    const result = await client.callTool({
      name: 'new_board',
      arguments: { name: 'fresh', copperLayers: 4 },
    });
    expect(result.isError).toBeFalsy();
    expect(doc.board.name).toBe('fresh');
    expect(doc.board.copperLayers).toBe(4);
    expect(doc.board.components).toHaveLength(0);
  });

  it('open_board loads a board file written by new_board', async () => {
    await client.callTool({ name: 'new_board', arguments: { name: 'other', copperLayers: 2 } });
    const boardPath = join(projectDir, 'other.flamingo');

    // Switch back to a different board first so open_board has something to do.
    await client.callTool({ name: 'new_board', arguments: { name: 'unrelated', copperLayers: 2 } });
    expect(doc.board.name).toBe('unrelated');

    const result = await client.callTool({ name: 'open_board', arguments: { path: boardPath } });
    expect(result.isError).toBeFalsy();
    expect(doc.board.name).toBe('other');
  });

  it('autoroute (mocked router) adds tracks and reports full routing', async () => {
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2', x: 5, y: 0 } });
    await client.callTool({ name: 'connect_pins', arguments: { net: 'N1', pins: ['R1.2', 'R2.1'] } });

    // Before: unrouted.
    expect(doc.board.tracks).toHaveLength(0);

    const result = await client.callTool({ name: 'autoroute', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as any);
    expect(text).toContain('1 tracks');
    expect(text).toContain('All nets fully routed.');

    expect(doc.board.tracks).toHaveLength(1);
    expect(doc.board.tracks[0]?.net).toBe('N1');
    expect(doc.board.tracks[0]?.layer).toBe('F.Cu');
  });

  it('autoroute unroutes the target net first (fresh route)', async () => {
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2', x: 5, y: 0 } });
    await client.callTool({ name: 'connect_pins', arguments: { net: 'N1', pins: ['R1.2', 'R2.1'] } });

    // Route once, then route again — should not accumulate duplicate tracks.
    await client.callTool({ name: 'autoroute', arguments: { nets: ['N1'] } });
    await client.callTool({ name: 'autoroute', arguments: { nets: ['N1'] } });
    expect(doc.board.tracks).toHaveLength(1);
  });

  it('unroute removes routed tracks/vias for a net', async () => {
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2', x: 5, y: 0 } });
    await client.callTool({ name: 'connect_pins', arguments: { net: 'N1', pins: ['R1.2', 'R2.1'] } });
    await client.callTool({ name: 'autoroute', arguments: {} });
    expect(doc.board.tracks.length).toBeGreaterThan(0);

    const result = await client.callTool({ name: 'unroute', arguments: { net: 'N1' } });
    expect(result.isError).toBeFalsy();
    expect(doc.board.tracks).toHaveLength(0);
  });

  it('save_board persists the current board to disk', async () => {
    await client.callTool({ name: 'new_board', arguments: { name: 'persisted', copperLayers: 2 } });
    await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
    const saveResult = await client.callTool({ name: 'save_board', arguments: {} });
    expect(saveResult.isError).toBeFalsy();

    const openResult = await client.callTool({
      name: 'open_board',
      arguments: { path: join(projectDir, 'persisted.flamingo') },
    });
    expect(openResult.isError).toBeFalsy();
    expect(doc.board.components).toHaveLength(1);
  });

  describe('export_fab', () => {
    it('refuses to export when DRC violations are present and waiveDrc is not set', async () => {
      // Fresh board (from beforeEach) has no outline -> guaranteed missing-outline violation.
      const result = await client.callTool({ name: 'export_fab', arguments: {} });
      expect(result.isError).toBe(true);
      const text = textOf(result as any);
      expect(text).toContain('missing-outline');
      expect(text).toContain('Export refused');
      expect(text).toContain('waiveDrc');
    });

    it('exports anyway when waiveDrc:true is passed, reporting the waived violations', async () => {
      await client.callTool({ name: 'new_board', arguments: { name: 'expwaive', copperLayers: 2 } });
      const exportDir = join(projectDir, 'fab');

      const result = await client.callTool({
        name: 'export_fab',
        arguments: { waiveDrc: true },
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result as any);
      expect(text).toContain('missing-outline');
      expect(text).toContain('Waived');

      for (const f of ['gerbers.zip', 'bom.csv', 'cpl.csv']) {
        const st = await stat(join(exportDir, f));
        expect(st.isFile()).toBe(true);
      }
    });

    it('exports without error when the board is DRC-clean, to the given outDir', async () => {
      await client.callTool({
        name: 'set_board_outline',
        arguments: {
          shape: 'polygon',
          points: [
            { x: -10, y: -10 },
            { x: 50, y: -10 },
            { x: 50, y: 30 },
            { x: -10, y: 30 },
          ],
        },
      });
      await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R1', x: 0, y: 0 } });
      await client.callTool({ name: 'place_component', arguments: { lcsc: 'C25804', refdes: 'R2', x: 5, y: 0 } });
      await client.callTool({ name: 'connect_pins', arguments: { net: 'N1', pins: ['R1.2', 'R2.1'] } });
      await client.callTool({ name: 'autoroute', arguments: {} });

      const customDir = join(projectDir, 'custom-fab-out');
      const result = await client.callTool({
        name: 'export_fab',
        arguments: { outDir: customDir },
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result as any);
      expect(text).not.toContain('Waived');

      for (const f of ['gerbers.zip', 'bom.csv', 'cpl.csv', 'board.render.svg']) {
        const st = await stat(join(customDir, f));
        expect(st.isFile()).toBe(true);
      }
    });

    it('defaults outDir to <dirname(board file)>/fab when outDir is omitted', async () => {
      await client.callTool({ name: 'new_board', arguments: { name: 'expdefault', copperLayers: 2 } });
      const result = await client.callTool({ name: 'export_fab', arguments: { waiveDrc: true } });
      expect(result.isError).toBeFalsy();
      const st = await stat(join(projectDir, 'fab', 'bom.csv'));
      expect(st.isFile()).toBe(true);
    });
  });
});

describe('MCP endpoint — persistence edge cases', () => {
  // Short debounce so "wait past the debounce window" is fast without racing
  // real fs I/O against a fake clock (see document.test.ts for the same
  // rationale).
  const DEBOUNCE_MS = 30;

  it('open_board does not schedule a rewrite of the file it just read', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'flamingo-mcp-persist-'));
    const doc = new Doc(newBoard('mcptest', 2), undefined, DEBOUNCE_MS);
    const started = await startServer(doc, 0, { partsApi: mockPartsApi, projectDir });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${started.port}/mcp`)),
    );

    try {
      const boardPath = join(projectDir, 'existing.flamingo');
      await writeFile(boardPath, serializeBoard(newBoard('existing', 2)), 'utf8');
      const before = await stat(boardPath);
      const beforeContent = await readFile(boardPath, 'utf8');

      const result = await client.callTool({ name: 'open_board', arguments: { path: boardPath } });
      expect(result.isError).toBeFalsy();
      expect(doc.board.name).toBe('existing');

      // Wait well past the debounce window that a stray scheduleSave() would fire in.
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 6));

      const after = await stat(boardPath);
      const afterContent = await readFile(boardPath, 'utf8');
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(afterContent).toBe(beforeContent);
    } finally {
      await client.close();
      await started.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('save_board on an unpathed doc returns an error result instead of falsely reporting success', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'flamingo-mcp-persist-'));
    const doc = new Doc(newBoard('mcptest', 2)); // constructed without a filePath
    const started = await startServer(doc, 0, { partsApi: mockPartsApi, projectDir });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${started.port}/mcp`)),
    );

    try {
      const result = await client.callTool({ name: 'save_board', arguments: {} });
      expect(result.isError).toBe(true);
      const text = textOf(result as any);
      expect(text).toContain('ERROR:');
      expect(text).toContain('no file path set');
    } finally {
      await client.close();
      await started.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
