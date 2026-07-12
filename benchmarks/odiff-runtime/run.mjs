import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, rm, stat, statfs} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const DEFAULT_CORPUS = fileURLToPath(new URL('../corpus/v1', import.meta.url));
const DEFAULT_OUTPUT = '/tmp/glint-odiff-benchmark';
const ENGINE_VERSION = '4.3.8';
const BURST_FILE_CHECKS = 126;
const BURST_DIFFS = 17;

export function expectedExitCode(testCase) {
  switch (testCase.expected.classification) {
    case 'changed':
      return 22;
    case 'layout-changed':
      return 21;
    case 'decode-error':
      return 1;
    case 'unchanged':
    case 'valid-or-limit-rejection':
      return 0;
    default:
      throw new Error(`Unsupported classification: ${testCase.expected.classification}`);
  }
}

export function selectBurstWork(taskIndex, manifest) {
  if (
    !Number.isInteger(taskIndex) ||
    taskIndex < 0 ||
    taskIndex >= BURST_FILE_CHECKS + BURST_DIFFS
  ) {
    throw new Error(`Task index must be between 0 and ${BURST_FILE_CHECKS + BURST_DIFFS - 1}`);
  }

  if (taskIndex < BURST_FILE_CHECKS) {
    const inputs = manifest.cases.flatMap((testCase) => testCase.inputs);
    return {kind: 'file-check', input: inputs[taskIndex % inputs.length]};
  }

  const diffCases = manifest.cases.filter(
    (testCase) => testCase.expected.engineInvocation === true,
  );
  return {kind: 'diff', testCase: diffCases[(taskIndex - BURST_FILE_CHECKS) % diffCases.length]};
}

async function hashFile(filePath) {
  const contents = await readFile(filePath);
  return createHash('sha256').update(contents).digest('hex');
}

async function directoryBytes(directory) {
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }

  let bytes = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      bytes += await directoryBytes(entryPath);
    } else if (entry.isFile()) {
      bytes += (await stat(entryPath)).size;
    }
  }
  return bytes;
}

async function filesystemSnapshot(directory) {
  const info = await statfs(directory);
  return {
    blockSize: info.bsize,
    totalBytes: info.blocks * info.bsize,
    availableBytes: info.bavail * info.bsize,
  };
}

function parseTimeMetrics(contents) {
  const [wallSeconds, userSeconds, systemSeconds, maxRssKiB, fsInputs, fsOutputs] = contents
    .trim()
    .split(';')
    .map(Number);
  return {wallSeconds, userSeconds, systemSeconds, maxRssKiB, fsInputs, fsOutputs};
}

export function runtimeExitIsSafe(testCase, exitCode) {
  if (testCase.expected.classification === 'decode-error') {
    return exitCode === 1;
  }
  return exitCode === 0 || exitCode === 21 || exitCode === 22;
}

export function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function killProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

async function runProcess({args, outputDirectory, timeoutMs, timeFile}) {
  const command = process.platform === 'linux' ? '/usr/bin/time' : 'odiff';
  const commandArgs =
    process.platform === 'linux'
      ? ['-q', '-f', '%e;%U;%S;%M;%I;%O', '-o', timeFile, 'odiff', ...args]
      : args;

  let stdout = '';
  let stderr = '';
  let peakOutputBytes = await directoryBytes(outputDirectory);
  const startedNs = process.hrtime.bigint();

  const child = spawn(command, commandArgs, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const sampler = setInterval(async () => {
    peakOutputBytes = Math.max(peakOutputBytes, await directoryBytes(outputDirectory));
  }, 10);
  sampler.unref();

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, timeoutMs);
  timeout.unref();

  const {code, signal} = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => resolve({code: exitCode, signal: exitSignal}));
  });

  clearInterval(sampler);
  clearTimeout(timeout);
  peakOutputBytes = Math.max(peakOutputBytes, await directoryBytes(outputDirectory));

  let resourceUsage = null;
  if (process.platform === 'linux') {
    try {
      const timeMetrics = await readFile(timeFile, 'utf8');
      if (timeMetrics.trim()) {
        resourceUsage = parseTimeMetrics(timeMetrics);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || !timedOut) {
        throw error;
      }
    }
  }

  return {
    code,
    signal,
    timedOut,
    durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    peakOutputBytes,
    resourceUsage,
  };
}

function odiffArguments(testCase, corpusDirectory, outputPath) {
  const [first, second] = testCase.inputs;
  const base = path.join(corpusDirectory, first.path);
  let candidate;

  if (second) {
    candidate = path.join(corpusDirectory, second.path);
  } else if (testCase.expected.classification === 'decode-error') {
    candidate = path.join(corpusDirectory, 'representative/base.png');
  } else {
    candidate = base;
  }

  return [base, candidate, outputPath, '--parsable-stdout', '--fail-on-layout', '--diff-mask'];
}

async function verifyManifest(manifest, corpusDirectory) {
  const mismatches = [];
  for (const testCase of manifest.cases) {
    for (const input of testCase.inputs) {
      const actual = await hashFile(path.join(corpusDirectory, input.path));
      if (actual !== input.sha256) {
        mismatches.push({path: input.path, expected: input.sha256, actual});
      }
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Corpus checksum mismatch: ${JSON.stringify(mismatches)}`);
  }
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function runDiffCase({
  testCase,
  corpusDirectory,
  outputDirectory,
  profile,
  iteration,
  timeoutMs,
}) {
  const caseDirectory = path.join(outputDirectory, `${testCase.id}-${iteration}`);
  await rm(caseDirectory, {recursive: true, force: true});
  await mkdir(caseDirectory, {recursive: true});

  const outputPath = path.join(caseDirectory, 'diff.png');
  const timeFile = path.join(caseDirectory, 'time.txt');
  const filesystemBefore = await filesystemSnapshot(caseDirectory);
  const result = await runProcess({
    args: odiffArguments(testCase, corpusDirectory, outputPath),
    outputDirectory: caseDirectory,
    timeoutMs,
    timeFile,
  });
  const filesystemAfter = await filesystemSnapshot(caseDirectory);
  const expectedCode = expectedExitCode(testCase);
  const classificationMatched = result.code === expectedCode;
  const passed = !result.timedOut && runtimeExitIsSafe(testCase, result.code);

  const record = {
    recordType: 'case',
    profile,
    caseId: testCase.id,
    classification: testCase.expected.classification,
    iteration,
    expectedExitCode: expectedCode,
    classificationMatched,
    passed,
    ...result,
    outputBytes: await directoryBytes(caseDirectory),
    filesystemBefore,
    filesystemAfter,
  };
  emit(record);
  return record;
}

async function runFileCheck({input, corpusDirectory, profile, taskIndex}) {
  const startedNs = process.hrtime.bigint();
  const actual = await hashFile(path.join(corpusDirectory, input.path));
  const record = {
    recordType: 'file-check',
    profile,
    taskIndex,
    path: input.path,
    bytes: input.bytes,
    durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
    passed: actual === input.sha256,
  };
  emit(record);
  return record;
}

export async function main() {
  const processStartedNs = process.hrtime.bigint();
  const corpusDirectory = process.env.GLINT_BENCH_CORPUS ?? DEFAULT_CORPUS;
  const outputDirectory = process.env.GLINT_BENCH_OUTPUT_DIR ?? DEFAULT_OUTPUT;
  const profile = process.env.GLINT_BENCH_PROFILE ?? 'local';
  const mode = process.env.GLINT_BENCH_MODE ?? 'suite';
  const timeoutMs = parsePositiveInteger(
    process.env.GLINT_BENCH_TIMEOUT_MS ?? 10_000,
    'GLINT_BENCH_TIMEOUT_MS',
  );
  const iterations = parsePositiveInteger(
    process.env.GLINT_BENCH_ITERATIONS ?? 5,
    'GLINT_BENCH_ITERATIONS',
  );

  await mkdir(outputDirectory, {recursive: true});
  const manifest = JSON.parse(await readFile(path.join(corpusDirectory, 'manifest.json'), 'utf8'));
  await verifyManifest(manifest, corpusDirectory);

  const versionProbe = spawnSync('odiff', ['--version'], {encoding: 'utf8'});
  const versionOutput = `${versionProbe.stdout}${versionProbe.stderr}`;
  if (versionProbe.status !== 0 || !versionOutput.includes(ENGINE_VERSION)) {
    throw new Error(`Expected ODiff ${ENGINE_VERSION}, received: ${versionOutput}`);
  }

  emit({
    recordType: 'environment',
    profile,
    mode,
    corpusVersion: manifest.corpusVersion,
    odiffVersion: ENGINE_VERSION,
    nodeVersion: process.version,
    architecture: process.arch,
    platform: process.platform,
    taskIndex: process.env.CLOUD_RUN_TASK_INDEX ?? null,
    taskCount: process.env.CLOUD_RUN_TASK_COUNT ?? null,
    processReadyMs: Number(process.hrtime.bigint() - processStartedNs) / 1_000_000,
  });

  const records = [];
  if (mode === 'task') {
    const taskIndex = Number(
      process.env.CLOUD_RUN_TASK_INDEX ?? process.env.GLINT_BENCH_TASK_INDEX,
    );
    const work = selectBurstWork(taskIndex, manifest);
    if (work.kind === 'file-check') {
      records.push(await runFileCheck({input: work.input, corpusDirectory, profile, taskIndex}));
    } else {
      records.push(
        await runDiffCase({
          testCase: work.testCase,
          corpusDirectory,
          outputDirectory,
          profile,
          iteration: 0,
          timeoutMs,
        }),
      );
    }
  } else if (mode === 'suite') {
    for (const testCase of manifest.cases) {
      if (
        testCase.expected.engineInvocation === false &&
        testCase.expected.classification === 'unchanged'
      ) {
        const [input] = testCase.inputs;
        records.push(await runFileCheck({input, corpusDirectory, profile, taskIndex: null}));
        continue;
      }
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        records.push(
          await runDiffCase({
            testCase,
            corpusDirectory,
            outputDirectory,
            profile,
            iteration,
            timeoutMs,
          }),
        );
      }
    }
  } else {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  emit({
    recordType: 'summary',
    profile,
    mode,
    passed: records.every((record) => record.passed),
    records: records.length,
    failed: records
      .filter((record) => !record.passed)
      .map((record) => record.caseId ?? record.path),
    classificationMismatches: records
      .filter((record) => record.classificationMatched === false)
      .map((record) => record.caseId),
    totalDurationMs: Number(process.hrtime.bigint() - processStartedNs) / 1_000_000,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    emit({recordType: 'fatal', message: error.message, stack: error.stack});
    process.exitCode = 1;
  });
}
