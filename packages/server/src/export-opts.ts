/**
 * Options shared by the mechanical exports (STEP, DXF, SVG): which board
 * elements to emit, which component side, DXF layering and units. Parsed
 * from the `/api/export.{step|dxf|svg}` query string; the UI's export modal
 * builds the same query.
 */

export const EXPORT_ELEMENTS = ['board', 'comps', 'vias', 'pth', 'mnt'] as const;
export type ExportElement = (typeof EXPORT_ELEMENTS)[number];
export type ExportInclude = Record<ExportElement, boolean>;
export type ExportSide = 'top' | 'bottom' | 'both';
export type ExportUnits = 'mm' | 'in';
export type DxfLayers = 'single' | 'layered';
export type ExportFormat = 'step' | 'dxf' | 'svg';

export const INCLUDE_ALL: ExportInclude = { board: true, comps: true, vias: true, pth: true, mnt: true };

export interface ExportQuery {
  detail: boolean;
  include: ExportInclude;
  side: ExportSide;
  layers: DxfLayers;
  units: ExportUnits;
}

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T, name: string): T {
  if (raw === null || raw === '') return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
}

/**
 * Parse export options. A missing `include` means everything; an empty one
 * is an error (there is nothing to export). Unknown values throw, so the
 * caller can answer 400 with the message.
 */
export function parseExportQuery(params: URLSearchParams): ExportQuery {
  let include = { ...INCLUDE_ALL };
  const raw = params.get('include');
  if (raw !== null) {
    const keys = raw.split(',').map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) throw new Error('Select at least one element to export');
    for (const k of keys) {
      if (!(EXPORT_ELEMENTS as readonly string[]).includes(k)) {
        throw new Error(`include: unknown element "${k}" (expected ${EXPORT_ELEMENTS.join(', ')})`);
      }
    }
    include = Object.fromEntries(EXPORT_ELEMENTS.map((k) => [k, keys.includes(k)])) as ExportInclude;
  }
  return {
    // `mode=detail` is the original spelling of `detail=hd`.
    detail: params.get('detail') === 'hd' || params.get('mode') === 'detail',
    include,
    side: pick(params.get('side'), ['top', 'bottom', 'both'] as const, 'both', 'side'),
    layers: pick(params.get('layers'), ['single', 'layered'] as const, 'layered', 'layers'),
    units: pick(params.get('units'), ['mm', 'in'] as const, 'mm', 'units'),
  };
}

/**
 * Download name: `{board}{suffix}.{ext}`. STEP HD gets `-hd`; the 2D
 * drawings say whether they hold the outline, the component outlines or
 * both. Mirrored by the UI's export modal so its status line matches.
 */
export function exportFileName(boardName: string, format: ExportFormat, q: Pick<ExportQuery, 'detail' | 'include'>): string {
  const base = boardName.replace(/[^\w.-]+/g, '_') || 'board';
  let suffix = '';
  if (format === 'step') suffix = q.detail ? '-hd' : '';
  else if (q.include.comps && !q.include.board) suffix = '-components';
  else if (q.include.comps) suffix = '-outline+components';
  else suffix = '-outline';
  return `${base}${suffix}.${format}`;
}
