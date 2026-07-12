import {spawn} from 'node:child_process';
import process from 'node:process';

import {killProcessTree, parseTimerDelay} from './process-control.mjs';

const handlerTimeoutMs = parseTimerDelay(
  process.env.GLINT_BENCH_HANDLER_TIMEOUT_MS ?? 10_000,
  'GLINT_BENCH_HANDLER_TIMEOUT_MS',
);

function runBenchmark(event) {
  return new Promise((resolve, reject) => {
    const mode = event?.mode ?? 'suite';
    const taskIndex = event?.taskIndex;
    if (mode !== 'suite' && mode !== 'task') {
      reject(new Error(`Unsupported benchmark mode: ${mode}`));
      return;
    }
    if (mode === 'task' && (!Number.isInteger(taskIndex) || taskIndex < 0 || taskIndex > 142)) {
      reject(new Error('taskIndex must be an integer between 0 and 142'));
      return;
    }

    const child = spawn(process.execPath, [`${process.env.LAMBDA_TASK_ROOT}/run.mjs`], {
      detached: true,
      env: {
        ...process.env,
        GLINT_BENCH_MODE: mode,
        ...(mode === 'task' ? {GLINT_BENCH_TASK_INDEX: String(taskIndex)} : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, handlerTimeoutMs);
    timeout.unref();

    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({code, signal, timedOut, stdout, stderr});
    });
  });
}

export async function handler(event) {
  const result = await runBenchmark(event);
  const records = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const summary = records.find((record) => record.recordType === 'summary');

  if (result.code !== 0 || result.timedOut || summary?.passed !== true) {
    throw new Error(
      JSON.stringify({
        error: 'benchmark-failed',
        code: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        stderr: result.stderr.trim(),
        summary: summary ?? null,
      }),
    );
  }

  return {summary, records};
}
