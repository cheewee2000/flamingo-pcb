# Flamingo — notes for Claude Code

Flamingo is prompt-first PCB CAD you drive over MCP. This file is for a future
Claude Code session working **in** this repo or **using** Flamingo to design a
board. See `README.md` for the human-facing overview and
`docs/superpowers/specs/2026-07-16-flamingo-design.md` for the full design spec.

## Running the server

```bash
npm install && npm run build
node packages/server/dist/cli.js serve board.flamingo   # prints "Flamingo v0.1.0 serving …"
```

- Serves the live UI at `http://localhost:4242`, streams board changes over
  `/ws`, and exposes the MCP endpoint at `/mcp`.
- `.mcp.json` (repo root) wires the `flamingo` MCP server to `/mcp` — its **37
  tools are available only while the server is running**. Start the server
  first, then use the tools.
- Port override: `FLAMINGO_PORT`. Autoroute timeout override:
  `FLAMINGO_ROUTE_TIMEOUT_MS` (default 300000).
- **Desktop app tabs:** the Mac app opens each board in its own native tab,
  each with its own server + MCP endpoint (ports scanned up from 4242, kept
  stable per project across relaunches). On open it writes the board's MCP URL
  into the project folder's `.mcp.json`, so a Claude Code session started in
  that folder connects to that board automatically — separate sessions can
  drive separate boards concurrently.

## Design workflow (tool names)

`prompt → parts → place → connect → route → drc → export`

1. **Choose parts.** `parts_search` then `parts_get`. Always `parts_get` before
   wiring a part — it lists the real pad numbers you'll reference.
   `datasheet_get` downloads the part's datasheet PDF (global cache
   `~/.flamingo/datasheets/`, plus a copy into the board's `datasheets/` dir) —
   read it before stating any specs.
2. **Lay out.** `new_board` (2/4/6 layers) → `set_board_outline` (rect with
   `cornerRadius`, polygon, or raw path) → `place_component` / `move_component`.
3. **Connect.** `connect_pins` (net + `REFDES.PAD` refs) builds nets.
   `create_net_class` + `assign_net_class` set track width / clearance / via
   sizes per net.
4. **Board features.** `add_zone` (copper pour), `add_mounting_hole`,
   `add_silk_text`, `add_keepout`. `remove_item` by id.
5. **Route.** `autoroute` (Freerouting; `passes`, optional `nets`). `unroute` /
   `get_ratsnest` to iterate.
6. **Check.** `run_drc` returns violations as data (never a tool error).
7. **Export.** `export_fab` writes `gerbers.zip` + `bom.csv` + `cpl.csv`
   (+ `board.render.svg`) for JLCPCB.

`screenshot` renders a PNG whenever you want to see the board. `get_board_state`
/ `describe_connections` give text summaries. `undo` / `redo` walk the op log.

## Panels (several boards fabricated as one piece)

A **panel** is a `.flamboyance` file next to the boards that places copies
("instances") of one or more board files on one fabrication panel. See "Panels
and order cost" in `README.md` for every tool and the matching `flamingo panel`
CLI commands. It is served in one of two ways:

- `flamingo serve combo.flamboyance`: like a board file, on its own. The panel
  view is at `http://localhost:4242`, and `/mcp` has the 24 panel tools and
  **no board tools**. The file is created if it is missing.
- `flamingo serve board.flamingo --panel combo.flamboyance`: the board's server
  with the panel added. All 61 tools at one `/mcp`; the panel view is at
  `/panel`. Use this when one session designs boards and panelizes them.

Two servers on one machine need two ports (`FLAMINGO_PORT`); `.mcp.json` points
at 4242.

`boards + quantities → quote_order → panel_apply_scenario → panel_check → export_panel_fab`

1. `panel_new`, then `panel_add_board` per board with `needed` (assembled
   boards that must be delivered).
2. `quote_order` ranks the ways to order them and itemizes every fee.
   `panel_apply_scenario id=...` loads a scenario's panel. Or build the panel
   by hand: `panel_add_instance`, then `panel_arrange`.
3. `panel_check` returns findings as data. Errors gate `export_panel_fab`
   (`waive: true` overrides).
4. `panel_screenshot` to look at it; `export_panel_fab` to write the fileset.
5. `panel_cost_curve` for the cost at each quantity. Every `needed` a board
   has been set to joins the curve; the points live in the panel file under
   `curve` (a cache, dropped when a board, setting or fee changes) so a
   quantity priced once is free to come back to. The panel view charts it
   only for a panel of one design, and only when asked (a button).

Conventions:

- **Instance ids** are `<board key><n>`: `S1`, `M3`. Merged BOM/CPL designators
  are `<instance>_<refdes>`: `S1_U2`. Positions are the bottom-left corner of
  the instance's bounding box, mm, y-up; rotations are degrees CCW, any angle
  (`panel_arrange` turns boards in steps of `settings.rotationStep`, 90 by default).
- **Every amount marked `~` is an estimate.** Say so when you quote it. Fees
  and limits live in `packages/panel/config/*.json` with a source URL and a
  `verified` flag each; bare-board prices are always estimates.
- **Never call JLCPCB's quote or order endpoints**, and never place an order.
  The cost model works from the local fee table plus JLCPCB's parts library
  (prices, attrition, Standard-only: the lookup the stock check makes).
- A panel refers to boards by path + content hash. After editing a board that
  is on a panel, `panel_check` reports it stale until `panel_refresh_boards`.
- Panel support is opt-in in `startServer({ panel: true })`; the CLI turns it
  on. `panelOnly: true` is the server of a panel file.
- The panel server polls its boards' file times, so a board saved by another
  server shows up as stale within about two seconds.

## Conventions

- **Units & axes:** millimetres, **y-up**. Rotations are degrees CCW.
- **Pin refs:** `REFDES.PAD`, e.g. `U1.14`, `R1.1`. Pad numbers are strings and
  come straight from the LCSC footprint (they can be names like `A6`, `B4A9`,
  not just `1..N`).
- **Net classes:** every net belongs to a class (default `default`:
  0.25mm track, 0.2mm clearance, 0.3/0.6mm via). Assign power/signal classes to
  override. Clearance for a pad/track pair is `max(rule floor, either net's
  class clearance)`.
- **DRC ruleset** is chosen by layer count (`jlcpcb-2l/4l/6l`, in
  `packages/engine/src/drc/rules.ts`); the 2-layer copper-clearance floor is
  0.127mm.
- **Component `value` is the bare value only** (`4.7k`, `100nF`, `SGM3732`) —
  it becomes the BOM Comment, and JLCPCB flags one LCSC part appearing under
  different Comments. Per-instance context ("I2C pull-up on SDA", "warm
  channel") goes in `role`, which never reaches the BOM. Enforced by the
  `bom-comment-conflict` DRC check.

## Stock check (part of DRC)

- `run_drc` and `export_fab` check **live JLCPCB assembly stock** (jlcpcb.com
  parts library — the stock that matters for JLC assembly; not LCSC retail and
  not the stale EasyEDA `stock` field) for every placed part with an LCSC id.
- `stock-out` (stock < quantity the board needs) is a **gating violation** —
  export refuses just like a geometry violation; `waiveDrc: true` waives it.
- `stock-low` (< 100 boards buildable) and `stock-unknown` (part not in the
  JLC library, or lookup failed) are **non-gating advisories** — printed in
  the report, never blocking, so network failures can't brick an export.
- Lookups are cached in memory for 10 min; `FLAMINGO_STOCK_CHECK=off`
  disables the check entirely.

## DRC, zones, and export (important)

- **DRC gates export.** `export_fab` fills all copper zones (`fillAllZones`) and
  runs the full ruleset on that *filled* board; it refuses to write files on any
  violation. Pass `waiveDrc: true` to override (waived violations are reported).
- **`run_drc` also checks the filled board.** Zones are filled on a working
  copy first (the live doc's stored zones and the undo log are untouched), so
  its report matches the export gate exactly -- no zone-outline noise. The
  browser overlay may still show stale markers if the UI last ran DRC before a
  fill; trust the tool report.

## parts_search caveat

Search is **keyword/relevance-ranked, not parametric.** An exact or near-exact
MPN (`0603WAF1002T5E`) or a specific LCSC id works far better than a parametric
query like `"10k 0603"`. Prefer known-good LCSC ids when you have them, and
always confirm stock + pads with `parts_get` before placing.

## Freerouting requirements

`autoroute` needs a **Java runtime** on `PATH`/`JAVA_HOME` (`brew install
openjdk` on macOS). `freerouting.jar` is auto-downloaded to
`~/.flamingo/freerouting.jar` on first use. Routing a real board can take a
minute or more — be patient and don't assume a hang.

## Caches

- Part footprints/info: `~/.flamingo/parts/` (EasyEDA API responses).
- `freerouting.jar`: `~/.flamingo/freerouting.jar`.

## Build & test

```bash
npm run build   # tsc per package + vite build for the ui
npm test        # vitest run across all packages
npx tsx packages/server/scripts/e2e-esp32.ts   # real end-to-end pipeline check
npx tsx packages/server/scripts/e2e-panel.ts   # panel pipeline: two boards, 1 + 5, quote, export
npx tsx packages/server/scripts/verify-panel-ui.ts   # panel view in headless Chromium
```

The E2E script drives only the public MCP tools against a real server with live
parts and real Freerouting, then validates the exported Gerbers with tracespace
and checks the BOM/CPL — it must exit 0.
