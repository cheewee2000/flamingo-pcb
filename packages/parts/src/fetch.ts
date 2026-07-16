/**
 * fetchPart: cache-first retrieval + parse of an EasyEDA/LCSC component.
 */

import type { Footprint } from '@flamingo/engine';
import { parseEasyedaFootprint, deriveInfo, type PartInfo } from './easyeda-parse.js';
import { readCache, writeCache } from './cache.js';

const API_VERSION = '6.4.19.5';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Flamingo/0.1 (+https://cwandt.com)';
const TIMEOUT_MS = 15_000;

function componentsUrl(lcsc: string): string {
  return `https://easyeda.com/api/products/${encodeURIComponent(lcsc)}/components?version=${API_VERSION}`;
}

async function fetchRaw(lcsc: string): Promise<unknown> {
  const res = await fetch(componentsUrl(lcsc), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`fetchPart(${lcsc}): HTTP ${res.status}`);
  const json = (await res.json()) as { success?: boolean; message?: string };
  if (!json.success) {
    throw new Error(`fetchPart(${lcsc}): ${json.message ?? 'component not found'}`);
  }
  return json;
}

/**
 * Fetch a component by LCSC id. Reads `~/.flamingo/parts/<LCSC>.json` first;
 * on a miss, calls the EasyEDA API and caches the RAW response before parsing.
 */
export async function fetchPart(
  lcsc: string,
): Promise<{ footprint: Footprint; info: PartInfo }> {
  let raw = await readCache(lcsc);
  if (raw === null) {
    raw = await fetchRaw(lcsc);
    await writeCache(lcsc, raw);
  }
  const { footprint, info } = parseEasyedaFootprint(raw);
  return { footprint, info: completeInfo(info, lcsc, raw) };
}

/** Fill required PartInfo fields, defaulting anything the source omitted. */
function completeInfo(
  partial: Partial<PartInfo>,
  lcsc: string,
  raw: unknown,
): PartInfo {
  const merged = { ...deriveInfo(unwrapResult(raw)), ...partial };
  return {
    lcsc: merged.lcsc || lcsc,
    mfr: merged.mfr ?? '',
    mpn: merged.mpn ?? '',
    description: merged.description ?? '',
    package: merged.package ?? '',
    basic: merged.basic ?? false,
    ...(merged.stock !== undefined ? { stock: merged.stock } : {}),
    ...(merged.price !== undefined ? { price: merged.price } : {}),
    ...(merged.datasheet !== undefined ? { datasheet: merged.datasheet } : {}),
  };
}

function unwrapResult(raw: unknown): Parameters<typeof deriveInfo>[0] {
  if (raw && typeof raw === 'object' && 'result' in raw) {
    return (raw as { result: Parameters<typeof deriveInfo>[0] }).result;
  }
  return raw as Parameters<typeof deriveInfo>[0];
}
