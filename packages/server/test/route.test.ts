import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { ensureFreerouting } from '../src/route.js';

describe('ensureFreerouting jar validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects and cleans up an invalid (too small / non-zip) download', async () => {
    // Fresh path that does not exist yet, so ensureFreerouting attempts a download.
    const jarPath = join(tmpdir(), `flamingo-jar-test-${randomUUID()}.jar`);
    const releases = {
      tag_name: 'v9.9.9',
      assets: [
        { name: 'freerouting-9.9.9.jar', browser_download_url: 'https://example.invalid/f.jar' },
      ],
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('api.github.com')) {
        return new Response(JSON.stringify(releases), { status: 200 });
      }
      // The "jar": a tiny HTML error page — not a PK zip, and well under 1MB.
      return new Response('<html>not a jar</html>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureFreerouting(jarPath)).rejects.toThrow(/invalid|retry|github/i);
    // No jar was committed at the target path (the temp file was removed).
    await expect(stat(jarPath)).rejects.toThrow();
  });
});
