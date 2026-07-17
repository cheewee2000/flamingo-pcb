/**
 * Freerouting runner.
 *
 * Locates a Java runtime and the freerouting.jar (downloading the jar from
 * GitHub releases on first use), then runs freerouting in batch mode over a
 * Specctra DSN and returns the resulting SES text.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const FLAMINGO_DIR = join(homedir(), '.flamingo');
const JAR_PATH = join(FLAMINGO_DIR, 'freerouting.jar');
const RELEASES_API = 'https://api.github.com/repos/freerouting/freerouting/releases/latest';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_PASSES = 20;

export interface RunFreeroutingOptions {
  passes?: number;
  /** Override the jar path (tests). */
  jarPath?: string;
  /** Override the java binary (tests). */
  java?: string;
  /** Override the timeout in ms. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Java location
// ---------------------------------------------------------------------------

function javaWorks(bin: string): boolean {
  try {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Locate a usable `java` binary, or null if none is found. Tries, in order:
 * $JAVA_HOME/bin/java, `java` on PATH, and the standard Homebrew openjdk
 * locations (Apple Silicon then Intel).
 */
export function findJava(): string | null {
  const candidates: string[] = [];
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin', 'java'));
  candidates.push('java');
  candidates.push('/opt/homebrew/opt/openjdk/bin/java');
  candidates.push('/usr/local/opt/openjdk/bin/java');
  for (const c of candidates) {
    if (javaWorks(c)) return c;
  }
  return null;
}

const JAVA_INSTALL_HINT =
  'Java runtime not found. Install it with:\n' +
  '  brew install openjdk\n' +
  '(openjdk is keg-only; either add /opt/homebrew/opt/openjdk/bin to PATH or set ' +
  'JAVA_HOME=/opt/homebrew/opt/openjdk).';

// ---------------------------------------------------------------------------
// freerouting.jar acquisition
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

/**
 * Ensure freerouting.jar exists at ~/.flamingo/freerouting.jar, downloading
 * the latest release asset from GitHub if missing. Returns the jar path.
 */
export async function ensureFreerouting(jarPath: string = JAR_PATH): Promise<string> {
  if (await fileExists(jarPath)) return jarPath;

  console.error('[flamingo] freerouting.jar not found — fetching latest release info...');
  const res = await fetch(RELEASES_API, {
    headers: { 'User-Agent': 'flamingo', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    throw new Error(`failed to query freerouting releases: HTTP ${res.status}`);
  }
  const release = (await res.json()) as { tag_name?: string; assets?: GithubAsset[] };
  const assets = release.assets ?? [];
  // Prefer a plain `freerouting-<version>.jar` (skip anything else).
  const asset =
    assets.find((a) => /^freerouting-.*\.jar$/.test(a.name)) ??
    assets.find((a) => /\.jar$/.test(a.name));
  if (!asset) {
    throw new Error('no .jar asset found in the latest freerouting release');
  }
  console.error(
    `[flamingo] downloading ${asset.name} (${release.tag_name ?? '?'})...`,
  );

  await mkdir(FLAMINGO_DIR, { recursive: true });
  const dl = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'flamingo' },
    redirect: 'follow',
  });
  if (!dl.ok || !dl.body) {
    throw new Error(`failed to download ${asset.name}: HTTP ${dl.status}`);
  }
  const tmpPath = `${jarPath}.tmp-${randomUUID()}`;
  await pipeline(Readable.fromWeb(dl.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmpPath));
  await rename(tmpPath, jarPath);
  console.error(`[flamingo] saved freerouting.jar to ${jarPath}`);
  return jarPath;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function tail(s: string, max = 2000): string {
  return s.length > max ? s.slice(-max) : s;
}

/**
 * Run freerouting in batch mode on `dsn` and return the SES output text.
 * Writes the DSN into a fresh temp dir, spawns java, reads out.ses, and
 * cleans up. Throws with a helpful message if java is missing, the router
 * times out, or no output is produced.
 */
export async function runFreerouting(
  dsn: string,
  opts: RunFreeroutingOptions = {},
): Promise<string> {
  const java = opts.java ?? findJava();
  if (!java) throw new Error(JAVA_INSTALL_HINT);

  const jar = opts.jarPath ?? (await ensureFreerouting());
  const passes = opts.passes ?? DEFAULT_PASSES;
  const timeoutMs =
    opts.timeoutMs ?? (Number(process.env.FLAMINGO_ROUTE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

  const dir = await mkdtemp(join(tmpdir(), `flamingo-route-${randomUUID()}-`));
  const inPath = join(dir, 'in.dsn');
  const outPath = join(dir, 'out.ses');

  try {
    await writeFile(inPath, dsn, 'utf8');

    const args = ['-jar', jar, '-de', inPath, '-do', outPath, '-mp', String(passes)];
    const ses = await new Promise<string>((resolve, reject) => {
      const child = spawn(java, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`freerouting timed out after ${timeoutMs}ms`));
          return;
        }
        readFile(outPath, 'utf8').then(
          (data) => {
            if (data.trim().length === 0) {
              reject(new Error(`freerouting produced an empty SES (exit ${code}). ${tail(stderr || stdout)}`));
            } else {
              resolve(data);
            }
          },
          () => {
            reject(
              new Error(
                `freerouting produced no output (exit ${code}). ${tail(stderr || stdout)}`,
              ),
            );
          },
        );
      });
    });
    return ses;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface RouteRunner {
  run(dsn: string, opts?: { passes?: number }): Promise<string>;
}

/** The production runner: locate java + jar and run freerouting for real. */
export const defaultRouteRunner: RouteRunner = {
  run: (dsn, opts) => runFreerouting(dsn, opts),
};
