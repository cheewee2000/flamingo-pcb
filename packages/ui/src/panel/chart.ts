/**
 * Panel view - the cost-by-quantity chart.
 *
 * Two small charts on one quantity axis: cost per board above, total below.
 * They are different scales, so they never share a y axis. Lines are the
 * page's ink; a quantity the boards were set to is a filled point and the
 * current one is also a dashed rule; a click on a point makes it the
 * quantity; hovering puts
 * the numbers and the way that gives them in the caption under the chart,
 * where they cover nothing. Drawn as inline SVG so it needs nothing the page
 * does not already have.
 */

import type { CostCurve, CostPoint } from '@flamingo/panel';

const W = 320;
const PLOT_H = 96;
const GAP = 26;
const LEFT = 44;
const RIGHT = 30;
const TOP = 14;
const BOTTOM = 22;
const H = TOP + PLOT_H + GAP + PLOT_H + BOTTOM;

function money(n: number): string {
  return `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
}

/** Quantities are spread on a log scale: 1 to 10 matters as much as 10 to 100. */
function xOf(q: number, qMin: number, qMax: number): number {
  const lo = Math.log(qMin);
  const hi = Math.log(Math.max(qMax, qMin * 1.0001));
  return LEFT + ((Math.log(q) - lo) / (hi - lo)) * (W - LEFT - RIGHT);
}

/** A round top for the y axis: 1, 2, 5 steps. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

interface Series {
  label: string;
  value: (p: CostPoint) => number;
  top: number;
}

function plot(curve: CostCurve, s: Series, qMin: number, qMax: number, current: number | null): string {
  const entered = new Set(curve.entered);
  const max = niceMax(Math.max(...curve.points.map(s.value)));
  const y = (v: number): number => s.top + PLOT_H - (v / max) * PLOT_H;
  const pts = curve.points.map((p) => ({ x: xOf(p.quantity, qMin, qMax), y: y(s.value(p)), p }));
  const line = pts.map((d, i) => `${i === 0 ? 'M' : 'L'}${d.x.toFixed(1)} ${d.y.toFixed(1)}`).join(' ');
  const grid = [0.5, 1].map((f) => {
    const v = max * f;
    return (
      `<line class="grid" x1="${LEFT}" x2="${W - RIGHT}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>` +
      `<text class="tick" x="${LEFT - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${money(v)}</text>`
    );
  });
  const cheapest = pts.reduce((a, b) => (b.p.perBoard < a.p.perBoard ? b : a));
  const here = current !== null ? pts.find((d) => d.p.quantity === current) : undefined;
  const labelled = s.label === 'per board' ? (here ?? cheapest) : (here ?? pts[pts.length - 1]!);
  return (
    `<g class="plot" data-series="${s.label}">` +
    `<text class="title" x="${LEFT}" y="${s.top - 4}">${esc(s.label)}</text>` +
    grid.join('') +
    `<line class="axis" x1="${LEFT}" x2="${W - RIGHT}" y1="${(s.top + PLOT_H).toFixed(1)}" y2="${(s.top + PLOT_H).toFixed(1)}"/>` +
    `<path class="line" d="${line}"/>` +
    pts.map((d) => `<circle class="pt${entered.has(d.p.quantity) ? ' entered' : ''}" cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="3.5" data-q="${d.p.quantity}"/>`).join('') +
    `<text class="value" x="${Math.min(labelled.x, W - RIGHT - 8).toFixed(1)}" y="${(labelled.y - 7).toFixed(1)}" text-anchor="middle">${money(s.value(labelled.p))}</text>` +
    `</g>`
  );
}

/**
 * Build the chart into `el`, with hover. `current` is the needed quantity
 * the panel has now; `onPick` is called with a point's quantity when it is
 * clicked.
 */
export function renderCostChart(el: HTMLElement, curve: CostCurve, current: number | null, onPick?: (quantity: number) => void): void {
  if (curve.points.length < 2) {
    el.innerHTML = `<div class="hint">${curve.impossible[0] ? esc(curve.impossible[0].reason) : 'Not enough to chart.'}</div>`;
    return;
  }
  const qMin = curve.points[0]!.quantity;
  const qMax = curve.points[curve.points.length - 1]!.quantity;
  const ticks = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].filter((q) => q >= qMin && q <= qMax);
  const series: Series[] = [
    { label: 'per board', value: (p) => p.perBoard, top: TOP },
    { label: 'total', value: (p) => p.total, top: TOP + PLOT_H + GAP },
  ];
  const axisY = TOP + PLOT_H + GAP + PLOT_H;
  const currentRule =
    current !== null && current >= qMin && current <= qMax
      ? `<line class="now" x1="${xOf(current, qMin, qMax).toFixed(1)}" x2="${xOf(current, qMin, qMax).toFixed(1)}" y1="${TOP}" y2="${axisY}"/>`
      : '';
  const estimate = curve.points.some((p) => p.estimate);
  el.innerHTML =
    `<svg class="cost-chart${onPick ? ' pickable' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost per board and total cost against quantity${onPick ? '; click a point to order that many' : ''}">` +
    currentRule +
    series.map((s) => plot(curve, s, qMin, qMax, current)).join('') +
    ticks
      .map(
        (q) =>
          `<text class="tick" x="${xOf(q, qMin, qMax).toFixed(1)}" y="${axisY + 14}" text-anchor="middle">${q}</text>`,
      )
      .join('') +
    `<line class="cursor" x1="0" x2="0" y1="${TOP}" y2="${axisY}" hidden/>` +
    `</svg>` +
    `<div class="chart-note"></div>`;
  const note = el.querySelector<HTMLElement>('.chart-note')!;
  const caption =
    `${curve.designs.length > 1 ? `${curve.designs.length} designs, this many of each` : 'boards'}; the cheapest way at each quantity` +
    `${curve.entered.length > 0 ? '; filled: quantities you entered' : ''}${estimate ? '; ~ estimates' : ''}`;
  note.textContent = caption;

  const svg = el.querySelector<SVGSVGElement>('svg')!;
  const cursor = svg.querySelector<SVGLineElement>('.cursor')!;
  const nearest = (ev: MouseEvent): CostPoint | null => {
    const box = svg.getBoundingClientRect();
    const x = ((ev.clientX - box.left) / box.width) * W;
    let best: CostPoint | null = null;
    let bestD = Infinity;
    for (const p of curve.points) {
      const d = Math.abs(xOf(p.quantity, qMin, qMax) - x);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };
  const show = (ev: MouseEvent): void => {
    const best = nearest(ev);
    if (!best) return;
    const cx = xOf(best.quantity, qMin, qMax);
    cursor.setAttribute('x1', cx.toFixed(1));
    cursor.setAttribute('x2', cx.toFixed(1));
    cursor.removeAttribute('hidden');
    svg.querySelectorAll<SVGCircleElement>('.pt').forEach((c) => c.classList.toggle('hot', Number(c.dataset.q) === best!.quantity));
    note.classList.add('chart-tip');
    note.innerHTML =
      `<b>${best.quantity}</b> board${best.quantity === 1 ? '' : 's'}${curve.designs.length > 1 ? ' of each' : ''}: ` +
      `<b>${money(best.perBoard)}</b> each, <b>${money(best.total)}</b> in all — ${esc(best.way.title)}`;
  };
  const hide = (): void => {
    cursor.setAttribute('hidden', '');
    note.classList.remove('chart-tip');
    note.textContent = caption;
    svg.querySelectorAll<SVGCircleElement>('.pt').forEach((c) => c.classList.remove('hot'));
  };
  svg.addEventListener('mousemove', show);
  svg.addEventListener('mouseleave', hide);
  if (onPick) {
    svg.addEventListener('click', (ev) => {
      const best = nearest(ev);
      if (best && best.quantity !== current) onPick(best.quantity);
    });
  }
}
