import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractDatasheetUrl,
  isPdf,
  sanitizeMpn,
  getDatasheet,
  type DatasheetDeps,
  type HttpResult,
} from '../src/datasheet.js';
import type { PartInfo } from '../src/easyeda-parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const productHtml = readFileSync(join(here, 'fixtures', 'lcsc-product-page.html'), 'utf8');

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]); // "%PDF-1.7\n"

function htmlResult(url: string, html: string): HttpResult {
  return {
    ok: true,
    status: 200,
    url,
    contentType: 'text/html; charset=utf-8',
    bytes: new TextEncoder().encode(html),
  };
}
function pdfResult(url: string, bytes = PDF_BYTES): HttpResult {
  return { ok: true, status: 200, url, contentType: 'application/pdf', bytes };
}

function info(overrides: Partial<PartInfo> = {}): PartInfo {
  return {
    lcsc: 'C21190',
    mfr: 'UNI-ROYAL',
    mpn: '0603WAF1001T5E',
    description: '1k 0603',
    package: '0603',
    basic: true,
    datasheet: 'https://www.lcsc.com/product-detail/C21190.html',
    ...overrides,
  };
}

describe('extractDatasheetUrl', () => {
  it('pulls the datasheet.lcsc.com PDF link out of a real product page', () => {
    const url = extractDatasheetUrl(productHtml);
    expect(url).toBe(
      'https://datasheet.lcsc.com/lcsc/1809192335_UNI-ROYAL-Uniroyal-Elec-0603WAF1001T5E_C21190.pdf',
    );
  });

  it('accepts wmsc.lcsc.com and atta.szlcsc.com hosts', () => {
    expect(extractDatasheetUrl('x <a href="https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/foo.pdf">')).toBe(
      'https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/foo.pdf',
    );
    expect(extractDatasheetUrl("href='https://atta.szlcsc.com/upload/public/pdf/source/bar.pdf'")).toBe(
      'https://atta.szlcsc.com/upload/public/pdf/source/bar.pdf',
    );
  });

  it('returns null when there is no PDF link', () => {
    expect(extractDatasheetUrl('<html><body>no datasheet here</body></html>')).toBeNull();
  });
});

describe('isPdf', () => {
  it('accepts %PDF magic', () => {
    expect(isPdf(PDF_BYTES)).toBe(true);
  });
  it('rejects HTML posing as a PDF', () => {
    expect(isPdf(new TextEncoder().encode('<!doctype html><html>...'))).toBe(false);
  });
  it('rejects too-short buffers', () => {
    expect(isPdf(new Uint8Array([0x25, 0x50]))).toBe(false);
  });
});

describe('sanitizeMpn', () => {
  it('keeps allowed chars and collapses runs of others', () => {
    expect(sanitizeMpn('ABC/123 v2')).toBe('ABC-123-v2');
    expect(sanitizeMpn('0603WAF1001T5E')).toBe('0603WAF1001T5E');
    expect(sanitizeMpn('a..b__c--d')).toBe('a..b__c--d');
  });
  it('trims leading/trailing separators and falls back for empties', () => {
    expect(sanitizeMpn('///weird///')).toBe('weird');
    expect(sanitizeMpn('日本語')).toBe('part');
    expect(sanitizeMpn('')).toBe('part');
  });
});

describe('getDatasheet', () => {
  let cacheRoot: string;

  function deps(over: Partial<DatasheetDeps> = {}): Partial<DatasheetDeps> {
    return {
      getInfo: over.getInfo ?? (async () => info()),
      httpGet: over.httpGet,
      cacheDir: over.cacheDir ?? (() => cacheRoot),
    };
  }

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), 'flamingo-ds-'));
  });
  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('resolves an HTML product page to the PDF, validates, and caches it', async () => {
    const calls: string[] = [];
    const httpGet = async (url: string): Promise<HttpResult> => {
      calls.push(url);
      if (url.endsWith('.pdf')) return pdfResult(url);
      return htmlResult(url, productHtml);
    };
    const res = await getDatasheet('C21190', { deps: deps({ httpGet }) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fromCache).toBe(false);
    expect(res.mpn).toBe('0603WAF1001T5E');
    expect(res.sourceUrl).toMatch(/datasheet\.lcsc\.com\/.*\.pdf$/);
    expect(res.cachePath).toBe(join(cacheRoot, 'C21190.pdf'));
    const onDisk = new Uint8Array(await readFile(res.cachePath));
    expect(isPdf(onDisk)).toBe(true);
    // Two GETs: product page, then the PDF.
    expect(calls).toHaveLength(2);
  });

  it('handles a datasheet link that is already a direct PDF', async () => {
    const httpGet = async (url: string): Promise<HttpResult> => pdfResult(url);
    const res = await getDatasheet('C21190', {
      deps: deps({ getInfo: async () => info({ datasheet: 'https://x/foo.pdf' }), httpGet }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sourceUrl).toBe('https://x/foo.pdf');
  });

  it('serves from cache on a second call without hitting the network', async () => {
    await writeFile(join(cacheRoot, 'C21190.pdf'), PDF_BYTES);
    let hits = 0;
    const httpGet = async (url: string): Promise<HttpResult> => {
      hits++;
      return pdfResult(url);
    };
    const res = await getDatasheet('C21190', { deps: deps({ httpGet }) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fromCache).toBe(true);
    expect(hits).toBe(0);
  });

  it('refresh: true bypasses the cache', async () => {
    await writeFile(join(cacheRoot, 'C21190.pdf'), PDF_BYTES);
    let hits = 0;
    const httpGet = async (url: string): Promise<HttpResult> => {
      hits++;
      return pdfResult(url);
    };
    const res = await getDatasheet('C21190', {
      refresh: true,
      deps: deps({ getInfo: async () => info({ datasheet: 'https://x/foo.pdf' }), httpGet }),
    });
    expect(res.ok).toBe(true);
    expect(hits).toBe(1);
  });

  it('copies into <boardDir>/datasheets/<MPN>-<LCSC>.pdf when a board dir is given', async () => {
    const boardDir = mkdtempSync(join(tmpdir(), 'flamingo-board-'));
    try {
      const httpGet = async (url: string): Promise<HttpResult> =>
        url.endsWith('.pdf') ? pdfResult(url) : htmlResult(url, productHtml);
      const res = await getDatasheet('C21190', { boardDir, deps: deps({ httpGet }) });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const expected = join(boardDir, 'datasheets', '0603WAF1001T5E-C21190.pdf');
      expect(res.projectPath).toBe(expected);
      expect(res.path).toBe(expected);
      expect(existsSync(expected)).toBe(true);
      expect(isPdf(new Uint8Array(await readFile(expected)))).toBe(true);
    } finally {
      rmSync(boardDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing project copy', async () => {
    const boardDir = mkdtempSync(join(tmpdir(), 'flamingo-board-'));
    try {
      const dsDir = join(boardDir, 'datasheets');
      await mkdir(dsDir, { recursive: true });
      const existing = join(dsDir, '0603WAF1001T5E-C21190.pdf');
      await writeFile(existing, new TextEncoder().encode('SENTINEL'));
      const httpGet = async (url: string): Promise<HttpResult> =>
        url.endsWith('.pdf') ? pdfResult(url) : htmlResult(url, productHtml);
      const res = await getDatasheet('C21190', { boardDir, deps: deps({ httpGet }) });
      expect(res.ok).toBe(true);
      expect(await readFile(existing, 'utf8')).toBe('SENTINEL');
    } finally {
      rmSync(boardDir, { recursive: true, force: true });
    }
  });

  it('fails structurally when the part has no datasheet URL', async () => {
    const res = await getDatasheet('C21190', {
      deps: deps({ getInfo: async () => info({ datasheet: undefined }) }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/no datasheet URL/i);
  });

  it('fails (and does not cache) when the page has no PDF link', async () => {
    const httpGet = async (url: string): Promise<HttpResult> =>
      htmlResult(url, '<html><body>nothing here</body></html>');
    const res = await getDatasheet('C21190', { deps: deps({ httpGet }) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/open it manually/i);
    expect(existsSync(join(cacheRoot, 'C21190.pdf'))).toBe(false);
  });

  it('rejects HTML posing as a PDF (bad magic) and does not cache it', async () => {
    const badBytes = new TextEncoder().encode('<html>error 404</html>');
    const httpGet = async (url: string): Promise<HttpResult> => ({
      ok: true,
      status: 200,
      url,
      contentType: 'application/pdf', // lies about content-type
      bytes: badBytes,
    });
    const res = await getDatasheet('C21190', {
      deps: deps({ getInfo: async () => info({ datasheet: 'https://x/foo.pdf' }), httpGet }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not a valid PDF/i);
    expect(existsSync(join(cacheRoot, 'C21190.pdf'))).toBe(false);
  });

  it('reports HTTP errors as structured failures', async () => {
    const httpGet = async (url: string): Promise<HttpResult> => ({
      ok: false,
      status: 503,
      url,
      contentType: null,
      bytes: new Uint8Array(),
    });
    const res = await getDatasheet('C21190', { deps: deps({ httpGet }) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/HTTP 503/);
  });
});
