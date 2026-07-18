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
import {InMemoryJobQueue} from '@glint/node-queue';
import {createApiApp} from './app.js';
import {loadApiEnvironment} from './config.js';

const apiEnvironment = loadApiEnvironment();
const databaseEnvironment = loadDatabaseEnvironment();
const observabilityEnvironment = loadObservabilityEnvironment();
const logger = await createGlintLogger({
  secrets: [
    ...databaseEnvironmentSecrets(databaseEnvironment),
    ...observabilityEnvironmentSecrets(observabilityEnvironment),
    apiEnvironment.GLINT_OBJECT_STORE_ACCESS_KEY_ID,
    apiEnvironment.GLINT_OBJECT_STORE_SECRET_ACCESS_KEY,
  ],
});
const database = await createPostgresDatabase({environment: databaseEnvironment, logger});
const blobStore = createS3BlobStore({
  bucket: apiEnvironment.GLINT_OBJECT_STORE_BUCKET,
  region: apiEnvironment.GLINT_OBJECT_STORE_REGION,
  endpoint: apiEnvironment.GLINT_OBJECT_STORE_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: apiEnvironment.GLINT_OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: apiEnvironment.GLINT_OBJECT_STORE_SECRET_ACCESS_KEY,
  },
});
const queue = new InMemoryJobQueue();
const app = await createApiApp({blobStore, database, queue, modules: []});

async function shutdown(signal: string) {
  logger.info('Stopping API process.', {signal});
  await app.close();
  await database.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('API shutdown failed.', {
          error: error instanceof Error ? error.message : String(error),
          signal,
        });
        process.exit(1);
      },
    );
  });
}

await app.listen({host: apiEnvironment.GLINT_API_HOST, port: apiEnvironment.GLINT_API_PORT});
logger.info('API process is ready.', {port: apiEnvironment.GLINT_API_PORT});
