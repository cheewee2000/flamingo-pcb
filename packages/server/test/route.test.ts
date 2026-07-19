import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createRouteProgressParser, ensureFreerouting, parseRouteLine, type RouteProgress } from '../src/route.js';

// Real freerouting stdout lines (id prefix included, since the parser must NOT
// depend on it). Backslash in the "[SESSION\JOB]" prefix is escaped for JS.
const LINE_START = "[F9645E\\C0D71A] Starting routing of 'blinker' on 15 threads...";
const LINE_PASS =
  "[F9645E\\C0D71A] Auto-router pass #1 on board 'x' was completed in 0.27 seconds with the score of 942.92 (4 unrouted).";
const LINE_SESSION =
  '[F9645E\\C0D71A] Auto-router session completed: started with 25 unrouted nets, completed in 0.38 seconds, final score: 958.44 (3 unrouted).';

describe('parseRouteLine', () => {
  it('parses a "starting" line with the thread count', () => {
    expect(parseRouteLine(LINE_START)).toEqual({ kind: 'started', threads: 15 });
  });

  it('parses a per-pass line (pass number, score, unrouted)', () => {
    expect(parseRouteLine(LINE_PASS)).toEqual({ kind: 'pass', pass: 1, score: 942.92, unrouted: 4 });
  });

  it('parses a session-completed line (final score, unrouted)', () => {
    expect(parseRouteLine(LINE_SESSION)).toEqual({ kind: 'session-done', score: 958.44, unrouted: 3 });
  });

  it('returns null for lines it does not recognise', () => {
    expect(parseRouteLine('[..] Reading DSN file...')).toBeNull();
    expect(parseRouteLine('')).toBeNull();
  });
});

describe('createRouteProgressParser (line buffering)', () => {
  it('emits one event per line even when chunks split lines mid-token', () => {
    const events: RouteProgress[] = [];
    const p = createRouteProgressParser((ev) => events.push(ev));
    // Deliberately split every line across a chunk boundary.
    p.push(LINE_START.slice(0, 30));
    p.push(LINE_START.slice(30) + '\n' + LINE_PASS.slice(0, 20));
    p.push(LINE_PASS.slice(20) + '\n' + LINE_SESSION.slice(0, 40));
    p.push(LINE_SESSION.slice(40) + '\n');
    expect(events).toEqual([
      { kind: 'started', threads: 15 },
      { kind: 'pass', pass: 1, score: 942.92, unrouted: 4 },
      { kind: 'session-done', score: 958.44, unrouted: 3 },
    ]);
  });

  it('does not emit a partial line until its newline arrives; flush() drains the tail', () => {
    const events: RouteProgress[] = [];
    const p = createRouteProgressParser((ev) => events.push(ev));
    p.push(LINE_PASS); // no trailing newline yet
    expect(events).toEqual([]); // still buffered
    p.flush();
    expect(events).toEqual([{ kind: 'pass', pass: 1, score: 942.92, unrouted: 4 }]);
  });
});

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
