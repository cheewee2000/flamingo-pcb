# UI: STEP export button, 3D silk text, draggable 2D silk text

*2026-07-18 — approved by user*

Four items, all in `packages/ui` (server untouched — `GET /api/export.step` already exists).

## 1. STEP export button in the 3D view

A `STEP` button in `#viewer3d-hud` (index.html), wired like the fab-export
button (`wireExportFabControls`, panels.ts): disabled while busy, blob download
reusing the same `content-disposition` filename logic.

## 2. Progress bar

Thin CW&T-style bar in the HUD under the button. The fetch streams
`response.body` and, since content-length is known, shows real download
progress; before the first byte it animates an indeterminate sweep. Errors
inline in red, same pattern as the fab-export status.

## 3. Silk text in the 3D view

`buildSilkGroup` (viewer3d/scene.ts) only emits line/arc/circle geometry —
both `board.silk` (standalone SilkText) and footprint `SilkItem` kind `text`
are skipped. Fix: render each text string to an offscreen canvas with the same
Space Mono stack the 2D renderer uses (`CANVAS_FONT`), and place it as a
transparent textured plane on the board surface (top/bottom offset, rotation,
mirrored on the back side, silk top/bottom colors). Planes join the existing
silk group so the HUD "silk" checkbox controls them. Placement math factored
into a pure function with a vitest unit; texture creation injected so tests
need no canvas.

## 4. Draggable silk text in the 2D editor

`select.ts` hit-tests silk (`hitEditTarget` → `{kind:'silk'}`) but only
components drag. Add a silk drag branch mirroring the component one: capture
`at` on pointerdown, ghost preview in `drawOverlay`, and on drop past the
4px threshold issue one `editSilkText {at}` op (server-authoritative,
undoable). Scope: standalone `board.silk` items only — component refdes/value
labels have no position field in the data model and stay fixed.

Version → 0.7.4.
