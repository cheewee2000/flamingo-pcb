/**
 * Freerouting runner.
 *
 * Locates a Java runtime and the freerouting.jar (downloading the jar from
 * GitHub releases on first use), then runs freerouting in batch mode over a
 * Specctra DSN and returns the resulting SES text.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
// Headless configuration
// ---------------------------------------------------------------------------

/**
 * Freerouting 2.x is GUI/analytics-first and, run naively in batch mode, hangs
 * in two places that make it unusable as a subprocess:
 *
 *  1. On startup it POSTs a telemetry "app started" event; with no reachable
 *     analytics server that call blocks before routing ever begins.
 *  2. After the auto-router converges it runs a *route optimizer* pass whose
 *     batch loop can deadlock and never return — so the job never reaches the
 *     COMPLETED state, the SES output is never written, and the process spins
 *     forever (empirically reproduced with v2.2.4 on JDK 26).
 *
 * We neutralise both by pointing freerouting at a throwaway user-data dir that
 * contains a `freerouting.json` disabling the GUI, analytics and the optimizer.
 * The auto-router alone fully connects the board (the optimizer only shortens
 * traces / removes vias), which is all we need. `profile.id` must be a real
 * UUID and the profile block must be present, or freerouting NPEs on a null
 * userId. Analytics is also disabled via env var as belt-and-suspenders.
 */
const FREEROUTING_CONFIG = {
  profile: { id: '00000000-0000-4000-8000-000000000000', email: '', allow_telemetry: false, allow_contact: false },
  gui: { enabled: false, input_directory: '', dialog_confirmation_timeout: 5 },
  router: { optimizer: { enabled: false }, scoring: {} },
  usage_and_diagnostic_data: { disable_analytics: true },
  feature_flags: { multi_threading: true, inspection_mode: false, other_menu: false, save_jobs: false },
  api_server: { enabled: false },
};

/** Write the headless freerouting.json into `dir` and return the env for the run. */
async function writeFreeroutingConfig(dir: string): Promise<NodeJS.ProcessEnv> {
  const config = {
    ...FREEROUTING_CONFIG,
    logging: { console: { enabled: true, level: 'INFO' }, file: { enabled: false, level: 'INFO', location: join(dir, 'freerouting.log') } },
  };
  await writeFile(join(dir, 'freerouting.json'), JSON.stringify(config, null, 2), 'utf8');
  return {
    ...process.env,
    FREEROUTING__USER_DATA_PATH: dir,
    FREEROUTING__USAGE_AND_DIAGNOSTIC_DATA__DISABLE_ANALYTICS: 'true',
  };
}

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

  // Validate the download before committing it: a jar is a zip, so it must
  // start with the PK\x03\x04 local-file-header magic and be a plausible size.
  // A truncated download or an HTML error page would otherwise be renamed into
  // place and fail cryptically every run thereafter.
  try {
    const info = await stat(tmpPath);
    const fh = await open(tmpPath, 'r');
    let magic: Buffer;
    try {
      magic = Buffer.alloc(4);
      await fh.read(magic, 0, 4, 0);
    } finally {
      await fh.close();
    }
    const isZip = magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04;
    if (!isZip || info.size <= 1_000_000) {
      throw new Error(
        `downloaded ${asset.name} looks invalid ` +
          `(${info.size} bytes, magic ${magic.toString('hex')}; expected a >1MB zip/jar). ` +
          'Delete any partial ~/.flamingo/freerouting.jar and retry; if it persists, ' +
          'download the jar manually from https://github.com/freerouting/freerouting/releases.',
      );
    }
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }

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
    const env = await writeFreeroutingConfig(dir);

    const args = ['-jar', jar, '-de', inPath, '-do', outPath, '-mp', String(passes)];
    const ses = await new Promise<string>((resolve, reject) => {
      const child = spawn(java, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
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
