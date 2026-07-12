import process from 'node:process';

const url = process.env.GLINT_BENCH_URL;
const token = process.env.GLINT_BENCH_ID_TOKEN;
const mode = process.env.GLINT_BENCH_CLIENT_MODE ?? 'suite';

if (!url) {
  throw new Error('GLINT_BENCH_URL is required');
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1];
}

async function invoke(path) {
  const startedNs = process.hrtime.bigint();
  let record;
  try {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: token ? {authorization: `Bearer ${token}`} : {},
    });
    const body = await response.text();
    const records = body
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const summary = records.find((responseRecord) => responseRecord.recordType === 'summary');
    record = {
      recordType: 'client-invocation',
      path,
      status: response.status,
      durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
      passed: response.ok && summary?.passed === true,
      workerSummary: summary ?? null,
    };
  } catch (error) {
    record = {
      recordType: 'client-invocation',
      path,
      status: null,
      durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
      passed: false,
      error: error.message,
      workerSummary: null,
    };
  }
  process.stdout.write(`${JSON.stringify(record)}\n`);
  return record;
}

const paths =
  mode === 'burst' ? Array.from({length: 143}, (_, index) => `/task/${index}`) : ['/suite'];
const startedNs = process.hrtime.bigint();
const records = await Promise.all(paths.map((path) => invoke(path)));
const durations = records.map((record) => record.durationMs);

process.stdout.write(
  `${JSON.stringify({
    recordType: 'client-summary',
    mode,
    passed: records.every((record) => record.passed),
    invocations: records.length,
    failed: records.filter((record) => !record.passed).map((record) => record.path),
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    maxDurationMs: Math.max(...durations),
    totalDurationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
  })}\n`,
);
