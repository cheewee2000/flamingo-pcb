# Flamingo

Prompt-first PCB CAD. A custom TypeScript engine drives a live, browser-based
PCB view — no schematic step. Claude Code picks LCSC parts, places them,
wires connectivity, autoroutes, and exports fab files (`gerbers.zip` +
`bom.csv` + `cpl.csv`) ready for JLCPCB.

See `docs/superpowers/specs/2026-07-16-flamingo-design.md` for the full design
spec and `docs/superpowers/plans/2026-07-16-flamingo.md` for the task plan.

## Requirements

- Node.js 22+
- Java runtime (for Freerouting, used by the autorouter — added in a later task)

## Structure

npm workspaces monorepo:

```
packages/
  engine/   pure library: data model, geometry, netlist/ratsnest, DRC, ops
  parts/    LCSC search + EasyEDA footprint fetch/parse/cache
  fab/      Gerber X2 + Excellon writers, BOM/CPL writers, DSN export / SES import
  server/   Node: document host, op log + undo/redo, HTTP + WebSocket, MCP endpoint
  ui/       browser PCB view (Canvas 2D), mouse tools (added in a later task)
```

All packages are ESM (`"type": "module"`), written in strict TypeScript, and
tested with Vitest (`packages/*/test/*.test.ts`).

## Development

```bash
npm install
npm run build   # tsc -p . in every package
npm test        # vitest run in every package
npm run serve   # run the built server: node packages/server/dist/index.js
```
