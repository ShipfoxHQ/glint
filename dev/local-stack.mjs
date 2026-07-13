import {execFile, spawn} from 'node:child_process';
import {closeSync, mkdirSync, openSync} from 'node:fs';
import {readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const stateDirectory = path.join(root, '.glint-local');
const processesFile = path.join(stateDirectory, 'processes.json');
const execFileAsync = promisify(execFile);

function integerEnvironment(name, fallback) {
  const value = process.env[name] ?? fallback;
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
  if (conductorBase !== undefined && conductorBase > 65_529) {
    throw new Error('CONDUCTOR_PORT must leave room for six derived service ports.');
  }
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
  const queuePort = integerEnvironment(
    'GLINT_QUEUE_PORT',
    conductorBase ? conductorBase + 6 : 9324,
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
      GLINT_QUEUE_ACCESS_KEY_ID: 'local-glint-queue',
      GLINT_QUEUE_DEAD_LETTER_URL: `http://127.0.0.1:${queuePort}/000000000000/glint-dead-letter`,
      GLINT_QUEUE_ENDPOINT: `http://127.0.0.1:${queuePort}`,
      GLINT_QUEUE_PORT: String(queuePort),
      GLINT_QUEUE_REGION: 'elasticmq',
      GLINT_QUEUE_SECRET_ACCESS_KEY: 'local-glint-queue-secret',
      GLINT_QUEUE_URL: `http://127.0.0.1:${queuePort}/000000000000/glint`,
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

async function processIdentity(pid) {
  if (!processIsAlive(pid)) return undefined;
  try {
    const [{stdout: command}, {stdout: startedAt}] = await Promise.all([
      execFileAsync('ps', ['-o', 'command=', '-p', String(pid)]),
      execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)]),
    ]);
    if (!command.trim() || !startedAt.trim()) return undefined;
    return {command: command.trim(), startedAt: startedAt.trim()};
  } catch {
    return undefined;
  }
}

async function isOwnedProcess(child) {
  if (!child.identity) return false;
  const current = await processIdentity(child.pid);
  return (
    current?.command === child.identity.command && current.startedAt === child.identity.startedAt
  );
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

async function startProcess(name, filter, environment) {
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
  await delay(100);
  const identity = await processIdentity(child.pid);
  if (!identity) throw new Error(`Could not record the ${name} process identity.`);
  return {name, pid: child.pid, logPath, identity};
}

async function start() {
  const existing = await readProcesses();
  const existingOwnership = await Promise.all(existing.map(isOwnedProcess));
  if (existing.length > 0 && existingOwnership.every(Boolean)) {
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
  await run(
    'docker',
    ['compose', 'up', '-d', '--wait', '--force-recreate', 'postgres', 'minio', 'queue'],
    {environment: config.environment},
  );
  await run('docker', ['compose', 'run', '--rm', 'minio-init'], {
    environment: config.environment,
  });
  await run('pnpm', ['--filter', '@glint/app-migrate', 'start'], {
    environment: config.environment,
  });

  const children = await Promise.all([
    startProcess('api', '@glint/app-api', config.environment),
    startProcess('worker', '@glint/app-worker', config.environment),
    startProcess('web', '@glint/app-web', config.environment),
  ]);
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
  const ownedChildren = [];
  for (const child of children) {
    if (await isOwnedProcess(child)) ownedChildren.push(child);
    else if (processIsAlive(child.pid)) {
      process.stderr.write(
        `Skipping stale ${child.name ?? 'local'} process state for PID ${child.pid}; identity does not match.\n`,
      );
    }
  }
  for (const {pid} of ownedChildren) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      process.kill(pid, 'SIGTERM');
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (ownedChildren.every(({pid}) => !processIsAlive(pid))) break;
    await delay(100);
  }
  for (const {pid} of ownedChildren) {
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
  process.stdout.write(
    'Glint local stack stopped; PostgreSQL, MinIO, and queue volumes were preserved.\n',
  );
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
  const ownership = await Promise.all(children.map(isOwnedProcess));
  if (children.length === 0 || ownership.some((owned) => !owned)) await start();
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
