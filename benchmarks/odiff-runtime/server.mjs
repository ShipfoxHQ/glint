import {spawn, spawnSync} from 'node:child_process';
import http from 'node:http';
import process from 'node:process';

const ENGINE_VERSION = '4.3.8';
const port = Number(process.env.PORT ?? 8080);
const childTimeoutMs = Number(process.env.GLINT_BENCH_CHILD_TIMEOUT_MS ?? 9_000);

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function runIsolated(overrides) {
  return new Promise((resolve, reject) => {
    const startedNs = process.hrtime.bigint();
    const child = spawn(process.execPath, ['/benchmark/run.mjs'], {
      env: {...process.env, ...overrides},
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
      child.kill('SIGKILL');
    }, childTimeoutMs);
    timeout.unref();

    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({
        code,
        signal,
        timedOut,
        durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
        stdout,
        stderr,
      });
    });
  });
}

const versionProbe = spawnSync('odiff', ['--version'], {encoding: 'utf8'});
const versionOutput = `${versionProbe.stdout}${versionProbe.stderr}`;
if (versionProbe.status !== 0 || !versionOutput.includes(ENGINE_VERSION)) {
  throw new Error(`Expected ODiff ${ENGINE_VERSION}, received: ${versionOutput}`);
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    emit({recordType: 'service-health', ok: true, odiffVersion: ENGINE_VERSION});
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({ok: true, odiffVersion: ENGINE_VERSION}));
    return;
  }

  let overrides;
  if (request.method === 'POST' && request.url === '/suite') {
    overrides = {GLINT_BENCH_MODE: 'suite'};
  } else {
    const taskMatch = request.method === 'POST' && request.url?.match(/^\/task\/(\d+)$/);
    if (taskMatch) {
      overrides = {GLINT_BENCH_MODE: 'task', GLINT_BENCH_TASK_INDEX: taskMatch[1]};
    }
  }

  if (!overrides) {
    response.writeHead(404, {'content-type': 'application/json'});
    response.end(JSON.stringify({error: 'not-found'}));
    return;
  }

  try {
    const result = await runIsolated(overrides);
    const passed = result.code === 0 && !result.timedOut;
    emit({
      recordType: 'service-invocation',
      path: request.url,
      passed,
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stderr: result.stderr.trim(),
    });
    response.writeHead(passed ? 200 : 500, {'content-type': 'application/x-ndjson'});
    response.end(result.stdout);
  } catch (error) {
    emit({recordType: 'service-error', path: request.url, message: error.message});
    response.writeHead(500, {'content-type': 'application/json'});
    response.end(JSON.stringify({error: 'invocation-failed'}));
  }
});

server.listen(port, '0.0.0.0', () => {
  emit({recordType: 'service-ready', port, odiffVersion: ENGINE_VERSION, pid: process.pid});
});
