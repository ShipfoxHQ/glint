import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';
import ArgosPlaywrightReporter from '@argos-ci/playwright/reporter';
import {argosVitestPlugin} from '@argos-ci/storybook/vitest-plugin';
import {createProtocolRecorder, recorderToken} from './recorder.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const workspaceRoot = resolve(packageRoot, '../..');
const defaultOutputDirectory = resolve(packageRoot, 'recordings/v1');

const crcTable = Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function onePixelPng(red, green, blue) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const image = deflateSync(Buffer.from([0, red, green, blue, 255]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', image),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function makeScreenshots(root, count, offset = 0) {
  await mkdir(root, {recursive: true});
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const path = join(root, `fixture-${String(index + 1).padStart(2, '0')}.png`);
    const color = index + offset + 1;
    await writeFile(path, onePixelPng(color % 255, (color * 37) % 255, (color * 83) % 255));
    paths.push(path);
  }
  return paths;
}

function packageDirectory(packageName) {
  const packageJson = fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
  return dirname(packageJson);
}

async function packageVersion(packageName) {
  return JSON.parse(await readFile(join(packageDirectory(packageName), 'package.json'), 'utf8'))
    .version;
}

function scrubOutput(output, baseUrl, temporaryRoot) {
  const recorderOrigin = new URL(baseUrl).origin;
  return output
    .replaceAll(recorderToken(), '<redacted:40-character-token>')
    .replaceAll('too-short', '<redacted-invalid-token>')
    .replaceAll(recorderOrigin, '<recorder-origin>')
    .replaceAll(temporaryRoot, '<temporary-directory>')
    .replaceAll(workspaceRoot, '<workspace>')
    .replaceAll(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .trim();
}

function isGitHubCiEnvironment(name) {
  return name === 'CI' || name.startsWith('GITHUB_');
}

function githubCiEnvironmentClears() {
  return Object.fromEntries(
    Object.keys(process.env)
      .filter(isGitHubCiEnvironment)
      .map((name) => [name, undefined]),
  );
}

async function runCommand(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
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
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  if (options.expectFailure ? exitCode === 0 : exitCode !== 0) {
    throw new Error(
      `Unexpected command exit ${exitCode}: ${command} ${args.join(' ')}\n${stdout}\n${stderr}`,
    );
  }
  return {
    exitCode,
    stdout: scrubOutput(stdout, options.baseUrl, options.temporaryRoot),
    stderr: scrubOutput(stderr, options.baseUrl, options.temporaryRoot),
  };
}

function commonEnvironment(baseUrl) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !isGitHubCiEnvironment(name)),
    ),
    ARGOS_API_BASE_URL: baseUrl,
    ARGOS_BRANCH: 'recording-branch',
    ARGOS_COMMIT: '1111111111111111111111111111111111111111',
    ARGOS_TOKEN: recorderToken(),
    DISABLE_GITHUB_TOKEN_WARNING: 'true',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}

async function runCli(args, context, expectFailure = false, environment = {}) {
  const cli = join(packageDirectory('@argos-ci/cli'), 'bin/argos-cli.js');
  return runCommand(process.execPath, [cli, ...args], {
    cwd: workspaceRoot,
    env: {...commonEnvironment(context.baseUrl), ...environment},
    expectFailure,
    baseUrl: context.baseUrl,
    temporaryRoot: context.temporaryRoot,
  });
}

async function withEnvironment(environment, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runPlaywrightReporter(context) {
  const screenshotPath = (await makeScreenshots(join(context.temporaryRoot, 'playwright'), 1))[0];
  const reporter = new ArgosPlaywrightReporter({buildName: 'playwright-recorder'});
  reporter.onBegin({shard: null});
  await reporter.onTestEnd(
    {},
    {
      attachments: [
        {
          name: 'argos/screenshot___playwright-recorder',
          contentType: 'image/png',
          path: screenshotPath,
        },
      ],
    },
  );
  const result = await withEnvironment(
    {...commonEnvironment(context.baseUrl), ...githubCiEnvironmentClears()},
    () =>
      reporter.onEnd({
        status: 'passed',
        startTime: new Date('2026-07-11T00:00:00.000Z'),
        duration: 42,
      }),
  );
  if (result?.status === 'failed') throw new Error('Playwright reporter upload failed');
  return {exitCode: 0, stdout: 'Playwright reporter completed', stderr: ''};
}

async function runStorybookReporter(context) {
  const screenshotRoot = join(context.temporaryRoot, 'storybook');
  await makeScreenshots(screenshotRoot, 1);
  const plugin = argosVitestPlugin({
    root: screenshotRoot,
    uploadToArgos: true,
    buildName: 'storybook-recorder',
  });
  const vitest = {config: {reporters: [], watch: false}};
  const project = {config: {setupFiles: []}};
  plugin.configureVitest({vitest, project});
  const reporter = vitest.config.reporters[0];
  reporter.onInit(vitest);
  await withEnvironment(
    {...commonEnvironment(context.baseUrl), ...githubCiEnvironmentClears()},
    () => reporter.onFinished(),
  );
  return {exitCode: 0, stdout: 'Storybook Vitest reporter completed', stderr: ''};
}

async function cliUploadScenario(context, count, extraArgs = [], expectFailure = false) {
  const screenshots = join(context.temporaryRoot, 'screenshots');
  await makeScreenshots(screenshots, count);
  return runCli(
    ['upload', screenshots, '--build-name', context.scenario.name, ...extraArgs],
    context,
    expectFailure,
  );
}

const scenarioDefinitions = [
  {
    name: 'cli-no-baseline',
    producer: '@argos-ci/cli',
    outcome: 'no-baseline',
    uploads: 'all',
    run: (context) => cliUploadScenario(context, 1),
  },
  {
    name: 'cli-unchanged',
    producer: '@argos-ci/cli',
    outcome: 'unchanged',
    uploads: 'none',
    run: (context) => cliUploadScenario(context, 1),
  },
  {
    name: 'cli-changed',
    producer: '@argos-ci/cli',
    outcome: 'changed',
    uploads: 'all',
    run: (context) => cliUploadScenario(context, 2),
  },
  {
    name: 'cli-zero-screenshot',
    producer: '@argos-ci/cli',
    outcome: 'unchanged',
    uploads: 'all',
    run: (context) => cliUploadScenario(context, 0),
  },
  {
    name: 'cli-skipped',
    producer: '@argos-ci/cli',
    outcome: 'skipped',
    uploads: 'none',
    run: (context) => runCli(['skip', '--build-name', context.scenario.name], context),
  },
  {
    name: 'cli-chunked-metadata',
    producer: '@argos-ci/cli',
    outcome: 'changed',
    uploads: 'all',
    run: (context) => cliUploadScenario(context, 12),
  },
  {
    name: 'cli-parallel-manual-finalize',
    producer: '@argos-ci/cli',
    outcome: 'changed',
    uploads: 'all',
    run: async (context) => {
      const shardOne = join(context.temporaryRoot, 'shard-one');
      const shardTwo = join(context.temporaryRoot, 'shard-two');
      await makeScreenshots(shardOne, 1, 20);
      await makeScreenshots(shardTwo, 1, 40);
      const common = [
        '--build-name',
        context.scenario.name,
        '--parallel',
        '--parallel-total',
        '2',
        '--parallel-nonce',
        'recording-parallel-nonce',
      ];
      await runCli(['upload', shardOne, ...common, '--parallel-index', '1'], context);
      await runCli(['upload', shardTwo, ...common, '--parallel-index', '2'], context);
      return runCli(['finalize', '--parallel-nonce', 'recording-parallel-nonce'], context);
    },
  },
  {
    name: 'cli-api-retry',
    producer: '@argos-ci/cli',
    outcome: 'changed',
    uploads: 'none',
    retryRoute: 'GET /v2/project',
    run: (context) => cliUploadScenario(context, 1),
  },
  {
    name: 'cli-upload-failure',
    producer: '@argos-ci/cli',
    outcome: 'changed',
    uploads: 'fail',
    expectedFailure: true,
    run: (context) => cliUploadScenario(context, 1, [], true),
  },
  {
    name: 'cli-invalid-token',
    producer: '@argos-ci/cli',
    uploads: 'none',
    expectedFailure: true,
    run: async (context) => {
      const screenshots = join(context.temporaryRoot, 'screenshots');
      await makeScreenshots(screenshots, 1);
      return runCli(['upload', screenshots, '--build-name', context.scenario.name], context, true, {
        ARGOS_TOKEN: 'too-short',
      });
    },
  },
  {
    name: 'cli-minimal-response-fields',
    producer: '@argos-ci/cli',
    outcome: 'changed',
    uploads: 'none',
    minimalResponses: true,
    run: (context) => cliUploadScenario(context, 1),
  },
  {
    name: 'playwright-reporter',
    producer: '@argos-ci/playwright',
    outcome: 'changed',
    uploads: 'all',
    run: runPlaywrightReporter,
  },
  {
    name: 'storybook-vitest-plugin',
    producer: '@argos-ci/storybook',
    outcome: 'changed',
    uploads: 'all',
    run: runStorybookReporter,
  },
];

export async function recordAll(
  outputDirectory = defaultOutputDirectory,
  definitions = scenarioDefinitions,
) {
  const versions = Object.fromEntries(
    await Promise.all(
      ['@argos-ci/cli', '@argos-ci/playwright', '@argos-ci/storybook'].map(async (name) => [
        name,
        await packageVersion(name),
      ]),
    ),
  );
  const outputParent = dirname(outputDirectory);
  await mkdir(outputParent, {recursive: true});
  const stagingDirectory = await mkdtemp(
    join(outputParent, `.${basename(outputDirectory)}-staging-`),
  );
  let promoted = false;
  try {
    const generatedNames = [];
    for (const definition of definitions) {
      const temporaryRoot = await mkdtemp(join(tmpdir(), 'glint-argos-recorder-'));
      const scenario = {
        ...definition,
        producer: {name: definition.producer, version: versions[definition.producer]},
      };
      const recorder = createProtocolRecorder(scenario);
      const baseUrl = await recorder.start();
      try {
        const result = await definition.run({scenario, temporaryRoot, baseUrl});
        const recording = recorder.recording(result);
        const filename = `${definition.name}.json`;
        await writeFile(
          join(stagingDirectory, filename),
          `${JSON.stringify(recording, null, 2)}\n`,
        );
        generatedNames.push(filename);
      } finally {
        await recorder.stop();
        await rm(temporaryRoot, {recursive: true, force: true});
      }
    }

    const previousDirectory = `${stagingDirectory}-previous`;
    let hasPreviousDirectory = true;
    try {
      await rename(outputDirectory, previousDirectory);
    } catch (error) {
      if (!(error instanceof Error) || error.code !== 'ENOENT') throw error;
      hasPreviousDirectory = false;
    }
    try {
      await rename(stagingDirectory, outputDirectory);
      promoted = true;
    } catch (error) {
      if (hasPreviousDirectory) await rename(previousDirectory, outputDirectory);
      throw error;
    }
    if (hasPreviousDirectory) await rm(previousDirectory, {recursive: true, force: true});
    return generatedNames.map((name) => join(outputDirectory, name));
  } finally {
    if (!promoted) await rm(stagingDirectory, {recursive: true, force: true});
  }
}

export async function replayRecordings(expectedDirectory = defaultOutputDirectory) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'glint-argos-replay-'));
  const actualDirectory = join(temporaryRoot, 'recordings');
  try {
    await recordAll(actualDirectory);
    const expectedNames = (await readdir(expectedDirectory)).sort();
    const actualNames = (await readdir(actualDirectory)).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error(
        `Replay fixture set differs: expected ${expectedNames.join(', ')}, got ${actualNames.join(', ')}`,
      );
    }
    for (const name of expectedNames) {
      const expected = await readFile(join(expectedDirectory, name), 'utf8');
      const actual = await readFile(join(actualDirectory, name), 'utf8');
      if (actual !== expected) throw new Error(`Replay differs from golden recording: ${name}`);
    }
    return actualNames;
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const generated = await recordAll();
  const digest = createHash('sha256')
    .update((await Promise.all(generated.map((path) => readFile(path)))).join(''))
    .digest('hex');
  process.stdout.write(`Recorded ${generated.length} Argos protocol scenarios (${digest}).\n`);
}
