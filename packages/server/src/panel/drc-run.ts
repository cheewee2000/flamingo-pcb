/**
 * A source board's own DRC, zone fill included, run off the main thread.
 *
 * On a routed board this takes from seconds to minutes (the clearance check
 * compares every pair of copper items). Run inline it would freeze the whole
 * server, MCP and WebSocket included, and no progress could reach a browser.
 * So each board runs in its own worker thread, a few at a time, and reports
 * progress as it goes.
 *
 * The worker is the compiled `drc-worker.js` beside this file. Where it does
 * not exist (tests run from the TypeScript sources) the check runs inline.
 */

import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Board, DrcViolation } from '@flamingo/engine';
import { fillAllZones, runDRC } from '@flamingo/engine';

export interface DrcStep {
  phase: 'zones' | 'drc';
  /** Estimated share of this board's work done, 0..1. */
  fraction: number;
  detail: string;
}

/**
 * Share of a board's run spent filling zones, when it has any. Measured on two
 * routed 4-layer boards with four pours each (2026-10-04): 5-13%.
 */
const ZONE_SHARE = 0.1;

/** Fill the zones of `board`, then run its DRC, reporting each step. */
export function boardDrc(board: Board, onStep?: (step: DrcStep) => void): DrcViolation[] {
  const zoneShare = board.zones.length > 0 ? ZONE_SHARE : 0;
  let filled = board;
  if (board.zones.length > 0) {
    onStep?.({ phase: 'zones', fraction: 0, detail: `zone 1 of ${board.zones.length}` });
    filled = fillAllZones(board, (done, total) => {
      onStep?.({
        phase: 'zones',
        fraction: (zoneShare * done) / total,
        detail: done < total ? `zone ${done + 1} of ${total}` : 'zones filled',
      });
    });
  }
  return runDRC(filled, (p) => {
    onStep?.({ phase: 'drc', fraction: zoneShare + (1 - zoneShare) * p.fraction, detail: p.check });
  });
}

const WORKER_URL = new URL('./drc-worker.js', import.meta.url);
const hasWorker = existsSync(fileURLToPath(WORKER_URL));

/** Boards checked at once. Each worker holds a board and its filled copy. */
const MAX_WORKERS = Math.max(1, Math.min(4, availableParallelism() - 1));
let active = 0;
const waiting: Array<() => void> = [];

async function slot(): Promise<() => void> {
  if (active >= MAX_WORKERS) await new Promise<void>((r) => waiting.push(r));
  active++;
  return () => {
    active--;
    waiting.shift()?.();
  };
}

type WorkerMsg = { type: 'step'; step: DrcStep } | { type: 'done'; violations: DrcViolation[] } | { type: 'error'; error: string };

function inWorker(board: Board, onStep?: (step: DrcStep) => void): Promise<DrcViolation[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData: { board } });
    let settled = false;
    worker.on('message', (msg: WorkerMsg) => {
      if (msg.type === 'step') onStep?.(msg.step);
      else if (msg.type === 'done') {
        settled = true;
        resolve(msg.violations);
      } else {
        settled = true;
        reject(new Error(msg.error));
      }
    });
    worker.on('error', (err) => {
      if (!settled) reject(err);
      settled = true;
    });
    worker.on('exit', (code) => {
      if (!settled) reject(new Error(`DRC worker exited with code ${code}`));
      settled = true;
    });
  });
}

/**
 * `boardDrc` in a worker thread, once one is free; no step is reported while
 * the board waits for one. Falls back to running inline if the worker cannot
 * be used.
 */
export async function boardDrcAsync(board: Board, onStep?: (step: DrcStep) => void): Promise<DrcViolation[]> {
  if (!hasWorker) return boardDrc(board, onStep);
  const release = await slot();
  try {
    return await inWorker(board, onStep);
  } catch (err) {
    console.error('[flamingo] DRC worker failed, checking inline:', err);
    return boardDrc(board, onStep);
  } finally {
    release();
  }
}
