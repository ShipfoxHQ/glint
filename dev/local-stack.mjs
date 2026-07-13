import {spawn} from 'node:child_process';
import {closeSync, mkdirSync, openSync} from 'node:fs';
import {readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {setTimeout as delay} from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const stateDirectory = path.join(root, '.glint-local');
const processesFile = path.join(stateDirectory, 'processes.json');

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer TCP port.`);
  }
  return parsed;
}

function configuration() {
  const conductorBase = process.env.CONDUCTOR_PORT
    ? integerEnvironment('CONDUCTOR_PORT')
    : undefined;
  const apiPort = integerEnvironment('GLINT_API_PORT', conductorBase ?? 3001);
  const webPort = integerEnvironment('GLINT_WEB_PORT', conductorBase ? conductorBase + 1 : 3000);
  const workerPort = integerEnvironment(
    'GLINT_WORKER_PORT',
    conductorBase ? conductorBase + 2 : 3002,
  );
  const postgresPort = integerEnvironment(
    'GLINT_POSTGRES_PORT',
    conductorBase ? conductorBase + 3 : 5432,
  );
  const minioPort = integerEnvironment(
    'GLINT_MINIO_PORT',
    conductorBase ? conductorBase + 4 : 9000,
  );
  const minioConsolePort = integerEnvironment(
    'GLINT_MINIO_CONSOLE_PORT',
    conductorBase ? conductorBase + 5 : 9001,
  );

  return {
    apiPort,
    webPort,
    workerPort,
    environment: {
      ...process.env,
      GLINT_API_PORT: String(apiPort),
      GLINT_MINIO_PORT: String(minioPort),
      GLINT_MINIO_CONSOLE_PORT: String(minioConsolePort),
      GLINT_POSTGRES_PORT: String(postgresPort),
      GLINT_OBJECT_STORE_ACCESS_KEY_ID: 'local-glint',
      GLINT_OBJECT_STORE_BUCKET: 'glint',
      GLINT_OBJECT_STORE_ENDPOINT: `http://127.0.0.1:${minioPort}`,
      GLINT_OBJECT_STORE_REGION: 'local',
      GLINT_OBJECT_STORE_SECRET_ACCESS_KEY: 'local-glint-secret',
      GLINT_WEB_API_URL: `http://127.0.0.1:${apiPort}`,
      GLINT_WEB_PORT: String(webPort),
      GLINT_WORKER_PORT: String(workerPort),
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: String(postgresPort),
    },
  };
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.environment ?? process.env,
      stdio: options.quiet ? 'ignore' : 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}.`));
    });
  });
}

async function readProcesses() {
  try {
    return JSON.parse(await readFile(processesFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(url, expectedStatus = 200) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === expectedStatus) return response;
      lastError = new Error(`${url} returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError ?? new Error(`${url} did not become ready.`);
}

function startProcess(name, filter, environment) {
  mkdirSync(stateDirectory, {recursive: true});
  const logPath = path.join(stateDirectory, `${name}.log`);
  const log = openSync(logPath, 'a');
  const child = spawn('pnpm', ['--filter', filter, 'start'], {
    cwd: root,
    detached: true,
    env: environment,
    stdio: ['ignore', log, log],
  });
  child.unref();
  closeSync(log);
  return {name, pid: child.pid, logPath};
}

async function start() {
  const existing = await readProcesses();
  if (existing.length > 0 && existing.every(({pid}) => processIsAlive(pid))) {
    throw new Error('The local Glint apps are already running. Use local:stop first.');
  }
  if (existing.length > 0) await stopApps();
  const config = configuration();
  mkdirSync(stateDirectory, {recursive: true});
  await run(
    'pnpm',
    [
      'turbo',
      'build',
      '--filter=@glint/app-api',
      '--filter=@glint/app-web',
      '--filter=@glint/app-worker',
      '--filter=@glint/app-migrate',
    ],
    {environment: config.environment},
  );
  await run('docker', ['compose', 'up', '-d', '--wait', '--force-recreate', 'postgres', 'minio'], {
    environment: config.environment,
  });
  await run('docker', ['compose', 'run', '--rm', 'minio-init'], {
    environment: config.environment,
  });
  await run('pnpm', ['--filter', '@glint/app-migrate', 'start'], {
    environment: config.environment,
  });

  const children = [
    startProcess('api', '@glint/app-api', config.environment),
    startProcess('worker', '@glint/app-worker', config.environment),
    startProcess('web', '@glint/app-web', config.environment),
  ];
  await writeFile(processesFile, `${JSON.stringify(children, null, 2)}\n`);

  try {
    await Promise.all([
      waitFor(`http://127.0.0.1:${config.apiPort}/ready`),
      waitFor(`http://127.0.0.1:${config.workerPort}/ready`),
      waitFor(`http://127.0.0.1:${config.webPort}/ready`),
    ]);
  } catch (error) {
    await stopApps();
    await run('docker', ['compose', 'down'], {environment: config.environment, quiet: true});
    throw error;
  }

  process.stdout.write(
    `Glint local stack is ready: web=http://127.0.0.1:${config.webPort} api=http://127.0.0.1:${config.apiPort} worker=http://127.0.0.1:${config.workerPort}\n`,
  );
}

async function stopApps() {
  const children = await readProcesses();
  for (const {pid} of children) {
    if (!processIsAlive(pid)) continue;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      process.kill(pid, 'SIGTERM');
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (children.every(({pid}) => !processIsAlive(pid))) break;
    await delay(100);
  }
  for (const {pid} of children) {
    if (!processIsAlive(pid)) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
  }
  await rm(processesFile, {force: true});
}

async function stop() {
  const config = configuration();
  await stopApps();
  await run('docker', ['compose', 'down'], {environment: config.environment});
  process.stdout.write('Glint local stack stopped; PostgreSQL and MinIO volumes were preserved.\n');
}

async function reset() {
  const config = configuration();
  await stopApps();
  await run('docker', ['compose', 'down', '--volumes', '--remove-orphans'], {
    environment: config.environment,
  });
  await rm(stateDirectory, {recursive: true, force: true});
  await start();
}

async function test() {
  const config = configuration();
  const children = await readProcesses();
  if (children.length === 0 || children.some(({pid}) => !processIsAlive(pid))) await start();
  const endpoints = [
    `http://127.0.0.1:${config.apiPort}/live`,
    `http://127.0.0.1:${config.apiPort}/ready`,
    `http://127.0.0.1:${config.workerPort}/live`,
    `http://127.0.0.1:${config.workerPort}/ready`,
    `http://127.0.0.1:${config.webPort}/live`,
    `http://127.0.0.1:${config.webPort}/ready`,
  ];
  for (const endpoint of endpoints) await waitFor(endpoint);
  await run(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'glint',
      '-d',
      'glint',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "SELECT 1 / count(*) FROM pg_tables WHERE schemaname = 'drizzle' AND tablename LIKE 'glint_%_migrations';",
    ],
    {environment: config.environment},
  );
  process.stdout.write('Local stack checks passed: migration, API, worker, and web are ready.\n');
}

const command = process.argv[2];
if (command === 'start') await start();
else if (command === 'stop') await stop();
else if (command === 'reset') await reset();
else if (command === 'test') await test();
else throw new Error('Usage: node dev/local-stack.mjs <start|stop|reset|test>');
