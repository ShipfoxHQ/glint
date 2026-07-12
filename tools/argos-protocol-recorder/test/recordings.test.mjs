import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {recordAll, replayRecordings} from '../src/run-recordings.mjs';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const recordingsRoot = join(packageRoot, 'recordings/v1');
const recordingNames = [
  'cli-no-baseline',
  'cli-unchanged',
  'cli-changed',
  'cli-zero-screenshot',
  'cli-skipped',
  'cli-chunked-metadata',
  'cli-parallel-manual-finalize',
  'cli-api-retry',
  'cli-upload-failure',
  'cli-invalid-token',
  'cli-minimal-response-fields',
  'playwright-reporter',
  'storybook-vitest-plugin',
];

async function recording(name) {
  return JSON.parse(await readFile(join(recordingsRoot, `${name}.json`), 'utf8'));
}

test('recordings cover the complete GLI-3 producer matrix', async () => {
  for (const name of recordingNames) assert.equal((await recording(name)).scenario, name);
  assert.equal((await recording('cli-changed')).producer.version, '5.0.5');
  assert.equal((await recording('playwright-reporter')).producer.version, '7.0.6');
  assert.equal((await recording('storybook-vitest-plugin')).producer.version, '6.0.7');
});

test('pinned CLI, Playwright, and Storybook producers replay the golden contract', async () => {
  assert.deepEqual(await replayRecordings(), recordingNames.map((name) => `${name}.json`).sort());
});

test('recordings contain no bearer token, live signed URL, or screenshot bytes', async () => {
  const files = await readdir(recordingsRoot);
  const content = (
    await Promise.all(files.map((file) => readFile(join(recordingsRoot, file), 'utf8')))
  ).join('\n');
  assert.doesNotMatch(content, /0123456789012345678901234567890123456789/);
  assert.doesNotMatch(content, /http:\/\/127\.0\.0\.1:\d+/);
  assert.doesNotMatch(content, /\/Users\//);
  assert.match(content, /Bearer <redacted:40-character-token>/);
  assert.match(content, /<signed-upload-url>/);
  assert.match(content, /"sha256": "[a-f0-9]{64}"/);
});

test('chunked, zero-screenshot, and upload-failure recordings preserve edge behavior', async () => {
  const chunked = await recording('cli-chunked-metadata');
  assert.equal(
    chunked.exchanges.filter((exchange) => exchange.request.path.startsWith('/signed-upload/'))
      .length,
    12,
  );
  assert.equal(
    chunked.exchanges.find((exchange) => exchange.request.path === '/v2/builds').request.body
      .screenshots.length,
    12,
  );

  const empty = await recording('cli-zero-screenshot');
  assert.deepEqual(
    empty.exchanges.find((exchange) => exchange.request.path === '/v2/builds').request.body
      .screenshots,
    [],
  );
  assert.equal(
    empty.exchanges.some((exchange) => exchange.request.method === 'PUT'),
    true,
  );

  const failed = await recording('cli-upload-failure');
  assert.equal(failed.expectedFailure, true);
  assert.equal(failed.exchanges.at(-1).response.status, 503);
  assert.equal(
    failed.exchanges.some((exchange) => exchange.request.method === 'PUT'),
    false,
  );
});

test('skip is POST /v2/builds with skipped true and no other API route', async () => {
  const value = await recording('cli-skipped');
  assert.deepEqual(
    value.exchanges.map((exchange) => exchange.request.path),
    ['/v2/builds'],
  );
  assert.equal(value.exchanges[0].request.body.skipped, true);
  assert.deepEqual(value.exchanges[0].request.body.screenshots, []);
});

test('API retries reuse request id and increment the attempt header', async () => {
  const value = await recording('cli-api-retry');
  const projectRequests = value.exchanges.filter(
    (exchange) => exchange.request.path === '/v2/project',
  );
  assert.equal(projectRequests.length, 2);
  assert.equal(projectRequests[0].response.status, 500);
  assert.equal(projectRequests[1].response.status, 200);
  assert.equal(
    projectRequests[0].request.headers['x-argos-request-id'],
    projectRequests[1].request.headers['x-argos-request-id'],
  );
  assert.deepEqual(
    projectRequests.map((exchange) => exchange.request.headers['x-argos-retry-attempt']),
    ['0', '1'],
  );
});

test('parallel shards update both indices then use the manual finalize route', async () => {
  const value = await recording('cli-parallel-manual-finalize');
  const updates = value.exchanges.filter((exchange) => exchange.request.method === 'PUT');
  assert.deepEqual(
    updates.map((exchange) => exchange.request.body.parallelIndex),
    [1, 2],
  );
  assert.equal(value.exchanges.at(-1).request.path, '/v2/builds/finalize');
});

test('a failed recording run preserves the previous complete output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glint-argos-recorder-test-'));
  const output = join(root, 'recordings');
  await mkdir(output);
  await writeFile(join(output, 'known-good.json'), 'known-good');
  try {
    await assert.rejects(
      recordAll(output, [
        {
          name: 'forced-failure',
          producer: '@argos-ci/cli',
          run: async () => {
            throw new Error('fixture-induced generation failure');
          },
        },
      ]),
      /fixture-induced generation failure/,
    );
    assert.deepEqual(await readdir(output), ['known-good.json']);
    assert.equal(await readFile(join(output, 'known-good.json'), 'utf8'), 'known-good');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
