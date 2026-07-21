# Routing progress bar — design

**Date:** 2026-07-21
**Scope:** UI-only. A determinate progress bar in the Lock & Route panel that
fills as the autorouter connects nets.

## Problem

The autoroute pipeline already broadcasts live progress over the `/ws` channel
(`RouteStatus` in `packages/server/src/autoroute.ts`), and the UI already
consumes it — but only as button-label text ("Routing… retry · pass 3 · 12
unrouted"). There is no visual sense of how far along a route is. Add a
progress bar.

## What already exists (no changes here)

- `RouteStatus` (broadcast one `running` per Freerouting progress event, then a
  single terminal `done`/`failed`): `{ state, stage?, pass?, unrouted?, score?,
  message? }`. `stage` is `'route'` (initial full-width pass) or `'retry'`
  (escape-width re-route of still-split nets).
- Pipeline order for one Lock & Route: `Starting…` (running, no `unrouted`) →
  Freerouting `route` passes (each a running event with `pass`/`unrouted`) →
  optional `retry` passes → widen/stitch tail (no further running events) →
  terminal `done` or `failed`.
- UI plumbing: `ws.ts` receives `routeStatus` messages → `main.ts` parks it in
  the store (`routeStatus`) → `panels.ts` `onStateChange` calls
  `routeStatusHandler(state.routeStatus)` when it changes. The Lock & Route
  button label is driven from that handler (`liveLabel`), and `doRoute()` POSTs
  `/api/route` and owns the numeric summary + reset in its `finally`.
- The status container is `#route-status` (`.route-status`), rendered below the
  `#route-btn`. `idle()` clears it; `setResult()` renders the ok/err summary.

## The bar

**Determinate fill by nets remaining.** No backend or WS-protocol change.

### Fill math (client-side, in `panels.ts`)

Track a per-route `baseline: number | null`.

- **Reset `baseline = null`** when a new route starts: at the top of `doRoute()`,
  and whenever a `Starting…` running status (state `running`, `unrouted`
  undefined) is seen — so a second route never inherits the first's baseline,
  regardless of who started it (button or MCP `autoroute` tool).
- On each `running` status with a defined `unrouted`:
  - If `baseline === null` or `unrouted > baseline`, set `baseline = unrouted`
    (baseline is the **max unrouted ever seen** this route — the bar can never
    overflow even if a later pass reports more unrouted nets).
  - `fraction = baseline > 0 ? (baseline − unrouted) / baseline : 0`, clamped to
    `[0, 1]`.
- **Before the first `unrouted` arrives** (`Starting…`): `fraction = 0`, bar in
  a subtle pulse/indeterminate-looking state so it doesn't read as stalled.
- **Retry stage:** `unrouted` reports only the still-split nets (a small number),
  so `fraction` naturally reads near-complete. This is honest — most nets are
  already routed. No special-casing.
- **Widen/stitch tail** (running stops arriving but no terminal yet): **hold the
  bar at its last fill.** Nothing to do — no event means no update.
- **Terminal `done`:** snap fill to 100%, recolor to the success signal. The bar
  is then removed when the panel returns to idle (existing `idle()` / doRoute
  `finally` path shows the numeric summary via `setResult`).
- **Terminal `failed`:** freeze fill at its last value, recolor the bar to the
  error signal alongside the error text.

### Rendering

- A thin bar element lives **inside `#route-status`, above** the existing
  live-text line. The text line (`pass N · M unrouted`) stays.
- Structure: a track `<div>` containing a fill `<div>` whose `width` (or
  `transform: scaleX`) is set from `fraction`.
- The button keeps its current behavior (disabled + `liveLabel` text while
  running). The bar augments, it doesn't replace, the button label.
- On idle, the bar is torn down with the rest of `#route-status`
  (`status.replaceChildren()` in `idle()` already clears it).

### Styling (`style.css`)

- Reuse existing CSS custom properties: track on `--rule` / `--paper-2`, fill on
  `--ink`. While routing the fill uses `--signal-orange` (matches `.route-busy`);
  at 100% `done` it uses `--signal-green` (matches `.route-result.ok`); on
  `failed` the error color (matches `.route-result.err`).
- The fill width transitions smoothly (`transition: width var(--dur) var(--ease)`)
  so incremental pass updates animate rather than jump.
- The "before first pass" pulse is a CSS animation on the bar (e.g. opacity
  pulse) that is removed once a real `fraction` is applied.

## Files touched

- `packages/ui/src/panels.ts` — bar element construction + fill math in the
  route-status handling (`routeStatusHandler`, `doRoute`, `idle`, and the
  shared render helper around lines 1327–1420). Add a `baseline` local scoped to
  `wireRouteControls`.
- `packages/ui/src/style.css` — bar track/fill styles and the pulse animation,
  next to the existing `.route-*` rules.

Explicitly **not** touched: `route.ts`, `autoroute.ts`, `ws.ts`, `main.ts`,
`state.ts`, the WS message protocol.

## Testing

- Manual: run `node packages/server/dist/cli.js serve <board>.flamingo`, open
  the UI, click Lock & Route on a board with several unrouted nets, watch the
  bar fill as passes report and drop to a near-full jump on retry, hold through
  the widen/stitch tail, then snap to green at 100%.
- Regression: existing route-status text and button behavior unchanged; a route
  started via the MCP `autoroute` tool (not the button) also drives the bar,
  since the handler is fed from the broadcast store.
- If a unit-testable pure helper falls out of the fill math (e.g. a
  `routeFraction(baseline, unrouted)` function), add a small vitest for the
  clamp / baseline-raise / divide-by-zero cases.

## Non-goals

- No time-based or pass-based percentage (routing is nonlinear; passes is a max,
  not a target).
- No indeterminate sweep for the tail (user chose determinate fill; the tail
  simply holds).
- No backend progress granularity beyond what Freerouting already emits.
