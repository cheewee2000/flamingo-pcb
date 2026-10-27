/**
 * Text reports for panels: what the MCP tools and the CLI print. Plain text,
 * one fact per line, numbers an agent can read back without parsing prose.
 */

import type { ArrangeResult, CostBreakdown, PanelIssue, QuoteResult, Received, Scenario } from '@flamingo/panel';
import type { PanelView } from './session.js';

export function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** `~` marks an amount that rests on an unverified number. */
export function amount(n: number, estimate: boolean): string {
  return `${estimate ? '~' : ' '}${money(n)}`;
}

export function formatIssues(issues: PanelIssue[]): string {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos = issues.filter((i) => i.severity === 'info');
  if (errors.length === 0 && warnings.length === 0) {
    const tail = infos.length > 0 ? `\n${infos.map(line).join('\n')}` : '';
    return `Panel check clean: 0 errors, 0 warnings.${tail}`;
  }
  const head = `Panel check: ${errors.length} error(s), ${warnings.length} warning(s).`;
  return [head, ...issues.map(line)].join('\n');
}

function line(i: PanelIssue): string {
  const who = i.instances.length > 0 ? ` — instances: ${i.instances.join(', ')}` : '';
  return `[${i.severity}] [${i.code}] ${i.message}${who}`;
}

export function formatReceived(received: Received[]): string {
  return received
    .map((r) => {
      const bits = [`${r.assembled} assembled`];
      if (r.bare > 0) bits.push(`${r.bare} bare`);
      const over = r.shortfall > 0 ? `SHORT by ${r.shortfall}` : r.overage > 0 ? `${r.overage} over` : 'exact';
      return `  ${r.key} (${r.name}): ${bits.join(' + ')} (need ${r.needed}; ${over})`;
    })
    .join('\n');
}

export function formatCost(cost: CostBreakdown): string {
  const width = Math.max(...cost.lines.map((l) => l.label.length), 10);
  const rows = cost.lines.map((l) => `  ${l.label.padEnd(width)}  ${amount(l.amount, l.estimate).padStart(10)}${l.detail ? `   ${l.detail}` : ''}`);
  rows.push(`  ${'TOTAL'.padEnd(width)}  ${amount(cost.total, cost.estimate).padStart(10)}`);
  return rows.join('\n');
}

export const ESTIMATE_LEGEND =
  '~ marks an ESTIMATE: it rests on a number that was not verified on a JLCPCB help page. Shipping, tax and coupons are not included.';

export function formatView(view: PanelView): string {
  const { panel, geometry } = view;
  const lines: string[] = [];
  lines.push(`Panel "${panel.name}"${view.filePath ? ` — ${view.filePath}` : ' — not saved yet'}`);
  if (geometry.frame) {
    lines.push(
      `Size: ${fmt(geometry.frame.width)} x ${fmt(geometry.frame.height)} mm, ${view.layers ?? '?'}-layer${view.rules ? ` (${view.rules})` : ''}, ${panel.settings.separation}, spacing ${fmt(panel.settings.spacing)} mm`,
    );
  } else {
    lines.push(`Size: empty, ${panel.settings.separation}, spacing ${fmt(panel.settings.spacing)} mm`);
  }
  const r = panel.settings.rails;
  lines.push(`Rails (mm): top ${fmt(r.top)}, bottom ${fmt(r.bottom)}, left ${fmt(r.left)}, right ${fmt(r.right)}`);
  lines.push(
    `Tabs: ${geometry.tabs.length}, fiducials: ${new Set(geometry.fiducials.map((f) => `${f.at.x},${f.at.y}`)).size}, tooling holes: ${geometry.toolingHoles.length}`,
  );

  lines.push(`Boards (${view.sources.length}):`);
  if (view.sources.length === 0) lines.push('  (none)');
  for (const s of view.sources) {
    const size = s.geometry ? `${fmt(s.geometry.width)} x ${fmt(s.geometry.height)} mm, ${s.geometry.copperLayers}-layer, ${s.geometry.partLines} part line(s), ${s.geometry.extendedParts} extended` : s.error ?? 'unresolved';
    const flags = [s.stale ? 'STALE' : '', s.error ? 'MISSING' : ''].filter(Boolean).join(' ');
    lines.push(
      `  ${s.key} = ${s.path} "${s.name}" (${size}) — need ${s.needed}, on panel ${s.instances} (${s.populated} populated)${flags ? ` ${flags}` : ''}`,
    );
  }

  lines.push(`Instances (${panel.instances.length}):`);
  if (panel.instances.length === 0) lines.push('  (none)');
  for (const i of panel.instances) {
    const placed = geometry.instances.find((p) => p.id === i.id);
    const blocked = placed ? (['N', 'E', 'S', 'W'] as const).filter((side) => placed.edges[side].blocked) : [];
    const flags = [
      i.populate ? 'populated' : 'bare',
      i.pinned ? 'pinned' : '',
      blocked.length > 0 ? `blocked edges ${blocked.join(',')}` : '',
      placed ? '' : 'NOT PLACED',
    ].filter(Boolean);
    lines.push(`  ${i.id} at (${fmt(i.at.x)}, ${fmt(i.at.y)}) rot ${i.rotation} — ${flags.join(', ')}`);
  }

  const errors = view.issues.filter((i) => i.severity === 'error').length;
  const warnings = view.issues.filter((i) => i.severity === 'warning').length;
  lines.push(`Check: ${errors} error(s), ${warnings} warning(s) (panel_check lists them)`);
  if (view.quote.cost) {
    lines.push(`Estimated cost of this panel: ${amount(view.quote.cost.total, view.quote.cost.estimate)} (quote_order compares alternatives)`);
  } else if (view.quote.problems.length > 0) {
    lines.push(`Cost: not available — ${view.quote.problems[0]}`);
  }
  return lines.join('\n');
}

export function formatPanelQuote(view: PanelView): string {
  const q = view.quote;
  const lines: string[] = [];
  if (!q.order || !q.cost) {
    lines.push('This panel cannot be priced as it stands:');
    for (const p of q.problems) lines.push(`  - ${p}`);
    return lines.join('\n');
  }
  const asm = q.order.assembly;
  lines.push(
    `Order: ${q.order.pcbQty} panel(s)${asm ? `, ${asm.qty} assembled (${asm.type === 'economic' ? 'Economic' : 'Standard'} PCBA)` : ', bare'}`,
  );
  lines.push(formatCost(q.cost));
  lines.push('Boards received:');
  lines.push(formatReceived(q.received));
  for (const p of q.problems) lines.push(`PROBLEM: ${p}`);
  for (const n of q.notes) lines.push(`Note: ${n}`);
  return lines.join('\n');
}

function formatScenario(s: Scenario, rank: number, detail: boolean): string {
  const lines: string[] = [];
  lines.push(
    `${String(rank).padStart(2)}. ${amount(s.total, s.estimate).padStart(10)}  ${amount(s.costPerNeededBoard, s.estimate).padStart(9)}/board  [${s.id}] ${s.title}`,
  );
  lines.push(`      ${s.summary}`);
  lines.push(
    `      received: ${s.received
      .map((r) => `${r.key} ${r.assembled}${r.bare > 0 ? `+${r.bare} bare` : ''} of ${r.needed}${r.overage > 0 ? ` (+${r.overage})` : ''}`)
      .join(', ')}`,
  );
  if (detail) {
    let order = '';
    for (const l of s.lines) {
      if (l.order !== order) {
        order = l.order;
        lines.push(`      order: ${order}`);
      }
      lines.push(`        ${l.label.padEnd(44)} ${amount(l.amount, l.estimate).padStart(10)}`);
    }
    if (s.layout) {
      lines.push(
        `      panel: ${fmt(s.layout.width)} x ${fmt(s.layout.height)} mm, ${s.layout.instances.length} board(s) — panel_apply_scenario id="${s.id}" loads it`,
      );
    } else {
      lines.push('      panel: none (single boards)');
    }
  }
  for (const w of s.warnings) lines.push(`      ! ${w}`);
  return lines.join('\n');
}

export function formatQuote(result: QuoteResult, detail: boolean): string {
  const lines: string[] = [];
  const label = { total: 'total cost', 'per-board': 'cost per board', overage: 'least overage' }[result.objective];
  lines.push(`${result.scenarios.length} scenario(s), ranked by ${label}:`);
  result.scenarios.forEach((s, i) => lines.push(formatScenario(s, i + 1, detail)));
  if (result.rejected.length > 0) {
    lines.push('', 'Not possible:');
    for (const r of result.rejected) lines.push(`  [${r.id}] ${r.title} — ${r.reason}`);
  }
  lines.push('', ESTIMATE_LEGEND);
  return lines.join('\n');
}

export function formatArrange(result: ArrangeResult): string {
  if (result.ok) {
    const skipped = result.skipped.length > 0 ? ` Skipped (source unreadable): ${result.skipped.join(', ')}.` : '';
    if (result.placements.length === 0) return `Nothing to arrange: every instance is pinned.${skipped}`;
    return (
      `Arranged ${result.placements.length} instance(s) into ${fmt(result.width)} x ${fmt(result.height)} mm ` +
      `(limit ${fmt(result.limit.width)} x ${fmt(result.limit.height)} mm, ${result.limit.label}).${skipped}`
    );
  }
  const fit = result.smallestFit
    ? ` Smallest panel that would fit: ${fmt(result.smallestFit.width)} x ${fmt(result.smallestFit.height)} mm.`
    : '';
  return `Does not fit: ${result.reason}${fit} The panel was left unchanged.`;
}
