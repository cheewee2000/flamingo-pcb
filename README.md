<img width="1732" height="1235" alt="Screenshot 2026-07-19 at 10 11 36 AM" src="https://github.com/user-attachments/assets/420a00d3-6ce6-4431-87b0-71b8e9271e6e" />
<img width="1776" height="1279" alt="Screenshot 2026-07-19 at 10 11 28 AM" src="https://github.com/user-attachments/assets/cc5a99a7-e894-490a-975a-5c25e4dcca2d" />
# Flamingo

![version](https://img.shields.io/badge/version-0.1.0-ff5a8c)

**Prompt-first PCB CAD for Claude Code.** No schematic step: describe the board
in plain language and Claude Code drives a custom TypeScript engine over MCP —
picking real [LCSC](https://www.lcsc.com/) parts, placing footprints, wiring
connectivity, autorouting with [Freerouting](https://github.com/freerouting/freerouting),
running DRC, and exporting a
[JLCPCB](https://jlcpcb.com/)-ready fab package (`gerbers.zip` + `bom.csv` +
`cpl.csv`). A live browser view shows the board update as it's built.



## Features

- **Prompt-first workflow over MCP** — 34 tools cover the whole flow: parts →
  placement → nets → routing → DRC → fab export. No schematic step.
- **Real parts** — LCSC keyword search plus EasyEDA footprint fetch/parse with
  real pad numbers and geometry, cached locally under `~/.flamingo/parts/`.
- **Live browser editor** — WebSocket-synced canvas view with selection and
  drag editing, a via tool (hover copper to inherit its net), silk text/line
  editing, board search, zone & label layer toggles, copper island tints, a
  nets panel showing each net's track width, a one-click **Lock & Route**
  button, and **Run DRC** with red canvas markers.
- **3D view + STEP export** — interactive 3D board with real vendor component
  models, 3D silkscreen, and STEP export in two flavours: light courtyard
  blocks or full detail (copper, silk, drilled barrels).
- **Autorouting** — Freerouting integration with per-net routing, automatic
  thin-escape retry for fat nets that can't exit fine-pitch pads, a widen pass
  that necks down only at obstructions, and automatic GND stitching vias for
  orphaned pour islands.
- **Copper features** — zone pours with filled-copper connectivity, keepouts,
  mounting holes/slots, and per-net-class track width / clearance / via rules.
- **DRC against JLCPCB capabilities** — rulesets picked by layer count:
  clearance, track width, drill/annular/via minimums, copper-to-edge,
  keepouts, hole-to-hole, courtyard overlap, silk-over-pad, unconnected nets,
  and outline checks.
- **Live stock check in DRC** — every placed part is checked against JLCPCB's
  assembly parts library; out-of-stock parts gate export (waivable), low or
  unknown stock is reported as a non-gating advisory.
- **Board-aware silkscreen** — refdes labels are auto-placed on-board,
  pad-safe, and non-overlapping by a whole-board solver.
- **Fab-ready export** — Gerber X2 + Excellon drills, JLCPCB BOM/CPL, a
  reference render SVG, and a browser download zip shaped for direct upload
  to JLCPCB's order page.
- **Op-log editing** — every change is an operation with full undo/redo;
  boards are plain JSON files that diff cleanly in git.
- **Agent-friendly feedback** — PNG screenshots (with ratsnest and DRC
  overlays), text board summaries, and connection listings on demand.

## Quick start

```bash
npm install
npm run build

# Serve a board (creates board.flamingo if it doesn't exist):
node packages/server/dist/cli.js serve board.flamingo
#   … or, once the server package is linked, `npx flamingo serve board.flamingo`

# Open the live view:
open http://localhost:4242
```

The server accepts edits and the live WebSocket only from pages opened on
`localhost` (a guard against other sites driving your open session). To open it
from another machine by name, list that name:
`FLAMINGO_ALLOWED_HOSTS=myhost node packages/server/dist/cli.js serve board.flamingo`,
then browse to `http://myhost:4242`. Comma-separate several names.

Point Claude Code at the running server by dropping this `.mcp.json` in your
project (it's already at the repo root):

```json
{
  "mcpServers": {
    "flamingo": { "type": "http", "url": "http://localhost:4242/mcp" }
  }
}
```

Now ask Claude Code to build a board — e.g. _"make me a 2-layer ESP32-S3
breakout with USB-C power and a 3.3V LDO"_ — and watch the browser view fill in.

## Requirements

- **Node.js 22+**
- **A Java runtime** (for the Freerouting autorouter). On macOS: `brew install
  openjdk` (keg-only — either add `/opt/homebrew/opt/openjdk/bin` to `PATH` or
  set `JAVA_HOME`). `freerouting.jar` is downloaded to `~/.flamingo/` on first
  autoroute.
- **Network** on first use, to fetch part footprints from the EasyEDA/LCSC API
  (cached under `~/.flamingo/parts/` afterward).

## The workflow

```
prompt → parts → place → connect → route → drc → export
```

1. **parts** — `parts_search` (keyword) then `parts_get` (pad list) to choose
   real LCSC parts and learn their pin numbers.
2. **place** — `new_board`, `set_board_outline`, then `place_component` /
   `move_component` to lay out footprints (mm, y-up).
3. **connect** — `connect_pins` builds nets from `REFDES.PAD` pin refs;
   `create_net_class` / `assign_net_class` set track/via/clearance rules.
4. **features** — `add_zone` (copper pours), `add_mounting_hole`, `add_silk_text`,
   `add_keepout`.
5. **route** — `autoroute` runs Freerouting for bulk routing; `add_track` /
   `add_via` place surgical fixes by hand; `get_ratsnest` / `unroute` help
   iterate.
6. **drc** — `run_drc` reports violations against the JLCPCB ruleset for the
   board's layer count, and checks live JLCPCB assembly stock for every placed
   part: a part with less stock than one board needs is a gating `stock-out`
   violation; low stock (fewer than 100 boards buildable) and parts missing
   from the JLC library are non-gating advisories. Set
   `FLAMINGO_STOCK_CHECK=off` to skip the stock half (e.g. offline).
7. **export** — `export_fab` runs DRC (fills zones first, including the stock
   check) and writes the JLCPCB fileset — refusing on any violation unless
   `waiveDrc` is set.

`screenshot` renders the board to a PNG at any point so Claude can see what it's
doing.

## MCP tools

34 tools are served at `http://localhost:4242/mcp`:

| Group | Tools |
| --- | --- |
| **Board / project** | `new_board`, `open_board`, `save_board`, `get_board_state`, `describe_connections` |
| **Parts** | `parts_search`, `parts_get`, `datasheet_get` |
| **Placement** | `place_component`, `move_component`, `remove_component` |
| **Connectivity** | `connect_pins`, `disconnect_pins`, `create_net_class`, `assign_net_class` |
| **Board features** | `set_board_outline`, `add_zone`, `add_keepout`, `add_mounting_hole`, `add_silk_text`, `add_silk_line`, `remove_item` |
| **Routing / analysis** | `add_track`, `add_via`, `get_ratsnest`, `autoroute`, `unroute`, `widen_tracks`, `run_drc` |
| **History** | `undo`, `redo` |
| **Output** | `export_fab`, `export_step`, `screenshot` |

## Panels and order cost

Several boards, of the same or of different designs, can be fabricated and
assembled as one **panel**. Flamingo lays the panel out, checks it against
JLCPCB's limits, estimates what it costs against the alternatives, and exports
one fileset for the whole panel.

```bash
node packages/server/dist/cli.js serve combo.flamboyance    # prints "Flamingo v0.1.0 serving …"
```

A panel file is served the way a board file is: one file, one server, its view
at `http://localhost:4242` (`FLAMINGO_PORT` to change the port), the file
created if it is missing. The server has the 24 panel tools at `/mcp` and no
board tools; boards are edited in servers of their own, and the panel notices
when one of its boards changes on disk.

To have the board tools and the panel tools at one MCP endpoint, serve a board
and name the panel. The panel view is then at `/panel`:

```bash
node packages/server/dist/cli.js serve board.flamingo --panel combo.flamboyance
```

A panel is a `.flamboyance` file stored next to the boards. It refers to each
source board by relative path plus a content hash and never copies it, so a
board edited after it was added marks the panel **stale** until
`panel_refresh_boards` accepts the change. Every edit is an operation with
undo/redo, as for boards. The file also carries the last priced cost-by-quantity
curve (`curve`): a cache, not part of the design, so the chart is there the
moment the panel opens and a quantity you have entered before costs nothing to
go back to.

```
boards + quantities → quote_order → panel_apply_scenario → panel_check → export_panel_fab
```

### Panel MCP tools

24 tools, served at the same `/mcp` endpoint as the 37 board tools:

| Group | Tool | What it does |
| --- | --- | --- |
| **File** | `panel_new` | Create an empty panel and save it as `<name>.flamboyance`. |
| | `panel_open` | Open a panel file. |
| | `panel_save` | Save now (edits also autosave). |
| | `panel_get_state` | Text summary: size, settings, boards and quantities, every instance, check and cost totals. |
| **Boards** | `panel_add_board` | Add a board file as a source, with a short key (`S`, `M`) and its quantity. |
| | `panel_remove_board` | Remove a board and all of its instances. |
| | `panel_refresh_boards` | Accept source boards as they are on disk now; clears `stale`. |
| | `panel_set_quantity` | Set `needed`: the assembled boards you must get. |
| **Instances** | `panel_add_instance` | Put one more copy of a board on the panel. |
| | `panel_remove_instance` | Remove one instance. |
| | `panel_move_instance` | Move an instance; pins it unless `pin:false`. |
| | `panel_rotate_instance` | Rotate by any angle about the instance's centre (default: 90° steps). |
| | `panel_set_populate` | `true` = assemble; `false` = ship bare (all its parts become do-not-place). |
| | `panel_pin` | Pin or unpin. Pinned instances are never moved by arrange. |
| **Layout** | `panel_set_settings` | Separation, spacing, rails, tabs, fiducials, tooling holes, layer count (promotion). |
| | `panel_arrange` | Pack every unpinned instance into the smallest panel that fits the limits; nests non-rectangular boards at any angle step. |
| | `panel_check` | Report everything wrong with the panel, as data. |
| | `panel_screenshot` | Render the panel to a PNG. |
| **History** | `panel_undo`, `panel_redo` | Walk the panel's op log. |
| **Cost** | `quote_order` | Ranked order scenarios with itemized fees, plus the cost of the panel as it stands. |
| | `panel_cost_curve` | Total and cost per board of the cheapest way at a standard set of quantities from 1 to 100 plus every quantity the boards have been set to; the panel view charts it when the panel has one design (with several, a quantity is one number per design and the cost is a surface, which one chart cannot show). Pricing waits for a press; the points are kept in the panel file (`curve`) and reused until a board, a setting or a fee table changes. |
| | `panel_apply_scenario` | Load the panel a scenario implies onto the panel. |
| **Output** | `export_panel_fab` | Write `gerbers.zip`, merged `bom.csv` and `cpl.csv`, and `panel.render.svg`. |

Instances are named after their board: `S1`, `M1`, `M2`, ... In the merged BOM
and CPL every designator is prefixed with its instance (`S1_U2`, `M3_R5`) and
every position is in panel coordinates. Positions are the bottom-left corner of
the instance's bounding box, in mm, y-up, like everything else in Flamingo.

### Separating the boards

`panel_set_settings separation=...` picks how the boards come apart:

- **`mouse-bite`** (default): routed gaps bridged by tabs, each perforated with a
  row of 0.6 mm holes. Snap the boards out by hand. Both assembly services take
  it, and any board shape works.
- **`silk-divider`**: no routing. The boards sit inside one rectangle with
  silkscreen lines between them, which JLCPCB counts as one design. You cut
  them apart yourself.
- **`v-cut`**: the boards abut, and JLCPCB scores a straight V-groove along
  every shared edge so they snap apart cleanly. JLCPCB only scores straight
  lines that run edge to edge across the whole panel. So every board must be a
  plain rectangle (no rounded corners), boards in a row must share their top
  and bottom edges, and boards in a column their left and right edges. The panel
  must measure 70 x 70 mm to 475 x 475 mm, parallel cuts must be at least 2 mm
  apart, and only Standard PCBA takes V-cut panels. The score lines go on the
  profile (`.GKO`) layer, each labelled `V-CUT`. Run `panel_arrange` after you
  switch, so the boards close up. Flamingo never proposes V-cut in `quote_order`.
  On a panel set to V-cut, its panel scenarios keep V-cut.

### Arranging boards of any shape

`panel_arrange` packs rectangular boards as rectangles, trying each as it is
and turned a quarter turn. A board that is not a rectangle, or a panel whose
`rotationStep` setting is not 90, is nested by its real outline instead: each
board is tried at every multiple of the step (plus the quarter turns) and
dropped where its grown outline overlaps nothing, so pentagons interlock and
an L-shaped board tucks into a corner. Set the step to match the shape:
`panel_set_settings rotationStep=36` for pentagons, 60 for hexagons, 30 or 15
for a finer search (slower). Tabs follow the outline edges, so two boards whose
slanted edges face each other within the tab length are joined there, and a
nested board that would be left without tabs is dropped again where it has
them. Any instance can also be turned by hand to any angle with
`panel_rotate_instance`.

### What the check looks for

- **Source boards**: unreadable, stale, or with DRC violations of their own.
- **Stackup**: all boards on a panel must share a layer count and rules set. A
  mismatch is reported with the option to **promote** the panel
  (`panel_set_settings copperLayers=4`): boards with fewer layers are then made
  at the higher count.
- **Blocked edges**: an edge where a component courtyard overhangs the outline
  (a USB-C connector) or a keepout reaches the edge (an antenna region) carries
  no tabs and keeps extra clearance from its neighbour.
- **Placement**: overlaps, spacing, overhanging parts that would hit a
  neighbour or a rail, instances that nothing holds.
- **Size**: the fab's largest board and the assembly services' panel limits.
- **V-cut** (on a V-cut panel only): rectangular boards, cuts that run between
  boards and never through one, panel size, the spacing and count of the cuts,
  and copper too close to a cut.

Errors stop `export_panel_fab` unless `waive:true`. Limits and panel geometry
defaults live in `packages/panel/config/panel-limits.json`.

### Cost model

`quote_order` compares, from each design's `needed` quantity:

- separate orders, one per design
- each design on a panel of its own
- one merged mouse-bite panel (pays JLCPCB's different-designs fee)
- one board with the designs divided by silkscreen lines (counts as one design;
  you cut the boards apart yourself)
- different panel counts and quantity steps
- for boards with different layer counts: split into one order per layer
  count, or promote

Rank by `total` (default), `per-board` or `overage`.

Fees live in `packages/panel/config/fee-table.json`. Each value records its
source URL and whether it was verified on a JLCPCB help page. **Anything built
on an unverified value is an estimate** and is marked `~` in every report and
in the browser. Assembly fees are verified; bare-board prices are estimates,
because JLCPCB publishes them only through its quote calculator, which
Flamingo never calls. Shipping, tax and coupons are not included. Nothing is
ever sent to JLCPCB and nothing is ordered.

Parts are priced from JLCPCB's parts library, the same lookup the stock check
makes: the price tier for the quantity billed, JLCPCB's own attrition for the
part (spares added, least billed), basic or extended, and whether the part is
**Standard only**. A part only Standard PCBA places rejects Economic PCBA for
every order that carries it, with the part named, and `panel_check` lists such
parts as an info finding. A part the library does not list falls back to the
EasyEDA price and the fee table's attrition classes, as an estimate; with no
price anywhere it is listed at zero and named in the notes.

Set `FLAMINGO_PANEL_CONFIG_DIR` to use your own copies of the two config files,
and `FLAMINGO_PANEL_PRICES=off` to skip the part lookups.

### Panel CLI

Every tool has a command that works on a panel file directly, no server needed:

```bash
flamingo panel new combo.flamboyance --name combo
flamingo panel add-board combo.flamboyance esp32.flamingo --key S --needed 1
flamingo panel add-board combo.flamboyance breakout.flamingo --key M --needed 5
flamingo panel quote combo.flamboyance
flamingo panel apply-scenario combo.flamboyance merged-needed-x2
flamingo panel check combo.flamboyance        # exit status 1 on errors
flamingo panel screenshot combo.flamboyance --out combo.png
flamingo panel export combo.flamboyance --out fab/combo
```

| Command | MCP tool |
| --- | --- |
| `new <file> [--name N]` | `panel_new` |
| `show <file>` | `panel_get_state` |
| `add-board <file> <board> [--key K] [--needed N]` | `panel_add_board` |
| `remove-board <file> <key>` | `panel_remove_board` |
| `refresh <file> [key ...]` | `panel_refresh_boards` |
| `set-quantity <file> <key> --needed N` | `panel_set_quantity` |
| `add-instance <file> <key> [--x X --y Y] [--rotation R] [--bare] [--count N]` | `panel_add_instance` |
| `remove-instance <file> <id>` | `panel_remove_instance` |
| `move-instance <file> <id> --x X --y Y [--no-pin]` | `panel_move_instance` |
| `rotate-instance <file> <id> [--rotation R \| --by DEG]` | `panel_rotate_instance` |
| `set-populate <file> <id> <true\|false>` | `panel_set_populate` |
| `pin <file> <id> [--unpin]` | `panel_pin` |
| `set <file> [--separation S] [--spacing MM] [--rail-top MM] ... [--layers auto\|2\|4\|6]` | `panel_set_settings` |
| `arrange <file> [--no-rotate] [--rotation-step DEG]` | `panel_arrange` |
| `check <file>` | `panel_check` |
| `screenshot <file> [--out F] [--width PX]` | `panel_screenshot` |
| `quote <file> [--objective O] [--brief] [--json] [--offline]` | `quote_order` |
| `apply-scenario <file> <id>` | `panel_apply_scenario` |
| `export <file> [--out DIR] [--waive]` | `export_panel_fab` |

`panel_undo` and `panel_redo` have no command: the op log is kept in memory, as
it is for boards, and each command is a process of its own.

### Panel view

The page of a panel server (`/`, or `/panel` on a board server) is a
slicer-style view: the panel as the build plate, board instances as objects you
select, drag, rotate and duplicate. The sidebar is three steps: the boards you
need and how many; the ways to order them, cheapest first, the panel on the
plate among them; and what is on the plate, with its counts, **Arrange** (`A`),
cost, checks and export. It shares the panel with MCP: an edit made through
either shows up in the other at once.

A panel is started from the page: **Boards** lists the board files next to the
panel, and picking one puts it on the plate. Each design has its own colour, on
the plate and in every list. Colour means which board and nothing else; bare,
pinned, blocked and in-error are drawn with line style, hatching and labels.

## Architecture

npm workspaces monorepo — all packages are ESM, strict TypeScript, tested with
Vitest (`packages/*/test/*.test.ts`):

```
packages/
  engine/   pure library: data model, geometry, netlist/ratsnest, zone fill, DRC, ops
  parts/    LCSC search + EasyEDA footprint fetch/parse/cache
  fab/      Gerber X2 + Excellon writers, BOM/CPL writers, DSN export / SES import
  panel/    panel format + ops, constraint checks, arrange, merge to one board, cost model, scenarios
  server/   Node: document host, op-log + undo/redo, HTTP + WebSocket, MCP endpoint, CLI, autoroute runner
  ui/       browser PCB view (Canvas 2D) with mouse editing tools
```

The `server` is the hub: it owns the live `Doc` (board + undo/redo), serves the
`ui` at `/`, streams changes over `/ws`, and exposes every editing operation as
an MCP tool at `/mcp`. Claude Code and the browser both act on the same board.

## Development

```bash
npm run build   # tsc -p . in every package (+ vite build for the ui)
npm test        # vitest run in every package
```

The full prompt→fab pipeline is exercised for real (live LCSC parts, real
Freerouting) by:

```bash
npx tsx packages/server/scripts/e2e-esp32.ts
```

which builds the reference board above, asserts a DRC-clean export, and
tracespace-validates every Gerber.

## License


MIT — see [LICENSE](LICENSE).
