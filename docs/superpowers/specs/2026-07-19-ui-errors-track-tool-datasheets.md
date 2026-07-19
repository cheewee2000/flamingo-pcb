# Spec: op-error surfacing, interactive track tool, datasheet management

Date: 2026-07-19. Three independent features closing workflow seams found in
the v0.1.0 survey. Sections 1–2 live in `packages/ui`; section 3 in
`packages/server` (+ small `packages/parts` touches).

---

## 1. UI op-error surfacing (toasts)

**Problem.** `ws.ts` already parses `{type:'opResult', result:{ok, error?}}`
and exposes an optional `onOpResult` handler, but `main.ts` never wires it —
a rejected edit silently does nothing in the browser.

**Design.**

- New `packages/ui/src/toast.ts`: `showToast(message: string, kind: 'error' | 'info')`.
  Fixed-position stack (bottom-center of the viewport), newest on top, max ~4
  visible, auto-dismiss after 6s (errors) / 3s (info), click to dismiss.
  Pure DOM (no framework), styles in `style.css` following existing class
  naming. Reusable by later features.
- `main.ts` wires `onOpResult`: on `ok === false`, `showToast(error, 'error')`.
  No toast on success (would be noise — the board visibly updates).
- Verify in `packages/server/src/http.ts` whether `opResult` goes only to the
  originating socket (expected) or is broadcast; if broadcast, scope it to the
  sender so client A doesn't see client B's rejections.
- Stretch (only if trivial): route failed `/api/*` fetches in `panels.ts`
  through the same toast instead of any existing `alert()`/silent paths.

**Out of scope:** success toasts, toast queue persistence, server-side changes
beyond the opResult scoping check.

**Test:** unit-test toast create/dismiss DOM behavior if the package has DOM
tests; otherwise a manual check is acceptable — but the `onOpResult` wiring
must be exercised by sending a deliberately invalid op in an integration test
if one exists for ws round-trips.

---

## 2. Interactive track drawing tool

**Problem.** The UI can rip up and autoroute but cannot draw a trace. The
"autorouter did 95%, fix three traces by hand" case requires typing
coordinates into the MCP `add_track` tool.

**Design.** New `packages/ui/src/tools/track.ts` implementing the `Tool`
contract (`tools/tool.ts`), registered in `main.ts` + toolbar. Follows the
conventions of `via.ts` (net inference via `hitTest`, class-derived sizes,
closure-state, overlay preview).

- **id** `'track'`, **label** `'Track'`, **shortcut** `'T'` (verify no
  collision in `TOOL_SHORTCUTS`), cursor `crosshair`.
- **Active layer:** new `toolOptions.trackLayer: LayerId` (default `'F.Cu'`).
  Options-row dropdown listing the board's copper layers (same pattern as the
  zone tool's `zoneLayer`). While routing, key **`l`** (or the dropdown)
  switches the active copper layer **and inserts a via** at the last placed
  vertex (via drill/diameter from the net's class — same rule as `via.ts`).
- **Start:** first click must land on copper (pad/track/via) — its net (from
  `hitTest`) becomes the route's net. Clicking bare board does nothing except
  a hint label ("start on a pad or track"). No fallback-net dropdown: a track
  with no net is never what you want.
- **Vertices:** each subsequent click appends a vertex at the snapped point.
  Heading snaps to 45° increments by default; **Shift** = free angle. (Grid
  snap/Ctrl-bypass already arrive via `PointerEvt.world`.)
- **Finish:**
  - Click on copper belonging to the **same net** → append that point and
    auto-commit (the common pad-to-pad case).
  - **Enter** or double-click → commit as drawn.
  - **Escape** or tool switch (`onDeactivate`) → discard.
- **Commit** as a single atomic `{op:'addTracks', tracks, vias}` — one undo
  step for the whole route including layer-change vias. Track `width` from
  the net's class `trackWidth`; each segment carries the layer it was drawn
  on.
- **Overlay:** committed-so-far polyline at true width (screen-scaled, min
  1px), live segment from last vertex to cursor, via markers at layer
  switches, `drawOverlayLabel` showing `net · width · layer`.
- **Explicitly not included:** push-and-shove, live DRC while drawing (post-
  hoc `run_drc`/export gate covers it), arc segments, dragging existing
  tracks. Document this in the file header.

**Test:** engine already covers `addTracks`; add a UI test only if the
package has a harness for tools — otherwise verify by hand in the browser
(start on a pad, draw across a layer change, confirm one undo removes all).

---

## 3. Datasheet management (`datasheet_get` MCP tool)

**Problem.** Real projects accumulate dozens of hand-downloaded PDFs
(`boards/eink-cell/datasheets/` has 37). `PartInfo.datasheet` already exists
(`easyeda-parse.ts:401` — the EasyEDA `link` field) but nothing fetches it.

**Design.** New MCP tool `datasheet_get` in `packages/server/src/mcp.ts`,
fetch/resolve logic in `packages/parts` (new `datasheet.ts`) so it's testable
without a server.

- **Input:** `{ lcsc: string, refresh?: boolean }`.
- **Resolution:** get `PartInfo` via the existing cached fetch. Take
  `info.datasheet`:
  - If missing → structured failure: "no datasheet URL for this part".
  - HTTP GET (follow redirects, ~30s timeout, real browser UA — LCSC blocks
    default fetch UAs sometimes).
  - If the response is a PDF (content-type or `%PDF` magic) → done.
  - If HTML (EasyEDA's `link` is usually an LCSC **product page**, not the
    PDF): scan the HTML for the first
    `https?://(datasheet|wmsc)\.lcsc\.com/[^"' ]+\.pdf` (case-insensitive;
    also accept `atta.szlcsc.com`), fetch that. If no match → structured
    failure that includes the product-page URL so the human can grab it.
  - Validate `%PDF` magic before writing; never save an HTML error page.
- **Storage:**
  - Always: global cache `~/.flamingo/datasheets/<LCSC>.pdf` (same dir
    convention as `~/.flamingo/parts/`). `refresh: true` bypasses it.
  - When the served board has a file path: also copy to
    `<board dir>/datasheets/<MPN>-<LCSC>.pdf` (MPN sanitized to
    `[A-Za-z0-9._-]`, collapse runs). Skip copy if the file already exists.
- **Output (structured text like the other tools):** absolute project path
  (or cache path), file size, MPN, source URL, and whether it came from
  cache. Failures are reported as tool results, not thrown errors (same
  policy as `run_drc`).
- **`parts_get`:** verify its output includes the datasheet URL; if not, add
  one line.
- **README:** add the tool to the MCP tools list (count goes 33 → 34).

**Test (vitest, `packages/parts`):** URL-extraction from a saved sample of an
LCSC product page (fixture HTML, no network); `%PDF` magic validation
(rejects HTML posing as PDF); filename sanitization. Network fetch itself is
mocked — the E2E script is not extended.

---

## Build/verify for all three

`npm run build` + `npm test` must pass. UI features get a live browser check
against a real served board; `datasheet_get` gets one real invocation against
a known LCSC part (e.g. one already used on eink-cell) before calling it done.
