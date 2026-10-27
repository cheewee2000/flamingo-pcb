#!/usr/bin/env node
/**
 * Headless-browser check of the panel view, on the boards e2e-panel.ts builds.
 *
 *     npx tsx packages/server/scripts/e2e-panel.ts        # builds the boards
 *     npm run build                                       # builds the page
 *     npx tsx packages/server/scripts/verify-panel-ui.ts
 *
 * Starts the real server with the real built UI, opens /panel in headless
 * Chromium, and checks, in the page itself:
 *
 *   - the view loads and connects
 *   - the sidebar is three steps: boards you need, ways to order them, and
 *     what is on the plate
 *   - a panel can be started from the page: boards are added from a list, and
 *     a way to order them is picked from the next
 *   - + and - change what is on the plate, and a panel made by hand is listed
 *     among the ways to order, priced and ranked with the rest
 *   - the ways to order are worked out again when what is needed changes
 *   - dragging an instance moves it and pins it
 *   - the right-click menu rotates, duplicates, toggles bare, unpins, deletes
 *   - A arranges, around a pinned instance, and explains a panel that cannot fit
 *   - the cost summary follows every change, and flags estimates
 *   - a row says what is on a panel, what is ordered and what you get, and
 *     the boards it delivers add up to the boards it orders
 *   - no text in the sidebar lies over other text or runs out of it, with and
 *     without a scrollbar taking room
 *   - selecting a way that is one panel puts it on the plate, and its row says so
 *   - selecting one that is not (separate orders) shows its orders on the
 *     plate, says so in a banner, and leaves the panel alone
 *   - warnings from the check are listed
 *   - Delete, Ctrl+Z and Ctrl+Shift+Z work
 *   - an edit made outside the browser (as MCP would) shows up without a reload
 *   - Export offers a zip, and the zip holds the fab files
 *   - a server started on a panel file has the same view at '/', without the
 *     link to an editor that is not there
 *   - colour means "which board" and nothing else: every instance is filled
 *     with its board's tint, and every coloured pixel and style has the hue of
 *     a board colour
 *   - Layout / Fabricated: the fabricated view is drawn in solder-mask green,
 *     boards can still be selected in it, and the choice survives a reload
 *
 * Screenshots go to panel-screenshots/ at the repo root. Exits 0 on success.
 *
 * Chromium is found in Playwright's cache (~/.cache/ms-playwright), or set
 * FLAMINGO_CHROMIUM to a Chromium or Chrome binary.
 *
 * On a machine without the libraries Chromium needs, run the browser in
 * Playwright's container and point the script at it:
 *
 *     docker run --rm -d --network host --name flamingo-pw \
 *       -v "$PWD/packages/server/scripts/lib/greyscale-fonts.conf:/fc/fonts.conf:ro" \
 *       -e FONTCONFIG_FILE=/fc/fonts.conf \
 *       mcr.microsoft.com/playwright:v1.61.1-noble \
 *       npx -y playwright@1.61.1 run-server --port 4177 --host 127.0.0.1
 *     FLAMINGO_PLAYWRIGHT_WS=ws://127.0.0.1:4177/ npx tsx packages/server/scripts/verify-panel-ui.ts
 *     docker stop flamingo-pw
 *
 * The font configuration matters to the last check only. A browser that
 * rasterizes text with subpixel (LCD) antialiasing tints the edges of every
 * letter red and blue; that is the rasterizer, not the page, and the
 * configuration turns it off so that the colour check is a statement about
 * the page. (macOS has had no subpixel antialiasing since 10.14.)
 */

import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { Resvg } from '@resvg/resvg-js';
import { newBoard } from '@flamingo/engine';
import type { JlcStock } from '@flamingo/parts';
import { fetchPart, searchParts } from '@flamingo/parts';
import type { PanelView } from '@flamingo/panel';
import { BOARD_COLORS, FAB_COLORS, boardColorAt, tint } from '@flamingo/panel';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';

process.env.FLAMINGO_STOCK_CHECK ??= 'off';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
/**
 * What JLCPCB's parts library said about the fixture boards' parts on
 * 2026-10-27, fixed here so the check does not depend on the live library:
 * a part going out of stock or Standard-only would otherwise change which
 * ways to order exist. The ESP32 module (C2913204) is in fact Standard only
 * there; the check keeps it Economic-eligible so the fixtures stay an
 * Economic PCBA order, which is what every cost step below reads.
 */
const JLC_PARTS: Record<string, Omit<JlcStock, 'lcsc'>> = {
  C15850: { stock: 1_000_000, basic: true, standardOnly: false, prices: [{ from: 1, to: null, price: 0.0438 }], attrition: { loss: 10, minimum: 20 } },
  C165948: { stock: 100_000, basic: false, standardOnly: false, prices: [{ from: 1, to: null, price: 0.187 }], attrition: { loss: 0, minimum: 2 } },
  C25804: { stock: 10_000_000, basic: true, standardOnly: false, prices: [{ from: 1, to: null, price: 0.0017 }], attrition: { loss: 10, minimum: 20 } },
  C2913204: { stock: 50_000, basic: false, standardOnly: false, prices: [{ from: 1, to: 9, price: 4.5929 }, { from: 10, to: null, price: 4.2 }], attrition: { loss: 0, minimum: 1 } },
  C605211: { stock: 1_000_000, basic: false, standardOnly: false, prices: [{ from: 1, to: null, price: 0.0362 }], attrition: { loss: 10, minimum: 20 } },
  C6186: { stock: 1_000_000, basic: true, standardOnly: false, prices: [{ from: 1, to: null, price: 0.2061 }], attrition: { loss: 0, minimum: 2 } },
  C23186: { stock: 10_000_000, basic: true, standardOnly: false, prices: [{ from: 1, to: null, price: 0.0015 }], attrition: { loss: 10, minimum: 20 } },
};
const PARTS_API = {
  fetchPart,
  searchParts,
  fetchStock: async (lcsc: string): Promise<JlcStock> => {
    const known = JLC_PARTS[lcsc];
    return known ? { lcsc, ...known } : { lcsc, stock: null, basic: false, standardOnly: false };
  },
};

const BOARDS_DIR = join(ROOT, '.superpowers', 'sdd', 'e2e-panel');
const SHOTS_DIR = join(ROOT, 'panel-screenshots');
const BOARDS = ['esp32-breakout.flamingo', 'usbc-breakout.flamingo'] as const;
const VIEWPORT = { width: 1600, height: 1000 };

let stepNo = 0;
function step(label: string): void {
  stepNo++;
  console.log(`\n[${stepNo}] ${label}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function findChromium(): string | undefined {
  if (process.env.FLAMINGO_CHROMIUM) return process.env.FLAMINGO_CHROMIUM;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  for (const b of BOARDS) {
    assert(existsSync(join(BOARDS_DIR, b)), `${join(BOARDS_DIR, b)} is missing: run packages/server/scripts/e2e-panel.ts first`);
  }
  assert(existsSync(join(ROOT, 'packages', 'ui', 'dist', 'panel.html')), 'packages/ui/dist/panel.html is missing: run npm run build first');

  const projectDir = await mkdtemp(join(tmpdir(), 'flamingo-panel-ui-'));
  for (const b of BOARDS) await copyFile(join(BOARDS_DIR, b), join(projectDir, b));
  await mkdir(SHOTS_DIR, { recursive: true });

  let started: StartedServer | undefined;
  let browser: Browser | undefined;
  const shots: Array<[string, string]> = [];

  try {
    started = await startServer(new Doc(newBoard('editor', 2)), 0, { projectDir, panel: true, partsApi: PARTS_API });
    const base = `http://127.0.0.1:${started.port}`;
    console.log(`Server on ${base}, project dir ${projectDir}`);

    const post = async (path: string, body: unknown = {}): Promise<Record<string, unknown>> => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return (await res.json()) as Record<string, unknown>;
    };
    const getView = async (): Promise<PanelView> => (await (await fetch(`${base}/api/panel`)).json()) as PanelView;

    // The page opens on a panel with nothing on it, the way a new one starts.
    await post('/api/panel/new', { name: 'first' });

    const remote = process.env.FLAMINGO_PLAYWRIGHT_WS;
    if (remote) {
      browser = await chromium.connect(remote);
      console.log(`Browser: Playwright server at ${remote}`);
    } else {
      const executablePath = findChromium();
      browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      console.log(`Browser: ${executablePath ?? 'Playwright default Chromium'}`);
    }
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: true });
    const page: Page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // The browser logs every non-2xx response. The refused export is one,
      // and it is asked for on purpose further down.
      if (m.location().url.includes('/api/panel/export.zip')) return;
      pageErrors.push(`${m.text()} (${m.location().url})`);
    });

    const shot = async (name: string, what: string): Promise<Buffer> => {
      const file = `${name}.png`;
      const png = await page.screenshot({ path: join(SHOTS_DIR, file) });
      shots.push([file, what]);
      console.log(`  screenshot ${file}`);
      return png;
    };
    /** The page's own state, read through its scripted-check handle. */
    const state = <T>(pick: string): Promise<T> => page.evaluate(`(() => { const s = window.flamingoPanel.state(); return ${pick}; })()`) as Promise<T>;
    const instances = (): Promise<Array<{ id: string; x: number; y: number; rotation: number; pinned: boolean; populate: boolean }>> =>
      state('s.view.panel.instances.map((i) => ({ id: i.id, x: i.at.x, y: i.at.y, rotation: i.rotation, pinned: i.pinned, populate: i.populate }))');
    /** Wait until the page's view satisfies `cond` (an expression over `v`, the view). */
    const until = async (cond: string, what: string): Promise<void> => {
      try {
        await page.waitForFunction(`(() => { const s = window.flamingoPanel && window.flamingoPanel.state(); const v = s && s.view; return !!v && (${cond}); })()`, undefined, { timeout: 8000 });
      } catch {
        throw new Error(`ASSERT FAILED: timed out waiting for: ${what}`);
      }
    };
    /** Centre of an instance in page pixels. */
    const centreOf = async (id: string): Promise<{ x: number; y: number }> => {
      const p = (await page.evaluate(
        `(() => { const s = window.flamingoPanel.state(); const i = s.view.geometry.instances.find((x) => x.id === ${JSON.stringify(id)}); if (!i) return null;
          const c = window.flamingoPanel.toPlate({ x: (i.bbox.minX + i.bbox.maxX) / 2, y: (i.bbox.minY + i.bbox.maxY) / 2 });
          const r = document.getElementById('plate-canvas').getBoundingClientRect(); return { x: r.left + c.x, y: r.top + c.y }; })()`,
      )) as { x: number; y: number } | null;
      assert(p, `instance ${id} is not on the plate`);
      return p;
    };
    const text = async (selector: string): Promise<string> => (await page.locator(selector).innerText()).trim();
    /** The heading of step 3 as written: the page shows headings in capitals. */
    const plateTitle = async (): Promise<string> => ((await page.locator('#plate-title').textContent()) ?? '').trim();
    /**
     * Text in the sidebar that lies over other text, or runs out of the
     * sidebar. Compared on the middle 70% of each line's height: lines set
     * close together touch at their edges without being over one another.
     */
    const textTrouble = (): Promise<string[]> =>
      page.evaluate(`(() => {
        const side = document.querySelector('.side');
        const bounds = side.getBoundingClientRect();
        const right = bounds.left + side.clientWidth;
        const clipped = (el) => { for (let e = el; e && e !== side; e = e.parentElement) { if (getComputedStyle(e).textOverflow === 'ellipsis') return true; } return false; };
        const rects = [];
        const walker = document.createTreeWalker(side, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = n.textContent.trim();
          const el = n.parentElement;
          if (!text || !el.checkVisibility() || clipped(el)) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) {
            if (r.width < 1 || r.height < 1) continue;
            const inset = r.height * 0.15;
            rects.push({ text: text.slice(0, 40), el, l: r.left, r: r.right, t: r.top + inset, b: r.bottom - inset });
          }
        }
        const out = [];
        for (const a of rects) if (a.r > right + 0.5 || a.l < bounds.left - 0.5) out.push('runs out of the sidebar: "' + a.text + '"');
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i], b = rects[j];
            if (a.el === b.el) continue;
            const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
            const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
            if (w > 1 && h > 1) out.push('"' + a.text + '" lies over "' + b.text + '"');
          }
        }
        return [...new Set(out)];
      })()`) as Promise<string[]>;
    /** The same with 17 px less room, as when the browser draws a scrollbar that takes it. */
    const tidy = async (where: string): Promise<void> => {
      const wide = await textTrouble();
      assert(wide.length === 0, `${where}: ${wide.join('; ')}`);
      const style = await page.addStyleTag({ content: '.side { box-sizing: border-box; padding-right: 17px; }' });
      const narrow = await textTrouble();
      await style.evaluate((e) => (e as HTMLElement).remove());
      assert(narrow.length === 0, `${where}, with a scrollbar: ${narrow.join('; ')}`);
    };
    const errorCodes = (): Promise<string[]> => state("s.view.issues.filter((i) => i.severity === 'error').map((i) => i.code)");
    const menu = async (id: string, item: string): Promise<void> => {
      const c = await centreOf(id);
      await page.mouse.click(c.x, c.y, { button: 'right' });
      await page.locator('#context-menu:not([hidden])').waitFor();
      await page.locator('#context-menu button', { hasText: item }).click();
    };

    // --- load --------------------------------------------------------------
    step('the view loads');
    await page.goto(`${base}/panel`);
    await page.waitForFunction('window.flamingoPanel && window.flamingoPanel.state().view !== null');
    await page.waitForFunction("document.getElementById('status-conn').textContent === 'connected'");
    assert((await page.title()) === 'Flamingo — Panel', 'wrong page title');
    assert((await text('#panel-name')) === 'first', 'the panel name is not shown');

    // --- starting a panel --------------------------------------------------
    step('a panel is started from the page');
    const steps = (await page.locator('.side .step h2').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    assert(
      JSON.stringify(steps) === JSON.stringify(['1 BOARDS YOU NEED', '2 WAYS TO ORDER THEM', '3 ON THE PLATE: NOTHING YET']),
      `the steps read ${JSON.stringify(steps)}`,
    );
    assert((await text('#plate-empty')).includes('Boards you need'), 'an empty panel does not say how to start');
    assert((await text('#option-list')).includes('Add a board in step 1'), 'step 2 does not say what it waits for');
    assert(!(await page.locator('#plate-edit').isVisible()), 'there are tools to change a panel that has no boards');
    assert(await page.locator('#export-btn').isDisabled(), 'an empty panel can be exported');
    await page.locator('#board-add button.add-board').first().waitFor();
    const offered = (await page.locator('#board-add button.add-board').allInnerTexts()).map((t) => t.replace(/^\+\s*/, '').trim()).sort();
    assert(JSON.stringify(offered) === JSON.stringify(['esp32-breakout', 'usbc-breakout']), `the boards on offer are ${JSON.stringify(offered)}`);
    assert((await text('#board-add .add-title')) === 'Add a board to start', 'the list of boards has no heading');
    await shot('00-start', 'A new panel: three steps, nothing on the plate, and the project\'s boards on offer under step 1.');
    await page.locator('#board-add button.add-board', { hasText: 'usbc-breakout' }).click();
    // A board is something needed. How it gets made is the next step's question.
    await until('v.panel.sources.length === 1 && v.panel.instances.length === 0', 'the first board needed, and nothing on the plate');
    // The list is fetched again once the panel has the board; give it the moment it needs.
    await page.waitForFunction("document.querySelectorAll('#board-add button.add-board').length === 1", undefined, { timeout: 5000 }).catch(() => {
      throw new Error('ASSERT FAILED: a board on the panel is still on offer');
    });
    await page.locator('#board-add button.add-board', { hasText: 'esp32-breakout' }).click();
    await until('v.panel.sources.length === 2 && v.panel.instances.length === 0', 'both boards needed');
    await page.waitForFunction("document.querySelectorAll('#board-add button.add-board').length === 0", undefined, { timeout: 5000 }).catch(() => {
      throw new Error('ASSERT FAILED: boards are on offer although all are on the panel');
    });
    assert((await text('#plate-empty')).includes('Step 2: pick a way to order'), 'the empty plate does not point at step 2');
    // Step 2 has the answers; one that is a panel goes on the plate when picked.
    await page.locator('#option-list [data-option]').first().waitFor();
    assert((await page.locator('#option-list .where').count()) === 0, 'a way to order is marked as on the plate while the plate is empty');
    const firstPanel = await state<string>('s.quote.scenarios.find((x) => x.orders.length === 1 && x.orders[0].panel && x.layout).id');
    await page.locator(`#option-list [data-option="${firstPanel}"]`).click();
    await until('v.panel.instances.length >= 2', 'a panel on the plate');
    await page.locator(`#option-list [data-option="${firstPanel}"] .where-plate`).waitFor();
    assert((await errorCodes()).length === 0, `starting a panel left errors: ${(await errorCodes()).join(', ')}`);
    const started0 = await getView();
    assert(started0.filePath !== null && started0.panel.sources.map((x) => x.path).sort().join() === 'esp32-breakout.flamingo,usbc-breakout.flamingo', 'the boards were not recorded by relative path');
    await shot('00b-started', 'Both boards added in step 1 and a way to order picked in step 2: its panel is on the plate, each board in its colour, and its row says \"on the plate\".');

    // The rest runs on the panel of the brief: S and M, 1 + 5 needed, nothing placed.
    await post('/api/panel/new', { name: 'combo' });
    await post('/api/panel/add-board', { path: 'esp32-breakout.flamingo', key: 'S', needed: 1 });
    await post('/api/panel/add-board', { path: 'usbc-breakout.flamingo', key: 'M', needed: 5 });
    await until("v.panel.name === 'combo' && v.panel.sources.length === 2 && v.panel.instances.length === 0", 'the combo panel');
    await page.waitForFunction("document.querySelectorAll('#board-list .board').length === 2");
    assert((await text('#panel-name')) === 'combo', 'the panel name is not shown');
    const rows = await page.locator('#board-list .board').count();
    assert(rows === 2, `expected 2 boards in the list, got ${rows}`);
    assert((await text('#board-list .board[data-key="S"] .board-name')) === 'esp32-breakout', 'board S is not listed by name');
    assert((await page.locator('#board-list .board[data-key="M"] input[data-field="needed"]').inputValue()) === '5', 'needed quantity of M is not shown');
    assert(await page.locator('#plate-empty').isVisible(), 'the empty plate does not say it is empty');
    assert((await plateTitle()) === 'On the plate: nothing yet', `step 3 is headed "${await plateTitle()}"`);
    await page.waitForFunction("document.querySelectorAll('#option-list [data-option]').length >= 4");
    assert((await page.locator('#option-list [data-option="own"]').count()) === 0, 'an empty plate is listed as a way to order');
    const canvasBox = await page.locator('#plate-canvas').boundingBox();
    assert(canvasBox && canvasBox.width > VIEWPORT.width * 0.7 && canvasBox.height > VIEWPORT.height * 0.9, 'the canvas does not take most of the screen');
    await shot('01-loaded-empty', 'The view as it opens: both boards listed with needed 1 and 5, the ways to order them, nothing on the plate yet.');

    // --- object list: + and - ----------------------------------------------
    step('+ puts instances on the plate');
    await page.locator('#plate-counts button[aria-label="one more S"]').click();
    await until('v.panel.instances.length === 1', 'S1 on the plate');
    for (let n = 1; n <= 5; n++) {
      await page.locator('#plate-counts button[aria-label="one more M"]').click();
      await until(`v.panel.instances.filter((i) => i.source === 'M').length === ${n}`, `${n} M instances`);
    }
    assert((await text('#plate-counts .count-control[data-key="M"] output')) === '5', 'the count of M does not read 5');
    assert((await page.locator('#board-list button, #board-list output').count()) === 0, 'step 1 still has the tools that change the plate');
    assert((await errorCodes()).length === 0, `adding instances left errors: ${(await errorCodes()).join(', ')}`);
    assert(!(await page.locator('#plate-empty').isVisible()), 'the empty-plate note is still showing');
    const costAll = await text('#cost-total');
    assert(/^\$\d+\.\d\d$/.test(costAll), `the cost total reads "${costAll}"`);
    assert(await page.locator('#cost-flag').isVisible(), 'the cost is not flagged as an estimate');
    const flags = (await page.evaluate(`[...document.querySelectorAll('#cost-summary table.lines td.flag')].map((e) => e.textContent.trim())`)) as string[];
    const flagged = flags.filter((f) => f === 'est.').length;
    const unflagged = flags.filter((f) => f === '').length;
    assert(flagged > 0 && unflagged > 0, `expected both estimated and verified fee lines, got ${flagged} and ${unflagged}`);
    assert((await text('#cost-summary .legend')).includes('est. = estimate'), 'the estimate mark is not explained');
    // Three subtotals, folded; the lines are one click away.
    const groups = (await page.locator('#cost-summary .cost-group .cost-name').allInnerTexts()).map((t) => t.trim());
    assert(JSON.stringify(groups) === JSON.stringify(['Boards', 'Assembly', 'Parts']), `the cost is grouped as ${JSON.stringify(groups)}`);
    assert(!(await page.locator('#cost-summary .cost-group table.lines').first().isVisible()), 'the fee lines are unfolded from the start');
    await page.locator('#cost-summary .cost-group summary', { hasText: 'Assembly' }).click();
    assert(await page.locator('#cost-summary .cost-group[open] table.lines td', { hasText: 'Economic PCBA setup' }).isVisible(), 'unfolding Assembly does not show its lines');
    const assemblyFlag = (await text('#cost-summary .cost-group[open] summary .flag'));
    assert(assemblyFlag === '', 'the Assembly subtotal is marked as an estimate although every line in it is verified');
    // Parts are priced from JLCPCB's library: at its tier, with its attrition, and not as an estimate.
    await page.locator('#cost-summary .cost-group summary', { hasText: 'Parts' }).click();
    const usbc = page.locator('#cost-summary .cost-group[open] table.lines tr', { hasText: 'C165948' });
    assert((await usbc.count()) === 1, 'the USB-C connector is not a part line');
    assert((await usbc.locator('td.flag').innerText()).trim() === '', "a part priced from JLCPCB's library is marked as an estimate");
    const usbcText = (await usbc.innerText()).replace(/\s+/g, ' ');
    const billed = /x (\d+)/.exec(usbcText);
    assert(billed, `the connector line does not say how many are billed: ${usbcText}`);
    const amount = (await usbc.locator('td.amount').innerText()).trim();
    assert(amount.includes((Number(billed[1]) * 0.187).toFixed(2)), `${billed[1]} connectors at the library's $0.187 do not come to ${amount}: ${usbcText}`);
    await page.locator('#cost-summary .cost-group[open] summary', { hasText: 'Parts' }).click();
    // A panel made by hand is a way to order like the others: listed, priced, ranked.
    const own = page.locator('#option-list [data-option="own"]');
    await own.waitFor();
    assert((await own.locator('.sc-name span').first().innerText()).trim() === 'Your panel', 'the panel made by hand is not called "Your panel"');
    assert((await own.locator('.where-plate').innerText()).trim() === 'on the plate', 'the panel made by hand is not marked as on the plate');
    assert((await own.locator('.sc-total').innerText()).trim().split(/\s/)[0] === costAll, 'the row of the panel and the cost in step 3 disagree');
    assert((await page.locator('#option-list .where-plate').count()) === 1, 'more than one way is marked as on the plate');
    assert((await plateTitle()) === 'On the plate: Your panel', `step 3 is headed "${await plateTitle()}"`);
    {
      const ranked = await page.locator('#option-list .scenario .sc-total').evaluateAll((els) => els.map((e) => parseFloat((e.textContent ?? '').replace('$', ''))));
      assert(ranked.every((t, i) => i === 0 || t >= ranked[i - 1]!), `your panel is not ranked with the rest: ${ranked.join(', ')}`);
      const ranks = (await page.locator('#option-list .scenario .sc-rank').allInnerTexts()).map((t) => Number(t));
      assert(ranks.every((r, i) => r === i + 1), `the ranks read ${ranks.join(', ')}`);
    }
    await tidy('with a panel made by hand');
    await shot('02-one-plus-five', 'After pressing + once for S and five times for M in step 3: 1 + 5 on the plate, listed in step 2 as \"Your panel\", ranked by its cost among the computed ways.');

    step('- takes one away, and the cost follows');
    await page.locator('#plate-counts button[aria-label="one fewer M"]').click();
    await until("v.panel.instances.filter((i) => i.source === 'M').length === 4", '4 M instances');
    await page.waitForFunction(`document.getElementById('cost-total').textContent !== ${JSON.stringify(costAll)}`);
    const costFour = await text('#cost-total');
    console.log(`  cost with 5 M: ${costAll}; with 4 M: ${costFour}`);
    assert(costFour !== costAll, 'the cost did not change when an instance was removed');
    await page.locator('#plate-counts button[aria-label="one more M"]').click();
    await until("v.panel.instances.filter((i) => i.source === 'M').length === 5", '5 M instances again');

    // --- drag pins ---------------------------------------------------------
    step('dragging an instance moves it and pins it');
    const before = (await instances()).find((i) => i.id === 'M3')!;
    assert(!before.pinned, 'M3 is pinned before it was ever dragged');
    const from = await centreOf('M3');
    const onto = await centreOf('S1');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + onto.x) / 2, (from.y + onto.y) / 2, { steps: 6 });
    const dragging = await state<{ id: string } | null>('s.drag');
    assert(dragging?.id === 'M3', 'no drag is in progress while the button is held');
    await shot('03-dragging', 'M3 picked up and on its way: drawn where the pointer has it, with its position beside it.');
    await page.mouse.move(onto.x, onto.y, { steps: 6 });
    await page.mouse.up();
    await until("v.panel.instances.find((i) => i.id === 'M3').pinned === true", 'M3 pinned after the drop');
    const after = (await instances()).find((i) => i.id === 'M3')!;
    assert(Math.hypot(after.x - before.x, after.y - before.y) > 5, 'M3 did not move');
    const onServer = (await getView()).panel.instances.find((i) => i.id === 'M3')!;
    assert(onServer.pinned && onServer.at.x === after.x && onServer.at.y === after.y, 'the server does not have the dropped position');
    assert((await state<string | null>('s.selection')) === 'M3', 'the dragged instance is not selected');
    assert((await text('#status-selection')).includes('pinned'), 'the status bar does not say the selection is pinned');

    step('the check lists what the drop caused, and marks the instances');
    await until("v.issues.some((i) => i.code === 'overlap')", 'an overlap error');
    const row = page.locator('#issue-list .issue-error[data-code="overlap"]');
    assert((await row.locator('.issue-title').innerText()).trim() === 'Overlap', 'the overlap has no short title');
    const chips = (await row.locator('.issue-chips .chip').allInnerTexts()).map((t) => t.trim()).sort();
    assert(JSON.stringify(chips) === JSON.stringify(['M3', 'S1']), `the overlap names ${JSON.stringify(chips)}`);
    assert(!(await row.locator('.issue-text').isVisible()), 'the sentence is shown before it is asked for');
    await row.locator('summary .issue-title').click();
    const overlap = (await row.locator('.issue-text').innerText()).trim();
    assert(/M3/.test(overlap) && /S1/.test(overlap) && /overlap/.test(overlap), `the overlap reads "${overlap}"`);
    assert(Number(await text('#issue-count .level-error')) >= 1, 'the heading does not count the errors');
    // A chip selects its instance on the plate and leaves the row as it is.
    await row.locator('.issue-chips .chip', { hasText: 'S1' }).click();
    assert((await state<string | null>('s.selection')) === 'S1', 'a chip does not select its instance');
    assert(await row.locator('.issue-text').isVisible(), 'selecting from a chip folded the row');
    await row.locator('.issue-chips .chip', { hasText: 'M3' }).click();
    await shot('04-dropped-pinned-overlap', 'M3 dropped on S1: pinned (filled corner square, PINNED), both marked with a second outline and ERROR, and the overlap listed under Checks with a chip per board involved.');

    // --- arrange -----------------------------------------------------------
    step('A arranges around the pinned instance');
    // Drag M3 somewhere it can stay: clear of everything, to the right of the panel.
    const frame = await state<{ maxX: number; minY: number }>('s.view.geometry.frame.outer');
    const clear = (await page.evaluate(
      `(() => { const c = window.flamingoPanel.toPlate({ x: ${frame.maxX} + 20, y: ${frame.minY} + 20 }); const r = document.getElementById('plate-canvas').getBoundingClientRect(); return { x: r.left + c.x, y: r.top + c.y }; })()`,
    )) as { x: number; y: number };
    const m3 = await centreOf('M3');
    await page.mouse.move(m3.x, m3.y);
    await page.mouse.down();
    await page.mouse.move(clear.x, clear.y, { steps: 8 });
    await page.mouse.up();
    await until("!v.issues.some((i) => i.code === 'overlap')", 'the overlap to clear');
    const pinnedAt = (await instances()).find((i) => i.id === 'M3')!;
    await page.locator('body').click({ position: { x: 5, y: 5 } }); // focus the page, not a field
    await page.keyboard.press('a');
    await page.locator('#arrange-msg:not([hidden])').waitFor();
    const arranged = await text('#arrange-msg');
    assert(/^Arranged 5 instances into [\d.]+ × [\d.]+ mm\.$/.test(arranged), `the arrange message reads "${arranged}"`);
    const kept = (await instances()).find((i) => i.id === 'M3')!;
    assert(kept.pinned && kept.x === pinnedAt.x && kept.y === pinnedAt.y, 'arrange moved the pinned instance');
    assert((await errorCodes()).length === 0, `arrange left errors: ${(await errorCodes()).join(', ')}`);
    await shot('05-arranged-around-pinned', 'After A: five instances packed, M3 left where it was pinned, and the message saying so.');

    // --- context menu ------------------------------------------------------
    step('the right-click menu');
    const c3 = await centreOf('M3');
    await page.mouse.click(c3.x, c3.y, { button: 'right' });
    await page.locator('#context-menu:not([hidden])').waitFor();
    const items = (await page.locator('#context-menu button').allInnerTexts()).map((t) => t.trim());
    assert(JSON.stringify(items) === JSON.stringify(['Rotate 90°', 'Duplicate', 'Delete', 'Make bare', 'Unpin']), `the menu reads ${JSON.stringify(items)}`);
    await shot('06-context-menu', 'Right-click on M3: rotate 90°, duplicate, delete, make bare, unpin.');
    await page.locator('#context-menu button', { hasText: 'Unpin' }).click();
    await until("v.panel.instances.find((i) => i.id === 'M3').pinned === false", 'M3 unpinned');
    assert(!(await page.locator('#context-menu').isVisible()), 'the menu stayed open');

    await menu('M3', 'Rotate 90°');
    await until("v.panel.instances.find((i) => i.id === 'M3').rotation !== " + kept.rotation, 'M3 rotated');
    await menu('M3', 'Make bare');
    await until("v.panel.instances.find((i) => i.id === 'M3').populate === false", 'M3 bare');
    assert((await text('#plate-counts .count-control[data-key="M"] .bare-n')) === '1 bare', 'the counts do not show the bare instance');
    await menu('M3', 'Duplicate');
    await until("v.panel.instances.filter((i) => i.source === 'M').length === 6", 'a sixth M');
    const copy = (await instances()).find((i) => i.id === 'M6')!;
    assert(!copy.populate && !copy.pinned, 'the duplicate did not keep bare, or came pinned');
    // The copy lands beside the original, which may be off the plate: arrange brings it in.
    await page.keyboard.press('a');
    await until("v.issues.filter((i) => i.severity === 'error').length === 0", 'a clean panel after arranging');
    await page.waitForFunction('window.flamingoPanel.state().busy === false');
    const unpinDisabled = await (async () => {
      const c = await centreOf('M6');
      await page.mouse.click(c.x, c.y, { button: 'right' });
      await page.locator('#context-menu:not([hidden])').waitFor();
      const disabled = await page.locator('#context-menu button', { hasText: 'Unpin' }).isDisabled();
      const label = await page.locator('#context-menu button', { hasText: /Make/ }).innerText();
      await page.keyboard.press('Escape');
      return { disabled, label: label.trim() };
    })();
    assert(unpinDisabled.disabled, 'Unpin is offered for an instance that is not pinned');
    assert(unpinDisabled.label === 'Make populated', 'a bare instance is not offered "Make populated"');
    assert(!(await page.locator('#context-menu').isVisible()), 'Escape did not close the menu');
    await shot('07-bare-instances', 'M3 turned and made bare, then duplicated as M6: bare instances are hatched with a dashed outline and read BARE.');
    await menu('M6', 'Delete');
    await until("!v.panel.instances.some((i) => i.id === 'M6')", 'M6 deleted');

    // --- keyboard ----------------------------------------------------------
    step('Delete, Ctrl+Z, Ctrl+Shift+Z');
    const c5 = await centreOf('M5');
    await page.mouse.click(c5.x, c5.y);
    assert((await state<string | null>('s.selection')) === 'M5', 'a click did not select M5');
    await page.keyboard.press('Delete');
    await until("!v.panel.instances.some((i) => i.id === 'M5')", 'M5 removed by Delete');
    await page.keyboard.press('Control+z');
    await until("v.panel.instances.some((i) => i.id === 'M5')", 'M5 back after undo');
    await page.keyboard.press('Control+Shift+z');
    await until("!v.panel.instances.some((i) => i.id === 'M5')", 'M5 gone again after redo');
    await page.keyboard.press('Control+z');
    await until("v.panel.instances.some((i) => i.id === 'M5')", 'M5 back');
    // A click on empty plate deselects; a drag there pans; the wheel zooms.
    const t0 = await state<{ scale: number; originPxX: number }>('s.transform');
    await page.mouse.move(canvasBox.x + 30, canvasBox.y + canvasBox.height - 30);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 90, canvasBox.y + canvasBox.height - 60, { steps: 4 });
    await page.mouse.up();
    const t1 = await state<{ scale: number; originPxX: number }>('s.transform');
    assert(Math.abs(t1.originPxX - t0.originPxX - 60) < 1 && t1.scale === t0.scale, 'dragging empty space did not pan');
    assert((await state<string | null>('s.selection')) === null, 'a press on empty plate did not deselect');
    await page.mouse.wheel(0, -300);
    const t2 = await state<{ scale: number }>('s.transform');
    assert(t2.scale > t1.scale, 'scrolling did not zoom');
    await page.mouse.wheel(0, 300);
    await page.mouse.move(canvasBox.x + 90, canvasBox.y + canvasBox.height - 60);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 30, canvasBox.y + canvasBox.height - 30, { steps: 4 });
    await page.mouse.up();

    // --- quantities and cost -----------------------------------------------
    step('the cost follows the needed quantity');
    await menu('M3', 'Make populated');
    await until("v.panel.instances.find((i) => i.id === 'M3').populate === true", 'M3 populated');
    const orderBefore = await text('#cost-summary .order-line');
    const totalBefore = await text('#cost-total');
    const needed = page.locator('#board-list .board[data-key="M"] input[data-field="needed"]');
    await needed.fill('12');
    await needed.press('Enter');
    await until("v.panel.sources.find((s) => s.key === 'M').needed === 12", 'needed 12 for M');
    await page.waitForFunction(`document.querySelector('#cost-summary .order-line').textContent !== ${JSON.stringify(orderBefore)}`);
    const orderAfter = await text('#cost-summary .order-line');
    const totalAfter = await text('#cost-total');
    const flat = (t: string): string => t.replace(/\s*\n\s*/g, ', ');
    console.log(`  needed 5: ${flat(orderBefore)}, ${totalBefore}; needed 12: ${flat(orderAfter)}, ${totalAfter}`);
    assert(orderAfter !== orderBefore && totalAfter !== totalBefore, 'the cost summary did not follow the needed quantity');
    // While the ways are priced again the list says so; once they are in, it stops.
    await page.waitForFunction('!window.flamingoPanel.state().quoting', undefined, { timeout: 60000 });
    const waysFor12 = await text('#option-list .scenarios');
    assert(waysFor12.length > 0, 'no ways listed for needed 12');
    const idsOf = (): Promise<string> => page.$$eval('#option-list [data-option]', (els) => els.map((e) => (e as HTMLElement).dataset.option!).sort().join(','));
    const idsSettled = await idsOf();

    step('Cancel puts the quantities and the ways back while a quote is on its way');
    // Hold the next quote request so the pending state can be looked at, however fast the server is.
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/panel/quote*', async (route) => {
      await held;
      await route.abort().catch(() => undefined); // unroute may have let it go already
    });
    await needed.fill('40');
    await needed.press('Enter');
    await until("v.panel.sources.find((s) => s.key === 'M').needed === 40", 'needed 40 for M');
    await page.locator('#quote-pending').waitFor({ timeout: 10000 });
    // The rows are drawn against the new numbers (their marks and rank move), but the ways are the old ones.
    const idsWhilePricing = await idsOf();
    assert(idsWhilePricing === idsSettled, `the ways changed while pricing: ${idsWhilePricing} vs ${idsSettled}`);
    await page.locator('#quote-cancel').click();
    await until("v.panel.sources.find((s) => s.key === 'M').needed === 12", 'needed back to 12 after Cancel');
    assert((await page.locator('#quote-pending').count()) === 0, 'the pending bar did not go away on Cancel');
    assert((await needed.inputValue()) === '12', `the needed field shows ${await needed.inputValue()} after Cancel`);
    assert((await text('#option-list .scenarios')) === waysFor12, 'Cancel did not bring the previous ways back');
    release!();
    await page.unroute('**/api/panel/quote*');
    await page.waitForTimeout(300);
    assert(!(await state<boolean>('!!s.quoting')), 'a quote was fetched again after Cancel');
    console.log('  pending bar shown while pricing; Cancel restored needed 12 and the same ways, with no new fetch');
    const gotM = page.locator('#cost-summary .received .got[data-board="M"]');
    assert((await gotM.getAttribute('data-need')) === '12', 'boards received does not show the new need');
    assert(Number(await gotM.getAttribute('data-got')) >= 12, 'fewer boards received than needed');
    // More boards than there is room to draw one by one: numbers instead.
    assert((await gotM.locator('.pips-text').innerText()).trim() === `${await gotM.getAttribute('data-got')}/12`, 'a large quantity is not shown as received/needed');
    const gotS = page.locator('#cost-summary .received .got[data-board="S"]');
    assert((await gotS.locator('.pip-met').count()) === 1, 'the need for S is not drawn one mark per board');
    assert((await gotS.locator('.pip-over').count()) === Number(await gotS.getAttribute('data-got')) - 1, 'the extra boards of S are not drawn one mark each');
    // The ways to order are answers to what is needed: a new need, new answers.
    await page.waitForFunction("window.flamingoPanel.state().quote.scenarios.every((s) => s.received.find((r) => r.key === 'M').needed === 12)");
    await page.waitForFunction("[...document.querySelectorAll('#option-list .got[data-board=\"M\"]')].every((e) => e.getAttribute('data-need') === '12')");
    assert((await page.locator('#option-list [data-option="own"] .where-plate').count()) === 1, 'your panel left the list when the need changed');
    assert((await page.locator('#option-list [data-option="own"] .sc-total').innerText()).trim().split(/\s/)[0] === totalAfter, 'the row of your panel did not follow the need');
    const derived = await state<number>('s.view.derivedMs');
    console.log(`  the server derived this view, checks and cost included, in ${derived} ms`);
    await shot('08-cost-follows-quantity', 'Needed quantity of M raised to 12 in step 1: the ways to order are worked out again, your panel among them, with more panels assembled and a new total.');
    await needed.fill('5');
    await needed.press('Enter');
    await until("v.panel.sources.find((s) => s.key === 'M').needed === 5", 'needed 5 for M');

    // --- scenarios ---------------------------------------------------------
    step('the cost-by-quantity chart is for one design, priced on request, fills in as it goes, and a point sets the quantity');
    // Two designs: no chart (a quantity would be one number per design).
    assert(await page.locator('#cost-curve').isHidden(), 'the chart is shown for a panel of two designs');
    assert(await page.locator('#cost-curve').evaluate((el) => (el.closest('.sub') as HTMLElement).hidden), 'the chart section (with its heading) is not hidden for two designs');
    await post('/api/panel/op', { op: 'removeSource', key: 'S' });
    await until('v.panel.sources.length === 1', 'one design on the panel');
    // Nothing is priced until asked: the section offers to, and no points are drawn.
    await page.locator('#curve-price').waitFor({ timeout: 10000 });
    assert((await page.locator('#cost-curve svg .pt').count()) === 0, 'the chart was priced without being asked');
    const toPrice = await state<number>('s.curve.missing.length');
    assert(toPrice >= 17, `only ${toPrice} quantities to price`);
    assert((await text('#curve-price')).includes(String(toPrice)), 'the button does not say how many quantities it will price');
    await page.locator('#curve-price').click();
    await page.locator('#curve-pricing').waitFor({ timeout: 10000 });
    await page.locator('#curve-stop').waitFor();
    await page.waitForFunction("(window.flamingoPanel.state().curvePricing || { done: 0 }).done > 0", undefined, { timeout: 60000 });
    const midway = await text('#curve-pricing');
    assert(/Pricing quantities \d+ of \d+/.test(midway), `the progress reads "${midway}"`);
    await page.waitForFunction('window.flamingoPanel.state().curvePricing === null && window.flamingoPanel.state().curve.missing.length === 0', undefined, { timeout: 120000 });
    const points = await page.locator('#cost-curve svg .pt').count();
    assert(points >= 20, `the chart has ${points} points (two charts of at least ten)`);
    assert((await page.locator('#curve-price').count()) === 0, 'the chart still offers to price when nothing is missing');
    assert((await page.locator('#cost-curve svg .now').count()) === 1, 'the needed quantity is not marked on the chart');
    const chart = page.locator('#cost-curve svg');
    await chart.scrollIntoViewIfNeeded();
    const cb = (await chart.boundingBox())!;
    await chart.hover({ position: { x: cb.width * 0.6, y: cb.height * 0.3 } });
    await page.locator('#cost-curve .chart-note.chart-tip').waitFor({ timeout: 5000 });
    const tipText = await text('#cost-curve .chart-note');
    assert(/\d+ boards?: \$[\d.]+ each, \$[\d.]+ in all/.test(tipText), `the chart tooltip reads "${tipText}"`);
    console.log(`  ${midway.replace(/\s+/g, ' ')} while it ran; ${points / 2} quantities priced; hover: ${tipText.replace(/\s+/g, ' ')}`);
    // A quantity entered in step 1 goes on the curve once priced (on request again), stays there, and is kept in the panel file.
    await needed.fill('7');
    await needed.press('Enter');
    await until("v.panel.sources.find((s) => s.key === 'M').needed === 7", 'needed 7 for M');
    await page.locator('#curve-price').waitFor({ timeout: 10000 });
    assert((await page.locator('#cost-curve svg .pt.entered[data-q="7"]').count()) === 0, 'the new quantity was priced without being asked');
    assert((await text('#curve-price')).includes('1 more'), `the button reads "${await text('#curve-price')}"`);
    await page.locator('#curve-price').click();
    await page.locator('#cost-curve svg .pt.entered[data-q="7"]').first().waitFor({ timeout: 60000 });
    await page.waitForFunction('window.flamingoPanel.state().curvePricing === null', undefined, { timeout: 60000 });
    assert((await page.locator('#cost-curve svg .pt.entered[data-q="7"]').count()) === 2, 'the entered quantity is not a filled point on both charts');
    // A click on a point makes it the quantity.
    const pick = page.locator('#cost-curve svg .pt[data-q="12"]').first();
    await pick.scrollIntoViewIfNeeded();
    await pick.click({ force: true });
    await until("v.panel.sources[0].needed === 12", 'needed 12 after clicking the point');
    assert((await needed.inputValue()) === '12', `the needed field shows ${await needed.inputValue()} after the click`);
    await needed.fill('5');
    await needed.press('Enter');
    await until("v.panel.sources.find((s) => s.key === 'M').needed === 5", 'needed 5 for M');
    await page.waitForFunction("window.flamingoPanel.state().curve && window.flamingoPanel.state().curve.missing.length === 0 && window.flamingoPanel.state().curve.points.some((p) => p.quantity === 7)", undefined, { timeout: 60000 });
    assert((await page.locator('#curve-price').count()) === 0, 'a quantity priced before is offered for pricing again');
    assert((await page.locator('#cost-curve svg .pt.entered[data-q="7"]').count()) === 2, 'the entered quantity left the curve when the need moved on');
    await page.waitForTimeout(1200); // the debounced save
    const onDisk = JSON.parse(await readFile(join(projectDir, 'combo.flamboyance'), 'utf8')) as { curve?: { entered: number[]; points: Array<{ quantity: number }> } };
    assert(onDisk.curve !== undefined && onDisk.curve.entered.includes(7), 'the entered quantity is not in the panel file');
    assert(onDisk.curve.points.some((pt) => pt.quantity === 7), 'the priced point is not in the panel file');
    console.log(`  7 entered and priced on request: a filled point on the curve, kept in the file with ${onDisk.curve.points.length} priced points; clicking 12 set the quantity to 12`);
    await page.locator('#cost-curve').screenshot({ path: join(SHOTS_DIR, '17b-cost-curve-chart.png') });
    shots.push(['17b-cost-curve-chart.png', 'The cost-by-quantity chart alone: the cheapest way to order each number of boards, the needed quantity a dashed rule, entered quantities filled.']);
    await shot('17-cost-curve', 'Cost by quantity for a panel of one design, priced on request: per-board and total cost of the cheapest way at each quantity. Filled points are quantities that were entered; they stay on the curve and are kept in the panel file. Clicking a point orders that many.');
    // Back to the panel of the brief: the four ops of this step undone (remove S, 7, 12, 5).
    for (let i = 0; i < 4; i++) await post('/api/panel/undo');
    await until("v.panel.sources.length === 2 && v.panel.sources.find((s) => s.key === 'M').needed === 5", 'both boards back, M needed 5');
    assert(await page.locator('#cost-curve').isHidden(), 'the chart stayed once the second design was back');

    step('picking a way to order puts its panel on the plate, with its cost');
    await page.waitForFunction("document.querySelectorAll('#option-list [data-option]').length >= 5");
    await page.waitForFunction("[...document.querySelectorAll('#option-list .got[data-board=\"M\"]')].every((e) => e.getAttribute('data-need') === '5')");
    await page.waitForFunction("window.flamingoPanel.state().quote.scenarios.every((s) => s.received.find((r) => r.key === 'M').needed === 5)");
    const totals = (await page.locator('#option-list .scenario .sc-total').allInnerTexts()).map((t) => Number(/\$([\d.]+)/.exec(t)![1]));
    assert(totals.every((t, i) => i === 0 || t >= totals[i - 1]!), `the scenarios are not ranked by total: ${totals.join(', ')}`);
    const first = page.locator('#option-list .scenario:not([data-option="own"])').first();
    // Boards received against needed, per design, one mark per board.
    const got = await first.locator('.sc-got .got').evaluateAll((els) => els.map((e) => [e.getAttribute('data-board'), e.getAttribute('data-got'), e.getAttribute('data-need'), e.querySelectorAll('.pip-met').length, e.querySelectorAll('.pip-over').length]));
    assert(got.length === 2 && got[0]![0] === 'S' && got[0]![2] === '1' && got[1]![0] === 'M' && got[1]![2] === '5', `a scenario row shows boards received as ${JSON.stringify(got)}`);
    for (const [key, g, need, met, over] of got) {
      assert(Number(met) === Number(need) && Number(over) === Number(g) - Number(need), `${key}: ${g} of ${need} drawn as ${met} + ${over} marks`);
    }
    assert(/^\d+ notes?$/.test((await first.locator('.sc-warn').innerText()).trim()), 'a scenario row does not count its notes');
    assert((await first.locator('.sc-total .est').innerText()).trim() === 'est.', 'a scenario row shows no estimate mark');
    assert((await first.locator('.sc-panel .chip').count()) >= 2, 'a scenario row does not show what is on the panel');
    // Every fact on the row says what it is.
    const labels = (await first.locator('.sc-facts dt').allInnerTexts()).map((t) => t.trim());
    assert(JSON.stringify(labels) === JSON.stringify(['panel', 'order', 'you get']), `a scenario row is labelled ${JSON.stringify(labels)}`);
    assert(/^5 panels min\s*:\s*\d+ assembled \+ \d+ bare$/.test((await first.locator('.sc-qty').innerText()).replace(/\s+/g, ' ').trim()), `the order reads "${(await first.locator('.sc-qty').innerText()).trim()}"`);
    const numbers = await first.locator('.sc-got .got').evaluateAll((els) => els.map((e) => [e.querySelector('.got-n')!.textContent, e.getAttribute('data-got')]));
    assert(numbers.every(([shown, g]) => shown === g), `boards received are numbered ${JSON.stringify(numbers)}`);
    const legend = (await text('#option-list .sc-legend')).replace(/\s+/g, ' ');
    for (const part of ['assembled, needed', 'assembled, extra', 'bare = delivered without parts', 'min = the smallest order JLCPCB takes']) {
      assert(legend.includes(part), `the legend does not say "${part}": ${legend}`);
    }
    // What is delivered adds up to what is ordered: every board of every panel made
    // is either assembled or bare, and the row says how many of each.
    {
      const sums = await state<Array<{ id: string; key: string; made: number; assembled: number; bare: number }>>(
        `s.quote.scenarios.flatMap((x) => x.received.map((r) => ({ id: x.id, key: r.key, assembled: r.assembled, bare: r.bare,
          made: x.orders.reduce((n, o) => n + o.priced.order.pcbQty * ((o.counts.find((c) => c.key === r.key) || { total: 0 }).total), 0) })))`,
      );
      for (const x of sums) assert(x.assembled + x.bare === x.made, `${x.id}: ${x.made} ${x.key} are made, ${x.assembled} + ${x.bare} delivered`);
      const shown = await page.locator('#option-list .scenario:not([data-option="own"]) .sc-got .got').evaluateAll((els) =>
        els.map((e) => ({ id: e.closest('.scenario')!.getAttribute('data-option'), key: e.getAttribute('data-board'), bare: Number(e.querySelector('.got-bare')?.getAttribute('data-bare') ?? 0), text: (e.querySelector('.got-bare')?.textContent ?? '').trim() })),
      );
      for (const x of shown) {
        const want = sums.find((y) => y.id === x.id && y.key === x.key)!;
        assert(x.bare === want.bare && (want.bare === 0 || x.text === `+ ${want.bare} bare`), `${x.id}: ${want.bare} bare ${x.key} are delivered, the row says "${x.text}"`);
      }
    }
    await tidy('the ways to order');
    assert((await first.locator('svg.sc-icon').count()) === 1, 'a scenario row has no drawing of its kind');
    // No fact runs over onto a second line.
    const tall = await page.locator('#option-list .sc-facts dd.sc-qty').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetHeight > 24).length);
    assert(tall === 0, `${tall} order line(s) wrap`);
    const separate = page.locator('#option-list [data-scenario="separate"]');
    const sepLabels = (await separate.locator('.sc-facts dt').allInnerTexts()).map((t) => t.trim());
    assert(JSON.stringify(sepLabels) === JSON.stringify(['order', 'order', 'you get']), `separate orders are labelled ${JSON.stringify(sepLabels)}`);
    // Cost as a length: the dearest scenario fills the bar, the cheapest is shortest.
    const meters = await page.locator('#option-list .scenario .sc-foot .meter i').evaluateAll((els) => els.map((e) => parseFloat((e as HTMLElement).style.width)));
    assert(meters[meters.length - 1] === 100 && meters[0]! < 100, `the cost bars are ${meters.join(', ')}`);
    // A row is a few words, not a paragraph.
    const words = (await first.innerText()).split(/\s+/).filter((w) => /[a-z]{3,}/i.test(w)).length;
    assert(words <= 20, `a scenario row has ${words} words`);

    // Each row says what picking it does.
    assert(((await separate.getAttribute('title')) ?? '').includes('Shows these orders on the plate'), 'a way that is not a panel does not say it is only shown');
    assert(((await first.getAttribute('title')) ?? '').includes('Puts this panel on the plate'), 'a way that is a panel does not say it goes on the plate');

    const target = 'merged-needed-x2';
    const want = await state<{ n: number; total: number; w: number; h: number }>(
      `(() => { const q = s.quote.scenarios.find((x) => x.id === '${target}'); return { n: q.layout.instances.length, total: q.total, w: q.layout.width, h: q.layout.height }; })()`,
    );
    await page.locator(`#option-list [data-scenario="${target}"]`).click();
    await until(`v.panel.instances.length === ${want.n}`, `${want.n} instances from the scenario`);
    await page.locator(`#option-list [data-option="${target}"] .where-plate`).waitFor();
    // The panel on the plate is now one of the computed ways, so it is not listed twice.
    assert((await page.locator('#option-list [data-option="own"]').count()) === 0, '"Your panel" is listed although the plate holds a computed way');
    assert((await page.locator('#option-list .where-plate').count()) === 1, 'more than one way is marked as on the plate');
    assert((await plateTitle()) === 'On the plate: Mouse-bite panel', `step 3 is headed "${await plateTitle()}"`);
    assert((await text('#arrange-msg')).startsWith('Put on the plate:'), `the message reads "${await text('#arrange-msg')}"`);
    const lines = await page.locator('#cost-summary table.lines tr').count();
    assert(lines >= 8, `the way on the plate has ${lines} fee lines`);
    const detail = async (): Promise<string> => (await page.locator('#cost-summary').evaluate((e) => e.textContent)) ?? '';
    assert((await detail()).includes('Different designs: 2 in one file'), 'the different-designs fee is not itemized');
    assert((await text('#cost-summary .cost-total .amount')) === `$${want.total.toFixed(2)}`, 'the cost in step 3 does not total to the way picked');
    if (!(await page.locator('#cost-summary .cost-group[open] summary', { hasText: 'Boards' }).count())) {
      await page.locator('#cost-summary .cost-group summary', { hasText: 'Boards' }).click();
    }
    assert(await page.locator('#cost-summary td', { hasText: 'Different designs: 2 in one file' }).isVisible(), 'unfolding Boards does not show the fee');
    const loaded = await state<{ w: number; h: number; sep: string }>('({ w: s.view.geometry.frame.width, h: s.view.geometry.frame.height, sep: s.view.panel.settings.separation })');
    assert(Math.abs(loaded.w - want.w) < 0.01 && Math.abs(loaded.h - want.h) < 0.01, `the plate is ${loaded.w} x ${loaded.h}, the scenario ${want.w} x ${want.h}`);
    await page.waitForFunction(`document.getElementById('cost-total').textContent === '$${want.total.toFixed(2)}'`);
    assert(await page.locator(`#option-list [data-option="${target}"].selected`).isVisible(), 'the way on the plate is not marked');
    assert((await errorCodes()).length === 0, `the loaded scenario has errors: ${(await errorCodes()).join(', ')}`);
    await shot('09-scenario-loaded', '"Mouse-bite panel" picked in step 2: its row reads "on the plate", its 1 + 3 panel is on the plate, and step 3 has its cost with Boards unfolded.');

    await page.locator('#option-list [data-scenario^="silk-divider"]').first().click();
    await until("v.panel.settings.separation === 'silk-divider'", 'a silk-divider panel on the plate');
    assert((await state<number>('s.view.geometry.tabs.length')) === 0, 'a silk-divider panel has tabs');
    await page.locator('#option-list [data-scenario^="silk-divider"] .where-plate').first().waitFor();
    await page.waitForFunction("document.getElementById('plate-title').textContent.startsWith('On the plate: ') && !document.getElementById('cost-summary').textContent.includes('Different designs')");
    assert((await page.locator('#option-list .where-plate').count()) === 1 && (await page.locator('#option-list [data-option="own"]').count()) === 0, 'the silk-divider panel is not the one way on the plate');
    assert(!(await detail()).includes('Different designs'), 'a silk-divided board is charged for different designs');
    await shot('10-scenario-silk-divider', 'The cheapest way: boards inside one outline, divided by silkscreen lines (dotted), no rails, no tabs.');

    // --- a scenario that is not a panel ------------------------------------
    step('separate orders are shown on the plate, not loaded');
    const panelBefore = JSON.stringify((await getView()).panel);
    const transformBefore = JSON.stringify(await state('s.transform'));
    await page.locator('#option-list [data-scenario="separate"]').click();
    await page.locator('#plate-banner:not([hidden])').waitFor();
    assert((await state<string | null>('s.preview')) === 'separate', 'the scenario is not on show');
    const bannerTitle = await text('#banner-title');
    assert(/^Option \d, Separate orders: 2 orders of single boards, no panel$/.test(bannerTitle), `the banner reads "${bannerTitle}"`);
    assert((await text('#banner-note')).includes('Your panel is unchanged'), 'the banner does not say the panel is unchanged');
    assert(JSON.stringify((await getView()).panel) === panelBefore, 'showing a scenario changed the panel');
    assert(JSON.stringify(await state('s.transform')) !== transformBefore, 'the plate did not move to show the orders');
    assert((await text('#plate-meaning')).includes('ordered on its own'), 'the way shown is not explained');
    assert((await plateTitle()) === 'Shown: Separate orders', `step 3 is headed "${await plateTitle()}"`);
    // Both are marked: the one shown, and the one that is still the panel.
    assert((await separate.locator('.where-shown').innerText()).trim() === 'shown', 'the way shown is not marked');
    assert((await page.locator('#option-list .where-plate').count()) === 1, 'the panel on the plate lost its mark while another way is shown');
    assert((await page.locator('#option-list .scenario.selected').count()) === 1 && (await separate.getAttribute('class'))!.includes('selected'), 'the way in view is not the one framed');
    // Step 3 is about what is shown: its cost and its export, and nothing to change or check.
    const sepTotal = await state<number>("s.quote.scenarios.find((x) => x.id === 'separate').total");
    assert((await text('#cost-total')) === `$${sepTotal.toFixed(2)}`, 'step 3 does not show the cost of what is shown');
    assert(!(await page.locator('#plate-edit').isVisible()) && !(await page.locator('#checks').isVisible()), 'what is only shown has tools or checks');
    assert(!(await page.locator('#export-btn').isDisabled()), 'separate orders cannot be exported');
    await tidy('with separate orders shown');
    {
      await page.locator('#export-btn').click();
      await page.locator('#export-link').waitFor();
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-link').click()]);
      assert(download.suggestedFilename() === 'combo-separate-fab.zip', `the download is called ${download.suggestedFilename()}`);
      const zipPath = join(projectDir, 'separate.zip');
      await download.saveAs(zipPath);
      const names = new AdmZip(zipPath).getEntries().map((e) => e.entryName);
      const folders = [...new Set(names.filter((n) => n.includes('/')).map((n) => n.split('/')[0]))];
      assert(folders.length === 2 && folders.every((f) => names.includes(`${f}/gerbers.zip`) && names.includes(`${f}/bom.csv`)), `the zip holds ${names.join(', ')}`);
      assert(JSON.stringify((await getView()).panel) === panelBefore, 'exporting separate orders changed the panel');
      console.log(`  ${download.suggestedFilename()}: ${folders.join(', ')}`);
    }
    // The plate shows two plates, one per order, each in its board's colour.
    const shotSeparate = await shot('10b-scenario-separate', 'Separate orders selected: the plate shows the two orders side by side, each a stack of single boards with its quantity, under a banner saying the panel is unchanged.');
    {
      const spots = (await page.evaluate(`(() => {
        const s = window.flamingoPanel.state();
        const sc = s.quote.scenarios.find((x) => x.id === 'separate');
        const r = document.getElementById('plate-canvas').getBoundingClientRect();
        let x = 0;
        return sc.orders.map((o) => {
          const f = o.plate.frame.outer;
          const c = window.flamingoPanel.toPlate({ x: x + (f.maxX - f.minX) * 0.8, y: (f.maxY - f.minY) * 0.2 });
          x += (f.maxX - f.minX) + 18;
          return { key: o.designs[0], x: r.left + c.x, y: r.top + c.y };
        });
      })()`)) as Array<{ key: string; x: number; y: number }>;
      const img = new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWPORT.width}" height="${VIEWPORT.height}"><image width="${VIEWPORT.width}" height="${VIEWPORT.height}" href="data:image/png;base64,${shotSeparate.toString('base64')}"/></svg>`,
      ).render();
      const boardKeys = await state<string[]>('s.view.panel.sources.map((x) => x.key)');
      assert(spots.length === 2, `expected two plates, got ${spots.length}`);
      for (const spot of spots) {
        const i = (Math.round(spot.y) * img.width + Math.round(spot.x)) * 4;
        const got = [img.pixels[i]!, img.pixels[i + 1]!, img.pixels[i + 2]!];
        const hex = tint(boardColorAt(boardKeys.indexOf(spot.key)));
        const want = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
        assert(got.every((v, k) => Math.abs(v - want[k]!) <= 3), `the plate of ${spot.key} is rgb(${got.join(',')}) where its board colour rgb(${want.join(',')}) was expected`);
      }
    }
    // Nothing on show can be edited.
    await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2, { button: 'right' });
    assert(!(await page.locator('#context-menu').isVisible()), 'a scenario on show has an object menu');
    await page.keyboard.press('Delete');
    await page.keyboard.press('a');
    await page.waitForTimeout(150);
    assert(JSON.stringify((await getView()).panel) === panelBefore, 'a key changed the panel while a scenario was on show');
    // Escape, or the button, brings the panel back.
    await page.keyboard.press('Escape');
    await page.locator('#plate-banner').waitFor({ state: 'hidden' });
    assert((await state<string | null>('s.preview')) === null, 'Escape did not bring the panel back');
    assert((await plateTitle()).startsWith('On the plate: ') && (await page.locator('#plate-edit').isVisible()), 'step 3 did not return to the panel');
    assert(JSON.stringify(await state('s.transform')) === transformBefore, 'the plate did not return to the panel');
    await page.locator('#option-list [data-scenario="separate"]').click();
    await page.locator('#plate-banner:not([hidden])').waitFor();
    await page.locator('#banner-back').click();
    await page.locator('#plate-banner').waitFor({ state: 'hidden' });
    assert((await state<string | null>('s.preview')) === null, 'the button did not bring the panel back');
    // So does picking the way that is on the plate.
    await page.locator('#option-list [data-scenario="separate"]').click();
    await page.locator('#plate-banner:not([hidden])').waitFor();
    await page.locator('#option-list .scenario:has(.where-plate)').click();
    await page.locator('#plate-banner').waitFor({ state: 'hidden' });
    assert(JSON.stringify((await getView()).panel) === panelBefore, 'picking the way that is on the plate changed the panel');
    // An edit to the panel from elsewhere ends the show too.
    await page.locator('#option-list [data-scenario="separate"]').click();
    await page.locator('#plate-banner:not([hidden])').waitFor();
    await post('/api/panel/op', { op: 'setPopulate', id: 'M1', populate: false });
    await page.locator('#plate-banner').waitFor({ state: 'hidden' });
    assert((await state<string>('s.view.panel.settings.separation')) === 'silk-divider', 'the panel is not the one that was there');
    await post('/api/panel/undo');

    await page.locator(`#option-list [data-scenario="${target}"]`).click();
    await until(`v.panel.settings.separation === 'mouse-bite' && v.panel.instances.length === ${want.n}`, 'the mouse-bite scenario back on the plate');

    // --- sync --------------------------------------------------------------
    step('an edit made outside the browser shows up without a reload');
    const r = await post('/api/panel/op', { op: 'setPopulate', id: 'M2', populate: false });
    assert(r.ok === true, `the outside edit was rejected: ${JSON.stringify(r)}`);
    await until("v.panel.instances.find((i) => i.id === 'M2').populate === false", 'M2 bare in the page');
    await page.waitForFunction("(document.querySelector('#plate-counts .count-control[data-key=\"M\"] .bare-n') || {}).textContent === '1 bare'");
    // The panel is no longer the computed way it was: it is listed as your own.
    await page.locator('#option-list [data-option="own"] .where-plate').waitFor();
    assert((await plateTitle()) === 'On the plate: Your panel', 'an edited panel is not called your panel');
    await post('/api/panel/undo');
    await until("v.panel.instances.find((i) => i.id === 'M2').populate === true", 'M2 populated again');
    await page.locator(`#option-list [data-option="${target}"] .where-plate`).waitFor();
    assert((await page.locator('#option-list [data-option="own"]').count()) === 0, 'undoing the edit did not make the panel the computed way again');

    // --- export ------------------------------------------------------------
    step('Export downloads the zip');
    // The download starts on its own once the zip is built; the link fetches it again.
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-btn').click()]);
    await page.locator('#export-link').waitFor();
    assert((await text('#export-msg')).startsWith('Exported:'), `the export message reads "${await text('#export-msg')}"`);
    assert(download.suggestedFilename() === 'combo-panel-fab.zip', `the download is called ${download.suggestedFilename()}`);
    const [again] = await Promise.all([page.waitForEvent('download'), page.locator('#export-link').click()]);
    assert(again.suggestedFilename() === 'combo-panel-fab.zip', 'the link does not download the zip again');
    const zipPath = join(projectDir, 'download.zip');
    await download.saveAs(zipPath);
    const names = new AdmZip(zipPath).getEntries().map((e) => e.entryName).sort();
    for (const n of ['combo.GTL', 'combo.GBL', 'combo.GKO', 'combo-PTH.DRL', 'combo-NPTH.DRL', 'bom.csv', 'cpl.csv', 'panel.render.svg', 'panel.fab.svg']) {
      assert(names.includes(n), `the zip has no ${n}`);
    }
    const bom = new AdmZip(zipPath).getEntry('bom.csv')!.getData().toString('utf8');
    assert(bom.includes('S1_U1') && bom.includes('M3_J1'), 'the BOM in the zip is not the merged one');
    console.log(`  ${download.suggestedFilename()}: ${names.length} files`);
    await shot('11-exported', 'Export fab files: the zip downloaded on its own, and the link fetches it again.');

    step('Export refuses a panel with errors, and says why');
    const s1 = (await instances()).find((i) => i.id === 'S1')!;
    await post('/api/panel/op', { op: 'moveInstance', id: 'M1', at: { x: s1.x + 2, y: s1.y + 2 }, pin: true });
    await until("v.issues.some((i) => i.code === 'overlap')", 'an overlap');
    await page.locator('#export-btn').click();
    await page.locator('#export-msg.msg-problem').waitFor();
    const refused = await text('#export-msg');
    assert(refused.startsWith('Not exported:') && refused.includes('overlap'), `the refusal reads "${refused}"`);
    assert((await page.locator('#export-link').count()) === 0, 'a download is offered for a panel with errors');
    await shot('12-export-refused', 'Export on a panel with an overlap: refused, with the findings that stopped it.');
    await post('/api/panel/undo');
    await until("!v.issues.some((i) => i.code === 'overlap')", 'the overlap undone');

    // --- does not fit ------------------------------------------------------
    step('arrange explains a panel that cannot fit');
    await post('/api/panel/count', { board: 'S', count: 44 });
    await until("v.panel.instances.filter((i) => i.source === 'S').length === 44", '44 S instances');
    const layoutBefore = JSON.stringify(await instances());
    await page.locator('#arrange-btn').click();
    await page.locator('#arrange-msg.msg-problem').waitFor();
    const noFit = await text('#arrange-msg');
    console.log(`  ${noFit.replace(/\n/g, ' | ')}`);
    assert(noFit.startsWith('Does not fit.'), `the message reads "${noFit}"`);
    assert(/instances do not fit within 250 x 250 mm \(the assembly panel limit\)/.test(noFit), 'the reason from the layout engine is missing');
    assert(/smallest panel that holds them is [\d.]+ x [\d.]+ mm/.test(noFit), 'the smallest panel that would fit is missing');
    assert(JSON.stringify(await instances()) === layoutBefore, 'a failed arrange moved something');
    await shot('13-does-not-fit', '44 + 3 instances: Arrange leaves the plate as it is and says why, with the smallest panel that would hold them.');
    await post('/api/panel/undo');
    await until("v.panel.instances.filter((i) => i.source === 'S').length === 1", 'back to one S');

    // --- stale -------------------------------------------------------------
    step('a source board edited on disk is marked stale');
    const boardPath = join(projectDir, 'usbc-breakout.flamingo');
    const edited = JSON.parse(await (await import('node:fs/promises')).readFile(boardPath, 'utf8')) as { silk: unknown[] };
    edited.silk.push({ id: 'note', layer: 'F.Silk', at: { x: 12, y: 8 }, text: 'rev b', height: 1, rotation: 0 });
    await writeFile(boardPath, JSON.stringify(edited, null, 2));
    started.panel!.touch();
    await until("v.sources.find((s) => s.key === 'M').stale === true", 'M stale in the page');
    assert((await text('#board-list .board[data-key="M"] .tag')).startsWith('stale'), 'the board list does not tag M as stale');
    assert((await text('#issue-list .issue[data-code="source-stale"] .issue-title')) === 'Board changed on disk', 'the stale board is not listed under Checks');
    await page.keyboard.press('a');
    await until("v.issues.filter((i) => i.severity === 'error').length === 0", 'a clean panel');
    await shot('14-stale-source', 'usbc-breakout edited on disk: tagged stale in the board list, its instances dotted and labelled STALE, and listed under Checks.');

    // --- colour ------------------------------------------------------------
    step('colour means which board, and nothing else');
    const hue = (r: number, g: number, b: number): number => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    const boardHues = BOARD_COLORS.map((c) => hue(...rgb(c)));
    const nearBoardHue = (r: number, g: number, b: number): boolean =>
      boardHues.some((h) => Math.min(Math.abs(h - hue(r, g, b)), 360 - Math.abs(h - hue(r, g, b))) <= 10);

    const png = await page.screenshot();
    const img = new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWPORT.width}" height="${VIEWPORT.height}"><image width="${VIEWPORT.width}" height="${VIEWPORT.height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`,
    ).render();
    const px = img.pixels;
    const at = (x: number, y: number): [number, number, number] => {
      const i = (Math.round(y) * img.width + Math.round(x)) * 4;
      return [px[i]!, px[i + 1]!, px[i + 2]!];
    };

    // Every instance is filled with the tint of its board's colour.
    const keys = await state<string[]>('s.view.panel.sources.map((x) => x.key)');
    const placed = await state<Array<{ id: string; source: string; populate: boolean }>>(
      's.view.geometry.instances.map((i) => ({ id: i.id, source: i.source, populate: i.populate }))',
    );
    for (const inst of placed) {
      const want = rgb(tint(boardColorAt(keys.indexOf(inst.source))));
      const c = await centreOf(inst.id);
      const box = (await page.evaluate(
        `(() => { const s = window.flamingoPanel.state(); const i = s.view.geometry.instances.find((x) => x.id === ${JSON.stringify(inst.id)}); const a = window.flamingoPanel.toPlate({ x: i.bbox.minX, y: i.bbox.minY }); const b = window.flamingoPanel.toPlate({ x: i.bbox.maxX, y: i.bbox.maxY }); return { w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; })()`,
      )) as { w: number; h: number };
      // The commonest colour in a patch beside the label, clear of the outline.
      const seen = new Map<string, number>();
      for (let dy = -6; dy <= 6; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
          const k = at(c.x + box.w * 0.3 + dx, c.y + box.h * 0.3 + dy).join(',');
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
      }
      const [most] = [...seen.entries()].sort((p, q) => q[1] - p[1])[0]!;
      const got = most.split(',').map(Number);
      assert(
        got.every((v, i) => Math.abs(v - want[i]!) <= 3),
        `${inst.id} is filled rgb(${most}); its board ${inst.source} is rgb(${want.join(',')})`,
      );
    }
    assert(new Set(placed.map((i) => i.source)).size === 2, 'the check needs instances of two boards on the plate');

    // And no pixel anywhere has a colour that is not a board's.
    let coloured = 0;
    let stray = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i]!, px[i + 1]!, px[i + 2]!];
      if (Math.max(r, g, b) - Math.min(r, g, b) <= 6) continue;
      coloured++;
      if (!nearBoardHue(r, g, b)) stray++;
    }
    assert(coloured > 1000, `only ${coloured} coloured pixels: the boards are not colour-coded`);
    assert(
      stray <= coloured * 0.002,
      `${stray} of ${coloured} coloured pixels have a hue that is no board's. If they all sit on the edges of text, the browser is antialiasing for an LCD: see the header of this script.`,
    );

    // The same in the styles, whatever the rasterizer does with them.
    const styled = (await page.evaluate(`(() => {
      const out = [];
      const probe = document.createElement('canvas').getContext('2d');
      for (const e of document.querySelectorAll('*')) {
        const c = getComputedStyle(e);
        for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor']) {
          probe.fillStyle = '#000';
          probe.fillStyle = c[prop];
          probe.clearRect(0, 0, 1, 1);
          probe.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
          if (a === 0 || Math.max(r, g, b) - Math.min(r, g, b) <= 6) continue;
          out.push({ what: e.tagName + '.' + e.className + ' ' + prop, r, g, b });
        }
      }
      return out;
    })()`)) as Array<{ what: string; r: number; g: number; b: number }>;
    const off = styled.filter((x) => !nearBoardHue(x.r, x.g, x.b));
    assert(styled.length > 0, 'nothing in the sidebar carries a board colour');
    assert(off.length === 0, `elements styled with a colour that is no board's:\n${off.slice(0, 10).map((x) => `${x.what} rgb(${x.r},${x.g},${x.b})`).join('\n')}`);
    const motion = await page.evaluate(`(() => [...document.querySelectorAll('*')].filter((e) => { const c = getComputedStyle(e); return c.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || c.animationName !== 'none' || c.boxShadow !== 'none' || c.backgroundImage !== 'none'; }).length)()`);
    assert(motion === 0, `${motion} element(s) have a transition, animation, shadow or gradient`);
    console.log(`  ${placed.length} instances filled with their board's tint; ${coloured} coloured pixels, ${stray} stray; no transition, animation, shadow or gradient`);

    // --- fabricated view ---------------------------------------------------
    step('the Fabricated view draws the panel as the fab makes it, and is remembered');
    const pressed = (look: string): Promise<string | null> => page.locator(`#look-toggle button[data-look="${look}"]`).getAttribute('aria-pressed');
    assert((await pressed('layout')) === 'true', 'the panel view does not start in Layout');
    await page.locator('#look-toggle button[data-look="fab"]').click();
    assert((await pressed('fab')) === 'true' && (await pressed('layout')) === 'false', 'the toggle does not show Fabricated as chosen');
    await until("s.look === 'fab'", 'the fabricated look');
    await page.waitForTimeout(100);
    const fabPng = await shot('16-fabricated', 'Fabricated view: green laminate where material stays, the plate where it is routed away, mouse-bite and tooling holes drilled through.');
    const fabImg = new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWPORT.width}" height="${VIEWPORT.height}"><image width="${VIEWPORT.width}" height="${VIEWPORT.height}" href="data:image/png;base64,${fabPng.toString('base64')}"/></svg>`,
    ).render();
    const mask = rgb(FAB_COLORS.mask);
    // `pixels` copies the whole image on every read: take it once. Read in
    // the loop it allocated gigabytes a second and took the machine down.
    const fabPx = fabImg.pixels;
    let green = 0;
    for (let i = 0; i < fabPx.length; i += 4) {
      if (Math.abs(fabPx[i]! - mask[0]!) <= 3 && Math.abs(fabPx[i + 1]! - mask[1]!) <= 3 && Math.abs(fabPx[i + 2]! - mask[2]!) <= 3) green++;
    }
    assert(green > 20000, `only ${green} pixels of solder-mask green in the fabricated view`);
    // Selecting still works on the fabricated plate.
    const fc = await centreOf('S1');
    await page.mouse.click(fc.x, fc.y);
    assert((await state<string | null>('s.selection')) === 'S1', 'clicking a board in the fabricated view does not select it');
    await page.reload();
    await page.waitForFunction('window.flamingoPanel && window.flamingoPanel.state().view !== null');
    assert((await pressed('fab')) === 'true', 'the fabricated view is not remembered across a reload');
    await page.locator('#look-toggle button[data-look="layout"]').click();
    assert((await state<string>('s.look')) === 'layout', 'Layout does not switch back');
    console.log(`  ${green} mask-green pixels; selection works; the choice survives a reload`);

    assert(pageErrors.length === 0, `the page logged errors:\n${pageErrors.join('\n')}`);

    // --- the board editor --------------------------------------------------
    step('the board editor still loads beside it');
    const editor = await context.newPage();
    const editorErrors: string[] = [];
    editor.on('pageerror', (e) => editorErrors.push(e.message));
    await editor.goto(`${base}/`);
    await editor.locator('#board-canvas').waitFor();
    await editor.waitForFunction("document.getElementById('status-conn').textContent.trim().length > 0 && !document.getElementById('status-conn').textContent.includes('connecting')");
    assert((await editor.title()) === 'Flamingo', `the editor page is titled "${await editor.title()}"`);
    assert((await editor.locator('#tool-buttons button').count()) > 5, 'the editor has no tool buttons');
    assert(editorErrors.length === 0, `the editor logged errors:\n${editorErrors.join('\n')}`);
    // The link in the panel view leads here.
    assert((await page.locator('a.bar-link').getAttribute('href')) === '/', 'the panel view does not link to the editor');
    assert(await page.locator('a.bar-link').isVisible(), 'the link to the editor is hidden on a server that has one');
    await editor.close();

    // --- a panel file served on its own ------------------------------------
    step('a server started on a panel file has the view at the root');
    const alone = await startServer(null, 0, { projectDir, panel: true, partsApi: PARTS_API });
    try {
      const root = `http://127.0.0.1:${alone.port}`;
      const made = await fetch(`${root}/api/panel/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'alone' }) });
      assert(made.ok, 'a panel could not be started on the second server');
      const solo = await context.newPage();
      const soloErrors: string[] = [];
      solo.on('pageerror', (e) => soloErrors.push(e.message));
      await solo.goto(`${root}/`);
      await solo.waitForFunction('window.flamingoPanel && window.flamingoPanel.state().view !== null');
      await solo.waitForFunction("document.getElementById('status-conn').textContent === 'connected'");
      assert((await solo.title()) === 'Flamingo — Panel', `the page at the root is titled "${await solo.title()}"`);
      assert(((await solo.locator('#panel-file').textContent()) ?? '').endsWith('alone.flamboyance'), `the panel file reads "${await solo.locator('#panel-file').textContent()}"`);
      assert(!(await solo.locator('a.bar-link').isVisible()), 'there is a link to an editor this server does not have');
      await solo.locator('#board-add button.add-board', { hasText: 'esp32-breakout' }).click();
      await solo.waitForFunction('window.flamingoPanel.state().view.panel.sources.length === 1');
      await solo.locator('#option-list [data-option]').first().waitFor();
      await solo.goto(`${root}/panel`);
      assert(new URL(solo.url()).pathname === '/', `/panel leads to ${new URL(solo.url()).pathname}`);
      assert(soloErrors.length === 0, `the page logged errors:\n${soloErrors.join('\n')}`);
      const png = await solo.screenshot({ path: join(SHOTS_DIR, '15-served-on-its-own.png') });
      assert(png.length > 0, 'no screenshot');
      shots.push(['15-served-on-its-own.png', 'A panel file served on its own (`flamingo serve alone.flamboyance`): the same view, at the root of its own port, with no link to a board editor.']);
      console.log('  screenshot 15-served-on-its-own.png');
      await solo.close();
    } finally {
      await alone.close().catch(() => {});
    }

    await writeFile(
      join(SHOTS_DIR, 'README.md'),
      [
        '# Panel view screenshots',
        '',
        'Taken by `packages/server/scripts/verify-panel-ui.ts` in headless Chromium',
        `(${VIEWPORT.width} x ${VIEWPORT.height}), on the boards \`e2e-panel.ts\` builds.`,
        '',
        ...shots.map(([file, what]) => `- \`${file}\` — ${what}`),
        '',
      ].join('\n'),
    );

    console.log('\n' + '='.repeat(64));
    console.log('  FLAMINGO PANEL VIEW — PASS');
    console.log('='.repeat(64));
    console.log(`  ${stepNo} checks, ${shots.length} screenshots in ${SHOTS_DIR}`);
    console.log('='.repeat(64));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (started) await started.close().catch(() => {});
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error('\nPANEL VIEW CHECK FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
