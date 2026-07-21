# Routing Progress Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a determinate progress bar to the Lock & Route panel that fills as the autorouter connects nets.

**Architecture:** UI-only. The autoroute pipeline already broadcasts `RouteStatus` progress over `/ws`, and `panels.ts` already consumes it to drive the button label. We extract the fill math into a pure, unit-tested helper module, then render a bar in the existing `#route-status` container driven by the same broadcast — so both the Lock & Route button and a route started by the MCP `autoroute` tool animate it.

**Tech Stack:** TypeScript, plain DOM (no framework), Vite, Vitest (node environment — no jsdom), CSS custom properties.

## Global Constraints

- Units/axes and engine concerns are irrelevant here (pure UI).
- UI test suite runs in the **node** environment — no DOM available in tests. Only pure logic is unit-tested; DOM wiring is verified by build + manual check.
- No changes to `route.ts`, `autoroute.ts`, `ws.ts`, `main.ts`, `state.ts`, or the WS message protocol.
- Reuse existing CSS custom properties: `--paper-2`, `--rule`, `--signal-orange`, `--signal-green`, `--signal-red`, `--ink-soft`, `--dur`, `--ease`.
- Baseline for the bar = **max `unrouted` count ever seen this route** (captured from the first Freerouting pass event, raised if a later event reports more). This is the approved approach — it measures progress across the nets Freerouting is actively working through.

## File Structure

- `packages/ui/src/route-progress.ts` (new) — two pure functions: `nextBaseline` and `routeFraction`. No DOM. The single source of truth for the fill math.
- `packages/ui/test/route-progress.test.ts` (new) — vitest for the two helpers.
- `packages/ui/src/panels.ts` (modify) — inside `wireRouteControls` (~lines 1327–1433): add closure state (`baseline`, `bar`, `lastFraction`), a `showBar` renderer, wire it into `routeStatusHandler`, `doRoute`, and `idle`; make `setResult` preserve the bar.
- `packages/ui/src/style.css` (modify) — bar track/fill styles and the pulse keyframe, next to the existing `.route-*` rules (after ~line 1120).

---

### Task 1: Pure fill-math helper

**Files:**
- Create: `packages/ui/src/route-progress.ts`
- Test: `packages/ui/test/route-progress.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `nextBaseline(prev: number | null, unrouted: number | undefined): number | null`
  - `routeFraction(baseline: number | null, unrouted: number | undefined): number`

- [ ] **Step 1: Write the failing test**

Create `packages/ui/test/route-progress.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextBaseline, routeFraction } from '../src/route-progress.js';

describe('nextBaseline', () => {
  it('captures the first unrouted count', () => {
    expect(nextBaseline(null, 25)).toBe(25);
  });
  it('holds when a later count is lower', () => {
    expect(nextBaseline(25, 12)).toBe(25);
  });
  it('raises to a higher later count so the bar never overflows', () => {
    expect(nextBaseline(12, 25)).toBe(25);
  });
  it('holds across events with no unrouted number', () => {
    expect(nextBaseline(25, undefined)).toBe(25);
  });
  it('stays null before any count is seen', () => {
    expect(nextBaseline(null, undefined)).toBeNull();
  });
});

describe('routeFraction', () => {
  it('is 0 before a baseline exists', () => {
    expect(routeFraction(null, 5)).toBe(0);
  });
  it('is 0 at the start (nothing routed yet)', () => {
    expect(routeFraction(25, 25)).toBe(0);
  });
  it('is 1 when fully routed', () => {
    expect(routeFraction(25, 0)).toBe(1);
  });
  it('reports partial progress', () => {
    expect(routeFraction(25, 12)).toBeCloseTo(0.52, 5);
  });
  it('clamps to [0,1] if unrouted exceeds baseline', () => {
    expect(routeFraction(25, 30)).toBe(0);
  });
  it('guards divide-by-zero', () => {
    expect(routeFraction(0, undefined)).toBe(0);
  });
  it('is 0 when the current count is unknown', () => {
    expect(routeFraction(25, undefined)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "packages/ui" && npx vitest run test/route-progress.test.ts`
Expected: FAIL — cannot resolve `../src/route-progress.js` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `packages/ui/src/route-progress.ts`:

```ts
/**
 * Pure fill math for the Lock & Route progress bar. Kept DOM-free so it can be
 * unit-tested in the node-environment UI test suite; panels.ts owns rendering.
 *
 * The bar measures nets remaining. Freerouting broadcasts an `unrouted` count
 * per pass; the baseline is the largest count seen this route (usually the
 * first pass), so the fill only ever moves toward "done" and never overflows.
 */

/** Highest unrouted-net count seen so far this route — the progress-bar denominator. */
export function nextBaseline(prev: number | null, unrouted: number | undefined): number | null {
  if (unrouted === undefined) return prev;
  if (prev === null || unrouted > prev) return unrouted;
  return prev;
}

/** Fraction [0,1] of nets routed: (baseline - unrouted) / baseline. 0 when unknown. */
export function routeFraction(baseline: number | null, unrouted: number | undefined): number {
  if (baseline === null || baseline <= 0 || unrouted === undefined) return 0;
  const f = (baseline - unrouted) / baseline;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "packages/ui" && npx vitest run test/route-progress.test.ts`
Expected: PASS — all 12 cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/route-progress.ts packages/ui/test/route-progress.test.ts
git commit -m "ui: pure fill-math helper for routing progress bar"
```

---

### Task 2: Render the bar in the Lock & Route panel

**Files:**
- Modify: `packages/ui/src/panels.ts` (inside `wireRouteControls`, ~1327–1433)
- Modify: `packages/ui/src/style.css` (after ~line 1120, near the `.route-*` rules)

**Interfaces:**
- Consumes: `nextBaseline`, `routeFraction` from Task 1; existing `liveLabel(s)`, `els.routeStatus` (`status`), `els.routeBtn` (`btn`), `RouteStatus` type.
- Produces: no exported API; a `.route-progress` element rendered inside `#route-status`.

**Behavior reference (why the code is shaped this way):**
- The one broadcast that has **no `stage`** is the initial `{ state:'running', message:'Starting autoroute…' }`; every Freerouting progress event carries `stage` (`'route'`/`'retry'`). So `s.stage === undefined` is the reliable "fresh route" marker that resets `baseline` — and retry events (small `unrouted`) do **not** reset it, so the bar reads near-complete during retry instead of snapping back to 0.
- `bar.fill.isConnected` guards rebuild after any `status.replaceChildren()` (idle/confirm) detaches the bar.

- [ ] **Step 1: Add the CSS**

In `packages/ui/src/style.css`, immediately after the `.route-busy` rule block (~line 1117), add:

```css
/* ---- Lock & Route progress bar (fills by nets remaining) ---- */

.route-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
}

.route-progress-track {
  height: 4px;
  background: var(--paper-2);
  border: 1px solid var(--rule);
  overflow: hidden;
}

.route-progress-track.pulse {
  animation: route-progress-pulse 1.1s var(--ease) infinite;
}

.route-progress-fill {
  height: 100%;
  width: 0;
  background: var(--signal-orange);
  transition: width var(--dur) var(--ease);
}

.route-progress-fill.done {
  background: var(--signal-green);
}

.route-progress-fill.failed {
  background: var(--signal-red);
}

.route-progress-label {
  font-size: 11px;
  color: var(--ink-soft);
}

@keyframes route-progress-pulse {
  0%, 100% { background: var(--paper-2); }
  50% { background: var(--rule); }
}
```

- [ ] **Step 2: Import the helpers in panels.ts**

In `packages/ui/src/panels.ts`, add after the existing `import { islandsFor } from './renderer.js';` (line 29):

```ts
import { nextBaseline, routeFraction } from './route-progress.js';
```

- [ ] **Step 3: Add closure state + `showBar`, and reset in `idle`**

In `wireRouteControls` (starts ~line 1327), replace the opening through the end of `idle()`:

```ts
  function wireRouteControls(): void {
    let routing = false;
    const btn = els.routeBtn;
    const status = els.routeStatus;

    function idle(): void {
      status.replaceChildren();
      btn.disabled = false;
      btn.textContent = 'Lock & Route';
    }
```

with:

```ts
  function wireRouteControls(): void {
    let routing = false;
    const btn = els.routeBtn;
    const status = els.routeStatus;

    // Progress-bar state, reset per route. `baseline` = max unrouted seen;
    // `lastFraction` is held on the bar when a phase (widen/stitch tail) or a
    // failure stops sending live counts.
    let baseline: number | null = null;
    let lastFraction = 0;
    let bar: { track: HTMLElement; fill: HTMLElement; label: HTMLElement } | null = null;

    function idle(): void {
      status.replaceChildren();
      bar = null;
      baseline = null;
      lastFraction = 0;
      btn.disabled = false;
      btn.textContent = 'Lock & Route';
    }

    /** Render/update the bar. Rebuilds the element if it was detached by a replaceChildren(). */
    function showBar(fraction: number, state: 'pulse' | 'active' | 'done' | 'failed', label: string): void {
      if (!bar || !bar.fill.isConnected) {
        status.replaceChildren();
        const wrap = document.createElement('div');
        wrap.className = 'route-progress';
        const track = document.createElement('div');
        track.className = 'route-progress-track';
        const fill = document.createElement('div');
        fill.className = 'route-progress-fill';
        const lbl = document.createElement('div');
        lbl.className = 'route-progress-label';
        track.appendChild(fill);
        wrap.append(track, lbl);
        status.appendChild(wrap);
        bar = { track, fill, label: lbl };
      }
      lastFraction = fraction;
      bar.track.classList.toggle('pulse', state === 'pulse');
      bar.fill.classList.toggle('done', state === 'done');
      bar.fill.classList.toggle('failed', state === 'failed');
      bar.fill.style.width = `${Math.round(fraction * 100)}%`;
      bar.label.textContent = label;
    }
```

- [ ] **Step 4: Make `setResult` keep the bar**

Replace the existing `setResult` (currently clears the whole container):

```ts
    function setResult(text: string, kind: 'ok' | 'err'): void {
      status.replaceChildren();
      const el = document.createElement('div');
      el.className = `route-result ${kind}`;
      el.textContent = text;
      status.appendChild(el);
    }
```

with (append below the bar, replacing only a prior result line):

```ts
    function setResult(text: string, kind: 'ok' | 'err'): void {
      status.querySelector('.route-result')?.remove();
      const el = document.createElement('div');
      el.className = `route-result ${kind}`;
      el.textContent = text;
      status.appendChild(el);
    }
```

- [ ] **Step 5: Drive the bar from `routeStatusHandler`**

Replace the existing handler:

```ts
    routeStatusHandler = (s: RouteStatus | null): void => {
      if (!s) return;
      if (s.state === 'running') {
        btn.disabled = true;
        btn.textContent = liveLabel(s);
        return;
      }
      if (routing) return;
      btn.disabled = false;
      btn.textContent = 'Lock & Route';
      if (s.message) setResult(s.message, s.state === 'failed' ? 'err' : 'ok');
    };
```

with:

```ts
    routeStatusHandler = (s: RouteStatus | null): void => {
      if (!s) return;
      if (s.state === 'running') {
        // The stage-less "Starting autoroute…" event marks a fresh route (any
        // origin). Retry events carry stage:'retry' and must NOT reset the
        // baseline, so the bar reads near-complete during the retry pass.
        if (s.stage === undefined) baseline = null;
        baseline = nextBaseline(baseline, s.unrouted);
        btn.disabled = true;
        btn.textContent = liveLabel(s);
        // Before any count arrives, pulse the track instead of showing a dead 0%.
        const started = baseline !== null;
        showBar(routeFraction(baseline, s.unrouted), started ? 'active' : 'pulse', liveLabel(s));
        return;
      }
      // Terminal: fill to 100% (done) or hold at the last fill in red (failed).
      if (s.state === 'done') showBar(1, 'done', 'Routed.');
      else showBar(lastFraction, 'failed', 'Route failed.');
      if (routing) return; // local doRoute() owns its own finish
      btn.disabled = false;
      btn.textContent = 'Lock & Route';
      if (s.message) setResult(s.message, s.state === 'failed' ? 'err' : 'ok');
    };
```

- [ ] **Step 6: Reset + prime the bar in `doRoute`**

Replace the start of `doRoute` (the `status.replaceChildren()` + `.route-busy` block):

```ts
    async function doRoute(): Promise<void> {
      if (routing) return;
      routing = true;
      btn.disabled = true;
      status.replaceChildren();
      const busy = document.createElement('div');
      busy.className = 'route-busy';
      busy.textContent = 'Routing… this can take a minute.';
      status.appendChild(busy);
      try {
```

with:

```ts
    async function doRoute(): Promise<void> {
      if (routing) return;
      routing = true;
      btn.disabled = true;
      status.replaceChildren();
      bar = null;
      baseline = null;
      lastFraction = 0;
      showBar(0, 'pulse', 'Routing… this can take a minute.');
      try {
```

Leave the rest of `doRoute` (fetch, `setResult` calls, `finally`) unchanged.

- [ ] **Step 7: Build to verify types + bundle**

Run: `npm run build`
Expected: PASS — tsc clean across packages, vite build for the ui succeeds, no unused-symbol or type errors.

- [ ] **Step 8: Run the full UI test suite (regression)**

Run: `cd "packages/ui" && npx vitest run`
Expected: PASS — Task 1's `route-progress` tests plus all existing UI tests green.

- [ ] **Step 9: Manual verification**

```bash
node packages/server/dist/cli.js serve boards/eink-cell/eink-cell.flamingo
```
Open `http://localhost:4242`, rip up all, then click **Lock & Route → Route**. Confirm:
- The track pulses briefly at the start (before the first pass count).
- The orange fill advances as passes report, and the label mirrors the button (`Routing… pass N · M unrouted`).
- On the escape-width retry (if it happens) the bar reads near-complete rather than snapping to 0.
- The fill holds during the widen/stitch tail, then snaps to a full green bar with the summary line beneath it.
- A route started via the MCP `autoroute` tool (not the button) animates the same bar.

- [ ] **Step 10: Commit**

```bash
git add packages/ui/src/panels.ts packages/ui/src/style.css
git commit -m "ui: routing progress bar in the Lock & Route panel"
```

---

## Self-Review

**Spec coverage:**
- Determinate fill by nets remaining → Task 1 (`routeFraction`) + Task 2 Step 5. ✓
- Baseline = max unrouted seen, reset per route → `nextBaseline` (Task 1) + `s.stage === undefined` reset (Task 2 Step 5) + `doRoute` reset (Step 6). ✓
- Pulse before first count → Task 2 Steps 1 (CSS) + 5 (`started ? 'active' : 'pulse'`). ✓
- Retry reads near-complete (no reset) → Step 5 comment + stage-gated reset. ✓
- Widen/stitch tail holds → no running events arrive, bar keeps last width (`lastFraction`). ✓
- `done` → 100% green; `failed` → hold + red → Step 5. ✓
- Bar in `#route-status`, button behavior unchanged, `setResult` keeps bar → Steps 4–6. ✓
- Reuse CSS vars; smooth width transition → Step 1. ✓
- No backend/WS/protocol changes → only `route-progress.ts`, `panels.ts`, `style.css` touched. ✓
- Both button and MCP-started routes drive the bar → handler is fed from the broadcast store (Step 5). ✓
- Divide-by-zero / clamp guards → Task 1 tests. ✓

**Placeholder scan:** none — every code and command step is concrete.

**Type consistency:** `nextBaseline`/`routeFraction` signatures identical between Task 1 definition, its tests, and the Task 2 import/usage. `bar` shape (`{ track, fill, label }`) consistent across `showBar` and `idle`. `showBar` state union (`'pulse'|'active'|'done'|'failed'`) matches all call sites and the CSS class names (`.pulse`, `.done`, `.failed`).
