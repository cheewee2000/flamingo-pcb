/**
 * Datasheet fetch/resolve for an LCSC part.
 *
 * `PartInfo.datasheet` (from easyeda-parse) is usually an LCSC *product page*,
 * not a direct PDF. This module resolves it to a real PDF:
 *   info.datasheet -> HTTP GET -> if PDF, done
 *                              -> if HTML, scrape the first datasheet/wmsc/atta
 *                                 .pdf link and fetch that
 * The bytes are validated (%PDF magic) before anything is written, so we never
 * cache an HTML error page as a ".pdf".
 *
 * Storage:
 *   - always: global cache `~/.flamingo/datasheets/<LCSC>.pdf`
 *     (same dir convention as `~/.flamingo/parts/`; `refresh` bypasses it)
 *   - when a board dir is known: also copy to
 *     `<board dir>/datasheets/<MPN>-<LCSC>.pdf` (MPN sanitized)
 *
 * Network access is injectable (`DatasheetDeps`) so the test suite runs offline.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { fetchPart } from './fetch.js';
import type { PartInfo } from './easyeda-parse.js';

// A browser-ish UA — LCSC/EasyEDA sometimes 403 default fetch agents.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const TIMEOUT_MS = 30_000;

/** Global datasheet cache dir: `~/.flamingo/datasheets` (override via FLAMINGO_CACHE_DIR's parent). */
export function datasheetsCacheDir(): string {
  const override = process.env.FLAMINGO_DATASHEET_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), '.flamingo', 'datasheets');
}

/** Minimal HTTP response shape the resolver needs (bytes + how to read them). */
export interface HttpResult {
  ok: boolean;
  status: number;
  /** Final URL after redirects. */
  url: string;
  /** Lower-cased content-type header, or null. */
  contentType: string | null;
  bytes: Uint8Array;
}

export interface DatasheetDeps {
  /** Fetch PartInfo for an LCSC id (default: the cached `fetchPart`). */
  getInfo(lcsc: string): Promise<PartInfo>;
  /** HTTP GET following redirects (default: real `fetch`). */
  httpGet(url: string): Promise<HttpResult>;
  /** Global cache dir (default: `datasheetsCacheDir()`). */
  cacheDir(): string;
}

export interface DatasheetOk {
  ok: true;
  lcsc: string;
  mpn: string;
  /** URL of the actual PDF that was fetched (or the product page, on cache hit). */
  sourceUrl: string;
  /** Path reported to the caller — the project copy if made, else the cache path. */
  path: string;
  cachePath: string;
  /** Present when the served board has a file path and the copy was made/exists. */
  projectPath?: string;
  bytes: number;
  fromCache: boolean;
}

export interface DatasheetFail {
  ok: false;
  error: string;
}

export type DatasheetOutcome = DatasheetOk | DatasheetFail;

export interface GetDatasheetOpts {
  refresh?: boolean;
  /** Directory of the served board file; enables the `<dir>/datasheets/` copy. */
  boardDir?: string;
  /** Injected for tests; production uses the real network + cache. */
  deps?: Partial<DatasheetDeps>;
}

/** True if the bytes start with the `%PDF` magic number. */
export function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 // F
  );
}

/**
 * Find the first datasheet PDF link in an LCSC product page's HTML.
 * Accepts datasheet.lcsc.com, wmsc.lcsc.com, and atta.szlcsc.com hosts.
 */
export function extractDatasheetUrl(html: string): string | null {
  const re =
    /https?:\/\/(?:datasheet|wmsc)\.lcsc\.com\/[^"'\s)]+?\.pdf|https?:\/\/atta\.szlcsc\.com\/[^"'\s)]+?\.pdf/i;
  const m = html.match(re);
  return m ? m[0] : null;
}

/** Sanitize an MPN for use in a filename: keep [A-Za-z0-9._-], collapse runs. */
export function sanitizeMpn(mpn: string): string {
  const cleaned = mpn.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'part';
}

async function realHttpGet(url: string): Promise<HttpResult> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/pdf,text/html,*/*',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    ok: res.ok,
    status: res.status,
    url: res.url || url,
    contentType: (res.headers.get('content-type') ?? '').toLowerCase() || null,
    bytes: buf,
  };
}

function resolveDeps(deps?: Partial<DatasheetDeps>): DatasheetDeps {
  return {
    getInfo: deps?.getInfo ?? (async (lcsc) => (await fetchPart(lcsc)).info),
    httpGet: deps?.httpGet ?? realHttpGet,
    cacheDir: deps?.cacheDir ?? datasheetsCacheDir,
  };
}

/** Does the response look like a PDF (by content-type or magic)? */
function looksPdf(res: HttpResult): boolean {
  if (res.contentType && res.contentType.includes('pdf')) return true;
  return isPdf(res.bytes);
}

/**
 * Fetch + resolve + store the datasheet for `lcsc`. Never throws for the
 * expected failure modes (no URL, non-PDF, HTTP error) — those come back as
 * `{ ok: false, error }`, matching the run_drc "failures are results" policy.
 */
export async function getDatasheet(
  lcsc: string,
  opts: GetDatasheetOpts = {},
): Promise<DatasheetOutcome> {
  const deps = resolveDeps(opts.deps);

  let info: PartInfo;
  try {
    info = await deps.getInfo(lcsc);
  } catch (err) {
    return { ok: false, error: `could not fetch part "${lcsc}": ${errMsg(err)}` };
  }

  const cachePath = join(deps.cacheDir(), `${sanitizeMpn(lcsc)}.pdf`);

  // Cache hit (unless refresh): reuse without touching the network.
  let bytes: Uint8Array | null = null;
  let sourceUrl = info.datasheet ?? '';
  let fromCache = false;
  if (!opts.refresh) {
    const cached = await readIfExists(cachePath);
    if (cached && isPdf(cached)) {
      bytes = cached;
      fromCache = true;
      if (!sourceUrl) sourceUrl = cachePath;
    }
  }

  if (bytes === null) {
    if (!info.datasheet) {
      return { ok: false, error: `no datasheet URL for part "${lcsc}"` };
    }
    const resolved = await resolvePdf(deps, info.datasheet);
    if (!resolved.ok) return resolved;
    bytes = resolved.bytes;
    sourceUrl = resolved.url;
    await writeFileEnsuringDir(cachePath, bytes);
  }

  // Optional project-dir copy: <board dir>/datasheets/<MPN>-<LCSC>.pdf
  let projectPath: string | undefined;
  if (opts.boardDir) {
    const name = `${sanitizeMpn(info.mpn || lcsc)}-${sanitizeMpn(lcsc)}.pdf`;
    projectPath = join(opts.boardDir, 'datasheets', name);
    if (!(await fileExists(projectPath))) {
      await mkdir(join(opts.boardDir, 'datasheets'), { recursive: true });
      // Copy from cache when possible, else write the bytes we hold.
      if (fromCache) await copyFile(cachePath, projectPath);
      else await writeFile(projectPath, bytes);
    }
  }

  return {
    ok: true,
    lcsc,
    mpn: info.mpn || '',
    sourceUrl,
    path: projectPath ?? cachePath,
    cachePath,
    ...(projectPath ? { projectPath } : {}),
    bytes: bytes.length,
    fromCache,
  };
}

/** Follow info.datasheet to a validated PDF byte buffer, or a structured failure. */
async function resolvePdf(
  deps: DatasheetDeps,
  datasheetUrl: string,
): Promise<{ ok: true; bytes: Uint8Array; url: string } | DatasheetFail> {
  let res: HttpResult;
  try {
    res = await deps.httpGet(datasheetUrl);
  } catch (err) {
    return { ok: false, error: `datasheet fetch failed (${datasheetUrl}): ${errMsg(err)}` };
  }
  if (!res.ok) {
    return { ok: false, error: `datasheet fetch returned HTTP ${res.status} (${datasheetUrl})` };
  }

  // Direct PDF?
  if (looksPdf(res)) {
    if (!isPdf(res.bytes)) {
      return { ok: false, error: `response was not a valid PDF (${res.url})` };
    }
    return { ok: true, bytes: res.bytes, url: res.url };
  }

  // Otherwise it's an HTML product page — scrape for the PDF link.
  const html = new TextDecoder('utf-8', { fatal: false }).decode(res.bytes);
  const pdfUrl = extractDatasheetUrl(html);
  if (!pdfUrl) {
    return {
      ok: false,
      error:
        `no PDF link found on the datasheet page — open it manually: ${res.url}`,
    };
  }

  let pdfRes: HttpResult;
  try {
    pdfRes = await deps.httpGet(pdfUrl);
  } catch (err) {
    return { ok: false, error: `datasheet PDF fetch failed (${pdfUrl}): ${errMsg(err)}` };
  }
  if (!pdfRes.ok) {
    return { ok: false, error: `datasheet PDF fetch returned HTTP ${pdfRes.status} (${pdfUrl})` };
  }
  if (!isPdf(pdfRes.bytes)) {
    return { ok: false, error: `linked file was not a valid PDF (${pdfRes.url})` };
  }
  return { ok: true, bytes: pdfRes.bytes, url: pdfRes.url };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeFileEnsuringDir(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes);
}
