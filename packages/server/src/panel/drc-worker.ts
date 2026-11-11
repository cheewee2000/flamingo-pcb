/**
 * Worker thread for drc-run.ts: checks one board, posts its progress, then
 * its violations. Progress is posted at most every 100 ms.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { Board } from '@flamingo/engine';
import { boardDrc } from './drc-run.js';
import type { DrcStep } from './drc-run.js';

const STEP_INTERVAL_MS = 100;

const port = parentPort!;
const { board } = workerData as { board: Board };
let last = 0;
let lastDetail = '';

try {
  const violations = boardDrc(board, (step: DrcStep) => {
    const now = Date.now();
    if (now - last < STEP_INTERVAL_MS && step.detail === lastDetail) return;
    last = now;
    lastDetail = step.detail;
    port.postMessage({ type: 'step', step });
  });
  port.postMessage({ type: 'done', violations });
} catch (err) {
  port.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
}
