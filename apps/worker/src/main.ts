import {
  createPostgresDatabase,
  databaseEnvironmentSecrets,
  loadDatabaseEnvironment,
} from '@glint/node-database';
import {createS3BlobStore} from '@glint/node-object-store';
import {
  createGlintLogger,
  loadObservabilityEnvironment,
  observabilityEnvironmentSecrets,
} from '@glint/node-observability';
import {createSqsJobQueue} from '@glint/node-queue';
import {createWorkerApp} from './app.js';
import {loadWorkerEnvironment} from './config.js';
import {checkOdiffBinary} from './odiff.js';

const workerEnvironment = loadWorkerEnvironment();
const databaseEnvironment = loadDatabaseEnvironment();
const observabilityEnvironment = loadObservabilityEnvironment();
const logger = await createGlintLogger({
  secrets: [
    ...databaseEnvironmentSecrets(databaseEnvironment),
    ...observabilityEnvironmentSecrets(observabilityEnvironment),
    workerEnvironment.GLINT_OBJECT_STORE_ACCESS_KEY_ID,
    workerEnvironment.GLINT_OBJECT_STORE_SECRET_ACCESS_KEY,
    workerEnvironment.GLINT_QUEUE_ACCESS_KEY_ID,
    workerEnvironment.GLINT_QUEUE_SECRET_ACCESS_KEY,
  ],
});
const database = await createPostgresDatabase({environment: databaseEnvironment, logger});
const blobStore = createS3BlobStore({
  bucket: workerEnvironment.GLINT_OBJECT_STORE_BUCKET,
  region: workerEnvironment.GLINT_OBJECT_STORE_REGION,
  endpoint: workerEnvironment.GLINT_OBJECT_STORE_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: workerEnvironment.GLINT_OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: workerEnvironment.GLINT_OBJECT_STORE_SECRET_ACCESS_KEY,
  },
});
const queue = createSqsJobQueue({
  accessKeyId: workerEnvironment.GLINT_QUEUE_ACCESS_KEY_ID,
  deadLetterQueueUrl: workerEnvironment.GLINT_QUEUE_DEAD_LETTER_URL,
  endpoint: workerEnvironment.GLINT_QUEUE_ENDPOINT,
  queueName: 'local-shared',
  queueUrl: workerEnvironment.GLINT_QUEUE_URL,
  region: workerEnvironment.GLINT_QUEUE_REGION,
  secretAccessKey: workerEnvironment.GLINT_QUEUE_SECRET_ACCESS_KEY,
});
await checkOdiffBinary();
const app = await createWorkerApp({
  blobStore,
  database,
  modules: [],
  odiffReady: checkOdiffBinary,
  queue,
});

async function shutdown(signal: string) {
  logger.info('Stopping worker process.', {signal});
  await app.close();
  await database.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('Worker shutdown failed.', {
          error: error instanceof Error ? error.message : String(error),
          signal,
        });
        process.exit(1);
      },
    );
  });
}

await app.listen({
  host: workerEnvironment.GLINT_WORKER_HOST,
  port: workerEnvironment.GLINT_WORKER_PORT,
});
logger.info('Worker process is ready.', {port: workerEnvironment.GLINT_WORKER_PORT});
