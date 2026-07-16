# Flamingo — prompt-first PCB CAD (design spec)

Date: 2026-07-16
Status: approved by CW

## What it is

A custom electronics CAD program purpose-built to be driven by Claude Code.
The user prompts the electronics ("make an ESP32 breakout with USB-C power");
Claude picks LCSC parts, places them, defines connectivity, autoroutes, and
exports fab files. There is **no schematic view** — everything happens in a
live PCB view in the browser, where the user can also manually move parts,
draw the board outline, keepouts, zones, and mounting holes.

Final output: `gerbers.zip` + `bom.csv` + `cpl.csv` ready to upload to
JLCPCB (PCB fab + SMT assembly), using **only LCSC parts**.

## Decisions made

| Decision | Choice |
|---|---|
| Engine | Custom TypeScript engine; proven external pieces only where foolish not to (Freerouting for autoroute) |
| App form | Local web app: Node server + browser UI; server owns the document |
| Manual editing scope | Placement + shapes by mouse (move/rotate/flip parts, outline, keepouts, zones, holes, silk, delete/rip-up tracks). Routing is autorouter + prompt-driven. No interactive push-and-shove. |
| Autorouter | Freerouting (headless JAR, Specctra DSN/SES round-trip). Requires a Java runtime (brew install). |
| Stack | TypeScript everywhere. npm workspaces monorepo, Vite UI, Vitest tests. |
| Layers | 2, 4, or 6 copper layers; through-hole vias only (JLCPCB standard service) |
| Parts | LCSC only. Footprints fetched from the EasyEDA component API and parsed directly into our model (no KiCad in the loop). |

## Architecture

npm-workspaces monorepo, packages communicating through typed interfaces:

```
packages/
  engine/   pure library: data model, geometry, netlist/ratsnest, DRC, ops
  parts/    LCSC search + EasyEDA footprint fetch/parse/cache
  fab/      Gerber X2 + Excellon writers, BOM/CPL writers, DSN export / SES import
  server/   Node: document host, op log + undo/redo, HTTP + WebSocket, MCP endpoint
  ui/       browser PCB view (Canvas 2D), mouse tools
```

**Single source of truth:** the server holds one live board document. Every
mutation — from the browser UI or from Claude via MCP — is a named,
validated **operation** applied server-side, appended to an undo/redo log,
and broadcast to all clients over WebSocket. The user watches Claude work in
real time; Claude sees manual edits instantly.

**Persistence:** `<project>/board.flamingo` — pretty-printed JSON, git-friendly.
Parts cache in `~/.flamingo/parts/<LCSC>.json`.

**MCP transport:** the server exposes MCP over streamable HTTP at
`http://localhost:4242/mcp`. The repo ships a `.mcp.json` so any Claude Code
session in a project folder can drive Flamingo. Claude can start the server
itself (`flamingo serve <project-dir>`, background).

## Data model (engine)

Units: **mm**, y-up internally (converted at UI and gerber boundaries as
needed). Angles in degrees CCW.

- `Board`: name, stackup (2/4/6 copper layers), outline (polylines with arc
  segments), keepouts (shape + layer set + what's kept out: copper/via/all),
  mounting holes, components, nets, net classes, tracks, vias, zones,
  silkscreen items, design-rule set id.
- `Component`: refdes, LCSC id, footprint (embedded), x/y/rotation/side,
  fields (value, description, mfr, package, JLCPCB basic/extended flag).
- `Footprint`: pads (rect/oval/circle/polygon; SMD or through-hole with
  drill), silk graphics, courtyard, origin = EasyEDA footprint origin
  (matches JLCPCB pick-and-place conventions).
- `Net`: name, class, member pins (`REFDES.PADNUMBER`). Net classes carry
  track width, clearance, via drill/diameter.
- `Track`: layer, width, net, segment (line or arc). `Via`: through-hole,
  net, drill, diameter.
- `Zone`: copper pour polygon, layer, net, clearance, thermal-relief
  settings; filled lazily (fill geometry computed by engine).
- Layers: `F.Cu, In1.Cu…In4.Cu, B.Cu, F/B.Silk, F/B.Mask, F/B.Paste, Edge`.

**Connectivity without a schematic:** the netlist is built by Claude from the
prompt via `connect` ops. Verification surfaces: ratsnest overlay (unrouted
connections as straight lines), click-to-highlight net, and a
`describe_connections` MCP tool that reads the netlist back in plain English.

## LCSC parts pipeline

- `parts_search(query, filters)` → LCSC catalog search; results flag JLCPCB
  **Basic vs Extended** so Claude prefers no-setup-fee parts, plus stock,
  price, package.
- `parts_get(lcsc_id)` → fetch `easyeda.com/api/products/{id}/components`,
  parse the EasyEDA footprint format (10 mil units → mm): pads, drills,
  silk, courtyard. Cache forever; re-fetch on demand.
- Every placed component embeds its parsed footprint in the board file, so
  a project is self-contained and reproducible offline.

## MCP tool surface (Claude's hands and eyes)

- **parts:** `parts_search`, `parts_get`, `place_component`,
  `move_component`, `remove_component`
- **connect:** `connect_pins` / `disconnect`, `create_net_class`,
  `assign_net_class`, `describe_connections`
- **draw:** `set_board_outline`, `add_keepout`, `add_zone`,
  `add_mounting_hole`, `add_silk_text`
- **route:** `autoroute` (all or listed nets), `unroute` (net or all),
  `add_track` / `add_via` (for surgical fixes)
- **inspect:** `get_board_state` (structured summary), `get_ratsnest`,
  `run_drc`, `screenshot` (server renders PNG of current view or a region —
  Claude looks at the board it's making)
- **project/export:** `new_board`, `open_board`, `save_board`, `undo`,
  `export_fab` (gerbers.zip + bom.csv + cpl.csv; refuses on DRC errors
  unless `waive: true`)

## Routing

Engine exports Specctra DSN (outline, keepouts as keepout regions, pads,
nets, net-class rules, layer count); server runs
`java -jar freerouting.jar -de board.dsn -do board.ses` headless with a
timeout; SES importer maps resulting wires/vias back to tracks. Per-net-class
width/clearance carried into DSN rules. Rip-up = delete tracks of a net and
re-run for that net.

## DRC

Built-in rule sets encoded from JLCPCB's published capabilities per layer
count (min trace width/spacing, min drill, via annulus, hole-to-hole,
copper-to-edge, silk-over-pad, mask sliver). Checks: clearance between
different nets (track/pad/via/zone), track width minimums, drill limits,
outline clearance, keepout violations, courtyard overlap, unconnected
ratsnest, silk over exposed copper. Violations render as UI markers and as a
structured MCP report.

## Fab export (JLCPCB)

- Gerber X2, one file per layer with JLCPCB-conventional names + Excellon
  drill (PTH + NPTH), zipped.
- `bom.csv`: Comment, Designator, Footprint, LCSC Part # (JLCPCB BOM format).
- `cpl.csv`: Designator, Mid X, Mid Y, Layer, Rotation (JLCPCB CPL format).
  Rotations follow EasyEDA/JLCPCB conventions (same ecosystem, so no KiCad
  rotation-fixup table needed; verify against a known part in testing).

## UI

Canvas-2D renderer (retained scene, dirty redraw — plenty for hobby-scale
boards): copper layers in standard colors with visibility toggles, pads,
tracks, vias, zones, ratsnest, outline, silk, DRC markers, top/bottom flip,
grid + snap, pan/zoom. Mouse tools: select/move (drag), rotate (R), flip
side (F), draw outline, draw keepout, draw zone, add mounting hole, add silk
text, delete track segment / rip up net, measure. Status bar: cursor mm,
grid, layer. Keyboard-first where sensible; no schematic view.

## Error handling

- Ops validated server-side (schema + semantics: unique refdes, net exists,
  layer valid for stackup); invalid ops rejected with a reason Claude can act on.
- EasyEDA/LCSC fetch failures: retry with backoff, then clear error; cache
  hits never require network.
- Freerouting: missing Java detected with install instructions; router
  timeout kills the process and reports partially-routed state honestly.
- Export refuses on DRC errors unless explicitly waived; always reports
  what was waived.

## Testing

- Engine/DRC/geometry: Vitest unit tests.
- EasyEDA parser: golden JSON fixtures for a representative part set (0402
  passive, SOT-23, QFN, TQFP, USB-C, ESP32 module) → expected footprints.
- Gerber/Excellon: parse output with an independent gerber parser
  (tracespace) and image-diff renders against goldens.
- DSN/SES: round-trip tests with fixture boards.
- End-to-end reference board (ESP32 breakout): script drives the real MCP
  tools → place → connect → route → DRC clean → export; gerbers validated.

## Build phases

1. **See and arrange:** engine model + ops, server + WebSocket, UI viewer +
   placement/outline/keepout tools, LCSC parts pipeline, core MCP tools.
2. **Route:** netlist/ratsnest, DSN export, Freerouting integration, SES
   import, rip-up, track/via surgical ops.
3. **Fab:** DRC rule sets + checks, gerber/Excellon/BOM/CPL writers,
   `export_fab`, validation against JLCPCB.
4. **Polish:** copper zones/pours, `screenshot` tool, net classes UI, silk
   editing, undo/redo UI, measure tool.

Each phase ends usable. Not in scope (ever, unless asked): schematic
editing, interactive push-and-shove routing, blind/buried vias, non-LCSC
libraries, 3D view.
